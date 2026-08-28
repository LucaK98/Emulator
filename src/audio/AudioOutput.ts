/**
 * Main-thread side of audio output.
 *
 * Two iOS specifics are handled here. First, an AudioContext starts suspended
 * and may only be resumed from a user gesture, so `resume()` is called from the
 * button that starts the game. Second, Safari routes Web Audio through the
 * "ambient" session by default, which means the ringer switch mutes the game;
 * declaring the session as playback fixes that.
 */

import {
  AUDIO_CHANNELS,
  AUDIO_RING_FRAMES,
  CTL_SLOTS,
  Ctl,
  PREFERRED_SAMPLE_RATE,
  SHARED_LAYOUT,
} from '../core/protocol';

/** Safari 16.4+ exposes this; other browsers do not, and do not need it. */
interface AudioSessionCapable {
  audioSession?: { type: string };
}

export class AudioOutput {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  get sampleRate(): number {
    return this.context?.sampleRate ?? PREFERRED_SAMPLE_RATE;
  }

  get isRunning(): boolean {
    return this.context?.state === 'running';
  }

  /**
   * Builds the audio graph. Safe to call before any user gesture: the context
   * simply stays suspended until `resume()`.
   */
  async init(shared: SharedArrayBuffer | null, baseUrl: string): Promise<void> {
    if (this.context) return;

    const session = navigator as Navigator & AudioSessionCapable;
    if (session.audioSession) {
      // Keep playing when the ringer switch is on silent.
      session.audioSession.type = 'playback';
    }

    // Asking for 48 kHz avoids resampling; Safari may ignore it, in which case
    // the core is retuned to whatever rate we actually got.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: PREFERRED_SAMPLE_RATE, latencyHint: 'interactive' });
    }
    catch {
      context = new AudioContext({ latencyHint: 'interactive' });
    }
    this.context = context;

    await context.audioWorklet.addModule(`${baseUrl}audio/pcm-processor.js`);

    this.node = new AudioWorkletNode(context, 'emulator-pcm', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [AUDIO_CHANNELS],
      processorOptions: {
        shared,
        ringFrames: AUDIO_RING_FRAMES,
        channels: AUDIO_CHANNELS,
        ctlOffset: SHARED_LAYOUT.ctlOffset,
        ctlSlots: CTL_SLOTS,
        audioOffset: SHARED_LAYOUT.audioOffset,
        ctlAudioRead: Ctl.AUDIO_READ,
        ctlAudioWrite: Ctl.AUDIO_WRITE,
      },
    });
    this.node.connect(context.destination);
  }

  /** Must be called from a user gesture the first time. */
  async resume(): Promise<void> {
    await this.context?.resume();
  }

  async suspend(): Promise<void> {
    await this.context?.suspend();
  }

  /** Fallback path: hand PCM straight to the worklet when there is no SAB. */
  pushSamples(samples: ArrayBuffer): void {
    this.node?.port.postMessage({ type: 'samples', samples }, [samples]);
  }

  /** Drops anything queued, e.g. after loading a save state. */
  flush(): void {
    this.node?.port.postMessage({ type: 'flush' });
  }

  async close(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.context?.close();
    this.context = null;
  }
}
