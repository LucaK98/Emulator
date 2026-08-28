/** Typed surface of the Emscripten module built by scripts/build-cores/build-melonds.sh. */
export interface MelonDsModule {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;

  _ndsw_init(model: number): void;
  _ndsw_deinit(): void;
  _ndsw_load_rom(ptr: number, size: number): number;
  _ndsw_reset(): void;

  _ndsw_run_frame(): number;
  _ndsw_framebuffer(): number;
  _ndsw_audio_buffer(): number;
  _ndsw_audio_capacity(): number;
  _ndsw_screen_width(): number;
  _ndsw_screen_height(): number;
  /** 0 = stacked, 1 = side by side. */
  _ndsw_set_layout(layout: number): void;
  _ndsw_frame_rate(): number;
  _ndsw_set_sample_rate(rate: number): void;

  _ndsw_set_key_mask(mask: number): void;
  /** Coordinates within the lower screen, 0..255 by 0..191. */
  _ndsw_touch(x: number, y: number): void;
  _ndsw_release_touch(): void;

  _ndsw_battery_size(): number;
  _ndsw_save_battery(ptr: number, size: number): number;
  _ndsw_load_battery(ptr: number, size: number): void;

  _ndsw_state_size(): number;
  _ndsw_save_state(ptr: number, size: number): number;
  _ndsw_load_state(ptr: number, size: number): number;
}

export type MelonDsFactory = () => Promise<MelonDsModule>;
