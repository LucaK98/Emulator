/**
 * Display preferences that apply to every game, kept in local storage.
 *
 * Deliberately per-device rather than per-game: how much an LCD grid helps
 * depends on the screen it is drawn on, not on what is being played.
 */

const KEY = 'display-settings';

export interface DisplaySettings {
  /** LCD grid strength, 0 to 1; 0 disables it. */
  lcdGrid: number;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { lcdGrid: 0 };

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
