/**
 * Dashboard - der Ein-Blick-Bildschirm.
 *
 * Reihenfolge nach Wichtigkeit: Streak, der große Tagesbutton, was heute
 * ansteht, dann der Monatskalender. Kein Menü, kein Scrollen nötig für die
 * eine Handlung, um die es täglich geht.
 */

import { el, card, clear } from '../dom.js';
import { party, pulse } from '../fx.js';
import { todayKey, monthGrid, monthName, WEEKDAYS, daysUntil, formatDay, daysBetween } from '../dates.js';
import { activeStreak, loggedToday, noteFor, activityStats } from '../store.js';
import { dueCards } from '../srs.js';
import { PATTERNS, masteredPatterns } from '../cognates.js';

/** Angezeigter Monat, relativ zum aktuellen. Überlebt das Neuzeichnen. */
let monthOffset = 0;

const CHEERS = [
  '¡Olé!', '¡Vamos!', '¡Genial!', '¡Qué bien!', '¡Increíble!', '¡Bravo!', '¡Eso es!',
];

function cheer(streak) {
  return CHEERS[streak % CHEERS.length];
}

function flameSize(streak) {
  // Die Flamme wächst mit der Streak, aber gedeckelt - sonst sprengt sie
  // irgendwann den Bildschirm.
  return Math.min(1 + streak * 0.03, 1.6);
}

export function render(ctx) {
  const { store, state, go, refresh } = ctx;
  const today = todayKey();
  const done = loggedToday(state, today);
  const streak = activeStreak(state, today);
  const due = dueCards(state.vocab, today, daysBetween);
  const stats = activityStats(state);
  const patternsDone = masteredPatterns(state.cognatesProgress.masteredIds).length;

  const flame = el(
    'div.streak__flame',
    { style: { transform: `scale(${flameSize(streak)})` } },
    streak > 0 ? '🔥' : '🌱',
  );

  const streakBox = el(
    'div.streak',
    null,
    flame,
    el(
      'div.streak__text',
      null,
      el('strong.streak__count', null, String(streak)),
      el('span.streak__label', null, streak === 1 ? 'Tag am Stück' : 'Tage am Stück'),
    ),
    state.streak.longest > streak
      ? el('span.streak__best', null, `Bestmarke ${state.streak.longest}`)
      : null,
  );

  const noteInput = el('textarea.note__input', {
    rows: 2,
    placeholder: 'Worüber habe ich heute gesprochen?',
    value: noteFor(state, today),
    onchange: (e) => store.setNote(e.target.value, today),
  });

  const logButton = el(
    'button.bigbutton',
    {
      type: 'button',
      class: done ? 'bigbutton--done' : '',
      onclick: (event) => {
        if (done) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const events = store.logSpeaking(noteInput.value, today);
        party(events, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      },
    },
    done
      ? el('span.bigbutton__label', null, `${cheer(streak)} Heute gesprochen ✅`)
      : el('span.bigbutton__label', null, 'Heute gesprochen ✅'),
    el(
      'span.bigbutton__sub',
      null,
      done ? 'Mañana geht es weiter' : 'Ein Gespräch zählt - egal wie kurz',
    ),
  );

  const hero = el(
    'section.card.hero',
    null,
    el('p.hero__hola', null, done ? `${cheer(streak)} ¡Qué crack!` : '¡Hola! Bereit zu sprechen?'),
    streakBox,
    logButton,
    el('div.note', null, noteInput),
  );

  const goalDays = state.goal?.targetDate ? daysUntil(state.goal.targetDate, today) : null;

  const quick = el(
    'div.quickgrid',
    null,
    tile(due.length, due.length === 1 ? 'Vokabel fällig' : 'Vokabeln fällig', () => go('vocab'), due.length > 0),
    tile(state.vocab.length, 'Vokabeln gesamt', () => go('vocab')),
    tile(`${patternsDone}/${PATTERNS.length}`, 'Cognate-Muster', () => go('cognates')),
    goalDays === null
      ? tile('–', 'Ziel setzen', () => go('goal'))
      : tile(
          goalDays >= 0 ? String(goalDays) : '0',
          goalDays >= 0 ? 'Tage bis zum Ziel' : 'Zieldatum erreicht',
          () => go('goal'),
        ),
  );

  const next = el(
    'section.card.next',
    null,
    el('h2.card__title', null, 'Als Nächstes'),
    el(
      'ul.checklist',
      null,
      item(done, done ? 'Heute gesprochen' : 'Heute sprechen (auch 5 Minuten zählen)'),
      state.vocab.length === 0
        ? item(false, 'Erste Vokabel anlegen', () => go('vocab'))
        : item(
            due.length === 0,
            due.length === 0
              ? 'Alle Vokabeln wiederholt'
              : `${due.length} ${due.length === 1 ? 'Vokabel wartet' : 'Vokabeln warten'} auf dich`,
            due.length > 0 ? () => go('vocab') : null,
          ),
      item(
        patternsDone === PATTERNS.length,
        patternsDone === PATTERNS.length
          ? 'Alle Cognate-Muster sitzen'
          : `Noch ${PATTERNS.length - patternsDone} Cognate-Muster zu knacken`,
        patternsDone < PATTERNS.length ? () => go('cognates') : null,
      ),
    ),
    stats.masteredVocab > 0
      ? el(
          'p.next__hint',
          null,
          `${stats.masteredVocab} ${stats.masteredVocab === 1 ? 'Vokabel sitzt' : 'Vokabeln sitzen'} im Langzeitgedächtnis.`,
        )
      : null,
  );

  const calendarCard = card('Dein Monat');
  renderCalendar(calendarCard, state, today, refresh);

  const view = el('div.view', null, hero, quick, next, calendarCard);

  // Zähler kurz pulsieren lassen, wenn heute schon eingetragen ist - ein
  // kleines Lebenszeichen beim Öffnen der App.
  if (done) requestAnimationFrame(() => pulse(streakBox.querySelector('.streak__count')));

  return view;
}

function tile(value, label, onclick, highlight = false) {
  return el(
    'button.tile',
    { type: 'button', class: highlight ? 'tile--hot' : '', onclick },
    el('span.tile__value', null, String(value)),
    el('span.tile__label', null, label),
  );
}

function item(done, text, onclick) {
  return el(
    'li.checklist__item',
    { class: done ? 'is-done' : '' },
    el('span.checklist__mark', null, done ? '✅' : '○'),
    onclick
      ? el('button.checklist__link', { type: 'button', onclick }, text)
      : el('span', null, text),
  );
}

function renderCalendar(host, state, today, refresh) {
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + monthOffset);
  const year = base.getFullYear();
  const month = base.getMonth();

  const doneDays = new Set(state.speakingLog.map((e) => e.date));
  const cells = monthGrid(year, month);

  const body = el(
    'div.calendar',
    null,
    el(
      'div.calendar__head',
      null,
      el('button.iconbutton', {
        type: 'button',
        'aria-label': 'Vorheriger Monat',
        onclick: () => {
          monthOffset -= 1;
          refresh();
        },
      }, '‹'),
      el('span.calendar__title', null, `${monthName(month)} ${year}`),
      el('button.iconbutton', {
        type: 'button',
        'aria-label': 'Nächster Monat',
        disabled: monthOffset >= 0,
        onclick: () => {
          monthOffset = Math.min(0, monthOffset + 1);
          refresh();
        },
      }, '›'),
    ),
    el('div.calendar__grid', null, WEEKDAYS.map((d) => el('span.calendar__weekday', null, d))),
    el(
      'div.calendar__grid',
      null,
      cells.map((cell) => {
        const isDone = doneDays.has(cell.key);
        const isToday = cell.key === today;
        const isFuture = cell.key > today;
        const classes = [
          'calendar__day',
          cell.inMonth ? '' : 'calendar__day--outside',
          isDone ? 'is-done' : '',
          isToday ? 'is-today' : '',
          isFuture ? 'is-future' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const note = state.speakingLog.find((e) => e.date === cell.key)?.note;
        return el(
          'span',
          {
            class: classes,
            title: isDone ? `${formatDay(cell.key)}${note ? `: ${note}` : ''}` : formatDay(cell.key),
          },
          String(cell.day),
        );
      }),
    ),
    el(
      'p.calendar__legend',
      null,
      // Kein rotes Warnsymbol für verpasste Tage: die App soll zum Weitermachen
      // einladen, nicht Buch über Versäumnisse führen.
      'Grün = gesprochen. Freie Tage bleiben einfach leer - weitermachen zählt.',
    ),
  );

  const title = host.querySelector('.card__title');
  clear(host);
  if (title) host.appendChild(title);
  host.appendChild(body);
}

/** Der Kalender öffnet wieder im aktuellen Monat, wenn man den Tab wechselt. */
export function reset() {
  monthOffset = 0;
}
