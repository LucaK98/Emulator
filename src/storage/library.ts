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
import { isLikelyNdsRom, parseNdsRom } from '../core/ndsRom';
import { systemForFileName, type SystemId } from '../core/systems';
import { deflate, inflate } from 'fflate';
import { archiveKind, unpackRom } from './archive';
import { Store, get, getAll, getAllKeys, put, remove } from './db';

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
  /**
   * Whether `data` is deflated. A Nintendo DS state is around 19 MB raw and
   * mostly zeroes; storing nine of those per game would fill the quota for no
   * reason. Absent on records written before compression existed, which is why
   * it is optional rather than assumed.
   */
  compressed?: boolean;
}

/** Slot name for the state written automatically when the app is backgrounded. */
export const AUTO_SLOT = 'auto';

/** Manual slots, numbered as the user sees them. */
export const MANUAL_SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

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
  baseUrl = '/',
): Promise<{ entry: GameEntry; alreadyPresent: boolean; warning: string | null }> {
  let buffer = await file.arrayBuffer();
  let bytes: Uint8Array = new Uint8Array(buffer);
  let name = file.name;
  let unpackNote: string | null = null;

  // A packed download is unpacked here rather than by the player: ROM hacks
  // are nearly always distributed as an archive, and unpacking one by hand on
  // a phone is a chore.
  const kind = archiveKind(bytes);
  if (kind) {
    const unpacked = await unpackRom(bytes, kind, baseUrl);
    bytes = unpacked.bytes;
    // A fresh copy: the unpacked view may sit inside a larger buffer, and what
    // gets stored has to be the cartridge and nothing else.
    buffer = bytes.slice().buffer as ArrayBuffer;
    name = unpacked.name;
    unpackNote = unpacked.note;
  }

  const spec = systemForFileName(name);
  if (!spec) {
    throw new Error('Unbekannte Dateiendung (erwartet .gb, .gbc, .gba oder .nds)');
  }

  const fallbackTitle = name.replace(/\.[^.]+$/, '');
  const id = await romId(bytes);
  const existing = await getGame(id);
  if (existing) return { entry: existing, alreadyPresent: true, warning: null };

  const describe = { gb: describeGb, gba: describeGba, nds: describeNds }[spec.id];
  const draft = describe(bytes, fallbackTitle);

  const entry: GameEntry = {
    id,
    system: spec.id,
    size: bytes.byteLength,
    addedAt: Date.now(),
    lastPlayedAt: null,
    thumbnail: null,
    ...draft.entry,
  };

  await put(Store.Roms, buffer, id);
  await put(Store.Games, entry);
  const warning = [unpackNote, draft.warning].filter(Boolean).join(' · ') || null;
  return { entry, alreadyPresent: false, warning };
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

function describeNds(bytes: Uint8Array, fallbackTitle: string): RomDraft {
  if (!isLikelyNdsRom(bytes)) {
    throw new Error('Keine Nintendo-DS-ROM (Kopfdaten unplausibel)');
  }
  const info = parseNdsRom(bytes, fallbackTitle);
  return {
    entry: {
      title: info.title,
      model: 0,
      // The save type is detected from the cartridge once it is loaded; the
      // player polls and simply gets nothing back until then.
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

/** Reads a state back, expanding it if it was stored compressed. */
export async function getState(id: string, slot: string): Promise<StateRecord | undefined> {
  const record = await get<StateRecord>(Store.States, stateKey(id, slot));
  if (!record || !record.compressed) return record;

  const expanded = await inflateAsync(new Uint8Array(record.data));
  return { ...record, data: expanded.buffer as ArrayBuffer, compressed: false };
}

export async function putState(
  id: string,
  slot: string,
  data: ArrayBuffer,
  thumbnail: string | null,
): Promise<void> {
  // Level 1: emulator states are long runs of zeroes, which even the fastest
  // setting collapses, and a save should not make the game stutter.
  const compressed = await deflateAsync(new Uint8Array(data));
  const record: StateRecord = {
    data: compressed.buffer as ArrayBuffer,
    thumbnail,
    createdAt: Date.now(),
    compressed: true,
  };
  await put(Store.States, record, stateKey(id, slot));
}

function deflateAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    deflate(bytes, { level: 1 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
}

function inflateAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    inflate(bytes, (error, data) => (error ? reject(error) : resolve(data)));
  });
}

export function deleteState(id: string, slot: string): Promise<undefined> {
  return remove(Store.States, stateKey(id, slot));
}

export interface SlotSummary {
  slot: string;
  /** Null when the slot is empty. */
  createdAt: number | null;
  thumbnail: string | null;
  bytes: number;
}

/**
 * Everything the slot picker needs, without loading the states themselves —
 * a Game Boy Advance state is half a megabyte, and there can be nine of them.
 */
export async function listSlots(id: string): Promise<SlotSummary[]> {
  const slots = [AUTO_SLOT, ...MANUAL_SLOTS];
  const records = await Promise.all(slots.map((slot) => getState(id, slot)));

  return slots.map((slot, index) => {
    const record = records[index];
    return {
      slot,
      createdAt: record?.createdAt ?? null,
      thumbnail: record?.thumbnail ?? null,
      bytes: record?.data.byteLength ?? 0,
    };
  });
}

/** Every stored state key, for the backup writer. */
export function listAllStateKeys(): Promise<IDBValidKey[]> {
  return getAllKeys(Store.States);
}

/**
 * Fletcher-32: strong enough to notice a changed save, and fast enough to run
 * over 128 KiB every couple of seconds without showing up in a profile.
 *
 * Note that it cannot distinguish runs of zeroes of different lengths — a known
 * property of Fletcher sums — which is why saveBatteryIfChanged compares the
 * byte length as well and never relies on the checksum alone.
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
