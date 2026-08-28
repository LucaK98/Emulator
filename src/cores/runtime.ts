/// <reference lib="webworker" />
/**
 * The emulation worker's runtime, shared by every core.
 *
 * The worker owns the core and the clock. Pacing is driven by the audio ring:
 * frames are emulated only while there is room for the audio they produce,
 * which makes the audio device the master clock and keeps sound from crackling
 * and the picture from drifting.
 *
 * Without a SharedArrayBuffer the same loop runs on a timer and posts copies.
 */

import {
  AUDIO_CHANNELS,
  AUDIO_RING_FRAMES,
  Ctl,
  FRAME_SLOTS,
  RunState,
  SYSTEMS,
  sharedLayout,
  viewShared,
  type FromWorker,
  type SharedViews,
  type SystemSpec,
  type ToWorker,
} from '../core/protocol';
import type { EmulatorCore } from './EmulatorCore';

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
/**
 * Frames emulated per slice before yielding. A blocking loop with Atomics.wait
 * would pace more precisely, but it also makes the worker deaf to messages:
 * pause, save-state and battery reads would never be serviced while the game
 * runs. With ~85 ms of audio buffered, yielding costs nothing measurable.
 */
const MAX_FRAMES_PER_SLICE = 8;

/** Builds the core once the module URL is known. */
export type CoreFactory = (coreUrl: string) => Promise<EmulatorCore>;

export function startWorkerRuntime(createCore: CoreFactory): void {
  let core: EmulatorCore | null = null;
  let spec: SystemSpec = SYSTEMS.gb;
  let shared: SharedViews | null = null;

  let running = false;
  let loopScheduled = false;
  let frameRate = 59.727;
  let writeSlot = 0;
  let keyMask = 0;
  let speedPercent = 100;
  let sampleRate = 48000;

  /** Ring write position in stereo frames, mirrored into the control block. */
  let audioWrite = 0;
  let nextFrameAt = 0;
  let lastAudioRead = -1;
  let lastDrainAt = 0;
  /** Ring position this worker set itself; movement to it is not the audio thread. */
  let discardedTo = -1;

  const post = (message: FromWorker, transfer: Transferable[] = []) =>
    (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);

  /* --- Audio ring ------------------------------------------------------- */

  const ringFilled = (views: SharedViews): number => {
    const read = Atomics.load(views.ctl, Ctl.AUDIO_READ);
    return (audioWrite - read + AUDIO_RING_FRAMES) % AUDIO_RING_FRAMES;
  };

  const pushAudio = (views: SharedViews, source: Int16Array, frames: number): void => {
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
  };

  /* --- Frame stepping --------------------------------------------------- */

  const stepFrame = (): void => {
    if (!core) return;

    core.setKeyMask(shared ? Atomics.load(shared.ctl, Ctl.KEY_MASK) : keyMask);
    const audioFrames = core.runFrame();
    const pixels = core.framePixels();

    if (shared) {
      writeSlot = (writeSlot + 1) % FRAME_SLOTS;
      shared.frames[writeSlot]!.set(pixels);

      if (core.capturePpu && shared.ppu.length > 0) {
        if (Atomics.load(shared.ctl, Ctl.CAPTURE_PPU) !== 0) {
          core.capturePpu(shared.ppu[writeSlot]!);
        }
      }

      Atomics.store(shared.ctl, Ctl.FRAME_SLOT, writeSlot);
      Atomics.add(shared.ctl, Ctl.FRAME_SEQ, 1);
      Atomics.add(shared.ctl, Ctl.FRAME_COUNT, 1);

      if (audioFrames > 0) pushAudio(shared, core.audioSamples(audioFrames), audioFrames);
    }
    else {
      // Copy out: the views alias the WASM heap, which the next frame overwrites.
      const frameCopy = new Uint32Array(pixels).buffer;
      post({ type: 'frame', pixels: frameCopy, seq: 0 }, [frameCopy]);

      if (audioFrames > 0) {
        const copy = new Int16Array(core.audioSamples(audioFrames)).buffer;
        post({ type: 'audio', samples: copy }, [copy]);
      }
    }
  };

  /* --- Pacing ----------------------------------------------------------- */

  const frameInterval = (): number => (1000 / frameRate) * (100 / speedPercent);

  const shouldStepNow = (now: number): boolean => {
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
  };

  const pump = (): void => {
    if (!running) {
      loopScheduled = false;
      return;
    }
    let budget = MAX_FRAMES_PER_SLICE;
    while (running && budget-- > 0 && shouldStepNow(performance.now())) stepFrame();
    setTimeout(pump, 1);
  };

  const startLoop = (): void => {
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
  };

  const stopLoop = (): void => {
    running = false;
    if (shared) Atomics.store(shared.ctl, Ctl.RUN_STATE, RunState.Paused);
  };

  /* --- Messages --------------------------------------------------------- */

  self.onmessage = async (event: MessageEvent<ToWorker>) => {
    const message = event.data;

    try {
      switch (message.type) {
        case 'init': {
          spec = SYSTEMS[message.system];
          core = await createCore(message.coreUrl);
          sampleRate = message.sampleRate;
          core.setSampleRate(sampleRate);

          shared = message.shared ? viewShared(message.shared, spec) : null;
          if (shared) {
            audioWrite = 0;
            Atomics.store(shared.ctl, Ctl.AUDIO_WRITE, 0);
            Atomics.store(shared.ctl, Ctl.AUDIO_READ, 0);
            // Sanity: a mismatched layout would corrupt memory silently.
            const expected = sharedLayout(spec).totalBytes;
            if (message.shared!.byteLength !== expected) {
              throw new Error(`Puffergröße passt nicht zu ${spec.label}`);
            }
          }
          post({ type: 'ready', usingShared: shared !== null });
          break;
        }

        case 'load': {
          if (!core) throw new Error('Core noch nicht initialisiert');
          core.init(message.model);
          core.setSampleRate(sampleRate);

          const battery = message.battery ? new Uint8Array(message.battery) : null;
          if (battery && core.batteryBeforeRom) core.loadBattery(battery);

          if (!core.loadRom(new Uint8Array(message.rom))) {
            throw new Error('ROM konnte nicht geladen werden');
          }

          if (battery && !core.batteryBeforeRom) core.loadBattery(battery);

          core.reset();
          frameRate = core.frameRate() || 59.727;
          post({ type: 'loaded', frameRate, hasBattery: core.batterySize() > 0 });
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
          core?.deinit();
          break;

        case 'reset':
          core?.reset();
          break;

        case 'setKeys':
          keyMask = message.mask;
          break;

        case 'setSpeed':
          speedPercent = Math.max(10, Math.min(800, message.percent));
          break;

        case 'requestBattery':
          post({ type: 'battery', token: message.token, data: core?.readBattery() ?? null });
          break;

        case 'requestState':
          post({ type: 'state', token: message.token, data: core?.readState() ?? null });
          break;

        case 'loadState': {
          if (!core) throw new Error('Core noch nicht initialisiert');
          const ok = core.loadState(new Uint8Array(message.data));
          post({ type: 'stateLoaded', token: message.token, ok });
          break;
        }
      }
    }
    catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
}
