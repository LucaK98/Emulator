/**
 * Unpacking ROMs from archives.
 *
 * ROM hacks are almost always distributed packed — a .zip or .rar holding the
 * patched cartridge next to a readme and a changelog. Making the player unpack
 * that by hand on an iPhone is a poor trade, so the import does it.
 *
 * ZIP costs nothing: fflate is already here for save-state compression. RAR and
 * 7z need libarchive, which is another 600 KiB of WebAssembly, so it is fetched
 * only when someone actually picks such a file — a library of plain .gba files
 * never pays for it.
 *
 * On licensing: libarchive reads RAR through its own BSD-licensed
 * implementation, not through the UnRAR source, whose field-of-use restriction
 * would be incompatible with this project's GPL-3.0.
 */

import { unzip } from 'fflate';
import { ALL_ROM_EXTENSIONS, systemForFileName } from '../core/systems';

export type ArchiveKind = 'zip' | 'rar' | '7z';

/**
 * For the file picker. iOS decides what a share sheet offers partly from this,
 * and an archive that cannot be selected cannot be imported.
 */
export const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z'];

export interface UnpackedRom {
  /** The name of the entry inside the archive, used for title and system. */
  name: string;
  bytes: Uint8Array;
  /** Set when the archive held more than one candidate. */
  note: string | null;
}

/**
 * What kind of archive this is, read from its magic bytes.
 *
 * The extension is not consulted: files renamed by a download or a share sheet
 * are common, and the header is the thing that decides how to read it.
 */
export function archiveKind(bytes: Uint8Array): ArchiveKind | null {
  const starts = (...signature: number[]) =>
    signature.every((byte, i) => bytes[i] === byte);

  // "PK\x03\x04", plus the empty- and spanned-archive variants.
  if (starts(0x50, 0x4b) && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7)) {
    return 'zip';
  }
  // "Rar!\x1a\x07" — RAR4 ends there with 0x00, RAR5 with 0x01 0x00.
  if (starts(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'rar';
  // "7z\xbc\xaf\x27\x1c"
  if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z';
  return null;
}

/** Picks the cartridge out of an archive's file list. */
function chooseRom(
  entries: Array<{ name: string; size: number }>,
): { name: string; note: string | null } {
  // Directory entries and the metadata folders macOS adds to every zip it
  // makes are never the cartridge.
  const candidates = entries.filter(
    (entry) =>
      !entry.name.endsWith('/') &&
      !entry.name.split('/').some((part) => part === '__MACOSX') &&
      !entry.name.split('/').pop()!.startsWith('.') &&
      systemForFileName(entry.name) !== null,
  );

  if (candidates.length === 0) {
    throw new Error(
      `Im Archiv ist keine ROM (gesucht: ${ALL_ROM_EXTENSIONS.join(', ')})`,
    );
  }
  if (candidates.length === 1) return { name: candidates[0]!.name, note: null };

  // Several cartridges in one archive — a multi-language release, or a hack
  // shipped beside the ROM it patches. The largest is the least bad guess, and
  // the player is told rather than left wondering.
  const sorted = [...candidates].sort((a, b) => b.size - a.size);
  const chosen = sorted[0]!;
  return {
    name: chosen.name,
    note: `${candidates.length} ROMs im Archiv, größte gewählt (${chosen.name})`,
  };
}

/** Reads every entry of a zip into memory. */
function readZip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, files) =>
      error ? reject(new Error(`Zip nicht lesbar: ${error.message}`)) : resolve(files),
    );
  });
}

/**
 * libarchive, loaded once and kept.
 *
 * The import is dynamic so the bundler splits it into its own chunk that a
 * player who never opens a .rar never downloads.
 */
let libarchive: Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ArchiveReader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wasm: any;
}> | null = null;

function loadLibarchive(baseUrl: string) {
  libarchive ??= (async () => {
    const module = await import('libarchive-wasm');
    const wasm = await module.libarchiveWasm({
      locateFile: () => `${baseUrl}libarchive.wasm`,
    });
    return { ArchiveReader: module.ArchiveReader, wasm };
  })();
  return libarchive;
}

/** Reads a RAR or 7z through libarchive. */
async function readWithLibarchive(
  bytes: Uint8Array,
  baseUrl: string,
): Promise<Record<string, Uint8Array>> {
  const { ArchiveReader, wasm } = await loadLibarchive(baseUrl);
  const reader = new ArchiveReader(wasm, new Int8Array(bytes));
  const files: Record<string, Uint8Array> = {};
  try {
    for (const entry of reader.entries()) {
      if (entry.getFiletype() !== 'File') continue;
      const data = entry.readData();
      files[entry.getPathname()] = new Uint8Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
    }
  }
  finally {
    reader.free();
  }
  return files;
}

/**
 * Pulls the cartridge out of an archive.
 *
 * Throws with a message meant for the player when the archive holds no ROM, is
 * encrypted, or cannot be read.
 */
export async function unpackRom(
  bytes: Uint8Array,
  kind: ArchiveKind,
  baseUrl: string,
): Promise<UnpackedRom> {
  const files =
    kind === 'zip' ? await readZip(bytes) : await readWithLibarchive(bytes, baseUrl);

  const listing = Object.entries(files).map(([name, data]) => ({
    name,
    size: data.length,
  }));
  const { name, note } = chooseRom(listing);

  const data = files[name]!;
  if (data.length === 0) {
    throw new Error(`${name} im Archiv ist leer — vermutlich passwortgeschützt`);
  }
  // Only the base name matters from here: a title should not carry the folder
  // structure of whoever packed the archive.
  return { name: name.split('/').pop()!, bytes: data, note };
}
