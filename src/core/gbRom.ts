/**
 * Game Boy cartridge header parsing.
 *
 * Enough of the header to pick a hardware model, name the entry in the library
 * and know whether the cartridge has battery-backed RAM worth persisting.
 * Layout per the Pan Docs cartridge header.
 */

/** SameBoy GB_model_t values we target. */
export const GbModel = {
  DMG_B: 0x002,
  CGB_E: 0x205,
} as const;

export interface GbRomInfo {
  /** Cleaned-up title from the header, or a fallback. */
  title: string;
  /** True when the cartridge declares Game Boy Color support. */
  colorCapable: boolean;
  /** True when the cartridge runs *only* on Game Boy Color hardware. */
  colorOnly: boolean;
  /** Raw cartridge type byte at 0x147. */
  cartridgeType: number;
  /** Battery-backed cartridge RAM, i.e. the game can save on its own. */
  hasBattery: boolean;
  /** The SameBoy model to emulate this cartridge on. */
  model: number;
  /** True when the header checksum matches; a mismatch usually means a bad dump. */
  headerChecksumValid: boolean;
}

const TITLE_START = 0x134;
const TITLE_END = 0x143; // exclusive; 0x143 is the CGB flag
const CGB_FLAG = 0x143;
const CARTRIDGE_TYPE = 0x147;
const HEADER_CHECKSUM = 0x14d;

/** Cartridge types that include a battery, per the Pan Docs table. */
const BATTERY_TYPES = new Set([
  0x03, 0x06, 0x09, 0x0d, 0x0f, 0x10, 0x13, 0x1b, 0x1e, 0x22, 0xff,
]);

export function isLikelyGameBoyRom(bytes: Uint8Array): boolean {
  // Every cartridge is at least 32 KiB and a whole number of banks.
  return bytes.length >= 0x8000 && bytes.length % 0x4000 === 0;
}

export function parseGbRom(bytes: Uint8Array, fallbackTitle: string): GbRomInfo {
  const cgbFlag = bytes[CGB_FLAG] ?? 0;
  const colorCapable = cgbFlag === 0x80 || cgbFlag === 0xc0;
  const colorOnly = cgbFlag === 0xc0;

  // The CGB flag occupies the last title byte, so colour cartridges have a
  // shorter title field.
  const titleEnd = colorCapable ? TITLE_END - 4 : TITLE_END;
  let title = '';
  for (let i = TITLE_START; i < titleEnd; i++) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) break;
    // Headers are ASCII; anything else means we are reading past the title.
    if (byte < 0x20 || byte > 0x7e) break;
    title += String.fromCharCode(byte);
  }
  title = title.trim();

  const cartridgeType = bytes[CARTRIDGE_TYPE] ?? 0;

  return {
    title: title || fallbackTitle,
    colorCapable,
    colorOnly,
    cartridgeType,
    hasBattery: BATTERY_TYPES.has(cartridgeType),
    model: colorCapable ? GbModel.CGB_E : GbModel.DMG_B,
    headerChecksumValid: headerChecksum(bytes) === (bytes[HEADER_CHECKSUM] ?? -1),
  };
}

/** The 0x134..0x14C checksum the boot ROM verifies before starting the game. */
export function headerChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) {
    sum = (sum - (bytes[i] ?? 0) - 1) & 0xff;
  }
  return sum;
}

/** Stable identity for a dump, used as the library and save-file key. */
export async function romId(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes); // detach from any SAB-backed view
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
