/**
 * Display preferences that apply to every game, kept in local storage.
 *
 * Deliberately per-device rather than per-game: how much an LCD grid helps
 * depends on the screen it is drawn on, not on what is being played.
 */

const KEY = 'display-settings';

/**
 * How the picture is scaled up to the screen.
 *
 * 'hart' is nearest neighbour: every emulated pixel is a hard block. Where the
 * scale is a whole number that is exactly right, and it is what the console
 * itself looks like. Where it is not — the DS fills a phone at about 4.6
 * device pixels per emulated one — some rows come out a pixel thicker than
 * their neighbours, and the unevenness crawls as the picture scrolls.
 *
 * 'weich' blends across one output pixel at each boundary and leaves the
 * insides of the blocks exactly as they were, so the edges stop stair-stepping
 * without the picture turning to mush.
 */
export type PictureFilter = 'hart' | 'weich';

export interface DisplaySettings {
  /** LCD grid strength, 0 to 1; 0 disables it. */
  lcdGrid: number;
  filter: PictureFilter;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { lcdGrid: 0, filter: 'hart' };

export function loadDisplaySettings(): DisplaySettings {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return { ...DEFAULT_DISPLAY_SETTINGS, ...JSON.parse(stored) };
  }
  catch {
    // Unreadable or blocked storage simply means the defaults.
  }
  return { ...DEFAULT_DISPLAY_SETTINGS };
}

export function saveDisplaySettings(settings: DisplaySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }
  catch {
    // Not worth interrupting anything over.
  }
}
