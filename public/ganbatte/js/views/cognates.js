/**
 * Cognate-Trainer.
 *
 * Kein Vokabelpauken, sondern Mustererkennung: Nach drei Beispielen auf -ción
 * hat man nicht drei Wörter gelernt, sondern eine Endung - und damit ein paar
 * hundert Wörter, die man ab jetzt versteht, ohne sie je gesehen zu haben.
 *
 * Deshalb zählt die Fortschrittsleiste Muster, nicht Vokabeln.
 */

import { el, card } from '../dom.js';
import { party, confetti, buzz } from '../fx.js';
import {
  PATTERNS,
  COGNATE_WORDS,
  FALSE_FRIENDS,
  MASTERY_HITS,
  masteredPatterns,
  pickWord,
  buildOptions,
} from '../cognates.js';

/** @type {{word:object, options:string[], picked:string|null}|null} */
let quiz = null;
let lastWordId = null;
let showFriends = false;

function nextQuestion(masteredIds) {
  const word = pickWord(masteredIds, lastWordId);
  lastWordId = word.id;
  quiz = { word, options: buildOptions(word), picked: null };
}

export function render(ctx) {
  const { store, state, refresh } = ctx;
  const masteredIds = state.cognatesProgress.masteredIds;
  const patternsDone = masteredPatterns(masteredIds);
  const allDone = patternsDone.length === PATTERNS.length;

  if (!quiz) nextQuestion(masteredIds);

  const ratio = patternsDone.length / PATTERNS.length;
  const progress = el(
    'div.progresswrap',
    null,
    el('div.progress', null, el('div.progress__bar', { style: { width: `${ratio * 100}%` } })),
    el(
      'p.progresswrap__label',
      null,
      `${patternsDone.length} von ${PATTERNS.length} Cognate-Mustern gemeistert · ${masteredIds.length}/${COGNATE_WORDS.length} Wörter`,
    ),
  );

  const answered = quiz.picked !== null;
  const correct = answered && quiz.picked === quiz.word.de;

  const pick = (option, event) => {
    if (quiz.picked !== null) return;
    quiz.picked = option;
    const isRight = option === quiz.word.de;
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (isRight) {
      confetti(origin, 26);
      buzz();
    } else {
      buzz([8, 40, 8]);
    }
    // Speichern zeichnet neu - die Auswahl steht schon in `quiz.picked`.
    const events = store.answerCognate(quiz.word.id, isRight);
    if (events.length) party(events, origin);
    // Kurz stehen lassen, damit man Feedback und Eselsbrücke lesen kann.
    setTimeout(() => {
      nextQuestion(store.state.cognatesProgress.masteredIds);
      refresh();
    }, isRight ? 1100 : 2200);
  };

  const hits = state.cognatesProgress.hits[quiz.word.id] || 0;
  const quizCard = el(
    'section.card.quiz',
    null,
    el('span.quiz__pattern', null, quiz.word.patternLabel),
    el('p.quiz__word', null, quiz.word.es),
    el(
      'div.quiz__options',
      null,
      quiz.options.map((option) => {
        const mark =
          !answered
            ? ''
            : option === quiz.word.de
              ? 'is-right'
              : option === quiz.picked
                ? 'is-wrong'
                : 'is-faded';
        return el(
          'button.option',
          { type: 'button', class: mark, onclick: (e) => pick(option, e) },
          option,
        );
      }),
    ),
    answered
      ? el(
          'p.quiz__feedback',
          { class: correct ? 'is-right' : '' },
          correct
            ? `¡Exacto! ${quiz.word.bridge ? `Denk an "${quiz.word.bridge}". ` : ''}${
                masteredIds.includes(quiz.word.id)
                  ? 'Sitzt.'
                  : `Noch ${Math.max(0, MASTERY_HITS - hits)}× richtig, dann sitzt es.`
              }`
            : `Fast! ${quiz.word.es} heißt ${quiz.word.de}.${quiz.word.bridge ? ` Eselsbrücke: "${quiz.word.bridge}".` : ''}`,
        )
      : el('p.quiz__feedback', null, 'Was heißt das? Rate ruhig - Raten ist der Trick.'),
  );

  const patternList = card(
    'Die Muster',
    el(
      'ul.patternlist',
      null,
      PATTERNS.map((pattern) => {
        const done = pattern.words.filter((w) => masteredIds.includes(w.id)).length;
        return el(
          'li.patternrow',
          { class: done === pattern.words.length ? 'is-done' : '' },
          el(
            'div.patternrow__head',
            null,
            el('span.patternrow__label', null, pattern.label),
            el(
              'span.patternrow__count',
              null,
              done === pattern.words.length ? '✅' : `${done}/${pattern.words.length}`,
            ),
          ),
          el('p.patternrow__rule', null, pattern.rule),
          el(
            'p.patternrow__words',
            null,
            pattern.words.map((w) => `${w.es} – ${w.de}`).join(' · '),
          ),
        );
      }),
    ),
  );

  const friends = card(
    'Falsos amigos',
    el(
      'button.ghostbutton',
      {
        type: 'button',
        onclick: () => {
          showFriends = !showFriends;
          refresh();
        },
      },
      showFriends ? 'Einklappen' : 'Die sechs fiesen Fallen zeigen',
    ),
    showFriends
      ? el(
          'ul.friendlist',
          null,
          FALSE_FRIENDS.map((f) =>
            el(
              'li.friendrow',
              null,
              el('span.friendrow__es', null, f.es),
              el('span.friendrow__de', null, f.de),
              el('span.friendrow__not', null, f.not),
            ),
          ),
        )
      : null,
  );

  return el(
    'div.view',
    null,
    el(
      'section.card.cognatehead',
      null,
      allDone
        ? el('p.cognatehead__done', null, '¡Todos! Alle Muster sitzen. Die Fragen laufen zur Auffrischung weiter.')
        : el('p.cognatehead__intro', null, 'Ein Muster gelernt = hunderte Wörter geschenkt.'),
      progress,
      allDone
        ? el(
            'button.ghostbutton',
            {
              type: 'button',
              onclick: () => {
                // Erst die Frage verwerfen, dann speichern: das Speichern
                // zeichnet neu und soll gleich die neue Frage zeigen.
                quiz = null;
                lastWordId = null;
                store.resetCognates();
              },
            },
            'Fortschritt zurücksetzen',
          )
        : null,
    ),
    quizCard,
    patternList,
    friends,
  );
}

export function reset() {
  quiz = null;
  showFriends = false;
}
