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
import type { SceneRenderer } from '../render/SceneRenderer';
import {
  DEFAULT_DEPTH_SETTINGS,
  Depth25DRenderer,
  type DepthSettings,
} from '../render/Depth25DRenderer';
import { DepthControls } from './DepthControls';
import { InputState, attachKeyboard } from '../input/InputState';
import { TouchControls, type PlayerAction } from './TouchControls';
import { SaveSlots } from './SaveSlots';
import { GamepadReader } from '../input/gamepad';
import { frameToDataUrl } from './frameThumbnail';
import { SYSTEMS } from '../core/systems';
import { mapToTouchScreen } from '../input/touchScreen';
import { loadDisplaySettings } from './displaySettings';
import { shareOrDownload } from '../storage/backup';
import { loadWorldMap, saveWorldMap } from '../storage/worldMap';
import {
  AUTO_SLOT,
  getRom,
  getState as readState,
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
/** Emulation speed while fast-forward is held, in percent. */
const FAST_FORWARD_PERCENT = 300;

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
  const rootRef = useRef<HTMLElement>(null);
  const coreRef = useRef<CoreClient | null>(null);
  /**
   * The renderer currently in use.
   *
   * Held because the core and the renderer are built by two effects that do
   * not wait for each other: with the depth view already switched on for a
   * game, the renderer is created while the core is still loading, and
   * attaching it there would attach it to nothing. Whichever finishes second
   * does the attaching.
   */
  const rendererRef = useRef<SceneRenderer | null>(null);
  const inputRef = useRef(new InputState());
  const gamepadRef = useRef<GamepadReader | null>(null);

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fps, setFps] = useState(0);
  const [restored, setRestored] = useState(false);

  const [layout, setLayout] = useState(0);
  const [rewind, setRewind] = useState({ available: false, seconds: 0 });
  const [shotNotice, setShotNotice] = useState<string | null>(null);
  const [depthMode, setDepthMode] = useState(game.depth3d ?? false);
  const [depthSettings, setDepthSettings] = useState<DepthSettings>(loadDepthSettings);
  const depthRef = useRef<Depth25DRenderer | null>(null);
  const [depthStats, setDepthStats] = useState({ raised: 0, learning: false, remembered: 0 });
  /*
   * Whether the on-screen buttons are out of the way.
   *
   * On a two-screen console the buttons overlay the lower screen, so only one
   * of the two can have the taps: with the buttons up they take them and the
   * console's touch screen is off, and hiding them hands it over.
   */
  const [controlsHidden, setControlsHidden] = useState(false);
  const touchScreenLive = spec.hasTouchScreen && controlsHidden;
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

    // The explored world goes with the state, and only with it: the two have
    // to agree about where the player is standing, or the map would be laid
    // over the wrong place when the game resumes.
    const world = depthRef.current?.worldSnapshot();
    if (world) await saveWorldMap(game.id, world);
  }, [game.id, spec]);

  const saveToSlot = useCallback(
    async (slot: string) => {
      const core = coreRef.current;
      if (!core) throw new Error('Kein laufendes Spiel');
      const data = await core.readState();
      if (!data) throw new Error('Zwischenstand konnte nicht erstellt werden');
      const frame = core.currentFrame();
      await putState(game.id, slot, data, frame ? frameToDataUrl(frame, spec) : null);
    },
    [game.id, spec],
  );

  const loadFromSlot = useCallback(
    async (slot: string) => {
      const core = coreRef.current;
      if (!core) throw new Error('Kein laufendes Spiel');
      const record = await readState(game.id, slot);
      if (!record) throw new Error('Slot ist leer');
      // Cartridge RAM is flushed first so the state we are leaving is not lost.
      await flushBattery();
      if (!(await core.loadState(record.data))) {
        throw new Error('Zwischenstand passt nicht zu diesem Spiel');
      }
    },
    [game.id, flushBattery],
  );

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
      onRewindReady: (available, seconds) => setRewind({ available, seconds }),
    });
    coreRef.current = core;
    if (rendererRef.current) core.attachRenderer(rendererRef.current);

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
    const renderer = useDepth ? Depth25DRenderer.create(canvas, spec) : GLRenderer.create(canvas, spec);
    if (!renderer) {
      setError('WebGL2 wird von diesem Browser nicht unterstützt');
      setPhase('error');
      return;
    }

    depthRef.current = useDepth ? (renderer as Depth25DRenderer) : null;
    if (depthRef.current) {
      depthRef.current.settings = depthSettings;
      // The world explored in earlier sessions, so the wide view does not have
      // to be walked out again from nothing. Loaded without blocking the first
      // frame; the renderer holds it until it can tell whether it fits.
      const depth = depthRef.current;
      void loadWorldMap(game.id).then((world) => {
        if (world && depthRef.current === depth) depth.restoreWorld(world);
      });
    }
    else (renderer as GLRenderer).gridStrength = loadDisplaySettings().lcdGrid;
    rendererRef.current = renderer;
    coreRef.current?.attachRenderer(renderer);

    return () => {
      coreRef.current?.attachRenderer(null);
      rendererRef.current = null;
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

    // Polled on its own frame so a controller still works while paused.
    const gamepad = new GamepadReader(input);
    gamepadRef.current = gamepad;
    gamepad.start();

    return () => {
      unsubscribe();
      detachKeyboard();
      gamepad.stop();
      gamepadRef.current = null;
    };
  }, []);

  /*
   * Touch screen. The canvas shows the whole composed picture, so a tap is
   * translated through the letterbox into the lower screen; taps that land
   * anywhere else are ignored rather than guessed at.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    // Only while the buttons are out of the way: otherwise every press of the
    // d-pad would also be a poke at the console's touch screen.
    if (!canvas || !touchScreenLive) return;

    const send = (event: PointerEvent) => {
      const core = coreRef.current;
      if (!core) return;
      const rect = canvas.getBoundingClientRect();
      const point = mapToTouchScreen(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { width: rect.width, height: rect.height },
        { width: core.frameWidth, height: core.frameHeight },
        layout,
      );
      if (point) core.touch(point.x, point.y);
    };

    const onDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      send(event);
    };
    const onMove = (event: PointerEvent) => {
      if (event.buttons === 0 && event.pointerType === 'mouse') return;
      send(event);
    };
    const onUp = () => coreRef.current?.releaseTouch();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      // A finger down when the buttons come back would otherwise stay down.
      coreRef.current?.releaseTouch();
    };
  }, [spec, layout, touchScreenLive, phase === 'error']);

  /**
   * Rewind and fast-forward act on the emulator rather than the console, so
   * they are held like buttons but routed past the input mask.
   */
  const onAction = useCallback((action: PlayerAction, pressed: boolean) => {
    const core = coreRef.current;
    if (!core) return;
    if (action === 'fastForward') core.setSpeed(pressed ? FAST_FORWARD_PERCENT : 100);
    else core.setRewind(pressed);
  }, []);

  const takeScreenshot = async () => {
    const core = coreRef.current;
    const frame = core?.currentFrame();
    if (!frame) return;

    const dataUrl = frameToDataUrl(frame, {
      ...spec,
      width: core!.frameWidth,
      height: core!.frameHeight,
    });
    if (!dataUrl) return;

    const blob = await (await fetch(dataUrl)).blob();
    const name = `${game.title.replace(/[^\w-]+/g, '_') || 'screenshot'}.png`;
    const how = await shareOrDownload(blob, name);
    setShotNotice(how === 'shared' ? 'Screenshot geteilt' : 'Screenshot gespeichert');
  };

  const changeLayout = (next: number) => {
    setLayout(next);
    coreRef.current?.setLayout(next);
  };

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
      remembered: depthRef.current?.rememberedCells() ?? 0,
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

  useDoubleTapGuard(rootRef);

  return (
    <main class={spec.hasTouchScreen ? 'screen player is-overlaid' : 'screen player'} ref={rootRef}>
      <div class="player-stage">
        <canvas
          key={depthMode && depthAvailable ? 'depth' : 'flat'}
          ref={canvasRef}
          class="player-canvas"
          width={spec.width}
          height={spec.height}
          // Reports the same gate the pointer handlers above are attached
          // under, so what the console receives can be read off the page.
          data-touchscreen={
            spec.hasTouchScreen ? (touchScreenLive ? 'an' : 'aus') : undefined
          }
        />

        {spec.hasTouchScreen && phase === 'running' && !menuOpen && (
          <div class="stage-tools">
            {/* Hiding the buttons takes the menu with them, so it comes along. */}
            {controlsHidden && (
              <button type="button" class="stage-tool" onClick={() => void openMenu()}>
                Menü
              </button>
            )}
            <button
              type="button"
              class="stage-tool"
              aria-pressed={controlsHidden}
              onClick={() => setControlsHidden(!controlsHidden)}
            >
              {controlsHidden ? 'Tasten einblenden' : 'Tasten ausblenden'}
            </button>
          </div>
        )}

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
            <button type="button" class="ghost-button" onClick={() => void takeScreenshot()}>
              Screenshot
            </button>
            {shotNotice && <p class="footnote">{shotNotice}</p>}
            <button type="button" class="ghost-button" onClick={() => void exit()}>
              Speichern und beenden
            </button>

            {spec.layouts && spec.layouts.length > 1 && (
              <section class="slots-panel">
                <h2>Bildschirme</h2>
                <div class="segmented" role="group">
                  {spec.layouts.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      class={layout === option.id ? 'segment is-active' : 'segment'}
                      aria-pressed={layout === option.id}
                      onClick={() => changeLayout(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <SaveSlots gameId={game.id} onSave={saveToSlot} onLoad={loadFromSlot} />

            <DepthControls
              enabled={depthMode}
              available={depthAvailable}
              unavailableReason={
                spec.supportsDepth
                  ? 'Braucht Cross-Origin-Isolation. Starte die App vom Home-Bildschirm.'
                  : `Für ${spec.label} nicht gebaut — der Tiefen-Renderer braucht Ebenen aus Kacheln.`
              }
              settings={depthSettings}
              raisedTiles={depthStats.raised}
              learning={depthStats.learning}
              rememberedCells={depthStats.remembered}
              onToggle={changeDepthMode}
              onChange={changeDepthSettings}
            />

            <p class="footnote">
              {rewind.available
                ? `Rücklauf: bis zu ${Math.round(rewind.seconds)} s`
                : 'Rücklauf für dieses System nicht möglich — die Zwischenstände sind zu groß'}
            </p>
            <p class="footnote fps-readout">{fps.toFixed(0)} fps</p>
          </Overlay>
        )}
      </div>

      {!controlsHidden && (
      <TouchControls
        input={inputRef.current}
        buttons={spec.buttons}
        actions={rewind.available ? ['rewind', 'fastForward'] : ['fastForward']}
        onAction={onAction}
        onMenu={() => void openMenu()}
        disabled={phase !== 'running' || menuOpen}
      />
      )}
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


/**
 * Stops iOS from zooming the page on a double tap.
 *
 * `touch-action` is supposed to settle this, and it is set on the player and
 * on the controls — but on iOS a double tap in the gaps between buttons, or on
 * the strip below them, still zooms. A zoomed page moves everything out from
 * under the player's thumbs mid-game, which is about the worst moment for it.
 *
 * The reliable remedy is to refuse the second tap's default action. Only the
 * second one of a quick pair is refused, so a single tap still activates a
 * button normally; the pair has to land close together, so two deliberate taps
 * in different places are left alone.
 */
function useDoubleTapGuard(ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    /** How close in time and space two taps must be to count as a double tap. */
    const WINDOW_MS = 350;
    const RADIUS_PX = 40;

    let lastTime = 0;
    let lastX = 0;
    let lastY = 0;

    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) return;
      const now = event.timeStamp;
      const near =
        Math.abs(touch.clientX - lastX) < RADIUS_PX &&
        Math.abs(touch.clientY - lastY) < RADIUS_PX;

      if (now - lastTime < WINDOW_MS && near && event.cancelable) {
        event.preventDefault();
        // Reset, so a third tap is a first tap again and a rapid series of
        // presses does not go permanently dead.
        lastTime = 0;
        return;
      }
      lastTime = now;
      lastX = touch.clientX;
      lastY = touch.clientY;
    };

    element.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => element.removeEventListener('touchend', onTouchEnd);
  }, [ref]);
}
