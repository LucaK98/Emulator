/** Typed surface of the Emscripten module built by scripts/build-cores/build-mgba.sh. */
export interface MgbaModule {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;

  _gbaw_init(model: number): void;
  _gbaw_deinit(): void;
  _gbaw_load_rom(ptr: number, size: number): number;
  _gbaw_reset(): void;

  /** Runs one video frame; returns the stereo frame count written to the audio buffer. */
  _gbaw_run_frame(): number;
  _gbaw_framebuffer(): number;
  _gbaw_audio_buffer(): number;
  _gbaw_audio_capacity(): number;
  _gbaw_screen_width(): number;
  _gbaw_screen_height(): number;
  _gbaw_frame_rate(): number;
  _gbaw_set_sample_rate(rate: number): void;

  _gbaw_set_key_mask(mask: number): void;

  _gbaw_battery_size(): number;
  _gbaw_save_battery(ptr: number, size: number): number;
  _gbaw_load_battery(ptr: number, size: number): void;
  /** Detected save type; -1 until the game first touches its save memory. */
  _gbaw_savedata_type(): number;

  /* PPU state for the 2.5D renderer; pointers into the core's own memory. */
  _gbaw_vram(): number;
  _gbaw_palette(): number;
  _gbaw_oam(): number;
  _gbaw_io(): number;
  _gbaw_scanline_log(): number;

  _gbaw_state_size(): number;
  _gbaw_save_state(ptr: number, size: number): number;
  _gbaw_load_state(ptr: number, size: number): number;
}

export type MgbaFactory = () => Promise<MgbaModule>;
