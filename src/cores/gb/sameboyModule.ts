/** Typed surface of the Emscripten module built by scripts/build-cores/build-sameboy.sh. */
export interface SameBoyModule {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;

  _gbw_init(model: number): void;
  _gbw_deinit(): void;
  _gbw_load_rom(ptr: number, size: number): number;
  _gbw_reset(): void;

  /** Runs one video frame; returns the stereo frame count written to the audio buffer. */
  _gbw_run_frame(): number;
  _gbw_framebuffer(): number;
  _gbw_audio_buffer(): number;
  _gbw_audio_capacity(): number;
  _gbw_screen_width(): number;
  _gbw_screen_height(): number;
  _gbw_frame_rate(): number;
  _gbw_set_sample_rate(rate: number): void;

  _gbw_set_key_mask(mask: number): void;

  _gbw_battery_size(): number;
  _gbw_save_battery(ptr: number, size: number): number;
  _gbw_load_battery(ptr: number, size: number): void;

  /** Pointers into the core's own memory; valid until the next _gbw_init. */
  _gbw_vram(): number;
  _gbw_vram_size(): number;
  _gbw_oam(): number;
  _gbw_oam_size(): number;
  _gbw_io(): number;
  _gbw_bg_palettes_rgb(): number;
  _gbw_obj_palettes_rgb(): number;
  _gbw_palette_entries(): number;
  _gbw_scanline_log(): number;
  _gbw_scanline_record_size(): number;
  _gbw_is_cgb(): number;

  _gbw_state_size(): number;
  _gbw_save_state(ptr: number): void;
  _gbw_load_state(ptr: number, size: number): number;
}

export type SameBoyFactory = () => Promise<SameBoyModule>;
