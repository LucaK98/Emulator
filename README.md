# Emulator

Ein privater Emulator für **Game Boy, Game Boy Color, Game Boy Advance und Nintendo DS**, gebaut als installierbare Web-App (PWA) für das iPhone. ROMs und Spielstände bleiben ausschließlich auf dem Gerät.

Alle vier Systeme laufen.

Das besondere Feature ist ein **2.5D-Renderer für Game-Boy-Spiele**: der Core gibt die PPU-Ebenen getrennt aus, der Renderer baut daraus eine echte 3D-Szene mit Kamera, Tiefe und Schatten.

> **3DS wird nicht unterstützt.** Es gibt keinen funktionierenden WebAssembly-Port von Citra/Azahar, und 3DS-Emulation braucht JIT plus eine GPU-Pipeline, die im Browser nicht erreichbar ist. Auf dem iPhone läuft 3DS heute nur über nativ sideloadete Apps.

## Status

| Phase | Inhalt | Stand |
| --- | --- | --- |
| 0 | Fundament: PWA-Shell, Cross-Origin-Isolation, Speicher-Persistenz, CI/Deploy | ✅ fertig |
| 1 | Game Boy / Color spielbar (SameBoy-Core, Renderer, Audio, Touch-Controls) | ✅ fertig |
| 2 | Savestate-Slots, Export/Import, Controller-Support | ✅ fertig |
| 3 | 2.5D-Renderer für Game Boy / Color | ✅ fertig |
| 4 | Game Boy Advance (mGBA) | ✅ fertig |
| 5 | Nintendo DS (melonDS) | ✅ fertig |
| 6 | Feinschliff: Rewind, Fast-Forward, Shader | offen |

## Auf dem iPhone einrichten

1. Die Pages-URL des Repos in **Safari** öffnen.
2. Auf **Teilen → Zum Home-Bildschirm** tippen.
3. Den Emulator ab jetzt **über das Home-Bildschirm-Symbol** starten, nicht mehr über Safari.

Schritt 2 ist keine Kür. Safari löscht Website-Daten nach sieben Tagen ohne Nutzung; nur eine zum Home-Bildschirm hinzugefügte App mit `display: standalone` ist davon ausgenommen. Die App blockiert deshalb den Start in einem Safari-Tab und erklärt den Schritt. Zusätzlich wird bei jedem Start `navigator.storage.persist()` angefragt — der aktuelle Stand steht im Systemstatus.

## Wie es funktioniert

**Cores.** Game Boy und Game Boy Color laufen auf [SameBoy](https://github.com/LIJI32/SameBoy) (`v1.0.3`), der Game Boy Advance auf [mGBA](https://github.com/mgba-emu/mgba) (`0.10.5`), der Nintendo DS auf [melonDS](https://github.com/melonDS-emu/melonDS) (`1.0rc`) — alle als Submodul unter `vendor/`, nach WebAssembly übersetzt und über ihre öffentliche API angesprochen, also ohne Patch. melonDS bringt einen freien BIOS-Ersatz und erzeugt seine Firmware selbst, deshalb sind keine fremden Systemdateien nötig. Die Wrapper in `native/gb/` und `native/gba/` halten Frame- und Audiopuffer als statischen Speicher, damit die JavaScript-Seite direkt aus dem WASM-Heap liest. SameBoys eigene Boot-ROMs werden aus dem Quelltext assembliert und ins Modul eingebettet.

Beide Wrapper bieten dieselbe Schnittstelle an (ein Frame pro Aufruf, Puffer als Zeiger in den Heap, Speicherdaten als flache Bytes), deshalb gibt es die Taktung, den Shared-Memory-Transport und die Nachrichtenbehandlung nur einmal — in `src/cores/runtime.ts`. Was sich zwischen den Systemen unterscheidet, steht als Spezifikation in `src/core/systems.ts`: Bildgröße, Tastensatz und ob der Core den Tiefen-Renderer bedienen kann.

**Threads.** Ein Worker besitzt den Core und die Uhr. Bild und Ton wandern über einen `SharedArrayBuffer`: der Renderer liest die Pixel, die der Worker hineingeschrieben hat, und das AudioWorklet leert den Ringpuffer auf dem Audio-Thread, ohne den Main-Thread zu wecken.

**Taktung.** Das Audiogerät ist die Uhr. Ein Frame wird emuliert, wenn im Ringpuffer Platz für den Ton ist, den er erzeugt — dadurch läuft die Emulation ohne Drift synchron zur Ausgabe. Wenn nichts abgespielt wird (stummes Gerät, angehaltener AudioContext, Headless-Browser), erkennt der Worker den stehenden Ring, verwirft den Rückstau und taktet auf die Wanduhr um: das Spiel läuft dann still weiter, statt einzufrieren.

**2.5D (nur Game Boy / Color).** Der Renderer arbeitet nicht mit dem fertigen Bild, sondern baut die Szene aus dem PPU-Zustand neu auf: Der Hintergrund wird ein Raster aus Blöcken, jeder Hardware-Sprite ein aufrecht stehendes Billboard mit Schatten, und die Fenster-Ebene bleibt flach obenauf — dort liegen Textboxen und Statusleisten, die gehören auf die Scheibe, nicht in die Welt. Die Farben kommen aus den Paletten, die der Core ohnehin schon auflöst, deshalb sieht eine Szene außer der Perspektive genauso aus wie flach.

**Wie die Höhen entstehen.** Nirgendwo in einem Game-Boy-Modul steht, wie hoch eine Kachel ist, und der Sinn des Features ist ja, dass es ohne spielspezifische Tabellen funktioniert. Also wird die Höhe aus etwas abgeleitet, das die Hardware sehr wohl verrät: wo Figuren sein können. Eine Kachel, auf der schon jemand stand, ist Boden — durch einen Baum läuft man nicht. Eine Kachel, die ständig zu sehen ist, auf der aber nie jemand steht, ist Wand, Baum, Klippe oder Wasser. Dieses eine Signal trennt eine Oberwelt von selbst in Boden und Kulisse.

Damit das nicht in Menüs und Kämpfen losgeht — die sind voll von Kacheln, auf denen niemand steht — lernt das Modell nur, solange die Karte tatsächlich scrollt und Sprites da sind. Ein einmaliges Verschieben der Scroll-Register beim Bildaufbau reicht nicht; es zählt anhaltende Bewegung. Wissen verfällt langsam, damit eine Höhle neu gelernt wird statt alte Höhen mitzuschleppen, und Höhen ändern sich schrittweise, damit nichts springt.

Der Effekt ist nicht in jedem Spiel gleich stark, deshalb liegen Ein/Aus, Kamerawinkel, Höhe, Aufrichtung und Schatten als Regler im Pausenmenü, und der flache Modus ist immer einen Tipp entfernt.

Für den GBA gibt es das noch nicht: Der Tiefen-Renderer liest die Game-Boy-PPU mit ihrer einen Hintergrundebene und 8×8-Kacheln. Der GBA hat vier Ebenen mit eigenen Prioritäten, Rotation und Skalierung — die Idee überträgt sich, aber es ist eigene Arbeit. Das Pausenmenü sagt das an der Stelle, wo sonst der Schalter wäre.

**Zwei Bildschirme.** Der DS-Wrapper setzt beide Bildschirme zu einem Bild zusammen, wahlweise übereinander oder nebeneinander. Beide Anordnungen enthalten genau gleich viele Pixel, deshalb reicht ein Puffer für beide und die Anordnung lässt sich im laufenden Spiel umschalten. Der Renderer bekommt die Bildgröße pro Frame mitgeteilt statt sie aus dem System abzuleiten.

**Touchscreen.** Ein Tipp auf die Zeichenfläche wird zweimal umgerechnet: aus dem Element in das tatsächlich gezeichnete Rechteck, und von dort in den unteren Bildschirm — der je nach Anordnung woanders liegt. Tipper daneben werden verworfen statt geraten.

**Ton beim DS.** Die Game-Boy-Cores lassen sich auf die Rate des AudioContext umstimmen; die DS-Soundhardware nicht. Ihre Ausgabe wird deshalb im Wrapper resampelt, und zwar auf genau eine Frame-Länge pro Bild — dadurch stimmt das Tempo unabhängig von der Hardware-Rate.

**Speichern.** Zwei Mechanismen laufen parallel. Batteriegepufferter Cartridge-RAM wird alle zwei Sekunden mit dem Gespeicherten verglichen und nur bei Änderung geschrieben. Zusätzlich entsteht bei `pagehide` und `visibilitychange` ein automatischer Savestate — das ist der letzte Moment, den iOS zusichert, bevor es eine App im Hintergrund abräumt. Beim erneuten Öffnen wird dieser Stand wiederhergestellt.

Dazu kommen acht Slots von Hand, jeder mit einem Bild des Moments und dem Alter. Speichern und Laden sind getrennte Modi statt zwei Knöpfe pro Slot: Auf einem Telefon werden neun Slots mit je zwei Knöpfen zu klein zum sicheren Treffen, und den falschen Stand zu überschreiben ist der eine Fehler, der wirklich Fortschritt kostet. Der Auto-Slot lässt sich nicht von Hand überschreiben — er ist das Netz der App.

**Sicherung.** Ein Backup ist eine gewöhnliche ZIP-Datei: `manifest.json`, `saves/`, `states/`, optional `roms/`. Der Punkt ist, dass der Fortschritt nicht in einer Browser-Datenbank gefangen ist, die man nicht sehen kann — die Datei geht über das iOS-Teilen-Blatt in die Dateien-App oder nach iCloud, und jeder kann sie öffnen. Spielstände hängen am ROM-Hash, deshalb findet ein eingespielter Stand sein Spiel auch dann wieder, wenn die ROM erst danach importiert wird.

**Controller.** Die Gamepad-API funktioniert in iOS Safari; ein gekoppelter MFi-, DualSense- oder Xbox-Controller taucht dort auf. Die Standardbelegung folgt der Anordnung statt den Beschriftungen: Auf einem Game Boy sitzt A rechts oberhalb von B, auf einem Standard-Controller die rechte Gesichtstaste ebenso zur unteren — so bleibt die Muskelerinnerung über sehr verschieden beschriftete Pads hinweg erhalten. Umbelegen geht in den Einstellungen. Der linke Stick verhält sich immer zusätzlich wie ein Steuerkreuz.

## Cores neu bauen

Die fertigen WASM-Cores liegen unter `public/cores/` **im Repo**. Weder CI noch das Pages-Deployment brauchen deshalb eine Emscripten-Toolchain. Neu bauen musst du sie nur, wenn du das Submodul oder den Wrapper änderst:

```bash
git submodule update --init --recursive
source /pfad/zu/emsdk/emsdk_env.sh        # Emscripten
RGBDS_DIR=/pfad/zu/rgbds \
  ./scripts/build-cores/build-sameboy.sh  # Boot-ROMs + sameboy.wasm
./scripts/build-cores/build-mgba.sh       # mgba.wasm
./scripts/build-cores/build-melonds.sh    # melonds.wasm
```

[RGBDS](https://github.com/gbdev/rgbds) wird nur für den Game-Boy-Core gebraucht, weil SameBoys Boot-ROMs Assembler-Quelltext sind. Der mGBA-Build läuft über dessen eigenes CMake; zwei Emscripten-Eigenheiten sind im Skript dokumentiert.

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

- **Game-Boy-Genauigkeit** gegen blarggs Hardware-Test-ROMs (`cpu_instrs`, `instr_timing`) plus einen Savestate-Round-Trip.
- **Nintendo-DS-Verhalten** gegen ein selbst gebautes Test-Programm, das auf jedem Bildschirm etwas anderes malt: Bildzusammensetzung, beide Bildschirm-Anordnungen, Bildrate, resampelte Audiorate und ein Savestate-Round-Trip.
- **Game-Boy-Advance-Verhalten** gegen jsmolkas ARM- und THUMB-Suiten: Bildgeometrie, Bildrate, Audiorate, Savestate-Round-Trip und die Erkennung, ob ein Modul überhaupt Speicher hat. Zu den Suiten selbst siehe `tests/roms/README.md` — mGBA besteht sie nicht vollständig, das sind bekannte Genauigkeitslücken des Cores und keine Wrapper-Fehler.
- **Ebenen-Dekoder** gegen den Emulator selbst: Die aus VRAM und OAM zurückgewonnenen Ebenen werden wieder flach zusammengesetzt und müssen das Bild des Cores **pixelgenau** treffen. Dafür gibt es `tests/roms/ppu-probe.gb`, das gezielt signierte Kachel-Adressierung, versetztes Scrolling, ein Fenster und 8×16-Sprites mit Flips und Priorität benutzt.
- **Höhenmodell** gegen `tests/roms/overworld-probe.gb`, eine scrollende Karte mit einer Figur, die einen Korridor aus Bodenkacheln entlangläuft. Im ROM steht nirgends, welche Kachel Kulisse ist — der Test verlangt, dass genau die Kulisse steht und der Boden flach bleibt.

Die Browser-Tests importieren eine ROM, spielen sie, beenden und laden neu (der Spielstand muss den Reload überleben), schalten 2.5D ein und prüfen, dass sich das Bild ändert und das Modell die richtige Kachel anhebt. Für den GBA prüfen sie zusätzlich, dass das Bild im richtigen Seitenverhältnis gezeichnet wird und die Schultertasten erscheinen.

Für den DS prüfen sie Import, beide Bildschirm-Anordnungen und dass die zusätzlichen Tasten erscheinen. Die Touchscreen-Umrechnung hat eigene Unit-Tests, weil sie sich ohne Gerät prüfen lässt.

Der Sicherungs-Test geht den ganzen Weg: Slot schreiben, Backup erzeugen, das Spiel samt Ständen löschen, das Backup wieder einspielen — danach muss der Slot erneut ladbar sein.

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
