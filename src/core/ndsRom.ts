/**
 * Nintendo DS cartridge header parsing.
 *
 * Only what the library needs: a title and a sanity check. Layout per GBATEK's
 * cartridge header description.
 */

const TITLE_LENGTH = 12;
const GAME_CODE_START = 0x0c;
const GAME_CODE_LENGTH = 4;
const ARM9_ROM_OFFSET = 0x20;
const ARM9_SIZE = 0x2c;
const HEADER_BYTES = 0x200;

export interface NdsRomInfo {
  title: string;
  gameCode: string;
  headerValid: boolean;
}

export function isLikelyNdsRom(bytes: Uint8Array): boolean {
  if (bytes.length <= HEADER_BYTES) return false;

  // The ARM9 binary must sit inside the file and be non-empty; that rules out
  // anything that merely happens to carry a .nds name.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(ARM9_ROM_OFFSET, true);
  const size = view.getUint32(ARM9_SIZE, true);
  return size > 0 && offset >= HEADER_BYTES && offset + size <= bytes.length;
}

export function parseNdsRom(bytes: Uint8Array, fallbackTitle: string): NdsRomInfo {
  return {
    title: readAscii(bytes, 0, TITLE_LENGTH) || fallbackTitle,
    gameCode: readAscii(bytes, GAME_CODE_START, GAME_CODE_LENGTH),
    headerValid: isLikelyNdsRom(bytes),
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
