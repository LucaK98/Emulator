/**
 * Backup and restore, as an ordinary ZIP file.
 *
 * The point of this is that the user's progress is not trapped in a browser
 * database they cannot see. A backup goes through the iOS share sheet into
 * Files, iCloud or anywhere else, and it is a plain archive: anyone can open it
 * and find their save next to a readable manifest.
 *
 * Cartridge saves and states are keyed by the ROM's hash, so a restored save
 * finds its game again even if the ROM is imported afterwards.
 */

import { unzip, zip, type Unzipped, type Zippable } from 'fflate';
import {
  AUTO_SLOT,
  MANUAL_SLOTS,
  getGame,
  getRom,
  getSave,
  getState,
  listGames,
  putState,
  saveBatteryIfChanged,
  type GameEntry,
} from './library';
import { Store, put } from './db';

const MANIFEST = 'manifest.json';
const FORMAT_VERSION = 1;

interface Manifest {
  format: number;
  createdAt: number;
  includesRoms: boolean;
  games: GameEntry[];
}

export interface BackupOptions {
  /** Cartridge images are large; saves are the part that cannot be re-made. */
  includeRoms: boolean;
}

export interface BackupSummary {
  games: number;
  saves: number;
  states: number;
  roms: number;
  bytes: number;
}

export interface RestoreSummary {
  games: number;
  saves: number;
  states: number;
  roms: number;
  /** Saves restored for games whose cartridge is not in the library. */
  waitingForRom: number;
}

/* --- Writing ------------------------------------------------------------ */

export async function createBackup(
  options: BackupOptions,
): Promise<{ blob: Blob; summary: BackupSummary }> {
  const games = await listGames();
  const files: Zippable = {};
  const summary: BackupSummary = { games: games.length, saves: 0, states: 0, roms: 0, bytes: 0 };

  for (const game of games) {
    const save = await getSave(game.id);
    if (save) {
      files[`saves/${game.id}.sav`] = new Uint8Array(save.data);
      summary.saves++;
    }

    for (const slot of [AUTO_SLOT, ...MANUAL_SLOTS]) {
      const state = await getState(game.id, slot);
      if (!state) continue;
      files[`states/${game.id}/${slot}.state`] = new Uint8Array(state.data);
      summary.states++;

      const thumbnail = dataUrlToBytes(state.thumbnail);
      if (thumbnail) files[`states/${game.id}/${slot}.png`] = thumbnail;
    }

    if (options.includeRoms) {
      const rom = await getRom(game.id);
      if (rom) {
        files[`roms/${game.id}.rom`] = new Uint8Array(rom);
        summary.roms++;
      }
    }
  }

  const manifest: Manifest = {
    format: FORMAT_VERSION,
    createdAt: Date.now(),
    includesRoms: options.includeRoms,
    games,
  };
  files[MANIFEST] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const archive = await zipAsync(files);
  summary.bytes = archive.byteLength;
  return { blob: new Blob([archive as BlobPart], { type: 'application/zip' }), summary };
}

/* --- Reading ------------------------------------------------------------ */

export async function restoreBackup(file: File): Promise<RestoreSummary> {
  const entries = await unzipAsync(new Uint8Array(await file.arrayBuffer()));

  const manifestBytes = entries[MANIFEST];
  if (!manifestBytes) throw new Error('Kein gültiges Backup: manifest.json fehlt');

  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  if (manifest.format !== FORMAT_VERSION) {
    throw new Error(`Backup-Format ${manifest.format} wird nicht unterstützt`);
  }

  const summary: RestoreSummary = { games: 0, saves: 0, states: 0, roms: 0, waitingForRom: 0 };

  // Cartridges first, so the entries that follow have something to attach to.
  for (const [path, bytes] of Object.entries(entries)) {
    const romId = path.match(/^roms\/([0-9a-f]+)\.rom$/)?.[1];
    if (!romId) continue;
    await put(Store.Roms, toArrayBuffer(bytes), romId);
    summary.roms++;
  }

  for (const game of manifest.games ?? []) {
    // A library entry without its cartridge would be a tile that cannot be
    // played; its saves are still restored and wait for the ROM.
    if (await getRom(game.id)) {
      const existing = await getGame(game.id);
      await put(Store.Games, existing ? { ...existing, ...game } : game);
      summary.games++;
    }
    else {
      summary.waitingForRom++;
    }
  }

  for (const [path, bytes] of Object.entries(entries)) {
    const saveId = path.match(/^saves\/([0-9a-f]+)\.sav$/)?.[1];
    if (saveId) {
      await saveBatteryIfChanged(saveId, toArrayBuffer(bytes));
      summary.saves++;
      continue;
    }

    const state = path.match(/^states\/([0-9a-f]+)\/([^/]+)\.state$/);
    if (state) {
      const [, id, slot] = state;
      const thumbnail = entries[`states/${id}/${slot}.png`];
      await putState(
        id!,
        slot!,
        toArrayBuffer(bytes),
        thumbnail ? bytesToDataUrl(thumbnail) : null,
      );
      summary.states++;
    }
  }

  return summary;
}

/* --- Delivering the file ------------------------------------------------ */

/**
 * Hands a file to the user.
 *
 * On iOS the share sheet is the natural route — it offers Files, iCloud and
 * everything else — so it is preferred where the browser supports sharing this
 * file. Everywhere else a download link does the job.
 */
export async function shareOrDownload(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
    catch (error) {
      // A cancelled share is not a failure; fall through to the download.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke late: Safari needs the URL alive while the download starts.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

export function backupFilename(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `emulator-backup-${stamp}.zip`;
}

/* --- Helpers ------------------------------------------------------------ */

function zipAsync(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Level 6: save states compress well and the wait is barely noticeable,
    // while stored-only archives are needlessly large.
    zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
}

function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, entries) => (error ? reject(error) : resolve(entries)));
  });
}

/** Copies out of the (possibly pooled) view fflate handed us. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function dataUrlToBytes(dataUrl: string | null): Uint8Array | null {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:image/png;base64,')) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: a single spread over a large array blows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
