/**
 * Ganbatte - App-Gerüst: Tabs, Neuzeichnen, Einstellungen, Service Worker.
 *
 * Die Bildschirme bauen bei jeder Änderung ihren DOM neu auf. Bei dieser
 * Datenmenge (ein Kalender, ein paar Listen) ist das in unter einer
 * Millisekunde erledigt und spart die gesamte Buchhaltung, die ein Framework
 * sonst übernimmt. Scrollposition und Fokus stellen wir gezielt wieder her.
 */

import { el, clear } from './dom.js';
import { createStore, activeStreak, loggedToday } from './store.js';
import { toast } from './fx.js';
import { todayKey } from './dates.js';
import * as dashboard from './views/dashboard.js';
import * as vocab from './views/vocab.js';
import * as cognates from './views/cognates.js';
import * as mnemonics from './views/mnemonics.js';
import * as goal from './views/goal.js';
import { dueCards } from './srs.js';
import { daysBetween } from './dates.js';

const TABS = [
  { id: 'dashboard', label: 'Heute', icon: '🔥', view: dashboard },
  { id: 'vocab', label: 'Vokabeln', icon: '🗂️', view: vocab },
  { id: 'cognates', label: 'Cognates', icon: '🧩', view: cognates },
  { id: 'mnemonics', label: 'Merksätze', icon: '💡', view: mnemonics },
  { id: 'goal', label: 'Ziel', icon: '🎯', view: goal },
];

const store = createStore();
let activeTab = TABS[0].id;

const root = document.getElementById('app');
const viewHost = el('main.main', { id: 'main' });
const navHost = el('nav.tabbar', { 'aria-label': 'Hauptnavigation' });
const headerHost = el('header.appbar');

function tabFromHash() {
  const id = location.hash.replace('#', '');
  return TABS.some((t) => t.id === id) ? id : null;
}

function go(id, { fromHash = false } = {}) {
  if (!TABS.some((t) => t.id === id)) return;
  if (id !== activeTab) {
    // Beim Verlassen räumt jeder Bildschirm seinen lokalen Zustand auf -
    // sonst kommt man in eine halb angefangene Lernrunde zurück.
    TABS.find((t) => t.id === activeTab)?.view.reset?.();
    activeTab = id;
  }
  if (!fromHash) location.hash = id;
  render({ toTop: true });
}

/**
 * @param {{toTop?:boolean, after?:() => void}} [options]
 */
function render(options = {}) {
  const tab = TABS.find((t) => t.id === activeTab) || TABS[0];
  const scroll = window.scrollY;

  const ctx = {
    store,
    state: store.state,
    go,
    refresh: (after) => render(typeof after === 'function' ? { after } : {}),
  };

  const node = tab.view.render(ctx);
  clear(viewHost);
  viewHost.appendChild(node);
  renderHeader();
  renderNav();

  if (options.toTop) window.scrollTo(0, 0);
  else window.scrollTo(0, scroll);
  options.after?.();
}

function renderHeader() {
  const state = store.state;
  const streak = activeStreak(state);
  clear(headerHost);
  headerHost.appendChild(
    el(
      'div.appbar__inner',
      null,
      el(
        'div.appbar__brand',
        null,
        el('span.appbar__mark', null, '¡'),
        el('span.appbar__title', null, 'Ganbatte'),
      ),
      el(
        'div.appbar__right',
        null,
        el(
          'span.appbar__streak',
          { class: loggedToday(state) ? 'is-done' : '' },
          `${streak > 0 ? '🔥' : '🌱'} ${streak}`,
        ),
        el(
          'button.iconbutton.iconbutton--quiet',
          { type: 'button', 'aria-label': 'Einstellungen', onclick: openSettings },
          '⋯',
        ),
      ),
    ),
  );
}

function renderNav() {
  const state = store.state;
  const due = dueCards(state.vocab, todayKey(), daysBetween).length;
  clear(navHost);
  for (const tab of TABS) {
    const isActive = tab.id === activeTab;
    navHost.appendChild(
      el(
        'button.tab',
        {
          type: 'button',
          class: isActive ? 'is-active' : '',
          'aria-current': isActive ? 'page' : null,
          onclick: () => go(tab.id),
        },
        el(
          'span.tab__icon',
          null,
          tab.icon,
          tab.id === 'vocab' && due > 0 ? el('span.tab__badge', null, String(Math.min(due, 99))) : null,
        ),
        el('span.tab__label', null, tab.label),
      ),
    );
  }
}

/** Einstellungen: Sichern, Zurückspielen, Aufräumen. */
function openSettings() {
  const existing = document.querySelector('.sheet');
  if (existing) existing.remove();

  const close = () => sheet.remove();

  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    onchange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        store.importJson(await file.text());
        close();
        toast('Daten zurückgespielt ✅', 'milestone');
        render({ toTop: true });
      } catch {
        toast('Diese Datei konnte ich nicht lesen', 'calm');
      }
    },
  });

  const sheet = el(
    'div.sheet',
    { onclick: (e) => e.target === e.currentTarget && close() },
    el(
      'div.sheet__panel',
      { role: 'dialog', 'aria-label': 'Einstellungen' },
      el('h2.sheet__title', null, 'Deine Daten'),
      el(
        'p.sheet__text',
        null,
        'Alles liegt nur auf diesem Gerät - kein Konto, keine Cloud. Deshalb: ab und zu sichern.',
      ),
      el(
        'button.primarybutton',
        {
          type: 'button',
          onclick: () => {
            const blob = new Blob([store.exportJson()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = el('a', { href: url, download: `ganbatte-${todayKey()}.json` });
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        },
        'Sicherung herunterladen',
      ),
      el(
        'button.ghostbutton',
        { type: 'button', onclick: () => fileInput.click() },
        'Sicherung einspielen',
      ),
      fileInput,
      el(
        'button.ghostbutton.ghostbutton--quiet',
        {
          type: 'button',
          onclick: () => {
            if (confirm('Wirklich alles löschen? Streak, Vokabeln, Ziel - alles weg.')) {
              store.resetAll();
              close();
              render({ toTop: true });
            }
          },
        },
        'Alles zurücksetzen',
      ),
      el('button.sheet__close', { type: 'button', onclick: close }, 'Schließen'),
    ),
  );
  document.body.appendChild(sheet);
}

/**
 * iOS kennt keinen Installations-Dialog: Auf dem iPhone geht es nur über
 * "Teilen → Zum Home-Bildschirm". Das weiß niemand von selbst, also sagen wir
 * es einmal - und merken uns, dass es weggetippt wurde.
 */
function maybeShowInstallHint() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const dismissed = localStorage.getItem('ganbatte.installHint') === 'dismissed';
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (standalone || dismissed || !isIos) return;

  const banner = el(
    'div.installhint',
    null,
    el('span', null, 'Tipp: über '),
    el('strong', null, 'Teilen → Zum Home-Bildschirm'),
    el('span', null, ' wird Ganbatte zur App auf deinem Startbildschirm.'),
    el(
      'button.iconbutton.iconbutton--quiet',
      {
        type: 'button',
        'aria-label': 'Hinweis ausblenden',
        onclick: () => {
          try {
            localStorage.setItem('ganbatte.installHint', 'dismissed');
          } catch {
            /* egal */
          }
          banner.remove();
        },
      },
      '×',
    ),
  );
  document.body.appendChild(banner);
}

function boot() {
  clear(root);
  root.appendChild(headerHost);
  root.appendChild(viewHost);
  root.appendChild(navHost);

  activeTab = tabFromHash() || TABS[0].id;
  window.addEventListener('hashchange', () => {
    const id = tabFromHash();
    if (id) go(id, { fromHash: true });
  });

  store.subscribe(() => render());
  render({ toTop: true });
  maybeShowInstallHint();

  // Beim Zurückholen aus dem Hintergrund kann ein Tageswechsel liegen: Streak,
  // fällige Karten und Countdown stimmen dann nicht mehr.
  let lastDay = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (todayKey() !== lastDay) {
      lastDay = todayKey();
      render();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // Ohne Service Worker läuft die App weiter, nur eben nicht offline.
      });
    });
  }
}

boot();
