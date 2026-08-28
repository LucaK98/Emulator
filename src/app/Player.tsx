/**
 * The play screen: canvas, controls and everything that keeps progress safe.
 *
 * Two save mechanisms run side by side. Cartridge RAM (what the game itself
 * calls "save") is polled and written back only when it changed. On top of that
 * an automatic save state is written when the app goes to the background, which
 * is what makes closing the app mid-battle harmless — iOS kills backgrounded
 * web apps without warning, and `pagehide` is the last moment we get.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { CoreClient } from '../core/CoreClient';
import { GLRenderer } from '../render/GLRenderer';
import { InputState, attachKeyboard } from '../input/InputState';
import { TouchControls } from './TouchControls';
import { frameToDataUrl } from './frameThumbnail';
import {
  AUTO_SLOT,
  getRom,
  getSave,
  getState,
  putState,
  saveBatteryIfChanged,
  updateGame,
  type GameEntry,
} from '../storage/library';

/** How often cartridge RAM is compared against what is stored. */
const BATTERY_POLL_MS = 2000;
/** How often an automatic save state is written while playing. */
const AUTO_STATE_MS = 60_000;

interface Props {
  game: GameEntry;
  baseUrl: string;
  onExit: () => void;
}

type Phase = 'loading' | 'ready' | 'running' | 'paused' | 'error';

export function Player({ game, baseUrl, onExit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coreRef = useRef<CoreClient | null>(null);
  const inputRef = useRef(new InputState());

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fps, setFps] = useState(0);
  const [restored, setRestored] = useState(false);

  /* --- Save helpers (stable across renders) ----------------------------- */

  const flushBattery = useCallback(async () => {
    const core = coreRef.current;
    if (!core || !game.hasBattery) return;
    const data = await core.readBattery();
    if (data) await saveBatteryIfChanged(game.id, data);
  }, [game.id, game.hasBattery]);

  const writeAutoState = useCallback(async () => {
    const core = coreRef.current;
    if (!core) return;
    const frame = core.currentFrame();
    const thumbnail = frame ? frameToDataUrl(frame) : null;
    const data = await core.readState();
    if (!data) return;
    await putState(game.id, AUTO_SLOT, data, thumbnail);
    await updateGame(game.id, { lastPlayedAt: Date.now(), thumbnail });
  }, [game.id]);

  /* --- Boot ------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    const core = new CoreClient({
      baseUrl,
      onError: (message) => {
        setError(message);
        setPhase('error');
      },
      onFps: setFps,
    });
    coreRef.current = core;

    void (async () => {
      try {
        const rom = await getRom(game.id);
        if (!rom) throw new Error('ROM nicht mehr in der Bibliothek');

        await core.init();
        if (cancelled) return;

        const save = game.hasBattery ? await getSave(game.id) : undefined;
        await core.load({
          rom,
          model: game.model,
          battery: save?.data ?? null,
        });
        if (cancelled) return;

        // Pick up exactly where the last session stopped.
        const auto = await getState(game.id, AUTO_SLOT);
        if (auto && !cancelled) {
          const ok = await core.loadState(auto.data);
          setRestored(ok);
        }

        if (!cancelled) setPhase('ready');
      }
      catch (problem) {
        if (cancelled) return;
        setError(problem instanceof Error ? problem.message : String(problem));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      coreRef.current = null;
      void core.destroy();
    };
  }, [game.id, game.model, game.hasBattery, baseUrl]);

  /* --- Renderer --------------------------------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = GLRenderer.create(canvas);
    if (!renderer) {
      setError('WebGL2 wird von diesem Browser nicht unterstützt');
      setPhase('error');
      return;
    }
    coreRef.current?.attachRenderer(renderer);
    return () => {
      coreRef.current?.attachRenderer(null);
      renderer.dispose();
    };
  }, [phase === 'error']);

  /* --- Input ------------------------------------------------------------ */

  useEffect(() => {
    const input = inputRef.current;
    const unsubscribe = input.subscribe((mask) => coreRef.current?.setKeys(mask));
    const detachKeyboard = attachKeyboard(input);
    return () => {
      unsubscribe();
      detachKeyboard();
    };
  }, []);

  /* --- Periodic saving -------------------------------------------------- */

  useEffect(() => {
    if (phase !== 'running') return;
    const battery = window.setInterval(() => void flushBattery(), BATTERY_POLL_MS);
    const state = window.setInterval(() => void writeAutoState(), AUTO_STATE_MS);
    return () => {
      window.clearInterval(battery);
      window.clearInterval(state);
    };
  }, [phase, flushBattery, writeAutoState]);

  /* --- Backgrounding ---------------------------------------------------- */

  useEffect(() => {
    // pagehide is the only event iOS reliably delivers before killing a tab,
    // and visibilitychange covers the app switcher. Both flush; neither awaits,
    // because the browser will not wait for us.
    const persist = () => {
      void flushBattery();
      void writeAutoState();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        persist();
        void coreRef.current?.pause();
        setPhase((current) => (current === 'running' ? 'paused' : current));
      }
    };

    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', persist);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushBattery, writeAutoState]);

  /* --- Actions ---------------------------------------------------------- */

  const startPlaying = async () => {
    await coreRef.current?.start();
    setPhase('running');
  };

  const resumePlaying = async () => {
    setMenuOpen(false);
    await coreRef.current?.resume();
    setPhase('running');
  };

  const openMenu = async () => {
    await coreRef.current?.pause();
    setPhase('paused');
    setMenuOpen(true);
  };

  const restart = async () => {
    coreRef.current?.reset();
    await resumePlaying();
  };

  const exit = async () => {
    await flushBattery();
    await writeAutoState();
    onExit();
  };

  /* --- Render ----------------------------------------------------------- */

  return (
    <main class="screen player">
      <div class="player-stage">
        <canvas ref={canvasRef} class="player-canvas" width={160} height={144} />

        {phase === 'loading' && <Overlay><p class="muted">Lädt …</p></Overlay>}

        {phase === 'error' && (
          <Overlay>
            <p class="lede">Das Spiel konnte nicht gestartet werden.</p>
            <p class="muted">{error}</p>
            <button type="button" class="ghost-button" onClick={onExit}>
              Zurück zur Bibliothek
            </button>
          </Overlay>
        )}

        {phase === 'ready' && (
          <Overlay>
            <p class="lede">{game.title}</p>
            <p class="muted">
              {restored ? 'Spielstand wiederhergestellt.' : 'Neues Spiel.'}
            </p>
            <button type="button" class="primary-button" onClick={() => void startPlaying()}>
              Spielen
            </button>
          </Overlay>
        )}

        {menuOpen && (
          <Overlay>
            <h2>Pause</h2>
            <button type="button" class="primary-button" onClick={() => void resumePlaying()}>
              Weiter
            </button>
            <button type="button" class="ghost-button" onClick={() => void restart()}>
              Neu starten
            </button>
            <button type="button" class="ghost-button" onClick={() => void exit()}>
              Speichern und beenden
            </button>
            <p class="footnote">{fps.toFixed(0)} fps</p>
          </Overlay>
        )}
      </div>

      <TouchControls
        input={inputRef.current}
        onMenu={() => void openMenu()}
        disabled={phase !== 'running' || menuOpen}
      />
    </main>
  );
}

function Overlay({ children }: { children: preact.ComponentChildren }) {
  return (
    <div class="player-overlay">
      <div class="overlay-card">{children}</div>
    </div>
  );
}
