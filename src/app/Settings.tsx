/**
 * Settings: what the app knows about this device's storage, the backup tools,
 * and controller mapping.
 *
 * The storage section is deliberately blunt. On iOS the difference between
 * "persistent" and "best effort" decides whether save games survive a week of
 * not playing, and that is worth stating plainly rather than hiding.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  backupFilename,
  createBackup,
  restoreBackup,
  shareOrDownload,
  type RestoreSummary,
} from '../storage/backup';
import { formatBytes, requestPersistentStorage, type StorageStatus } from '../storage/persist';
import { hasSharedArrayBuffer, type IsolationState } from '../platform/isolation';
import { isStandalone } from '../platform/device';
import { InputState } from '../input/InputState';
import {
  GamepadReader,
  defaultMapping,
  firstGamepad,
  loadMapping,
  saveMapping,
  type GamepadMapping,
} from '../input/gamepad';
import type { ButtonName } from '../core/systems';
import {
  loadDisplaySettings,
  saveDisplaySettings,
  type DisplaySettings,
} from './displaySettings';

interface Props {
  isolation: Exclude<IsolationState, { status: 'reloading' }>;
  storage: StorageStatus;
  onStorageChange: (status: StorageStatus) => void;
  onClose: () => void;
}

const MAPPABLE: ButtonName[] = [
  'Up',
  'Down',
  'Left',
  'Right',
  'A',
  'B',
  'Start',
  'Select',
  'L',
  'R',
  'X',
  'Y',
];

export function Settings({ isolation, storage, onStorageChange, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [includeRoms, setIncludeRoms] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [display, setDisplay] = useState<DisplaySettings>(loadDisplaySettings);
  const [mapping, setMapping] = useState<GamepadMapping>(loadMapping);
  const [padName, setPadName] = useState<string | null>(null);
  const [binding, setBinding] = useState<ButtonName | null>(null);
  const readerRef = useRef<GamepadReader | null>(null);

  useEffect(() => {
    const reader = new GamepadReader(new InputState());
    readerRef.current = reader;
    reader.start();

    const check = () => setPadName(firstGamepad()?.id ?? null);
    check();
    const interval = window.setInterval(check, 1000);

    return () => {
      window.clearInterval(interval);
      reader.stop();
      readerRef.current = null;
    };
  }, []);

  const runBackup = async () => {
    setBusy('backup');
    setNotice(null);
    try {
      const { blob, summary } = await createBackup({ includeRoms });
      const how = await shareOrDownload(blob, backupFilename());
      setNotice(
        `${summary.saves} Spielstände, ${summary.states} Zwischenstände` +
          `${summary.roms ? `, ${summary.roms} ROMs` : ''} · ${formatBytes(summary.bytes)} ` +
          (how === 'shared' ? 'geteilt' : 'geladen'),
      );
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : 'Sicherung fehlgeschlagen');
    }
    finally {
      setBusy(null);
    }
  };

  const runRestore = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    setBusy('restore');
    setNotice(null);
    try {
      const summary = await restoreBackup(file);
      setNotice(describeRestore(summary));
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : 'Einspielen fehlgeschlagen');
    }
    finally {
      setBusy(null);
    }
  };

  const bind = async (button: ButtonName) => {
    const reader = readerRef.current;
    if (!reader) return;
    setBinding(button);
    const index = await reader.captureNextButton();
    const next = { ...mapping, [button]: index };
    setMapping(next);
    saveMapping(next);
    reader.setMapping(next);
    setBinding(null);
  };

  const resetMapping = () => {
    const next = defaultMapping();
    setMapping(next);
    saveMapping(next);
    readerRef.current?.setMapping(next);
  };

  return (
    <main class="screen settings">
      <header class="app-header">
        <h1>Einstellungen</h1>
        <button type="button" class="icon-button" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
      </header>

      <section class="panel">
        <h2>Speicher</h2>
        <dl>
          <Row
            label="Dauerhafter Speicher"
            ok={storage.persisted}
            value={
              storage.unsupported ? 'Nicht unterstützt' : storage.persisted ? 'Aktiv' : 'Nur Best-Effort'
            }
          />
          <Row
            label="Belegung"
            neutral
            value={`${formatBytes(storage.usage)} von ${formatBytes(storage.quota)}`}
          />
          <Row
            label="Vom Home-Bildschirm"
            ok={isStandalone()}
            value={isStandalone() ? 'Ja' : 'Nein — Daten laufen nach 7 Tagen ab'}
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
        <button
          type="button"
          class="ghost-button"
          onClick={() => void requestPersistentStorage().then(onStorageChange)}
        >
          Neu prüfen
        </button>
      </section>

      <section class="panel">
        <h2>Bild</h2>
        <p class="muted">
          Ein Gitter zwischen den Pixeln, wie es die Zwischenräume eines LCD zeichnen. Es blendet
          sich aus, wenn ein emulierter Pixel zu klein wird, um noch eine Lücke zu tragen. Wirkt
          erst beim nächsten Spielstart.
        </p>
        <label class="slider">
          <span class="slider-label">
            LCD-Gitter
            <span class="slider-value">
              {display.lcdGrid === 0 ? 'aus' : `${Math.round(display.lcdGrid * 100)} %`}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.05}
            value={display.lcdGrid}
            onInput={(event) => {
              const next = {
                ...display,
                lcdGrid: Number((event.currentTarget as HTMLInputElement).value),
              };
              setDisplay(next);
              saveDisplaySettings(next);
            }}
          />
        </label>
      </section>

      <section class="panel">
        <h2>Sicherung</h2>
        <p class="muted">
          Ein Backup ist eine gewöhnliche ZIP-Datei mit deinen Spielständen. Du kannst sie in die
          Dateien-App oder nach iCloud legen und jederzeit wieder einspielen.
        </p>

        <label class="checkbox">
          <input
            type="checkbox"
            checked={includeRoms}
            onChange={(event) => setIncludeRoms((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            Spiele mitsichern
            <span class="checkbox-hint">
              Deutlich größer. Spielstände allein sind das, was du nicht ersetzen kannst.
            </span>
          </span>
        </label>

        <button
          type="button"
          class="primary-button"
          disabled={busy !== null}
          onClick={() => void runBackup()}
        >
          {busy === 'backup' ? 'Sichert …' : 'Backup erstellen'}
        </button>

        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => void runRestore(event)}
        />
        <button
          type="button"
          class="ghost-button"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
        >
          {busy === 'restore' ? 'Spielt ein …' : 'Backup einspielen'}
        </button>

        {notice && <p class="footnote">{notice}</p>}
      </section>

      <section class="panel">
        <h2>Controller</h2>
        <p class="muted">
          {padName
            ? padName
            : 'Kein Controller verbunden. Koppel ihn in den iOS-Einstellungen und drücke dann eine Taste.'}
        </p>

        <dl>
          {MAPPABLE.map((button) => (
            <div class="row" key={button}>
              <dt>{button}</dt>
              <dd>
                <button
                  type="button"
                  class="ghost-button inline"
                  disabled={!padName || binding !== null}
                  onClick={() => void bind(button)}
                >
                  {binding === button ? 'Taste drücken …' : `Taste ${mapping[button]}`}
                </button>
              </dd>
            </div>
          ))}
        </dl>

        <button type="button" class="ghost-button" onClick={resetMapping}>
          Standardbelegung
        </button>
      </section>
    </main>
  );
}

function describeRestore(summary: RestoreSummary): string {
  const parts = [
    `${summary.games} Spiele`,
    `${summary.saves} Spielstände`,
    `${summary.states} Zwischenstände`,
  ];
  if (summary.roms) parts.push(`${summary.roms} ROMs`);
  let text = `Eingespielt: ${parts.join(', ')}`;
  if (summary.waitingForRom) {
    text += ` · ${summary.waitingForRom} warten auf ihre ROM`;
  }
  return text;
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
