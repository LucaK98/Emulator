import { useEffect, useState } from 'preact/hooks';
import { Onboarding } from './Onboarding';
import { storageIsAtRiskOfEviction } from '../platform/device';
import {
  ensureIsolation,
  hasSharedArrayBuffer,
  registerServiceWorker,
  type IsolationState,
} from '../platform/isolation';
import { formatBytes, requestPersistentStorage, type StorageStatus } from '../storage/persist';

const BYPASS_KEY = 'install-gate-bypassed';

/** Isolation as it can still be observed once boot has settled. */
type SettledIsolation = Exclude<IsolationState, { status: 'reloading' }>;

type Boot =
  | { phase: 'starting' }
  | { phase: 'reloading' }
  | { phase: 'ready'; isolation: SettledIsolation; storage: StorageStatus };

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'starting' });
  const [bypassed, setBypassed] = useState(() => sessionStorage.getItem(BYPASS_KEY) === '1');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Isolation first: it may reload the page, and there is no point doing
      // other work before that.
      const isolation = await ensureIsolation();
      if (isolation.status === 'reloading') {
        if (!cancelled) setBoot({ phase: 'reloading' });
        return;
      }
      // Already isolated via real headers (dev server) — still register the
      // worker so the app works offline.
      await registerServiceWorker();

      const storage = await requestPersistentStorage();
      if (!cancelled) setBoot({ phase: 'ready', isolation, storage });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (boot.phase !== 'ready') {
    return (
      <main class="screen centered">
        <p class="muted">{boot.phase === 'reloading' ? 'Wird neu geladen …' : 'Startet …'}</p>
      </main>
    );
  }

  if (storageIsAtRiskOfEviction() && !bypassed) {
    return (
      <Onboarding
        onContinueAnyway={() => {
          sessionStorage.setItem(BYPASS_KEY, '1');
          setBypassed(true);
        }}
      />
    );
  }

  return <Library isolation={boot.isolation} storage={boot.storage} />;
}

function Library({ isolation, storage }: { isolation: SettledIsolation; storage: StorageStatus }) {
  return (
    <main class="screen library">
      <header class="app-header">
        <h1>Emulator</h1>
      </header>

      <section class="empty-state">
        <p class="lede">Noch keine Spiele in der Bibliothek.</p>
        <p class="muted">
          Der ROM-Import kommt mit dem Game-Boy-Core. Bis dahin prüft dieser Bildschirm, ob dein
          Gerät alles mitbringt, was der Emulator braucht.
        </p>
      </section>

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
