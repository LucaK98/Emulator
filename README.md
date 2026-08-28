# Emulator

Ein privater Emulator für **Game Boy, Game Boy Color, Game Boy Advance und Nintendo DS**, gebaut als installierbare Web-App (PWA) für das iPhone. ROMs und Spielstände bleiben ausschließlich auf dem Gerät.

Das besondere Feature ist ein **2.5D-Renderer für Game-Boy-Spiele**: der Core gibt die PPU-Ebenen getrennt aus, der Renderer baut daraus eine echte 3D-Szene mit Kamera, Tiefe und Schatten.

> **3DS wird nicht unterstützt.** Es gibt keinen funktionierenden WebAssembly-Port von Citra/Azahar, und 3DS-Emulation braucht JIT plus eine GPU-Pipeline, die im Browser nicht erreichbar ist. Auf dem iPhone läuft 3DS heute nur über nativ sideloadete Apps.

## Status

| Phase | Inhalt | Stand |
| --- | --- | --- |
| 0 | Fundament: PWA-Shell, Cross-Origin-Isolation, Speicher-Persistenz, CI/Deploy | ✅ fertig |
| 1 | Game Boy / Color spielbar (SameBoy-Core, Renderer, Audio, Touch-Controls) | offen |
| 2 | Savestates, Bibliothek, Export/Import, Controller | offen |
| 3 | 2.5D-Renderer | offen |
| 4 | Game Boy Advance (mGBA) | offen |
| 5 | Nintendo DS (melonDS) | offen |
| 6 | Feinschliff: Rewind, Fast-Forward, Shader | offen |

## Auf dem iPhone einrichten

1. Die Pages-URL des Repos in **Safari** öffnen.
2. Auf **Teilen → Zum Home-Bildschirm** tippen.
3. Den Emulator ab jetzt **über das Home-Bildschirm-Symbol** starten, nicht mehr über Safari.

Schritt 2 ist keine Kür. Safari löscht Website-Daten nach sieben Tagen ohne Nutzung; nur eine zum Home-Bildschirm hinzugefügte App mit `display: standalone` ist davon ausgenommen. Die App blockiert deshalb den Start in einem Safari-Tab und erklärt den Schritt. Zusätzlich wird bei jedem Start `navigator.storage.persist()` angefragt — der aktuelle Stand steht im Systemstatus.

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
