/// <reference lib="webworker" />
/**
 * Game Boy / Game Boy Color emulation worker.
 *
 * The worker owns the core and the clock. Pacing is driven by the audio ring:
 * it emulates frames only while there is room for the audio they produce, and
 * otherwise parks on Atomics.wait. That makes the audio device the master clock,
 * which is what keeps sound from crackling and the picture from drifting —
 * far steadier than pacing on a timer.
 *
 * Without a SharedArrayBuffer the same loop runs on a timer and posts copies.
 */

import {
  AUDIO_CHANNELS,
  AUDIO_RING_FRAMES,
  Ctl,
  FRAME_PIXELS,
  FRAME_SLOTS,
  RunState,
  viewShared,
  type FromWorker,
  type SharedViews,
  type ToWorker,
} from '../../core/protocol';
import type { SameBoyFactory, SameBoyModule } from './sameboyModule';

/** Stereo frames to keep queued. ~85 ms: enough to ride out a stutter. */
const TARGET_AUDIO_FILL = 4096;
/**
 * If the audio thread stops draining for this long the ring stays full forever
 * and pacing on it would freeze the picture. Happens whenever output is
 * unavailable: a suspended AudioContext, a muted or absent device, a headless
 * browser. Past this point emulation is paced on the clock instead and queued
 * audio is dropped, so the game keeps running silently rather than stalling.
 */
const AUDIO_STALL_MS = 250;

let core: SameBoyModule | null = null;
let shared: SharedViews | null = null;
let running = false;
let loopScheduled = false;

let frameRate = 59.727;
let writeSlot = 0;
let keyMask = 0;
let speedPercent = 100;

/** Ring write position in stereo frames, mirrored into the control block. */
let audioWrite = 0;

/** Output rate the core is tuned to; set from the AudioContext at init. */
let sampleRate = 48000;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

function fail(error: unknown): void {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}

/* --- Audio ring --------------------------------------------------------- */

function ringFilled(views: SharedViews): number {
  const read = Atomics.load(views.ctl, Ctl.AUDIO_READ);
  return (audioWrite - read + AUDIO_RING_FRAMES) % AUDIO_RING_FRAMES;
}

/** Copies `frames` stereo frames from the core's audio buffer into the ring. */
function pushAudio(views: SharedViews, source: Int16Array, frames: number): void {
  const capacity = AUDIO_RING_FRAMES - 1 - ringFilled(views);
  const count = Math.min(frames, capacity);
  if (count <= 0) return;

  const firstRun = Math.min(count, AUDIO_RING_FRAMES - audioWrite);
  views.audio.set(source.subarray(0, firstRun * AUDIO_CHANNELS), audioWrite * AUDIO_CHANNELS);
  if (count > firstRun) {
    views.audio.set(source.subarray(firstRun * AUDIO_CHANNELS, count * AUDIO_CHANNELS), 0);
  }

  audioWrite = (audioWrite + count) % AUDIO_RING_FRAMES;
  Atomics.store(views.ctl, Ctl.AUDIO_WRITE, audioWrite);
}

/* --- Frame stepping ----------------------------------------------------- */

/** Runs one frame and publishes pixels and audio. Returns the audio frame count. */
function stepFrame(): number {
  if (!core) return 0;

  if (shared) {
    core._gbw_set_key_mask(Atomics.load(shared.ctl, Ctl.KEY_MASK));
  }
  else {
    core._gbw_set_key_mask(keyMask);
  }

  const audioFrames = core._gbw_run_frame();

  const pixelPtr = core._gbw_framebuffer();
  const pixels = core.HEAPU32.subarray(pixelPtr >>> 2, (pixelPtr >>> 2) + FRAME_PIXELS);

  if (shared) {
    writeSlot = (writeSlot + 1) % FRAME_SLOTS;
    shared.frames[writeSlot]!.set(pixels);
    Atomics.store(shared.ctl, Ctl.FRAME_SLOT, writeSlot);
    Atomics.add(shared.ctl, Ctl.FRAME_SEQ, 1);
    Atomics.add(shared.ctl, Ctl.FRAME_COUNT, 1);

    if (audioFrames > 0) {
      const audioPtr = core._gbw_audio_buffer();
      const samples = core.HEAP16.subarray(
        audioPtr >> 1,
        (audioPtr >> 1) + audioFrames * AUDIO_CHANNELS,
      );
      pushAudio(shared, samples, audioFrames);
    }
  }
  else {
    // Copy out: the views alias the WASM heap, which the next frame overwrites.
    const frameCopy = new Uint32Array(pixels).buffer;
    post({ type: 'frame', pixels: frameCopy, seq: 0 }, [frameCopy]);

    if (audioFrames > 0) {
      const audioPtr = core._gbw_audio_buffer();
      const copy = new Int16Array(
        core.HEAP16.subarray(audioPtr >> 1, (audioPtr >> 1) + audioFrames * AUDIO_CHANNELS),
      ).buffer;
      post({ type: 'audio', samples: copy }, [copy]);
    }
  }

  return audioFrames;
}

/* --- Run loop ----------------------------------------------------------- */

/**
 * Frames emulated per slice before yielding. A blocking loop with Atomics.wait
 * would pace more precisely, but it also makes the worker deaf to messages:
 * pause, save-state and battery reads would never be serviced while the game
 * runs. With ~85 ms of audio buffered, yielding costs nothing measurable.
 */
const MAX_FRAMES_PER_SLICE = 8;

let nextFrameAt = 0;
let lastAudioRead = -1;
let lastDrainAt = 0;
/** Ring position this worker set itself; movement to it is not the audio thread. */
let discardedTo = -1;

/** Milliseconds per emulated frame at the current speed setting. */
function frameInterval(): number {
  return (1000 / frameRate) * (100 / speedPercent);
}

/**
 * Decides whether another frame is due right now.
 *
 * With shared memory the audio thread is the clock: a frame is emulated
 * whenever there is ring space for the audio it will produce, which keeps
 * emulation locked to the output device with no drift. If audio stops draining
 * — a suspended context, a muted device, a headless browser — the backlog is
 * dropped and pacing falls back to the wall clock so the game keeps running
 * silently instead of freezing.
 */
function shouldStepNow(now: number): boolean {
  if (!shared) {
    if (now < nextFrameAt) return false;
    nextFrameAt = Math.max(now, nextFrameAt) + frameInterval();
    return true;
  }

  const read = Atomics.load(shared.ctl, Ctl.AUDIO_READ);
  if (read !== lastAudioRead) {
    if (read !== discardedTo) lastDrainAt = now;
    lastAudioRead = read;
  }

  const target = Math.max(1024, Math.round((TARGET_AUDIO_FILL * 100) / speedPercent));
  if (ringFilled(shared) < target) {
    nextFrameAt = now + frameInterval();
    return true;
  }

  if (now - lastDrainAt > AUDIO_STALL_MS) {
    const write = Atomics.load(shared.ctl, Ctl.AUDIO_WRITE);
    Atomics.store(shared.ctl, Ctl.AUDIO_READ, write);
    discardedTo = write;
    lastAudioRead = write;

    if (now < nextFrameAt) return false;
    nextFrameAt = Math.max(now, nextFrameAt) + frameInterval();
    return true;
  }

  return false;
}

function pump(): void {
  if (!running) {
    loopScheduled = false;
    return;
  }

  let budget = MAX_FRAMES_PER_SLICE;
  while (running && budget-- > 0 && shouldStepNow(performance.now())) {
    stepFrame();
  }

  setTimeout(pump, 1);
}

function startLoop(): void {
  if (running) return;
  running = true;

  const now = performance.now();
  nextFrameAt = now;
  lastDrainAt = now;
  lastAudioRead = shared ? Atomics.load(shared.ctl, Ctl.AUDIO_READ) : -1;
  discardedTo = -1;

  if (shared) Atomics.store(shared.ctl, Ctl.RUN_STATE, RunState.Running);
  if (!loopScheduled) {
    loopScheduled = true;
    pump();
  }
}

function stopLoop(): void {
  running = false;
  if (shared) Atomics.store(shared.ctl, Ctl.RUN_STATE, RunState.Paused);
}

/* --- Buffer helpers ----------------------------------------------------- */

/** Copies `bytes` into the WASM heap and runs `use` with the pointer. */
function withHeapBuffer<T>(module: SameBoyModule, bytes: Uint8Array, use: (ptr: number) => T): T {
  const ptr = module._malloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, ptr);
    return use(ptr);
  }
  finally {
    module._free(ptr);
  }
}

function readBattery(module: SameBoyModule): ArrayBuffer | null {
  const size = module._gbw_battery_size();
  if (size <= 0) return null;
  const ptr = module._malloc(size);
  try {
    module._gbw_save_battery(ptr, size);
    return new Uint8Array(module.HEAPU8.subarray(ptr, ptr + size)).buffer;
  }
  finally {
    module._free(ptr);
  }
}

function readState(module: SameBoyModule): ArrayBuffer | null {
  const size = module._gbw_state_size();
  if (size <= 0) return null;
  const ptr = module._malloc(size);
  try {
    module._gbw_save_state(ptr);
    return new Uint8Array(module.HEAPU8.subarray(ptr, ptr + size)).buffer;
  }
  finally {
    module._free(ptr);
  }
}

/* --- Message handling --------------------------------------------------- */

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'init': {
        const factory: SameBoyFactory = (await import(/* @vite-ignore */ message.coreUrl)).default;
        core = await factory();
        sampleRate = message.sampleRate;
        core._gbw_set_sample_rate(sampleRate);
        shared = message.shared ? viewShared(message.shared) : null;
        if (shared) {
          audioWrite = 0;
          Atomics.store(shared.ctl, Ctl.AUDIO_WRITE, 0);
          Atomics.store(shared.ctl, Ctl.AUDIO_READ, 0);
        }
        post({ type: 'ready', usingShared: shared !== null });
        break;
      }

      case 'load': {
        if (!core) throw new Error('Core noch nicht initialisiert');
        core._gbw_init(message.model);
        core._gbw_set_sample_rate(sampleRate);

        const rom = new Uint8Array(message.rom);
        const result = withHeapBuffer(core, rom, (ptr) => core!._gbw_load_rom(ptr, rom.length));
        if (result !== 0) throw new Error('ROM konnte nicht geladen werden');

        if (message.battery) {
          const battery = new Uint8Array(message.battery);
          withHeapBuffer(core, battery, (ptr) => core!._gbw_load_battery(ptr, battery.length));
        }

        core._gbw_reset();
        frameRate = core._gbw_frame_rate() || 59.727;
        post({ type: 'loaded', frameRate, hasBattery: core._gbw_battery_size() > 0 });
        break;
      }

      case 'start':
      case 'resume':
        startLoop();
        break;

      case 'pause':
        stopLoop();
        break;

      case 'stop':
        stopLoop();
        if (core) core._gbw_deinit();
        break;

      case 'reset':
        if (core) core._gbw_reset();
        break;

      case 'setKeys':
        keyMask = message.mask;
        break;

      case 'setSpeed':
        speedPercent = Math.max(10, Math.min(800, message.percent));
        break;

      case 'requestBattery':
        post({ type: 'battery', token: message.token, data: core ? readBattery(core) : null });
        break;

      case 'requestState':
        post({ type: 'state', token: message.token, data: core ? readState(core) : null });
        break;

      case 'loadState': {
        if (!core) throw new Error('Core noch nicht initialisiert');
        const data = new Uint8Array(message.data);
        const ok = withHeapBuffer(core, data, (ptr) => core!._gbw_load_state(ptr, data.length));
        post({ type: 'stateLoaded', token: message.token, ok: ok === 0 });
        break;
      }
    }
  }
  catch (error) {
    fail(error);
  }
};
