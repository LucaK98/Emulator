/**
 * Keeping an explored world between sessions.
 *
 * The depth view draws the ground from what the player has already walked
 * through, because the console holds barely more map than it shows. That
 * exploration is worth keeping: without this, every launch starts blind again
 * and the wide view has to be earned from scratch.
 *
 * Stored per game beside the save states, and compressed — the buffer is
 * mostly untouched cells, which deflate to a fraction of their size.
 */

import { deflate, inflate } from 'fflate';
import { Store, get, put, remove } from './db';
import type { WorldSnapshot } from '../render/worldMemory';

/** What actually goes into the database. */
interface StoredWorldMap {
  version: number;
  savedAt: number;
  /** How many layers the cells below are split into. */
  layerCount: number;
  /** Origin and scroll per layer, four numbers each, in layer order. */
  anchors: number[];
  fingerprintLength: number;
  /** Fingerprint and every layer's cells, deflated together. */
  data: ArrayBuffer;
}

export async function saveWorldMap(gameId: string, snapshot: WorldSnapshot): Promise<void> {
  const cellBytes = snapshot.layers.reduce((sum, l) => sum + l.cells.byteLength, 0);
  const raw = new Uint8Array(snapshot.fingerprint.length + cellBytes);
  raw.set(snapshot.fingerprint, 0);

  let offset = snapshot.fingerprint.length;
  for (const layer of snapshot.layers) {
    raw.set(new Uint8Array(layer.cells.buffer, layer.cells.byteOffset, layer.cells.byteLength), offset);
    offset += layer.cells.byteLength;
  }

  const packed = await deflateAsync(raw);
  const record: StoredWorldMap = {
    version: snapshot.version,
    savedAt: Date.now(),
    layerCount: snapshot.layers.length,
    anchors: snapshot.layers.flatMap((l) => [l.originX, l.originY, l.lastScrollX, l.lastScrollY]),
    fingerprintLength: snapshot.fingerprint.length,
    data: packed.buffer.slice(
      packed.byteOffset,
      packed.byteOffset + packed.byteLength,
    ) as ArrayBuffer,
  };
  await put(Store.WorldMaps, record, gameId);
}

export async function loadWorldMap(gameId: string): Promise<WorldSnapshot | null> {
  const record = await get<StoredWorldMap>(Store.WorldMaps, gameId);
  if (!record) return null;

  const raw = await inflateAsync(new Uint8Array(record.data));
  const fingerprint = raw.slice(0, record.fingerprintLength);

  const cellsPerLayer = (raw.length - record.fingerprintLength) / record.layerCount;
  // A stored map whose shape does not divide evenly is not one this build
  // wrote; ignoring it costs an exploration, keeping it would draw nonsense.
  if (!Number.isInteger(cellsPerLayer) || cellsPerLayer % 4 !== 0) return null;

  const layers: WorldSnapshot['layers'] = [];
  for (let index = 0; index < record.layerCount; index++) {
    const start = record.fingerprintLength + index * cellsPerLayer;
    const bytes = raw.slice(start, start + cellsPerLayer);
    layers.push({
      cells: new Uint32Array(bytes.buffer, bytes.byteOffset, cellsPerLayer / 4),
      originX: record.anchors[index * 4] ?? 0,
      originY: record.anchors[index * 4 + 1] ?? 0,
      lastScrollX: record.anchors[index * 4 + 2] ?? 0,
      lastScrollY: record.anchors[index * 4 + 3] ?? 0,
    });
  }

  return { version: record.version, fingerprint, layers };
}

export function deleteWorldMap(gameId: string): Promise<void> {
  return remove(Store.WorldMaps, gameId);
}

function deflateAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    deflate(bytes, { level: 6 }, (error, data) =>
      error ? reject(error) : resolve(data),
    );
  });
}

function inflateAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    inflate(bytes, (error, data) => (error ? reject(error) : resolve(data)));
  });
}
