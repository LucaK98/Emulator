/**
 * Game Boy Advance cartridge header parsing.
 *
 * Only what the library needs: a title, and enough of a sanity check to reject
 * a file that is not a cartridge image. Layout per the GBA cartridge header.
 */

const TITLE_START = 0xa0;
const TITLE_LENGTH = 12;
const GAME_CODE_START = 0xac;
const GAME_CODE_LENGTH = 4;
/** Fixed byte every licensed cartridge carries. */
const FIXED_VALUE_OFFSET = 0xb2;
const FIXED_VALUE = 0x96;
const HEADER_BYTES = 0xc0;

export interface GbaRomInfo {
  title: string;
  /** Four-character game code, e.g. "BPRD" for the German FireRed. */
  gameCode: string;
  /** True when the fixed header byte matches; a mismatch means a bad dump. */
  headerValid: boolean;
}

export function isLikelyGbaRom(bytes: Uint8Array): boolean {
  // Smallest sensible cartridge is far larger than the header itself.
  return bytes.length > HEADER_BYTES && bytes[FIXED_VALUE_OFFSET] === FIXED_VALUE;
}

export function parseGbaRom(bytes: Uint8Array, fallbackTitle: string): GbaRomInfo {
  return {
    title: readAscii(bytes, TITLE_START, TITLE_LENGTH) || fallbackTitle,
    gameCode: readAscii(bytes, GAME_CODE_START, GAME_CODE_LENGTH),
    headerValid: bytes[FIXED_VALUE_OFFSET] === FIXED_VALUE,
  };
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let text = '';
  for (let i = start; i < start + length; i++) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) break;
    if (byte < 0x20 || byte > 0x7e) break;
    text += String.fromCharCode(byte);
  }
  return text.trim();
}
