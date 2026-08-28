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
import {
  DEFAULT_DEPTH_SETTINGS,
  Depth25DRenderer,
  type DepthSettings,
} from '../render/Depth25DRenderer';
import { DepthControls } from './DepthControls';
import { InputState, attachKeyboard } from '../input/InputState';
import { TouchControls } from './TouchControls';
import { frameToDataUrl } from './frameThumbnail';
import { SYSTEMS } from '../core/systems';
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
/** Camera settings are a personal preference, so they are shared across games. */
const DEPTH_SETTINGS_KEY = 'depth-settings';

function loadDepthSettings(): DepthSettings {
  try {
    const stored = localStorage.getItem(DEPTH_SETTINGS_KEY);
    if (stored) return { ...DEFAULT_DEPTH_SETTINGS, ...JSON.parse(stored) };
  }
  catch {
    // Corrupt or unavailable storage is not worth failing over.
  }
  return { ...DEFAULT_DEPTH_SETTINGS };
}

interface Props {
  game: GameEntry;
  baseUrl: string;
  onExit: () => void;
}

type Phase = 'loading' | 'ready' | 'running' | 'paused' | 'error';

export function Player({ game, baseUrl, onExit }: Props) {
  const spec = SYSTEMS[game.system];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coreRef = useRef<CoreClient | null>(null);
  const inputRef = useRef(new InputState());

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fps, setFps] = useState(0);
  const [restored, setRestored] = useState(false);

  const [depthMode, setDepthMode] = useState(game.depth3d ?? false);
  const [depthSettings, setDepthSettings] = useState<DepthSettings>(loadDepthSettings);
  const depthRef = useRef<Depth25DRenderer | null>(null);
  const [depthStats, setDepthStats] = useState({ raised: 0, learning: false });
  // Depth rendering reads PPU state out of shared memory each frame; without
  // cross-origin isolation there is no shared memory to read.
  const depthAvailable =
    spec.supportsDepth && typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;

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
    const thumbnail = frame ? frameToDataUrl(frame, spec) : null;
    const data = await core.readState();
    if (!data) return;
    await putState(game.id, AUTO_SLOT, data, thumbnail);
    await updateGame(game.id, { lastPlayedAt: Date.now(), thumbnail });
  }, [game.id, spec]);

  /* --- Boot ------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    const core = new CoreClient({
      baseUrl,
      system: spec,
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
  }, [game.id, game.model, game.hasBattery, baseUrl, spec]);

  /* --- Renderer --------------------------------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const useDepth = depthMode && depthAvailable;
    const renderer = useDepth ? Depth25DRenderer.create(canvas) : GLRenderer.create(canvas, spec);
    if (!renderer) {
      setError('WebGL2 wird von diesem Browser nicht unterstützt');
      setPhase('error');
      return;
    }

    depthRef.current = useDepth ? (renderer as Depth25DRenderer) : null;
    if (depthRef.current) depthRef.current.settings = depthSettings;
    coreRef.current?.attachRenderer(renderer);

    return () => {
      coreRef.current?.attachRenderer(null);
      depthRef.current = null;
      renderer.dispose();
    };
    // depthSettings is applied through the ref below, not by rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depthMode, depthAvailable, spec, phase === 'error']);

  // Slider moves take effect immediately without touching the GL objects.
  useEffect(() => {
    if (depthRef.current) depthRef.current.settings = depthSettings;
  }, [depthSettings]);

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

  useEffect(() => {
    if (!menuOpen) return;
    const model = depthRef.current?.heights;
    setDepthStats({
      raised: model?.raisedTileCount() ?? 0,
      learning: model?.learning ?? false,
    });
  }, [menuOpen]);

  const changeDepthMode = (enabled: boolean) => {
    setDepthMode(enabled);
    void updateGame(game.id, { depth3d: enabled });
  };

  const changeDepthSettings = (next: DepthSettings) => {
    setDepthSettings(next);
    try {
      localStorage.setItem(DEPTH_SETTINGS_KEY, JSON.stringify(next));
    }
    catch {
      // Not worth interrupting play over.
    }
  };

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
        <canvas
          key={depthMode && depthAvailable ? 'depth' : 'flat'}
          ref={canvasRef}
          class="player-canvas"
          width={spec.width}
          height={spec.height}
        />

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

            <DepthControls
              enabled={depthMode}
              available={depthAvailable}
              unavailableReason={
                spec.supportsDepth
                  ? 'Braucht Cross-Origin-Isolation. Starte die App vom Home-Bildschirm.'
                  : `Für ${spec.label} noch nicht gebaut — der Tiefen-Renderer liest die Game-Boy-PPU.`
              }
              settings={depthSettings}
              raisedTiles={depthStats.raised}
              learning={depthStats.learning}
              onToggle={changeDepthMode}
              onChange={changeDepthSettings}
            />

            <p class="footnote">{fps.toFixed(0)} fps</p>
          </Overlay>
        )}
      </div>

      <TouchControls
        input={inputRef.current}
        buttons={spec.buttons}
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
