# Emulator

Ein privater Emulator für **Game Boy, Game Boy Color, Game Boy Advance und Nintendo DS**, gebaut als installierbare Web-App (PWA) für das iPhone. ROMs und Spielstände bleiben ausschließlich auf dem Gerät.

Das besondere Feature ist ein **2.5D-Renderer für Game-Boy-Spiele**: der Core gibt die PPU-Ebenen getrennt aus, der Renderer baut daraus eine echte 3D-Szene mit Kamera, Tiefe und Schatten.

> **3DS wird nicht unterstützt.** Es gibt keinen funktionierenden WebAssembly-Port von Citra/Azahar, und 3DS-Emulation braucht JIT plus eine GPU-Pipeline, die im Browser nicht erreichbar ist. Auf dem iPhone läuft 3DS heute nur über nativ sideloadete Apps.

## Status

| Phase | Inhalt | Stand |
| --- | --- | --- |
| 0 | Fundament: PWA-Shell, Cross-Origin-Isolation, Speicher-Persistenz, CI/Deploy | ✅ fertig |
| 1 | Game Boy / Color spielbar (SameBoy-Core, Renderer, Audio, Touch-Controls) | ✅ fertig |
| 2 | Savestate-Slots, Export/Import, Controller-Support | offen |
| 3 | 2.5D-Renderer für Game Boy / Color | ✅ fertig |
| 4 | Game Boy Advance (mGBA) | offen |
| 5 | Nintendo DS (melonDS) | offen |
| 6 | Feinschliff: Rewind, Fast-Forward, Shader | offen |

## Auf dem iPhone einrichten

1. Die Pages-URL des Repos in **Safari** öffnen.
2. Auf **Teilen → Zum Home-Bildschirm** tippen.
3. Den Emulator ab jetzt **über das Home-Bildschirm-Symbol** starten, nicht mehr über Safari.

Schritt 2 ist keine Kür. Safari löscht Website-Daten nach sieben Tagen ohne Nutzung; nur eine zum Home-Bildschirm hinzugefügte App mit `display: standalone` ist davon ausgenommen. Die App blockiert deshalb den Start in einem Safari-Tab und erklärt den Schritt. Zusätzlich wird bei jedem Start `navigator.storage.persist()` angefragt — der aktuelle Stand steht im Systemstatus.

## Wie es funktioniert

**Cores.** Game Boy und Game Boy Color laufen auf [SameBoy](https://github.com/LIJI32/SameBoy) (Submodul unter `vendor/sameboy`, auf `v1.0.3` gepinnt), übersetzt nach WebAssembly. Der Wrapper in `native/gb/sameboy_wasm.c` hält Frame- und Audiopuffer als statischen Speicher, damit die JavaScript-Seite direkt aus dem WASM-Heap liest. SameBoys eigene Boot-ROMs werden aus dem Quelltext assembliert und ins Modul eingebettet.

**Threads.** Ein Worker besitzt den Core und die Uhr. Bild und Ton wandern über einen `SharedArrayBuffer`: der Renderer liest die Pixel, die der Worker hineingeschrieben hat, und das AudioWorklet leert den Ringpuffer auf dem Audio-Thread, ohne den Main-Thread zu wecken.

**Taktung.** Das Audiogerät ist die Uhr. Ein Frame wird emuliert, wenn im Ringpuffer Platz für den Ton ist, den er erzeugt — dadurch läuft die Emulation ohne Drift synchron zur Ausgabe. Wenn nichts abgespielt wird (stummes Gerät, angehaltener AudioContext, Headless-Browser), erkennt der Worker den stehenden Ring, verwirft den Rückstau und taktet auf die Wanduhr um: das Spiel läuft dann still weiter, statt einzufrieren.

**2.5D.** Der Renderer arbeitet nicht mit dem fertigen Bild, sondern baut die Szene aus dem PPU-Zustand neu auf: Der Hintergrund wird ein Raster aus Blöcken, jeder Hardware-Sprite ein aufrecht stehendes Billboard mit Schatten, und die Fenster-Ebene bleibt flach obenauf — dort liegen Textboxen und Statusleisten, die gehören auf die Scheibe, nicht in die Welt. Die Farben kommen aus den Paletten, die der Core ohnehin schon auflöst, deshalb sieht eine Szene außer der Perspektive genauso aus wie flach.

**Wie die Höhen entstehen.** Nirgendwo in einem Game-Boy-Modul steht, wie hoch eine Kachel ist, und der Sinn des Features ist ja, dass es ohne spielspezifische Tabellen funktioniert. Also wird die Höhe aus etwas abgeleitet, das die Hardware sehr wohl verrät: wo Figuren sein können. Eine Kachel, auf der schon jemand stand, ist Boden — durch einen Baum läuft man nicht. Eine Kachel, die ständig zu sehen ist, auf der aber nie jemand steht, ist Wand, Baum, Klippe oder Wasser. Dieses eine Signal trennt eine Oberwelt von selbst in Boden und Kulisse.

Damit das nicht in Menüs und Kämpfen losgeht — die sind voll von Kacheln, auf denen niemand steht — lernt das Modell nur, solange die Karte tatsächlich scrollt und Sprites da sind. Ein einmaliges Verschieben der Scroll-Register beim Bildaufbau reicht nicht; es zählt anhaltende Bewegung. Wissen verfällt langsam, damit eine Höhle neu gelernt wird statt alte Höhen mitzuschleppen, und Höhen ändern sich schrittweise, damit nichts springt.

Der Effekt ist nicht in jedem Spiel gleich stark, deshalb liegen Ein/Aus, Kamerawinkel, Höhe, Aufrichtung und Schatten als Regler im Pausenmenü, und der flache Modus ist immer einen Tipp entfernt.

**Speichern.** Zwei Mechanismen laufen parallel. Batteriegepufferter Cartridge-RAM wird alle zwei Sekunden mit dem Gespeicherten verglichen und nur bei Änderung geschrieben. Zusätzlich entsteht bei `pagehide` und `visibilitychange` ein automatischer Savestate — das ist der letzte Moment, den iOS zusichert, bevor es eine App im Hintergrund abräumt. Beim erneuten Öffnen wird dieser Stand wiederhergestellt.

## Cores neu bauen

Die fertigen WASM-Cores liegen unter `public/cores/` **im Repo**. Weder CI noch das Pages-Deployment brauchen deshalb eine Emscripten-Toolchain. Neu bauen musst du sie nur, wenn du das Submodul oder den Wrapper änderst:

```bash
git submodule update --init --recursive
source /pfad/zu/emsdk/emsdk_env.sh        # Emscripten
RGBDS_DIR=/pfad/zu/rgbds \
  ./scripts/build-cores/build-sameboy.sh  # baut Boot-ROMs + sameboy.wasm
```

[RGBDS](https://github.com/gbdev/rgbds) wird gebraucht, weil SameBoys Boot-ROMs Assembler-Quelltext sind.

## Entwicklung

```bash
npm install
npm run dev          # Dev-Server, setzt COOP/COEP-Header direkt
npm run build        # Typecheck + Produktions-Build nach dist/
npm run preview      # dist/ lokal servieren
npm run typecheck
npm test             # Unit-Tests (Vitest)
npm run test:e2e     # Browser-Tests (Playwright)
npm run gen:icons    # PWA-Icons neu erzeugen (stdlib-Python, kein Pillow nötig)
```

Die Unit-Tests fahren den gebauten Core direkt in Node:

- **Core-Genauigkeit** gegen blarggs Hardware-Test-ROMs (`cpu_instrs`, `instr_timing`) plus einen Savestate-Round-Trip.
- **Ebenen-Dekoder** gegen den Emulator selbst: Die aus VRAM und OAM zurückgewonnenen Ebenen werden wieder flach zusammengesetzt und müssen das Bild des Cores **pixelgenau** treffen. Dafür gibt es `tests/roms/ppu-probe.gb`, das gezielt signierte Kachel-Adressierung, versetztes Scrolling, ein Fenster und 8×16-Sprites mit Flips und Priorität benutzt.
- **Höhenmodell** gegen `tests/roms/overworld-probe.gb`, eine scrollende Karte mit einer Figur, die einen Korridor aus Bodenkacheln entlangläuft. Im ROM steht nirgends, welche Kachel Kulisse ist — der Test verlangt, dass genau die Kulisse steht und der Boden flach bleibt.

Die Browser-Tests importieren eine ROM, spielen sie, beenden und laden neu (der Spielstand muss den Reload überleben) und schalten 2.5D ein, prüfen dass sich das Bild ändert und dass das Modell die richtige Kachel anhebt.

Läuft in einer Umgebung bereits ein Chromium, kann Playwright ihn statt eines eigenen Downloads verwenden:

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

### Cross-Origin-Isolation

Die Emulator-Worker reichen Framebuffer und Audio über einen `SharedArrayBuffer` an den Main-Thread. Den gibt der Browser nur frei, wenn das Dokument cross-origin-isoliert ist (COOP + COEP).

- **Dev/Preview:** Vite setzt die Header direkt (siehe `vite.config.ts`).
- **Produktion auf GitHub Pages:** Pages kann keine eigenen Header ausliefern. `public/sw.js` hängt sie deshalb als Service Worker an jede Antwort und lädt die Seite einmal neu.

Klappt das nicht, läuft die App trotzdem — der Core fällt dann auf Kopieren per `postMessage` zurück. Der Systemstatus zeigt an, welcher Weg aktiv ist.

## Deployment

`.github/workflows/deploy.yml` baut bei jedem Push auf `main` mit `BASE_PATH=/<repo>/` und veröffentlicht `dist/` auf GitHub Pages. In den Repo-Einstellungen muss unter *Pages* die Quelle auf **GitHub Actions** stehen.

## ROMs

Es sind keine Spiele im Repo, und es werden auch keine hinzugefügt — `.gitignore` blockt die entsprechenden Endungen. Spiele werden über den Datei-Import aus der Dateien-App geladen und verlassen das Gerät nie. Die einzige Ausnahme sind frei verteilbare Homebrew-Test-ROMs unter `tests/roms/`, die zur Prüfung der Core-Genauigkeit dienen.

## Lizenz

GPL-3.0-or-later (siehe [`LICENSE`](LICENSE)).

Die Lizenz ist durch die eingebundenen Cores bestimmt: melonDS steht unter GPL-3.0, was für das gesamte ausgelieferte Bundle gilt. SameBoy (MIT) und mGBA (MPL-2.0) sind damit vereinbar.
