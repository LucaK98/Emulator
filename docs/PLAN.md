# Plan: Privater Multi-System-Emulator als iPhone-PWA

## Context

Das Repo `LucaK98/Emulator` ist komplett leer (kein einziger Commit) — reines Greenfield. Ziel ist ein privater Emulator, der auf dem iPhone läuft, ROMs lokal vom Gerät lädt, Spielstände dauerhaft behält (auch nach App-/Browser-Schließen) und ein 2.5D-Tiefen-Feature für Game-Boy-Spiele mitbringt.

**Entschiedener Scope (nach Rückfrage):**
- **Systeme:** Game Boy, Game Boy Color, Game Boy Advance, Nintendo DS. **3DS ist gestrichen** — es existiert kein funktionierender WASM-Port von Citra/Azahar, und 3DS-Emulation braucht JIT plus eine GPU-Shader-Pipeline, die im Browser nicht erreichbar ist. Auf dem iPhone läuft 3DS heute ausschließlich über nativ sideloadete Apps mit JIT-Hook (Folium, Manic EMU), und selbst dort ist JIT seit iOS 26 brüchig.
- **Form:** Installierbare PWA (statische Seite, WASM-Cores), gehostet auf GitHub Pages.
- **2.5D:** generisch für **alle** GB/GBC-Spiele, ohne spielspezifische Profile.

**Warum PWA und nicht nativ:** kein Mac/Xcode nötig, keine 7-Tage-Signatur-Erneuerung, ein `git push` deployt. Der Preis ist das fehlende JIT — für GB/GBC/GBA irrelevant, für DS spürbar (2D-Titel laufen auf A14+ mit 60 fps, 3D-lastige Titel je nach Spiel knapp darunter).

---

## Architektur

```
Main-Thread                          Worker (pro Core)
├── UI (Preact + TS)                 ├── WASM-Core (SameBoy / mGBA / melonDS)
├── WebGL2-Renderer                  ├── Emulations-Loop (frei laufend)
│   ├── Plain2D  (alle Systeme)      └── schreibt in SharedArrayBuffer:
│   └── Depth25D (GB/GBC)                ├── Framebuffer(s)
├── AudioWorklet (Ring-Buffer)           ├── Audio-Ring-Buffer
├── Input (Touch + Gamepad API)          └── Layer-/Debug-Buffer (nur GB)
└── Storage (OPFS + IndexedDB)       ← Input via Atomics/SAB
```

**Stack:** Vite + TypeScript + Preact (klein, kein React-Overhead), Ausgabe = rein statische Dateien.

### Cross-Origin-Isolation (kritisch)
`SharedArrayBuffer` verlangt COOP/COEP-Header, die GitHub Pages nicht setzen kann. Lösung: **`coi-serviceworker`** — ein Service Worker, der die Header client-seitig injiziert und die Seite einmal neu lädt. Muss vor allem anderen registriert werden. Fallback ohne SAB: Core auf dem Main-Thread mit `postMessage`-Transfer (funktioniert, ~15 % langsamer) — als Notpfad implementieren, damit die App nie komplett ausfällt.

### Cores

| System | Core | Quelle | Aufwand |
|---|---|---|---|
| GB/GBC | **SameBoy**, gepatcht | MIT, Emscripten-Build selbst erstellen | mittel — der Patch ist der Kern des 2.5D-Features |
| GBA | **mGBA** | `@thenick775/mgba-wasm` (fertig, treibt gbajs3) | klein |
| NDS | **melonDS** | `44670/melonDS-wasm` bzw. der `ds-anywhere`-Fork | mittel — Build-Pipeline + Perf-Tuning |

SameBoy wird bewusst nicht durch einen fertigen JS-Core ersetzt: das 2.5D-Feature braucht Zugriff auf die PPU-Interna (welcher Layer, welche Tile-ID, welches Priority-Bit hat diesen Pixel erzeugt), und SameBoy hat dafür bereits eine saubere, per-Pixel arbeitende Fetcher-Implementierung plus Debugger-APIs.

**Lizenz:** melonDS ist GPL-3.0. Sobald der DS-Core mit ausgeliefert wird, muss das gesamte verteilte Bundle GPL-3.0-kompatibel sein. SameBoy (MIT) und mGBA (MPL-2.0) sind das. → Repo unter **GPL-3.0** lizenzieren.

---

## Das 2.5D-Feature (generisch, ohne Spielprofile)

Der Ansatz: der Core komponiert nicht mehr blind zu einem 2D-Bild, sondern gibt die PPU-Ebenen getrennt heraus. Der Renderer baut daraus eine echte 3D-Szene. Das entspricht dem Vorgehen von „Pokémon R3D", aber ohne handgepflegte Tile-Tabelle.

**SameBoy-Patch — pro Frame zusätzlich exportieren:**
- BG-Layer, Window-Layer, OBJ-Layer als je eigene RGBA-Textur (160×144, transparent wo der Layer nichts zeichnet)
- Pro Pixel ein 32-Bit-Attributwort: Quell-Layer, Tile-ID, ob das BG-Priority-Bit gesetzt war
- Pro Scanline die Scroll-Register `SCX`/`SCY`/`WX`/`WY` (viele Spiele ändern die mitten im Frame)
- Sprite-Tabelle des Frames: X/Y/Tile/Attribute je sichtbarem OBJ

**Renderer (WebGL2), rein aus Hardware-Zustand abgeleitet:**
1. **Boden:** BG-Layer als texturiertes Quad, nach hinten weggekippt, perspektivische Kamera. Scanline-Scroll erzeugt echten Parallax statt eines starren Bildes.
2. **Figuren:** Jeder Hardware-Sprite wird ein aufrecht stehendes Billboard auf der Bodenebene an seiner BG-Position — dadurch „stehen" Charaktere auf, statt flach zu liegen. Z-Sortierung nach Y-Position.
3. **Automatische Extrusion (der eigentliche Trick):** Der Game Boy hat ein OBJ-to-BG-Priority-Bit. Wenn ein BG-Tile *vor* einem Sprite gezeichnet wird, steht dieses Tile im Spiel offensichtlich vor der Figur — also ist es hoch (Baum, Hauswand, Klippe). Der Renderer führt einen laufenden Zähler pro Tile-ID: wie oft wurde diese Tile-ID mit Priorität vor einem Sprite gezeichnet? Daraus ergibt sich eine Höhe zwischen 0 und 1, die als Extrusion in die Geometrie geht. Das lernt sich im Spielverlauf von selbst an, braucht **keine** Spielkenntnis und funktioniert in jedem GB-Titel, der Sprite-Priorität benutzt.
4. **Schatten:** einfache Shadow-Map von den Sprite-Billboards auf den extrudierten Boden.
5. **HUD:** Der Window-Layer (Textboxen, Statusleisten) wird flach im Screen-Space darübergelegt, kameraunabhängig — genau das, wofür Spiele ihn benutzen.

**UI-Kontrolle:** Slider für Kamerawinkel, Höhe, FOV, Extrusionsstärke, Schattenintensität; ein Umschalter „Flach / 2.5D" pro Spiel, gespeichert in den Spieleinstellungen. Da die Heuristik nicht in jedem Titel gleich gut greift, ist der Flach-Modus jederzeit einen Tap entfernt.

**Später erweiterbar:** GBA hat vier separate BG-Layer mit eigenen Prioritäten — dasselbe Prinzip greift dort noch sauberer. Bewusst nicht in Phase 3.

---

## Speicherstände & Persistenz

Das ist auf iOS der Punkt, an dem solche Projekte scheitern. Zwei Gefahren: Safari löscht Web-Daten nach **7 Tagen Inaktivität**, und iOS killt Hintergrund-Tabs ohne Vorwarnung.

**Gegenmaßnahmen:**
- **Home-Screen-Installation ist Pflicht.** Mit `display: standalone` im Manifest und einmaligem „Zum Home-Bildschirm hinzufügen" greift die 7-Tage-Löschung nicht mehr. Die App zeigt beim ersten Start in Safari einen nicht wegklickbaren Onboarding-Screen, der genau das erklärt — nicht als Nice-to-have, sondern als Voraussetzung.
- `navigator.storage.persist()` bei **jedem** Start aufrufen (nicht nur einmal), Ergebnis in den Einstellungen als Statusanzeige sichtbar machen.
- **Battery-SRAM:** 2 s nach dem letzten Schreibzugriff debounced in OPFS flushen, zusätzlich hart bei `visibilitychange` (hidden) und `pagehide`.
- **Auto-Savestate:** ebenfalls bei `visibilitychange`/`pagehide` sowie alle 60 s. Beim Start bietet die Bibliothek „Fortsetzen" mit Thumbnail an. Damit ist ein vom System abgeschossener Tab folgenlos.
- **Savestate-Slots:** 8 manuelle Slots pro Spiel plus Auto-Slot, jeder mit PNG-Thumbnail und Zeitstempel.
- **Export/Import:** einzelne `.sav`/`.state` sowie ein vollständiges Backup-ZIP (ROM-Metadaten + alle Saves) über den Share-Sheet in die Dateien-App. Der Sicherheitsgurt, falls doch mal Daten verloren gehen.

**Speicherorte:** ROM-Blobs und Savestates in **OPFS** (schnell, für große Dateien gebaut, Safari 16.4+); Bibliotheks-Index, Einstellungen und Thumbnails in **IndexedDB**. ROMs kommen über `<input type="file">` (Dateien-App, iCloud, AirDrop) und Drag & Drop hinein, werden per Header/Hash identifiziert und verlassen das Gerät nie.

---

## iPhone-UX

- `viewport-fit=cover` + `env(safe-area-inset-*)`, `user-scalable=no`, `overscroll-behavior: none`, `touch-action: none`, `-webkit-touch-callout: none` — kein Gummiband-Scrollen, kein Doppeltipp-Zoom, keine Textauswahl beim Hämmern auf das D-Pad.
- **Touch-Controls:** Pointer-Events mit `setPointerCapture`, echtes Multitouch, diagonale D-Pad-Zonen, konfigurierbare Größe/Position/Deckkraft. **Hinweis:** iOS Safari unterstützt die Vibration API nicht — es gibt kein haptisches Feedback. Ersatz: kurzer visueller Tastenglow (optional abschaltbar).
- **Layouts:** Hochkant = Bildschirm oben, Controls unten. Quer = Bildschirm zentriert, Controls halbtransparent links/rechts überlagert. DS zusätzlich: gestapelt, nebeneinander, „nur unten groß".
- **DS-Touchscreen:** Tap/Drag auf dem unteren Screen wird auf die DS-Touch-Koordinaten gemappt; im Quer-Layout mit korrekter Skalierung.
- **Controller:** Gamepad API funktioniert in iOS Safari — MFi, DualSense, Xbox koppeln sich per Bluetooth und werden mit Remapping-UI unterstützt.
- **Audio:** AudioWorklet mit Lock-free-Ring-Buffer, Start erst nach User-Geste. `navigator.audioSession.type = 'playback'` setzen, damit der stumm geschaltete Klingelton-Schalter das Spiel nicht mitstummschaltet.
- **Bibliothek:** Kachelraster mit Screenshot-Thumbnails aus dem Auto-Savestate, „Zuletzt gespielt" oben, Wischen zum Löschen, Suche.
- Fast-Forward (Halten) und Rewind (Ringpuffer aus komprimierten Savestates) als Komfort in der letzten Phase.

---

## Repo-Struktur

```
/                       Vite-Root, statischer Build
├─ src/
│  ├─ app/              UI: Bibliothek, Player, Einstellungen, Onboarding
│  ├─ core/             Worker-Bridge, gemeinsames Core-Interface, SAB-Layout
│  ├─ cores/{gb,gba,nds}/  Worker + Glue je Core
│  ├─ render/           WebGL2: Plain2D, Depth25D, Shader
│  ├─ audio/            AudioWorklet + Ring-Buffer
│  ├─ input/            Touch-Overlay, Gamepad, Keymap
│  └─ storage/          OPFS, IndexedDB, Save-Manager, Backup
├─ vendor/sameboy/      Submodul + Emscripten-Patch (Layer-Export)
├─ scripts/build-cores/ Docker-basierte Emscripten-Builds
├─ public/              Manifest, Icons, coi-serviceworker.js
├─ tests/               Vitest + Playwright, Test-ROMs (Homebrew)
└─ .github/workflows/   CI + Pages-Deploy
```

Keine ROMs im Repo — `.gitignore` blockt `*.gb *.gbc *.gba *.nds *.sav *.state`. Die einzigen mitgelieferten ROMs sind frei verteilbare Homebrew-Test-ROMs für die Tests.

---

## Umsetzung in Phasen

**Phase 0 — Fundament**
Vite/TS/Preact-Scaffold, GPL-3.0-Lizenz, PWA-Manifest + Service Worker, `coi-serviceworker`, GitHub-Actions-Deploy auf Pages, Onboarding-Screen mit Home-Screen-Anleitung. Ergebnis: leere, aber installierbare App auf dem iPhone.

**Phase 1 — GB/GBC spielbar**
SameBoy als Submodul, Emscripten-Build-Skript, Worker-Bridge mit SAB, WebGL2-`Plain2D`-Renderer, AudioWorklet, Touch-Controls, ROM-Import, Battery-SRAM-Persistenz. Ergebnis: Pokémon Rot läuft mit Ton und Speicherung auf dem iPhone.

**Phase 2 — Persistenz & Bibliothek**
Savestate-Slots mit Thumbnails, Auto-Savestate auf `pagehide`, „Fortsetzen"-Flow, Export/Import + Backup-ZIP, Bibliotheks-UI, Gamepad-Support, Einstellungen. Ergebnis: nichts geht mehr verloren, egal wie die App geschlossen wird.

**Phase 3 — 2.5D**
SameBoy-Patch für Layer-/Attribut-/Scanline-Export, `Depth25D`-Renderer, Priority-basierte Extrusions-Heuristik, Schatten, Kamera-Slider, Umschalter pro Spiel.

**Phase 4 — GBA**
`@thenick775/mgba-wasm` einbinden, Core-Interface bedienen, Layout/Keymap. Geringer Aufwand, da der Rahmen steht.

**Phase 5 — DS**
melonDS-WASM bauen und einbinden, Dual-Screen-Layouts, Touchscreen-Mapping, Performance-Tuning (Frameskip, Auflösungsskalierung). Ehrliche Erwartung: 2D-Titel flüssig, 3D-Titel je nach Spiel.

**Phase 6 — Feinschliff**
Rewind, Fast-Forward, LCD-Shader, Screenshot-Funktion, Bugfixing auf dem echten Gerät.

---

## Verifikation

**Automatisiert (läuft hier im Container, Chromium + Playwright sind vorinstalliert):**
- **Core-Korrektheit:** Blargg `cpu_instrs`/`instr_timing` und `dmg-acid2` als frei verteilbare Test-ROMs headless laufen lassen; Ergebnis-Framebuffer gegen Referenz-Hash prüfen. Ein grüner `cpu_instrs`-Durchlauf ist der Beweis, dass der Patch die CPU nicht kaputt gemacht hat.
- **Persistenz-Test:** Playwright mit iPhone-Viewport → ROM laden, 300 Frames laufen, Savestate schreiben, Seite neu laden, Savestate wiederherstellen, Framebuffer muss identisch sein. Zusätzlich der Pfad über `pagehide` (Auto-Savestate).
- **2.5D-Regression:** Screenshot-Vergleich des `Depth25D`-Renderers bei fixem Frame und fixen Kameraparametern.
- **Layout:** Playwright-Screenshots bei iPhone-SE-, 15-Pro- und 15-Pro-Max-Viewport, hoch und quer, mit Safe-Area-Simulation — fängt abgeschnittene Controls unter der Home-Indicator-Leiste.
- CI führt Lint, Typecheck, Vitest und die Playwright-Suite bei jedem Push aus.

**Manuell auf dem Gerät (nur du kannst das):**
1. Pages-URL in Safari öffnen → „Zum Home-Bildschirm hinzufügen" → App vom Home-Screen starten, Standalone prüfen.
2. ROM aus der Dateien-App importieren, spielen, Ton mit stumm geschaltetem Klingelton-Schalter prüfen.
3. App per App-Switcher hart schließen, eine Minute warten, neu starten → „Fortsetzen" muss exakt an der Stelle weitermachen.
4. Nach 8+ Tagen ohne Öffnen erneut starten → Daten müssen noch da sein (Beweis, dass die Home-Screen-Installation greift).
5. Bluetooth-Controller koppeln, 2.5D in einem Pokémon-Titel und in einem Nicht-Pokémon-Titel bewerten.

---

## Bekannte Risiken

- **DS-Performance** ist die größte Unbekannte. Ohne JIT hängt alles am iPhone-Modell. Falls melonDS zu langsam ist: DeSmuME-WASM als Alternative testen, sonst Frameskip/Auflösungsskalierung.
- **Die 2.5D-Heuristik greift nicht überall.** Spiele, die BG-Priorität kaum nutzen, sehen flach aus. Deshalb der Ein-Tap-Umschalter und die Slider — kein Modus wird erzwungen.
- **`coi-serviceworker`** ist ein Workaround; falls Safari ihn bricht, greift der Main-Thread-Fallback ohne SAB.
- **OPFS auf iOS** hat Speicherquoten, die vom freien Gerätespeicher abhängen. Die App zeigt Verbrauch und Quote in den Einstellungen an und warnt vor dem Import, wenn es eng wird.
