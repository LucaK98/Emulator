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

/* --- Rewind ------------------------------------------------------------- */

/**
 * How often the machine's state is captured while playing. Every twelfth frame
 * is five snapshots a second: fine enough that stepping back feels continuous,
 * coarse enough not to cost a noticeable amount of time per frame.
 */
const REWIND_INTERVAL_FRAMES = 12;
/** Total memory the history may occupy. */
const REWIND_BUDGET_BYTES = 48 * 1024 * 1024;
/**
 * A single state larger than this makes rewind pointless — a Nintendo DS state
 * is around 19 MB, so a history worth having would not fit in memory at all.
 * Those systems simply do not offer it.
 */
const REWIND_MAX_STATE_BYTES = 8 * 1024 * 1024;
/**
 * Wall-clock frames between two steps back. A snapshot is twelve emulated
 * frames apart, so stepping every fourth frame rewinds at about three times
 * real speed — fast enough to undo a mistake, slow enough to see where to stop.
 */
const REWIND_STEP_EVERY_FRAMES = 4;

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

  /** Most recent first; each entry is a complete machine state. */
  let rewindHistory: ArrayBuffer[] = [];
  let rewindDepth = 0;
  let rewindAvailable = false;
  let rewinding = false;
  let framesSinceCapture = 0;

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

  /** Publishes whatever the core currently shows, without emulating. */
  const publishFrame = (audioFrames: number): void => {
    if (!core) return;
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

      const size = core.frameSize();
      Atomics.store(shared.ctl, Ctl.FRAME_WIDTH, size.width);
      Atomics.store(shared.ctl, Ctl.FRAME_HEIGHT, size.height);

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

  const stepFrame = (): void => {
    if (!core) return;

    core.setKeyMask(shared ? Atomics.load(shared.ctl, Ctl.KEY_MASK) : keyMask);
    const audioFrames = core.runFrame();
    publishFrame(audioFrames);

    if (rewindAvailable && ++framesSinceCapture >= REWIND_INTERVAL_FRAMES) {
      framesSinceCapture = 0;
      const state = core.readState();
      if (state) {
        rewindHistory.unshift(state);
        if (rewindHistory.length > rewindDepth) rewindHistory.length = rewindDepth;
      }
    }
  };

  /** Steps one snapshot back. Returns false once the history runs out. */
  const stepBack = (): boolean => {
    if (!core) return false;
    const state = rewindHistory.shift();
    if (!state) return false;

    core.loadState(new Uint8Array(state));
    // Restoring a state does not redraw anything: the frame buffer still holds
    // the last picture that was emulated. One frame from the restored state
    // produces the picture that belongs to it — a net step backwards, since a
    // snapshot is a dozen frames apart.
    core.runFrame();
    // Whatever audio that frame produced is dropped; rewinding is silent.
    publishFrame(0);
    return true;
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
    if (rewinding) {
      // Paced on the clock: rewinding produces no audio, so the ring cannot be
      // the clock here.
      const now = performance.now();
      if (now >= nextFrameAt) {
        nextFrameAt = Math.max(now, nextFrameAt) + frameInterval() * REWIND_STEP_EVERY_FRAMES;
        stepBack();
      }
      setTimeout(pump, 1);
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

          // Whether a history is worth keeping depends on how big one state is,
          // which is only knowable once a game is loaded.
          rewindHistory = [];
          framesSinceCapture = 0;
          const probe = core.readState();
          const stateBytes = probe?.byteLength ?? 0;
          rewindAvailable = stateBytes > 0 && stateBytes <= REWIND_MAX_STATE_BYTES;
          rewindDepth = rewindAvailable ? Math.floor(REWIND_BUDGET_BYTES / stateBytes) : 0;

          post({ type: 'loaded', frameRate, hasBattery: core.batterySize() > 0 });
          post({
            type: 'rewindReady',
            available: rewindAvailable,
            seconds: (rewindDepth * REWIND_INTERVAL_FRAMES) / frameRate,
          });
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

        case 'touch':
          core?.touch?.(message.x, message.y);
          break;

        case 'releaseTouch':
          core?.releaseTouch?.();
          break;

        case 'setLayout':
          core?.setLayout?.(message.layout);
          break;

        case 'setRewind':
          rewinding = message.active && rewindAvailable;
          if (rewinding) nextFrameAt = performance.now();
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
