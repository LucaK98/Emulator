/**
 * Install gate shown when the app runs in an iOS Safari tab.
 *
 * This is not decoration: WebKit clears script-writable storage after seven
 * days of inactivity for ordinary sites, and only exempts pages added to the
 * home screen with a standalone display mode. A tab-launched install would
 * silently lose save games, so installation is presented as a requirement
 * rather than a suggestion.
 */

interface Props {
  onContinueAnyway: () => void;
}

/** The iOS share-sheet glyph, so the instructions point at something visible. */
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" class="inline-icon">
      <path
        d="M12 3v12M12 3l-4 4M12 3l4 4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function Onboarding({ onContinueAnyway }: Props) {
  return (
    <main class="screen onboarding">
      <div class="onboarding-card">
        <h1>Zum Home-Bildschirm hinzufügen</h1>
        <p class="lede">
          Safari löscht Website-Daten nach sieben Tagen ohne Nutzung. Nur als installierte App
          bleiben deine Spielstände dauerhaft erhalten.
        </p>

        <ol class="steps">
          <li>
            Tippe unten in Safari auf <ShareIcon /> <strong>Teilen</strong>.
          </li>
          <li>
            Wähle <strong>Zum Home-Bildschirm</strong>.
          </li>
          <li>
            Starte den Emulator ab jetzt <strong>über das Symbol auf dem Home-Bildschirm</strong>,
            nicht mehr über Safari.
          </li>
        </ol>

        <p class="footnote">
          Deine ROMs und Spielstände bleiben dabei ausschließlich auf diesem Gerät.
        </p>

        <button type="button" class="ghost-button" onClick={onContinueAnyway}>
          Ohne Installation fortfahren
        </button>
        <p class="warning">Spielstände können dann nach sieben Tagen verloren gehen.</p>
      </div>
    </main>
  );
}
