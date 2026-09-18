/**
 * Merksätze - die Eselsbrücken-Sammlung.
 *
 * Zwei Quellen fließen zusammen: eigene Einträge und die Eselsbrücken, die
 * schon an Vokabeln hängen. Sie doppelt eintragen zu müssen wäre die sicherste
 * Methode, die Sammlung sterben zu lassen.
 *
 * Der Blättermodus zeigt genau eine Karte. Merksätze wirken, wenn man sie
 * wiedersieht - nicht, wenn sie in einer Liste verstauben.
 */

import { el, card, field } from '../dom.js';
import { toast, confetti } from '../fx.js';
import { formatDay } from '../dates.js';

let index = 0;
let showForm = false;

/** Eigene Einträge zuerst, danach die an Vokabeln hängenden. */
function collect(state) {
  const own = state.mnemonics.map((m) => ({
    id: m.id,
    term: m.term,
    text: m.text,
    added: m.added,
    source: 'own',
  }));
  const fromVocab = state.vocab
    .filter((c) => c.mnemonic)
    .map((c) => ({
      id: c.id,
      term: `${c.es} – ${c.translation}`,
      text: c.mnemonic,
      added: c.added,
      source: 'vocab',
    }));
  return [...own, ...fromVocab];
}

export function render(ctx) {
  const { store, state, refresh } = ctx;
  const all = collect(state);

  if (index >= all.length) index = 0;

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
    showForm ? 'Abbrechen' : '＋ Neuer Merksatz',
  );

  const browser =
    all.length === 0
      ? card(
          'Noch leer',
          el(
            'p.empty',
            null,
            'Eselsbrücken schlagen Vokabelpauken. Was klingt wie ein deutsches Wort, was sieht aus wie ein Bild? „El pelo" (das Haar) – ein Pelz auf dem Kopf.',
          ),
        )
      : browseCard(all, refresh);

  const list =
    all.length === 0
      ? null
      : card(
          `Alle ${all.length}`,
          el(
            'div.mnemolist',
            null,
            all.map((m) =>
              el(
                'div.mnemorow',
                null,
                el(
                  'div.mnemorow__main',
                  null,
                  m.term ? el('span.mnemorow__term', null, m.term) : null,
                  el('span.mnemorow__text', null, m.text),
                ),
                m.source === 'vocab'
                  ? el('span.badge', { title: 'Hängt an einer Vokabel' }, 'Vokabel')
                  : el(
                      'button.iconbutton.iconbutton--quiet',
                      {
                        type: 'button',
                        'aria-label': 'Merksatz löschen',
                        onclick: () => {
                          if (confirm('Merksatz wirklich löschen?')) store.removeMnemonic(m.id);
                        },
                      },
                      '×',
                    ),
              ),
            ),
          ),
        );

  return el('div.view', null, browser, card(null, toggle, form), list);
}

function browseCard(all, refresh) {
  const current = all[Math.min(index, all.length - 1)];
  const step = (delta) => {
    index = (index + delta + all.length) % all.length;
    refresh();
  };

  const node = el(
    'section.card.mnemocard',
    null,
    el('span.mnemocard__count', null, `${index + 1} / ${all.length}`),
    current.term ? el('p.mnemocard__term', null, current.term) : null,
    el('p.mnemocard__text', null, current.text),
    el('span.mnemocard__date', null, `notiert am ${formatDay(current.added)}`),
    el(
      'div.buttonrow',
      null,
      el('button.ghostbutton', { type: 'button', onclick: () => step(-1) }, '‹ Zurück'),
      el('button.ghostbutton', { type: 'button', onclick: () => step(1) }, 'Weiter ›'),
    ),
  );

  // Wischen wie bei Karteikarten: horizontale Geste blättert.
  let startX = null;
  node.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
  }, { passive: true });
  node.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });

  return node;
}

function addForm(store) {
  const term = el('input.input', { type: 'text', placeholder: 'Wort oder Wendung (optional)' });
  const text = el('textarea.input', { rows: 3, placeholder: 'Deine Eselsbrücke' });

  return el(
    'form.form',
    {
      onsubmit: (event) => {
        event.preventDefault();
        if (!text.value.trim()) {
          toast('Ohne Merksatz wird das nichts 🙂', 'calm');
          return;
        }
        index = 0;
        store.addMnemonic(term.value, text.value);
        confetti(null, 40);
        toast('¡Guardado! Merksatz gesichert', 'fiesta');
      },
    },
    field('Wort', term),
    field('Merksatz', text),
    el('button.primarybutton', { type: 'submit' }, 'Sichern'),
  );
}

export function reset() {
  showForm = false;
}
