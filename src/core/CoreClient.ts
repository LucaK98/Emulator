/**
 * Main-thread handle for a running emulator core.
 *
 * Owns the worker, the shared buffer, the audio graph and the render loop, and
 * exposes a small imperative API to the UI. Everything that can be zero-copy is
 * zero-copy: with a SharedArrayBuffer the render loop reads pixels the worker
 * wrote in place, and audio never touches this thread at all.
 */

import { AudioOutput } from '../audio/AudioOutput';
import type { SceneRenderer } from '../render/SceneRenderer';
import {
  Ctl,
  FRAME_PIXELS,
  createSharedBuffer,
  viewShared,
  type FromWorker,
  type SharedViews,
  type ToWorker,
} from './protocol';

export interface CoreClientOptions {
  baseUrl: string;
  /** Called when the worker reports a fatal problem. */
  onError?: (message: string) => void;
  /** Called with frames-per-second roughly once a second. */
  onFps?: (fps: number) => void;
}

export interface LoadOptions {
  rom: ArrayBuffer;
  model: number;
  battery: ArrayBuffer | null;
}

export class CoreClient {
  private worker: Worker;
  private shared: SharedArrayBuffer | null = null;
  private views: SharedViews | null = null;
  private audio = new AudioOutput();
  private renderer: SceneRenderer | null = null;

  private rafHandle = 0;
  private lastSeq = -1;
  private fallbackFrame: Uint32Array | null = null;

  private pending = new Map<number, (value: ArrayBuffer | null) => void>();
  private pendingStateLoad = new Map<number, (ok: boolean) => void>();
  private nextToken = 1;

  private readyPromise: Promise<boolean>;
  private loadedResolvers: Array<(rate: number) => void> = [];

  /** True when the zero-copy path is in use. */
  usingShared = false;
  frameRate = 59.727;

  constructor(private readonly options: CoreClientOptions) {
    this.worker = new Worker(new URL('../cores/gb/gbWorker.ts', import.meta.url), {
      type: 'module',
      name: 'gb-core',
    });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(event.data);

    this.readyPromise = new Promise<boolean>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  private resolveReady: (usingShared: boolean) => void = () => {};

  /** Boots the worker, the core module and the audio graph. */
  async init(): Promise<void> {
    // SharedArrayBuffer only exists when the document is cross-origin isolated.
    if (typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated) {
      this.shared = createSharedBuffer();
      this.views = viewShared(this.shared);
    }

    await this.audio.init(this.shared, this.options.baseUrl);

    this.send({
      type: 'init',
      shared: this.shared,
      coreUrl: `${this.options.baseUrl}cores/sameboy.js`,
      sampleRate: this.audio.sampleRate,
    });

    this.usingShared = await this.readyPromise;
  }

  /**
   * Installs the renderer and tells the worker whether it needs PPU state.
   * Capturing costs ~18 KiB a frame, so it stays off for the flat renderer.
   */
  attachRenderer(renderer: SceneRenderer | null): void {
    this.renderer = renderer;
    this.setPpuCapture(renderer?.needsPpuState ?? false);
  }

  private setPpuCapture(enabled: boolean): void {
    if (this.views) Atomics.store(this.views.ctl, Ctl.CAPTURE_PPU, enabled ? 1 : 0);
  }

  async load(options: LoadOptions): Promise<void> {
    const done = new Promise<number>((resolve) => this.loadedResolvers.push(resolve));
    this.send({ type: 'load', ...options }, [options.rom]);
    this.frameRate = await done;
  }

  /** Starts emulation and audio. Must be called from a user gesture on iOS. */
  async start(): Promise<void> {
    await this.tryResumeAudio();
    this.send({ type: 'start' });
    this.startRenderLoop();
  }

  /**
   * Audio must never gate emulation: a device with no output, a rejected
   * autoplay policy or a headless browser would otherwise leave the player
   * staring at a frozen screen. The worker detects the stalled ring and paces
   * itself on the clock instead.
   */
  private async tryResumeAudio(): Promise<void> {
    try {
      await this.audio.resume();
    }
    catch {
      // Silent play is still play.
    }
  }

  async pause(): Promise<void> {
    this.send({ type: 'pause' });
    this.stopRenderLoop();
    await this.audio.suspend();
  }

  async resume(): Promise<void> {
    await this.tryResumeAudio();
    this.send({ type: 'resume' });
    this.startRenderLoop();
  }

  reset(): void {
    this.send({ type: 'reset' });
  }

  setSpeed(percent: number): void {
    this.send({ type: 'setSpeed', percent });
  }

  /** Publishes the current button state. Cheap enough to call per input event. */
  setKeys(mask: number): void {
    if (this.views) Atomics.store(this.views.ctl, Ctl.KEY_MASK, mask);
    else this.send({ type: 'setKeys', mask });
  }

  readBattery(): Promise<ArrayBuffer | null> {
    return this.request((token) => ({ type: 'requestBattery', token }));
  }

  readState(): Promise<ArrayBuffer | null> {
    return this.request((token) => ({ type: 'requestState', token }));
  }

  loadState(data: ArrayBuffer): Promise<boolean> {
    const token = this.nextToken++;
    const done = new Promise<boolean>((resolve) => this.pendingStateLoad.set(token, resolve));
    this.send({ type: 'loadState', data, token }, [data]);
    this.audio.flush();
    return done;
  }

  /** Current frame as RGBA bytes, for save-state thumbnails and screenshots. */
  currentFrame(): Uint32Array | null {
    if (this.views) {
      const slot = Atomics.load(this.views.ctl, Ctl.FRAME_SLOT);
      return this.views.frames[slot] ?? null;
    }
    return this.fallbackFrame;
  }

  async destroy(): Promise<void> {
    this.stopRenderLoop();
    this.send({ type: 'stop' });
    await this.audio.close();
    this.worker.terminate();
  }

  /* --- internals -------------------------------------------------------- */

  private request(build: (token: number) => ToWorker): Promise<ArrayBuffer | null> {
    const token = this.nextToken++;
    const done = new Promise<ArrayBuffer | null>((resolve) => this.pending.set(token, resolve));
    this.send(build(token));
    return done;
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private onMessage(message: FromWorker): void {
    switch (message.type) {
      case 'ready':
        this.resolveReady(message.usingShared);
        break;

      case 'loaded':
        for (const resolve of this.loadedResolvers.splice(0)) resolve(message.frameRate);
        break;

      case 'frame':
        // Fallback path only; with shared memory the render loop polls instead.
        this.fallbackFrame = new Uint32Array(message.pixels);
        break;

      case 'audio':
        this.audio.pushSamples(message.samples);
        break;

      case 'battery':
      case 'state': {
        const resolve = this.pending.get(message.token);
        this.pending.delete(message.token);
        resolve?.(message.data);
        break;
      }

      case 'stateLoaded': {
        const resolve = this.pendingStateLoad.get(message.token);
        this.pendingStateLoad.delete(message.token);
        resolve?.(message.ok);
        break;
      }

      case 'error':
        this.options.onError?.(message.message);
        break;
    }
  }

  private startRenderLoop(): void {
    if (this.rafHandle) return;

    let framesDrawn = 0;
    let lastReport = performance.now();

    const tick = () => {
      this.rafHandle = requestAnimationFrame(tick);

      const frame = this.nextFrame();
      if (frame && this.renderer) {
        this.renderer.resize(window.devicePixelRatio || 1);
        this.renderer.render(frame.pixels, frame.ppu);
        framesDrawn++;
      }

      const now = performance.now();
      if (now - lastReport >= 1000) {
        this.options.onFps?.((framesDrawn * 1000) / (now - lastReport));
        framesDrawn = 0;
        lastReport = now;
      }
    };

    this.rafHandle = requestAnimationFrame(tick);
  }

  /** Returns the newest completed frame, or null if nothing new arrived. */
  private nextFrame(): { pixels: Uint32Array; ppu: Uint8Array | null } | null {
    if (this.views) {
      const seq = Atomics.load(this.views.ctl, Ctl.FRAME_SEQ);
      if (seq === this.lastSeq) return null;
      this.lastSeq = seq;
      const slot = Atomics.load(this.views.ctl, Ctl.FRAME_SLOT);
      const pixels = this.views.frames[slot];
      if (!pixels || pixels.length !== FRAME_PIXELS) return null;
      const ppu = this.renderer?.needsPpuState ? (this.views.ppu[slot] ?? null) : null;
      return { pixels, ppu };
    }

    const pixels = this.fallbackFrame;
    this.fallbackFrame = null;
    // Without shared memory there is no PPU capture, so only the flat renderer
    // works; the player keeps depth mode disabled in that case.
    return pixels ? { pixels, ppu: null } : null;
  }

  private stopRenderLoop(): void {
    if (!this.rafHandle) return;
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }
}
