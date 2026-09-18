/**
 * SMART-Ziel: Niveau, Datum, Anlass.
 *
 * Das "M" in SMART ist hier die ehrliche Schwachstelle - eine Web-App kann
 * kein Sprachniveau messen. Sie schätzt es aus dem, was sie sieht (Sprechtage,
 * gefestigte Vokabeln, Cognate-Muster), und schreibt ausdrücklich "Schätzung"
 * daneben. Lieber eine transparente Näherung als eine erfundene Note.
 */

import { el, card, field } from '../dom.js';
import { toast, confetti } from '../fx.js';
import { todayKey, daysUntil, formatDay, daysBetween } from '../dates.js';
import { activityStats } from '../store.js';
import {
  LEVELS,
  XP,
  XP_PER_LEVEL,
  totalXp,
  estimatedLevel,
  levelLabel,
  levelIndex,
  goalProgress,
  pace,
} from '../levels.js';

let editing = false;

export function render(ctx) {
  const { store, state, refresh } = ctx;
  const today = todayKey();

  if (!state.goal || editing) return renderForm(ctx, today);

  const goal = state.goal;
  const activity = activityStats(state);
  const now = estimatedLevel(goal.startLevel, activity);
  const progress = goalProgress(goal, activity);
  const daysLeft = goal.targetDate ? daysUntil(goal.targetDate, today) : null;
  const elapsed = daysBetween(goal.startedDate, today);
  const speed = pace(goal, activity, daysLeft ?? 0);

  const scale = el(
    'div.scale',
    null,
    el(
      'div.scale__track',
      null,
      el('div.scale__fill', { style: { width: `${(now / (LEVELS.length - 1)) * 100}%` } }),
      marker(levelIndex(goal.startLevel), 'Start', 'scale__marker--start'),
      marker(levelIndex(goal.targetLevel), '🏁', 'scale__marker--target'),
      marker(now, '🧍', 'scale__marker--now'),
    ),
    el(
      'div.scale__labels',
      null,
      LEVELS.map((l, i) =>
        el(
          'span.scale__label',
          { style: { left: `${(i / (LEVELS.length - 1)) * 100}%` } },
          l,
        ),
      ),
    ),
  );

  const countdown =
    daysLeft === null
      ? null
      : el(
          'div.countdown',
          null,
          el('span.countdown__value', null, String(Math.abs(daysLeft))),
          el(
            'span.countdown__label',
            null,
            daysLeft > 0
              ? daysLeft === 1
                ? 'Tag bis zum Zieldatum'
                : 'Tage bis zum Zieldatum'
              : daysLeft === 0
                ? 'Heute ist der Tag!'
                : 'Tage über dem Zieldatum - kein Problem, weiter geht’s',
          ),
        );

  const head = el(
    'section.card.goalhead',
    null,
    el('p.goalhead__line', null, `${goal.startLevel} → ${goal.targetLevel}`),
    el('p.goalhead__date', null, goal.targetDate ? `bis ${formatDay(goal.targetDate)}` : 'ohne festes Datum'),
    scale,
    el(
      'p.goalhead__now',
      null,
      `Geschätzt bist du bei ${levelLabel(now)} · ${Math.round(progress * 100)} % der Strecke`,
    ),
    countdown,
  );

  const motivation = goal.motivation
    ? card('Warum du das machst', el('blockquote.motivation', null, goal.motivation))
    : null;

  const xp = totalXp(activity);
  const breakdown = card(
    'Woraus die Schätzung kommt',
    el(
      'ul.breakdown',
      null,
      row(
        `${activity.speakingDays} ${activity.speakingDays === 1 ? 'Sprech-Tag' : 'Sprech-Tage'}`,
        activity.speakingDays * XP.speakingDay,
      ),
      row(
        `${activity.masteredVocab} ${activity.masteredVocab === 1 ? 'gefestigte Vokabel' : 'gefestigte Vokabeln'}`,
        activity.masteredVocab * XP.masteredVocab,
      ),
      row(
        `${activity.masteredCognates} ${activity.masteredCognates === 1 ? 'gemeistertes Cognate' : 'gemeisterte Cognates'}`,
        activity.masteredCognates * XP.masteredCognate,
      ),
      el('li.breakdown__row.breakdown__row--sum', null, el('span', null, 'Gesamt'), el('span', null, `${xp} XP`)),
    ),
    el(
      'p.next__hint',
      null,
      `Eine Niveaustufe entspricht hier ${XP_PER_LEVEL} XP. Das ist eine Faustregel, kein Test - gesprochene Zeit zählt am meisten, weil sie am meisten bringt.`,
    ),
  );

  const paceCard =
    daysLeft === null || speed.done
      ? card(
          'Tempo',
          el(
            'p.pace',
            null,
            speed.done
              ? '¡Lo lograste! Nach dieser Schätzung hast du dein Ziel erreicht. Zeit für ein neues.'
              : 'Ohne Zieldatum gibt es kein Tempo - und das ist auch okay.',
          ),
        )
      : card(
          'Tempo',
          el(
            'p.pace',
            null,
            daysLeft > 0
              ? `Für dein Datum bräuchtest du rund ${Math.ceil(speed.perDay)} XP pro Tag. Zum Vergleich: ein Sprech-Tag bringt ${XP.speakingDay} XP, eine gefestigte Vokabel ${XP.masteredVocab}.`
              : 'Das Datum ist durch. Setz dir ein neues - der Weg zählt, nicht der Kalender.',
          ),
          daysLeft > 0 && speed.perDay > XP.speakingDay * 1.5
            ? el(
                'p.next__hint',
                null,
                'Klingt sportlich? Dann verschieb lieber das Datum als das Ziel. Kleine Schritte, die du wirklich gehst, schlagen jeden ehrgeizigen Plan.',
              )
            : null,
        );

  const meta = card(
    'Seit wann',
    el(
      'p.pace',
      null,
      elapsed === 0
        ? `Heute geht es los (Start: ${formatDay(goal.startedDate)}).`
        : `Du bist seit ${elapsed} ${elapsed === 1 ? 'Tag' : 'Tagen'} dabei (Start: ${formatDay(goal.startedDate)}).`,
    ),
    el(
      'div.buttonrow',
      null,
      el(
        'button.ghostbutton',
        {
          type: 'button',
          onclick: () => {
            editing = true;
            refresh();
          },
        },
        'Ziel bearbeiten',
      ),
      el(
        'button.ghostbutton.ghostbutton--quiet',
        {
          type: 'button',
          onclick: () => {
            if (confirm('Ziel wirklich löschen?')) store.clearGoal();
          },
        },
        'Ziel löschen',
      ),
    ),
  );

  return el('div.view', null, head, motivation, breakdown, paceCard, meta);
}

function marker(position, label, extra) {
  const percent = (position / (LEVELS.length - 1)) * 100;
  return el('span', { class: `scale__marker ${extra}`, style: { left: `${percent}%` } }, label);
}

function row(label, value) {
  return el('li.breakdown__row', null, el('span', null, label), el('span', null, `${value} XP`));
}

function renderForm(ctx, today) {
  const { store, state, refresh } = ctx;
  const existing = state.goal;

  const start = select(LEVELS, existing?.startLevel || 'A1');
  const target = select(LEVELS, existing?.targetLevel || 'B1');
  const date = el('input.input', {
    type: 'date',
    value: existing?.targetDate || '',
    min: today,
  });
  const motivation = el('textarea.input', {
    rows: 3,
    placeholder: 'z. B. „Im Mai mit Marias Familie in Valencia am Tisch mitreden."',
    value: existing?.motivation || '',
  });

  const submit = (event) => {
    event.preventDefault();
    if (levelIndex(target.value) <= levelIndex(start.value)) {
      toast('Das Ziel sollte über deinem Startniveau liegen', 'calm');
      return;
    }
    editing = false;
    store.setGoal(
      {
        startLevel: start.value,
        targetLevel: target.value,
        targetDate: date.value,
        motivation: motivation.value.trim(),
      },
      today,
    );
    confetti(null, 90);
    toast('¡Vale! Ziel steht 🎯', 'milestone');
  };

  return el(
    'div.view',
    null,
    card(
      existing ? 'Ziel bearbeiten' : 'Dein SMART-Ziel',
      el(
        'p.next__hint',
        null,
        'Konkret, messbar, mit Datum - und mit einem Grund, der dich morgens aus dem Bett holt.',
      ),
      el(
        'form.form',
        { onsubmit: submit },
        field('Wo stehst du heute?', start),
        field('Wo willst du hin?', target),
        field('Bis wann?', date),
        field('Wozu? (dein Anlass)', motivation),
        el('button.primarybutton', { type: 'submit' }, existing ? 'Speichern' : 'Ziel setzen'),
        existing
          ? el(
              'button.ghostbutton',
              {
                type: 'button',
                onclick: () => {
                  editing = false;
                  refresh();
                },
              },
              'Abbrechen',
            )
          : null,
      ),
    ),
    !existing
      ? card(
          'Warum überhaupt ein Ziel?',
          el(
            'p.pace',
            null,
            '„Spanisch lernen" ist kein Ziel, sondern ein Wunsch. „Bis zum 1. Juni auf B1 ein 15-Minuten-Gespräch führen" ist eines: Du weißt jeden Tag, ob du näher dran bist.',
          ),
        )
      : null,
  );
}

function select(options, value) {
  return el(
    'select.input',
    null,
    options.map((o) => el('option', { value: o, selected: o === value }, o)),
  );
}

export function reset() {
  editing = false;
}
