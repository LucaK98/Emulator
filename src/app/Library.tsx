/**
 * Game library: import cartridges, pick one to play, see whether storage is
 * actually safe on this device.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { importRom, listGames, deleteGame, type GameEntry } from '../storage/library';
import { formatBytes, type StorageStatus } from '../storage/persist';
import { hasSharedArrayBuffer, type IsolationState } from '../platform/isolation';

interface Props {
  isolation: Exclude<IsolationState, { status: 'reloading' }>;
  storage: StorageStatus;
  onPlay: (game: GameEntry) => void;
}

export function Library({ isolation, storage, onPlay }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [games, setGames] = useState<GameEntry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const refresh = () => void listGames().then(setGames);

  useEffect(refresh, []);

  const onFiles = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = ''; // allow re-importing the same file
    if (files.length === 0) return;

    const messages: string[] = [];
    for (const file of files) {
      try {
        const { entry, info, alreadyPresent } = await importRom(file);
        if (alreadyPresent) messages.push(`${entry.title} war schon da`);
        else if (!info.headerChecksumValid) {
          messages.push(`${entry.title} hinzugefügt — Prüfsumme stimmt nicht, evtl. defekter Dump`);
        }
        else messages.push(`${entry.title} hinzugefügt`);
      }
      catch (problem) {
        messages.push(`${file.name}: ${problem instanceof Error ? problem.message : 'Fehler'}`);
      }
    }
    setNotice(messages.join(' · '));
    refresh();
  };

  const onDelete = async (game: GameEntry) => {
    if (!confirm(`„${game.title}" mit allen Spielständen löschen?`)) return;
    await deleteGame(game.id);
    refresh();
  };

  return (
    <main class="screen library">
      <header class="app-header">
        <h1>Emulator</h1>
        <button
          type="button"
          class="icon-button"
          onClick={() => setShowDiagnostics((open) => !open)}
          aria-label="Systemstatus"
        >
          ⓘ
        </button>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept=".gb,.gbc,application/octet-stream"
        multiple
        hidden
        onChange={(event) => void onFiles(event)}
      />
      <button type="button" class="primary-button" onClick={() => fileRef.current?.click()}>
        Spiel hinzufügen
      </button>
      {notice && <p class="footnote">{notice}</p>}

      {games === null ? (
        <p class="muted">Lädt …</p>
      ) : games.length === 0 ? (
        <section class="empty-state">
          <p class="lede">Noch keine Spiele in der Bibliothek.</p>
          <p class="muted">
            Tippe auf „Spiel hinzufügen" und wähle eine .gb- oder .gbc-Datei aus der
            Dateien-App. Sie bleibt auf diesem Gerät.
          </p>
        </section>
      ) : (
        <ul class="game-grid">
          {games.map((game) => (
            <li key={game.id}>
              <button type="button" class="game-tile" onClick={() => onPlay(game)}>
                <span class="game-thumb">
                  {game.thumbnail ? (
                    <img src={game.thumbnail} alt="" width={320} height={288} />
                  ) : (
                    <span class="game-thumb-empty" aria-hidden="true" />
                  )}
                </span>
                <span class="game-title">{game.title}</span>
                <span class="game-meta">
                  {game.colorCapable ? 'Game Boy Color' : 'Game Boy'} · {formatBytes(game.size)}
                </span>
              </button>
              <button
                type="button"
                class="tile-delete"
                onClick={() => void onDelete(game)}
                aria-label={`${game.title} löschen`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {showDiagnostics && (
        <section class="diagnostics">
          <h2>Systemstatus</h2>
          <dl>
            <Row
              label="Dauerhafter Speicher"
              ok={storage.persisted}
              value={
                storage.unsupported
                  ? 'Nicht unterstützt'
                  : storage.persisted
                    ? 'Aktiv'
                    : 'Nur Best-Effort'
              }
            />
            <Row
              label="Speicherbelegung"
              neutral
              value={`${formatBytes(storage.usage)} von ${formatBytes(storage.quota)}`}
            />
            <Row
              label="Cross-Origin-Isolation"
              ok={isolation.status === 'isolated'}
              value={isolation.status === 'isolated' ? 'Aktiv' : isolation.reason}
            />
            <Row
              label="SharedArrayBuffer"
              ok={hasSharedArrayBuffer()}
              value={hasSharedArrayBuffer() ? 'Verfügbar' : 'Fallback ohne SAB'}
            />
          </dl>
        </section>
      )}
    </main>
  );
}

function Row({
  label,
  value,
  ok,
  neutral = false,
}: {
  label: string;
  value: string;
  ok?: boolean;
  neutral?: boolean;
}) {
  const state = neutral ? 'neutral' : ok ? 'ok' : 'warn';
  return (
    <div class="row">
      <dt>{label}</dt>
      <dd class={`status status-${state}`}>{value}</dd>
    </div>
  );
}
