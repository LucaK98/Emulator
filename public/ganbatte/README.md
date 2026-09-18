# Ganbatte – Spanisch jeden Tag

Ein täglicher Spanisch-Tracker als eigenständige PWA. Er liegt in diesem Repo
unter `public/ganbatte/` und wird vom Pages-Deploy des Emulators mit
veröffentlicht, also unter `https://<user>.github.io/Emulator/ganbatte/`.

Inhaltlich hat er mit dem Emulator nichts zu tun – technisch teilt er sich nur
das Deployment. Die Idee kommt aus Benny Lewis' *12 Rules for Learning Foreign
Languages*: jeden Tag sprechen, Cognates als Abkürzung nutzen, Vokabeln in
Abständen wiederholen, Eselsbrücken bauen, ein Ziel mit Datum setzen.

## Warum es so gebaut ist, wie es gebaut ist

**Kein Build-Schritt.** Reines HTML, CSS und ES-Module. Vite kopiert `public/`
unverändert – die App ist buchstäblich ein Ordner mit Dateien und läuft auch,
wenn man ihn auf einen beliebigen Webserver legt. Kein Framework, das in zwei
Jahren ein Sicherheitsupdate braucht.

**Kein Backend.** Der gesamte Zustand steht als ein JSON-Objekt in
`localStorage` (Schlüssel `ganbatte.state.v1`). Für ein paar hundert Vokabeln
sind das Kilobytes; IndexedDB wäre Aufwand ohne Gegenwert. Der Preis ist, dass
die Daten am Gerät hängen – deshalb gibt es unter *⋯ → Deine Daten* Export und
Import als Datei.

**Kein Schuldgefühl.** Verpasste Tage bleiben im Kalender einfach leer, es gibt
kein Rot und keine Mahnung. Wer eine Streak verliert, fängt bei 1 an, und die
App sagt „¡Vamos!" statt „Streak verloren".

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `js/main.js` | Tabs, Neuzeichnen, Einstellungen, Service-Worker-Registrierung |
| `js/store.js` | Zustand, Persistenz, alle schreibenden Aktionen, Meilensteine |
| `js/srs.js` | Leitner-Intervalle 1 / 3 / 7 / 14 / 30 Tage |
| `js/dates.js` | Tagesschlüssel in *lokaler* Zeit (nie `toISOString()`) |
| `js/levels.js` | Schätzung des GER-Niveaus aus Aktivität |
| `js/cognates.js` | Elf Cognate-Muster à drei Wörter plus sechs falsche Freunde |
| `js/fx.js` | Konfetti, Jubelmeldungen, Haptik |
| `js/dom.js` | `el()` – der ganze „View-Layer" |
| `js/views/*.js` | Die fünf Bildschirme |

Die Bildschirme bauen ihren DOM bei jeder Änderung neu auf. Bei dieser
Datenmenge kostet das nichts und spart die gesamte Buchhaltung eines
Frameworks. Aktionen ändern erst den lokalen Zustand des Bildschirms (welche
Karte, welche Frage) und rufen dann den Store – das Speichern löst das
Neuzeichnen aus und soll dabei schon den neuen Stand sehen.

## Datenmodell

```jsonc
{
  "streak":  { "current": 7, "longest": 12, "lastLoggedDate": "2026-09-18" },
  "speakingLog": [{ "date": "2026-09-18", "note": "Tandem über Fußball" }],
  "vocab": [{ "id": "v…", "es": "la playa", "translation": "der Strand",
              "mnemonic": "Play a Beach", "step": 2, "interval": 3,
              "nextReview": "2026-09-21", "added": "2026-09-18",
              "history": [{ "date": "2026-09-18", "known": true }] }],
  "cognatesProgress": { "masteredIds": ["cion-1"], "hits": { "cion-1": 2 } },
  "mnemonics": [{ "id": "m…", "term": "el pelo", "text": "Pelz auf dem Kopf" }],
  "goal": { "startLevel": "A1", "targetLevel": "B1", "targetDate": "2027-06-01",
            "motivation": "…", "startedDate": "2026-09-18" },
  "celebrated": ["streak-7"]
}
```

Alles, was beim Laden fehlt oder den falschen Typ hat, wird ersetzt statt
abzustürzen (`normalize()` in `store.js`): halb kaputte Daten dürfen die App
nicht am Starten hindern, dafür sind sie zu schwer wiederzubeschaffen.

## Auf dem iPhone installieren

1. `…/Emulator/ganbatte/` in **Safari** öffnen.
2. **Teilen → Zum Home-Bildschirm**.
3. Ab dann über das Symbol starten.

Schritt 2 ist auch hier keine Kür: Safari räumt Website-Daten nach sieben Tagen
ohne Nutzung weg, eine zum Home-Bildschirm hinzugefügte App mit
`display: standalone` ist davon ausgenommen. Die App weist beim ersten Besuch
in Safari einmal darauf hin.

## Entwickeln und Testen

```sh
npm run dev      # http://localhost:5173/Emulator/ganbatte/
npm run build && npm run preview
npx playwright test tests/e2e/ganbatte.spec.ts
python3 scripts/gen-ganbatte-icons.py   # Icons neu erzeugen
```

Die Icons werden ohne fremde Bibliotheken aus Distanzfeldern gezeichnet und
sind als PNG eingecheckt; der Build braucht kein Python.
