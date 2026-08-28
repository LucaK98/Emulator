/**
 * Audio output for the emulator.
 *
 * Runs on the audio thread and drains the emulator's stereo ring buffer
 * directly out of the SharedArrayBuffer, so producing sound never depends on
 * the main thread being responsive. Advancing the read index also wakes the
 * emulation worker, which is parked on Atomics.wait when the ring is full —
 * that is what makes the audio device the master clock for emulation speed.
 *
 * When no SharedArrayBuffer is available the same processor consumes chunks
 * posted over the message port instead.
 *
 * Registered as a classic AudioWorklet module; constants arrive through
 * processorOptions so they stay defined in one place (src/core/protocol.ts).
 */

class EmulatorPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options.processorOptions ?? {};
    this.ringFrames = opts.ringFrames ?? 16384;
    this.channels = opts.channels ?? 2;
    this.ctlAudioRead = opts.ctlAudioRead ?? 5;
    this.ctlAudioWrite = opts.ctlAudioWrite ?? 4;

    if (opts.shared) {
      this.ctl = new Int32Array(opts.shared, opts.ctlOffset, opts.ctlSlots);
      this.ring = new Int16Array(opts.shared, opts.audioOffset, this.ringFrames * this.channels);
    } else {
      this.ctl = null;
      this.ring = null;
      // Fallback queue of Int16Array chunks posted from the main thread.
      this.queue = [];
      this.queueOffset = 0;
      this.port.onmessage = (event) => {
        if (event.data?.type === 'samples') this.queue.push(new Int16Array(event.data.samples));
        else if (event.data?.type === 'flush') { this.queue.length = 0; this.queueOffset = 0; }
      };
    }

    this.stopped = false;
    this.port.onmessageerror = () => {};
    // Holds the last emitted sample so an underrun fades rather than clicks.
    this.lastLeft = 0;
    this.lastRight = 0;
  }

  /** Reads up to `frames` stereo frames from the shared ring. */
  pullShared(left, right, frames) {
    const read = Atomics.load(this.ctl, this.ctlAudioRead);
    const write = Atomics.load(this.ctl, this.ctlAudioWrite);
    const available = (write - read + this.ringFrames) % this.ringFrames;
    const count = Math.min(frames, available);

    let position = read;
    for (let i = 0; i < count; i++) {
      const base = position * this.channels;
      left[i] = this.ring[base] / 32768;
      right[i] = this.ring[base + 1] / 32768;
      position = position + 1 === this.ringFrames ? 0 : position + 1;
    }

    if (count > 0) {
      Atomics.store(this.ctl, this.ctlAudioRead, position);
      // Wake the emulation worker if it is waiting for ring space.
      Atomics.notify(this.ctl, this.ctlAudioRead);
    }
    return count;
  }

  /** Reads up to `frames` stereo frames from the posted-chunk queue. */
  pullQueued(left, right, frames) {
    let written = 0;
    while (written < frames && this.queue.length > 0) {
      const chunk = this.queue[0];
      const chunkFrames = chunk.length / this.channels;
      const take = Math.min(frames - written, chunkFrames - this.queueOffset);
      for (let i = 0; i < take; i++) {
        const base = (this.queueOffset + i) * this.channels;
        left[written + i] = chunk[base] / 32768;
        right[written + i] = chunk[base + 1] / 32768;
      }
      written += take;
      this.queueOffset += take;
      if (this.queueOffset >= chunkFrames) {
        this.queue.shift();
        this.queueOffset = 0;
      }
    }
    return written;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return !this.stopped;

    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];
    const frames = left.length;

    const written = this.ctl
      ? this.pullShared(left, right, frames)
      : this.pullQueued(left, right, frames);

    if (written > 0) {
      this.lastLeft = left[written - 1];
      this.lastRight = right[written - 1];
    }

    // Underrun: decay towards silence instead of snapping to zero, which is
    // audible as a click on every dropped buffer.
    for (let i = written; i < frames; i++) {
      this.lastLeft *= 0.98;
      this.lastRight *= 0.98;
      left[i] = this.lastLeft;
      right[i] = this.lastRight;
    }

    return !this.stopped;
  }
}

registerProcessor('emulator-pcm', EmulatorPcmProcessor);
