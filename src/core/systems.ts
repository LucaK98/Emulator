/**
 * The consoles the emulator supports, and what differs between them.
 *
 * Screen size, button set and whether the core can hand over PPU state for the
 * depth renderer are all per-system, so everything that used to assume a Game
 * Boy takes a spec instead.
 */

export type SystemId = 'gb' | 'gba';

export type ButtonName =
  | 'Right'
  | 'Left'
  | 'Up'
  | 'Down'
  | 'A'
  | 'B'
  | 'Select'
  | 'Start'
  | 'L'
  | 'R';

/**
 * Bit positions in the shared button mask. The first eight match SameBoy's
 * GB_key_t so a Game Boy mask passes straight through; the shoulder buttons
 * are appended, and the GBA wrapper translates the whole mask to its own
 * register order.
 */
export const Button: Record<ButtonName, number> = {
  Right: 0,
  Left: 1,
  Up: 2,
  Down: 3,
  A: 4,
  B: 5,
  Select: 6,
  Start: 7,
  L: 8,
  R: 9,
};

export function bit(name: ButtonName): number {
  return 1 << Button[name];
}

export interface SystemSpec {
  id: SystemId;
  label: string;
  width: number;
  height: number;
  /** Whether the core can capture PPU state for the 2.5D renderer. */
  supportsDepth: boolean;
  /** Buttons this hardware actually has. */
  buttons: ButtonName[];
  /** File extensions accepted for this system, lower case with the dot. */
  extensions: string[];
}

const HANDHELD_BUTTONS: ButtonName[] = [
  'Right',
  'Left',
  'Up',
  'Down',
  'A',
  'B',
  'Select',
  'Start',
];

export const SYSTEMS: Record<SystemId, SystemSpec> = {
  gb: {
    id: 'gb',
    label: 'Game Boy',
    width: 160,
    height: 144,
    supportsDepth: true,
    buttons: HANDHELD_BUTTONS,
    extensions: ['.gb', '.gbc'],
  },
  gba: {
    id: 'gba',
    label: 'Game Boy Advance',
    width: 240,
    height: 160,
    // The depth renderer reads the Game Boy PPU. The GBA's four background
    // layers and affine modes need their own treatment, which is not built.
    supportsDepth: false,
    buttons: [...HANDHELD_BUTTONS, 'L', 'R'],
    extensions: ['.gba'],
  },
};

/** Picks a system from a file name, or null when the extension is unknown. */
export function systemForFileName(name: string): SystemSpec | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = name.slice(dot).toLowerCase();
  for (const spec of Object.values(SYSTEMS)) {
    if (spec.extensions.includes(extension)) return spec;
  }
  return null;
}

/** Every accepted extension, for the file picker's accept attribute. */
export const ALL_ROM_EXTENSIONS = Object.values(SYSTEMS).flatMap((s) => s.extensions);
