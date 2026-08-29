/**
 * Game library: import cartridges, pick one to play, see whether storage is
 * actually safe on this device.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { importRom, listGames, deleteGame, type GameEntry } from '../storage/library';
import { ALL_ROM_EXTENSIONS, SYSTEMS } from '../core/systems';
import { ARCHIVE_EXTENSIONS } from '../storage/archive';
import { formatBytes } from '../storage/persist';

interface Props {
  onPlay: (game: GameEntry) => void;
  onOpenSettings: () => void;
}

export function Library({ onPlay, onOpenSettings }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [games, setGames] = useState<GameEntry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        const { entry, alreadyPresent, warning } = await importRom(
          file,
          import.meta.env.BASE_URL,
        );
        if (alreadyPresent) messages.push(`${entry.title} war schon da`);
        else if (warning) messages.push(`${entry.title} hinzugefügt — ${warning}`);
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
          onClick={onOpenSettings}
          aria-label="Einstellungen"
        >
          ⚙
        </button>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept={`${ALL_ROM_EXTENSIONS.join(',')},${ARCHIVE_EXTENSIONS.join(',')},application/octet-stream`}
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
            Tippe auf „Spiel hinzufügen" und wähle eine {ALL_ROM_EXTENSIONS.join(', ')}-Datei
            aus der Dateien-App. Sie bleibt auf diesem Gerät.
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
                  {describeSystem(game)} · {formatBytes(game.size)}
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

    </main>
  );
}

/** Game Boy Color is worth distinguishing; the rest is just the system name. */
function describeSystem(game: GameEntry): string {
  if (game.system === 'gb') return game.colorCapable ? 'Game Boy Color' : 'Game Boy';
  return SYSTEMS[game.system].label;
}
