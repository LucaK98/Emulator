/**
 * Save-state slots in the pause menu.
 *
 * Save and load are separate modes rather than two buttons per slot: with nine
 * slots on a phone screen, per-slot buttons end up too small to hit reliably,
 * and overwriting the wrong save is the one mistake that actually costs
 * progress. Picking the mode first makes every tap unambiguous.
 */

import { useEffect, useState } from 'preact/hooks';
import { AUTO_SLOT, listSlots, type SlotSummary } from '../storage/library';
import { formatBytes } from '../storage/persist';

type Mode = 'save' | 'load';

interface Props {
  gameId: string;
  onSave: (slot: string) => Promise<void>;
  onLoad: (slot: string) => Promise<void>;
}

export function SaveSlots({ gameId, onSave, onLoad }: Props) {
  const [mode, setMode] = useState<Mode>('save');
  const [slots, setSlots] = useState<SlotSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => void listSlots(gameId).then(setSlots);
  useEffect(refresh, [gameId]);

  const act = async (slot: SlotSummary) => {
    if (busy) return;
    setBusy(slot.slot);
    setNotice(null);
    try {
      if (mode === 'save') {
        await onSave(slot.slot);
        setNotice(`In ${slotLabel(slot.slot)} gespeichert`);
      }
      else {
        await onLoad(slot.slot);
        setNotice(`${slotLabel(slot.slot)} geladen`);
      }
      refresh();
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : 'Fehlgeschlagen');
    }
    finally {
      setBusy(null);
    }
  };

  return (
    <section class="slots-panel">
      <h2>Spielstände</h2>

      <div class="segmented" role="group">
        <button
          type="button"
          class={mode === 'save' ? 'segment is-active' : 'segment'}
          aria-pressed={mode === 'save'}
          onClick={() => setMode('save')}
        >
          Speichern
        </button>
        <button
          type="button"
          class={mode === 'load' ? 'segment is-active' : 'segment'}
          aria-pressed={mode === 'load'}
          onClick={() => setMode('load')}
        >
          Laden
        </button>
      </div>

      {slots === null ? (
        <p class="muted">Lädt …</p>
      ) : (
        <ul class="slot-grid">
          {slots.map((slot) => {
            // The automatic slot is written on its own; overwriting it by hand
            // would only throw away the app's own safety net.
            const disabled =
              busy !== null ||
              (mode === 'load' && slot.createdAt === null) ||
              (mode === 'save' && slot.slot === AUTO_SLOT);

            return (
              <li key={slot.slot}>
                <button
                  type="button"
                  class="slot"
                  disabled={disabled}
                  onClick={() => void act(slot)}
                  aria-label={`${slotLabel(slot.slot)} ${mode === 'save' ? 'speichern' : 'laden'}`}
                >
                  <span class="slot-thumb">
                    {slot.thumbnail ? (
                      <img src={slot.thumbnail} alt="" />
                    ) : (
                      <span class="slot-thumb-empty" aria-hidden="true" />
                    )}
                  </span>
                  <span class="slot-name">{slotLabel(slot.slot)}</span>
                  <span class="slot-meta">
                    {slot.createdAt === null ? 'leer' : formatAge(slot.createdAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {notice && <p class="footnote">{notice}</p>}
      {slots && (
        <p class="footnote">
          Belegt: {formatBytes(slots.reduce((sum, slot) => sum + slot.bytes, 0))}
        </p>
      )}
    </section>
  );
}

function slotLabel(slot: string): string {
  return slot === AUTO_SLOT ? 'Auto' : `Slot ${slot}`;
}

/** Coarse, readable ages — the exact second never matters here. */
export function formatAge(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'gerade eben';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `vor ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} h`;

  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'gestern' : `vor ${days} Tagen`;

  return new Date(timestamp).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}
