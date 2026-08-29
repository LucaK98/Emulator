/**
 * The 2.5D panel in the pause menu.
 *
 * Every value is adjustable because the effect depends on the game: a title
 * that leans on tile priority reads beautifully at a steep angle, another looks
 * better nearly flat. Flat is always one tap away.
 */

import type { DepthSettings } from '../render/Depth25DRenderer';

interface Props {
  enabled: boolean;
  available: boolean;
  unavailableReason: string;
  settings: DepthSettings;
  /** Tiles the height model currently considers raised. */
  raisedTiles: number;
  learning: boolean;
  /** Tiles of world remembered from walking around, including past sessions. */
  rememberedCells: number;
  onToggle: (enabled: boolean) => void;
  onChange: (settings: DepthSettings) => void;
}

export function DepthControls({
  enabled,
  available,
  unavailableReason,
  settings,
  raisedTiles,
  learning,
  rememberedCells,
  onToggle,
  onChange,
}: Props) {
  if (!available) {
    return (
      <section class="depth-panel">
        <h2>2.5D</h2>
        <p class="muted">{unavailableReason}</p>
      </section>
    );
  }

  return (
    <section class="depth-panel">
      <h2>2.5D</h2>

      <button
        type="button"
        class={enabled ? 'primary-button' : 'ghost-button'}
        onClick={() => onToggle(!enabled)}
      >
        {enabled ? '2.5D an' : '2.5D aus'}
      </button>

      {enabled && (
        <>
          <Slider
            label="Kamerawinkel"
            min={25}
            max={90}
            step={1}
            value={settings.tiltDegrees}
            format={(v) => `${v.toFixed(0)}°`}
            onInput={(tiltDegrees) => onChange({ ...settings, tiltDegrees })}
          />
          <Slider
            label="Höhe"
            min={0}
            max={32}
            step={1}
            value={settings.extrusion}
            format={(v) => v.toFixed(0)}
            onInput={(extrusion) => onChange({ ...settings, extrusion })}
          />
          <Slider
            label="Figuren aufrichten"
            min={0}
            max={1}
            step={0.05}
            value={settings.stand}
            format={(v) => `${Math.round(v * 100)} %`}
            onInput={(stand) => onChange({ ...settings, stand })}
          />
          <Slider
            label="Schatten"
            min={0}
            max={0.8}
            step={0.05}
            value={settings.shadow}
            format={(v) => `${Math.round((v / 0.8) * 100)} %`}
            onInput={(shadow) => onChange({ ...settings, shadow })}
          />

          <p class="footnote heights-readout">
            {describeHeights(raisedTiles)}
            {learning ? ' · lernt' : ' · Lernen pausiert'}
          </p>
          <p class="footnote world-readout" data-cells={rememberedCells}>
            {describeWorld(rememberedCells)}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * How much explored world is being drawn from.
 *
 * Worth showing: the wide view is earned by walking, and kept between
 * sessions, so a number that grows explains itself where a picture that simply
 * gets bigger does not.
 */
function describeWorld(cells: number): string {
  if (cells === 0) return 'Karte: noch nichts erkundet';
  // A Game Boy screen is 20 by 18 tiles; screens are a friendlier unit here.
  const screens = cells / (20 * 18);
  if (screens < 1.5) return 'Karte: knapp ein Bildschirm erkundet';
  return `Karte: rund ${Math.round(screens)} Bildschirme erkundet`;
}

function describeHeights(count: number): string {
  if (count === 0) return 'Noch keine Kachel steht';
  return count === 1 ? '1 Kachel steht' : `${count} Kacheln stehen`;
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  format,
  onInput,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onInput: (value: number) => void;
}) {
  return (
    <label class="slider">
      <span class="slider-label">
        {label}
        <span class="slider-value">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(event) => onInput(Number((event.currentTarget as HTMLInputElement).value))}
      />
    </label>
  );
}
