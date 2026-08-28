/**
 * Storage persistence and quota.
 *
 * `navigator.storage.persist()` must be requested on *every* launch, not once:
 * WebKit does not durably remember the grant, and a best-effort origin can be
 * evicted when the device runs low on space. Callers should surface the result
 * so the user can tell whether their saves are actually safe.
 */

export interface StorageStatus {
  /** Whether the origin is in persistent mode (not subject to eviction). */
  persisted: boolean;
  /** Bytes currently used, if the browser reports it. */
  usage: number | undefined;
  /** Bytes available to this origin, if the browser reports it. */
  quota: number | undefined;
  /** Set when the Storage API is missing entirely. */
  unsupported: boolean;
}

export async function requestPersistentStorage(): Promise<StorageStatus> {
  if (!navigator.storage) {
    return { persisted: false, usage: undefined, quota: undefined, unsupported: true };
  }

  let persisted = false;
  try {
    persisted = (await navigator.storage.persisted?.()) ?? false;
    if (!persisted) {
      persisted = (await navigator.storage.persist?.()) ?? false;
    }
  } catch {
    persisted = false;
  }

  let usage: number | undefined;
  let quota: number | undefined;
  try {
    const estimate = await navigator.storage.estimate?.();
    usage = estimate?.usage;
    quota = estimate?.quota;
  } catch {
    // Estimation is advisory; ignore failures.
  }

  return { persisted, usage, quota, unsupported: false };
}

/** Human-readable byte count for the settings screen. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
