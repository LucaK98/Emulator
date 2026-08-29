/**
 * Persistent storage, built on IndexedDB.
 *
 * IndexedDB rather than OPFS: OPFS on Safari only gained a main-thread writable
 * stream in a recent release and its worker-only sync handles would force the
 * save path through another worker for no real gain at these sizes. IndexedDB
 * is available on every iOS version we care about, stores multi-megabyte
 * ArrayBuffers happily, and is covered by the same storage-persistence grant.
 */

const DB_NAME = 'emulator';
const DB_VERSION = 2;

export const Store = {
  Games: 'games',
  Roms: 'roms',
  Saves: 'saves',
  States: 'states',
  /** The explored world per game, for the depth view. */
  WorldMaps: 'worldMaps',
} as const;

export type StoreName = (typeof Store)[keyof typeof Store];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      // Metadata for the library list, keyed by ROM hash.
      if (!db.objectStoreNames.contains(Store.Games)) {
        db.createObjectStore(Store.Games, { keyPath: 'id' });
      }
      // Raw cartridge images, keyed by the same hash.
      if (!db.objectStoreNames.contains(Store.Roms)) {
        db.createObjectStore(Store.Roms);
      }
      // Battery-backed cartridge RAM, keyed by ROM id.
      if (!db.objectStoreNames.contains(Store.Saves)) {
        db.createObjectStore(Store.Saves);
      }
      // Save states, keyed by `${romId}:${slot}`.
      if (!db.objectStoreNames.contains(Store.WorldMaps)) {
        db.createObjectStore(Store.WorldMaps);
      }
      if (!db.objectStoreNames.contains(Store.States)) {
        db.createObjectStore(Store.States);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // A version change from another tab would block writes; close and let the
      // next call reopen.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB nicht verfügbar'));
    request.onblocked = () => reject(new Error('IndexedDB ist durch einen anderen Tab blockiert'));
  });

  return dbPromise;
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        transaction.onabort = () => reject(transaction.error ?? new Error('Transaktion abgebrochen'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Speicherzugriff fehlgeschlagen'));
      }),
  );
}

export function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
  return run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
}

export function remove(store: StoreName, key: IDBValidKey): Promise<undefined> {
  return run(store, 'readwrite', (s) => s.delete(key));
}

export function getAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function getAllKeys(store: StoreName): Promise<IDBValidKey[]> {
  return run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());
}
