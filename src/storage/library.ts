/**
 * The game library: metadata, cartridge images, battery saves and save states.
 *
 * Battery RAM is written back only when it actually changed. The core gives us
 * no write hook, so the player polls it on an interval and on page hide; a
 * cheap checksum decides whether the write is worth doing. That keeps a
 * 128 KiB save out of IndexedDB sixty times a minute while still surviving the
 * tab being killed.
 */

import { isLikelyGameBoyRom, parseGbRom, romId } from '../core/gbRom';
import { isLikelyGbaRom, parseGbaRom } from '../core/gbaRom';
import { systemForFileName, type SystemId } from '../core/systems';
import { Store, get, getAll, put, remove } from './db';

export interface GameEntry {
  id: string;
  title: string;
  system: SystemId;
  /** Core-specific hardware model; only the Game Boy core distinguishes any. */
  model: number;
  size: number;
  hasBattery: boolean;
  colorCapable: boolean;
  addedAt: number;
  lastPlayedAt: number | null;
  /** data: URL of the last auto-save-state frame, used as the library tile. */
  thumbnail: string | null;
  /** Whether this game was last played with the 2.5D renderer. */
  depth3d?: boolean;
}

export interface SaveRecord {
  data: ArrayBuffer;
  checksum: number;
  updatedAt: number;
}

export interface StateRecord {
  data: ArrayBuffer;
  thumbnail: string | null;
  createdAt: number;
}

/** Slot name for the state written automatically when the app is backgrounded. */
export const AUTO_SLOT = 'auto';

export async function listGames(): Promise<GameEntry[]> {
  const games = await getAll<GameEntry>(Store.Games);
  return games.sort((a, b) => (b.lastPlayedAt ?? b.addedAt) - (a.lastPlayedAt ?? a.addedAt));
}

export function getGame(id: string): Promise<GameEntry | undefined> {
  return get<GameEntry>(Store.Games, id);
}

export function getRom(id: string): Promise<ArrayBuffer | undefined> {
  return get<ArrayBuffer>(Store.Roms, id);
}

/**
 * Adds a cartridge image to the library, or returns the existing entry when the
 * same dump was imported before. Importing the same game twice must not orphan
 * its saves, which is why the ROM hash is the identity.
 */
export async function importRom(
  file: File,
): Promise<{ entry: GameEntry; alreadyPresent: boolean; warning: string | null }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const spec = systemForFileName(file.name);
  if (!spec) {
    throw new Error('Unbekannte Dateiendung (erwartet .gb, .gbc oder .gba)');
  }

  const fallbackTitle = file.name.replace(/\.[^.]+$/, '');
  const id = await romId(bytes);
  const existing = await getGame(id);
  if (existing) return { entry: existing, alreadyPresent: true, warning: null };

  const draft = spec.id === 'gba' ? describeGba(bytes, fallbackTitle) : describeGb(bytes, fallbackTitle);

  const entry: GameEntry = {
    id,
    system: spec.id,
    size: buffer.byteLength,
    addedAt: Date.now(),
    lastPlayedAt: null,
    thumbnail: null,
    ...draft.entry,
  };

  await put(Store.Roms, buffer, id);
  await put(Store.Games, entry);
  return { entry, alreadyPresent: false, warning: draft.warning };
}

type RomDraft = {
  entry: Pick<GameEntry, 'title' | 'model' | 'hasBattery' | 'colorCapable'>;
  warning: string | null;
};

function describeGb(bytes: Uint8Array, fallbackTitle: string): RomDraft {
  if (!isLikelyGameBoyRom(bytes)) {
    throw new Error('Keine Game-Boy-ROM (erwartet mindestens 32 KB in ganzen Bänken)');
  }
  const info = parseGbRom(bytes, fallbackTitle);
  return {
    entry: {
      title: info.title,
      model: info.model,
      hasBattery: info.hasBattery,
      colorCapable: info.colorCapable,
    },
    warning: info.headerChecksumValid ? null : 'Prüfsumme stimmt nicht, evtl. defekter Dump',
  };
}

function describeGba(bytes: Uint8Array, fallbackTitle: string): RomDraft {
  if (!isLikelyGbaRom(bytes)) {
    throw new Error('Keine Game-Boy-Advance-ROM (Kopfkennung fehlt)');
  }
  const info = parseGbaRom(bytes, fallbackTitle);
  return {
    entry: {
      title: info.title,
      model: 0,
      // The save type is only detected once a game first writes to its save
      // memory, so the player always polls; reads return nothing until then.
      hasBattery: true,
      colorCapable: true,
    },
    warning: null,
  };
}

export async function updateGame(id: string, patch: Partial<GameEntry>): Promise<void> {
  const entry = await getGame(id);
  if (!entry) return;
  await put(Store.Games, { ...entry, ...patch });
}

export async function deleteGame(id: string): Promise<void> {
  await remove(Store.Games, id);
  await remove(Store.Roms, id);
  await remove(Store.Saves, id);
  await remove(Store.States, stateKey(id, AUTO_SLOT));
  for (let slot = 1; slot <= 8; slot++) {
    await remove(Store.States, stateKey(id, String(slot)));
  }
}

/* --- Battery saves ------------------------------------------------------ */

export function getSave(id: string): Promise<SaveRecord | undefined> {
  return get<SaveRecord>(Store.Saves, id);
}

/**
 * Writes cartridge RAM only when it differs from what is already stored.
 * Returns true when a write happened.
 */
export async function saveBatteryIfChanged(id: string, data: ArrayBuffer): Promise<boolean> {
  const checksum = fletcher32(new Uint8Array(data));
  const existing = await getSave(id);
  if (existing && existing.checksum === checksum && existing.data.byteLength === data.byteLength) {
    return false;
  }
  const record: SaveRecord = { data, checksum, updatedAt: Date.now() };
  await put(Store.Saves, record, id);
  return true;
}

/* --- Save states -------------------------------------------------------- */

export function stateKey(id: string, slot: string): string {
  return `${id}:${slot}`;
}

export function getState(id: string, slot: string): Promise<StateRecord | undefined> {
  return get<StateRecord>(Store.States, stateKey(id, slot));
}

export async function putState(
  id: string,
  slot: string,
  data: ArrayBuffer,
  thumbnail: string | null,
): Promise<void> {
  const record: StateRecord = { data, thumbnail, createdAt: Date.now() };
  await put(Store.States, record, stateKey(id, slot));
}

export function deleteState(id: string, slot: string): Promise<undefined> {
  return remove(Store.States, stateKey(id, slot));
}

/**
 * Fletcher-32: strong enough to notice a changed save, and fast enough to run
 * over 128 KiB every couple of seconds without showing up in a profile.
 */
export function fletcher32(bytes: Uint8Array): number {
  let sum1 = 0xffff;
  let sum2 = 0xffff;
  let i = 0;
  const words = bytes.length >> 1;

  let remaining = words;
  while (remaining > 0) {
    // Defer the modulo: 359 words is the most that can accumulate safely.
    let block = Math.min(359, remaining);
    remaining -= block;
    while (block-- > 0) {
      sum1 += (bytes[i]! | (bytes[i + 1]! << 8)) >>> 0;
      sum2 += sum1;
      i += 2;
    }
    sum1 = (sum1 & 0xffff) + (sum1 >>> 16);
    sum2 = (sum2 & 0xffff) + (sum2 >>> 16);
  }

  if (bytes.length & 1) {
    sum1 += bytes[bytes.length - 1]!;
    sum2 += sum1;
    sum1 = (sum1 & 0xffff) + (sum1 >>> 16);
    sum2 = (sum2 & 0xffff) + (sum2 >>> 16);
  }

  return (((sum2 & 0xffff) << 16) | (sum1 & 0xffff)) >>> 0;
}
