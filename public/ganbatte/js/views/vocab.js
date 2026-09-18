/**
 * Vokabeln: sammeln und in kurzen Runden wiederholen.
 *
 * Die Lernrunde arbeitet eine Warteschlange ab. Eine Karte, die nicht saß,
 * wandert ans Ende der Runde statt auf morgen - so endet jede Session mit
 * lauter Treffern. Das ist der Unterschied zwischen "geschafft" und
 * "abgebrochen".
 */

import { el, card, field } from '../dom.js';
import { party, confetti, toast } from '../fx.js';
import { todayKey, daysBetween, daysUntil } from '../dates.js';
import { dueCards, masteredCount, accuracy, STEPS } from '../srs.js';

/** @type {{queue:string[], done:number, total:number, revealed:boolean}|null} */
let session = null;
let showForm = false;
let query = '';

export function render(ctx) {
  const { store, state, refresh } = ctx;
  const today = todayKey();
  const due = dueCards(state.vocab, today, daysBetween);

  if (session) return renderSession(ctx, today);

  const stats = el(
    'div.quickgrid.quickgrid--three',
    null,
    stat(state.vocab.length, 'gesammelt'),
    stat(masteredCount(state.vocab), 'sitzen fest'),
    stat(due.length, 'heute fällig'),
  );

  const start = el(
    'button.bigbutton',
    {
      type: 'button',
      class: due.length === 0 ? 'bigbutton--calm' : '',
      disabled: due.length === 0,
      onclick: () => {
        session = {
          queue: due.map((c) => c.id),
          done: 0,
          total: due.length,
          revealed: false,
        };
        refresh();
      },
    },
    el('span.bigbutton__label', null, due.length === 0 ? 'Alles wiederholt 🎉' : 'Lernrunde starten'),
    el(
      'span.bigbutton__sub',
      null,
      due.length === 0
        ? nextDueHint(state.vocab, today)
        : `${due.length} ${due.length === 1 ? 'Karte' : 'Karten'} warten`,
    ),
  );

  const form = showForm ? addForm(store) : null;

  const toggle = el(
    'button.ghostbutton',
    {
      type: 'button',
      onclick: () => {
        showForm = !showForm;
        refresh();
      },
    },
    showForm ? 'Abbrechen' : '＋ Neue Vokabel',
  );

  const search = el('input.search', {
    type: 'search',
    placeholder: 'Suchen …',
    value: query,
    oninput: (e) => {
      query = e.target.value;
      // Nur die Liste neu zeichnen wäre schöner, aber das Feld behält den
      // Fokus, weil wir es beim Neuaufbau gezielt wiederherstellen.
      const pos = e.target.selectionStart;
      refresh(() => {
        const input = document.querySelector('.search');
        if (input) {
          input.focus();
          input.setSelectionRange(pos, pos);
        }
      });
    },
  });

  const hits = filterCards(state.vocab, query);
  const list = el(
    'div.vocablist',
    null,
    hits.length === 0
      ? el(
          'p.empty',
          null,
          state.vocab.length === 0
            ? 'Noch keine Vokabel. Fang mit drei Wörtern an, die du heute wirklich sagen willst.'
            : 'Nichts gefunden.',
        )
      : hits.map((c) => vocabRow(c, store, today)),
  );

  const acc = accuracy(state.vocab);

  return el(
    'div.view',
    null,
    el('section.card', null, stats, start),
    card(null, toggle, form),
    card(
      'Deine Wörter',
      search,
      list,
      acc !== null
        ? el('p.next__hint', null, `Trefferquote bisher: ${Math.round(acc * 100)} %`)
        : null,
    ),
  );
}

function nextDueHint(cards, today) {
  if (cards.length === 0) return 'Leg unten deine erste Vokabel an';
  const next = cards
    .map((c) => c.nextReview)
    .sort()
    .find((d) => d > today);
  if (!next) return 'Nichts offen - ¡perfecto!';
  const days = daysUntil(next, today);
  return days === 1 ? 'Morgen geht es weiter' : `Weiter in ${days} Tagen`;
}

function filterCards(cards, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter(
    (c) =>
      c.es.toLowerCase().includes(needle) ||
      c.translation.toLowerCase().includes(needle) ||
      c.mnemonic.toLowerCase().includes(needle),
  );
}

function stat(value, label) {
  return el('div.tile.tile--static', null, el('span.tile__value', null, String(value)), el('span.tile__label', null, label));
}

function addForm(store) {
  const es = el('input.input', { type: 'text', placeholder: 'p. ej. la playa', autocapitalize: 'none' });
  const de = el('input.input', { type: 'text', placeholder: 'z. B. der Strand' });
  const mn = el('input.input', { type: 'text', placeholder: 'Eselsbrücke (optional)' });

  const submit = (event) => {
    event.preventDefault();
    if (!es.value.trim() || !de.value.trim()) {
      toast('Spanisch und Übersetzung brauchen wir beide', 'calm');
      return;
    }
    const rect = event.target.getBoundingClientRect();
    // Speichern zeichnet den Bildschirm neu; das Formular kommt leer zurück.
    const events = store.addVocab({ es: es.value, translation: de.value, mnemonic: mn.value });
    party(events, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    requestAnimationFrame(() => document.querySelector('.form .input')?.focus());
  };

  return el(
    'form.form',
    { onsubmit: submit },
    field('Spanisch', es),
    field('Deutsch', de),
    field('Eselsbrücke', mn),
    el('button.primarybutton', { type: 'submit' }, 'Hinzufügen'),
  );
}

function vocabRow(c, store, today) {
  const dueIn = daysUntil(c.nextReview, today);
  const when = dueIn <= 0 ? 'heute fällig' : dueIn === 1 ? 'morgen' : `in ${dueIn} Tagen`;
  return el(
    'div.vocabrow',
    null,
    el(
      'div.vocabrow__main',
      null,
      el('span.vocabrow__es', null, c.es),
      el('span.vocabrow__de', null, c.translation),
      c.mnemonic ? el('span.vocabrow__mn', null, `💡 ${c.mnemonic}`) : null,
    ),
    el(
      'div.vocabrow__meta',
      null,
      el('span.steps', null, STEPS.map((_, i) => el('span.step', { class: i < c.step ? 'is-on' : '' }))),
      el('span.vocabrow__due', null, when),
    ),
    el(
      'button.iconbutton.iconbutton--quiet',
      {
        type: 'button',
        'aria-label': `${c.es} löschen`,
        onclick: () => {
          if (confirm(`"${c.es}" wirklich löschen?`)) store.removeVocab(c.id);
        },
      },
      '×',
    ),
  );
}

function renderSession(ctx, today) {
  const { store, state, refresh } = ctx;
  const cardId = session.queue[0];
  const current = state.vocab.find((c) => c.id === cardId);

  if (!current) {
    // Karte wurde zwischendurch gelöscht - einfach überspringen.
    session.queue.shift();
    if (session.queue.length === 0) {
      session = null;
      return render(ctx);
    }
    return renderSession(ctx, today);
  }

  const total = Math.max(session.total, session.done + session.queue.length);
  const progress = el(
    'div.progress',
    null,
    el('div.progress__bar', { style: { width: `${(session.done / total) * 100}%` } }),
  );

  const answer = (known, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    // Erst die Runde weiterdrehen, dann speichern: das Speichern zeichnet den
    // Bildschirm neu, und der soll dabei schon die nächste Karte zeigen.
    session.queue.shift();
    session.revealed = false;
    if (known) {
      session.done += 1;
    } else {
      // Noch mal ans Ende der Runde, nicht auf morgen.
      session.queue.push(current.id);
    }
    const finishedWith = session.queue.length === 0 ? session.done : null;
    if (finishedWith !== null) session = null;

    const events = store.reviewVocab(current.id, known, today);

    if (finishedWith !== null) {
      confetti(null, 150);
      toast(
        finishedWith > 0
          ? `¡Olé! ${finishedWith} ${finishedWith === 1 ? 'Karte' : 'Karten'} wiederholt`
          : 'Runde beendet',
        'milestone',
      );
    } else if (known) {
      confetti(origin, 22);
    }
    if (events.length) party(events, origin);
  };

  const flashcard = el(
    'button.flashcard',
    {
      type: 'button',
      class: session.revealed ? 'is-revealed' : '',
      onclick: () => {
        if (session.revealed) return;
        session.revealed = true;
        refresh();
      },
    },
    el('span.flashcard__es', null, current.es),
    session.revealed
      ? el(
          'span.flashcard__back',
          null,
          el('span.flashcard__de', null, current.translation),
          current.mnemonic ? el('span.flashcard__mn', null, `💡 ${current.mnemonic}`) : null,
        )
      : el('span.flashcard__hint', null, 'Tippen zum Aufdecken'),
  );

  const buttons = session.revealed
    ? el(
        'div.answerrow',
        null,
        el(
          'button.answerbutton.answerbutton--again',
          { type: 'button', onclick: (e) => answer(false, e) },
          'Nochmal 🤔',
        ),
        el(
          'button.answerbutton.answerbutton--known',
          { type: 'button', onclick: (e) => answer(true, e) },
          'Wusste ich 😎',
        ),
      )
    : el('p.session__hint', null, 'Erst überlegen, dann aufdecken.');

  return el(
    'div.view.view--session',
    null,
    el(
      'div.session__top',
      null,
      el(
        'button.ghostbutton',
        {
          type: 'button',
          onclick: () => {
            session = null;
            refresh();
          },
        },
        'Runde beenden',
      ),
      el('span.session__count', null, `${session.done} / ${total}`),
    ),
    progress,
    flashcard,
    buttons,
  );
}

/** Beim Tabwechsel keine halbe Lernrunde im Hintergrund stehen lassen. */
export function reset() {
  session = null;
  showForm = false;
  query = '';
}
