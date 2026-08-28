import { useEffect, useState } from 'preact/hooks';
import { Onboarding } from './Onboarding';
import { Library } from './Library';
import { Player } from './Player';
import { Settings } from './Settings';
import { storageIsAtRiskOfEviction } from '../platform/device';
import { ensureIsolation, registerServiceWorker, type IsolationState } from '../platform/isolation';
import { requestPersistentStorage, type StorageStatus } from '../storage/persist';
import type { GameEntry } from '../storage/library';

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
  const [playing, setPlaying] = useState<GameEntry | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  if (settingsOpen) {
    return (
      <Settings
        isolation={boot.isolation}
        storage={boot.storage}
        onStorageChange={(storage) => setBoot({ ...boot, storage })}
        onClose={() => setSettingsOpen(false)}
      />
    );
  }

  if (playing) {
    return (
      <Player
        game={playing}
        baseUrl={import.meta.env.BASE_URL}
        onExit={() => setPlaying(null)}
      />
    );
  }

  return <Library onPlay={setPlaying} onOpenSettings={() => setSettingsOpen(true)} />;
}
