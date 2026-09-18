/**
 * Zustand der App - alles lokal, kein Backend, kein Konto.
 *
 * Gespeichert wird in localStorage als ein einziger JSON-Blob. Das reicht für
 * die Datenmengen hier locker (ein paar hundert Vokabeln sind Kilobytes) und
 * macht Export/Import zu einem Einzeiler. IndexedDB wäre Overkill.
 *
 * Schreiben passiert gebündelt am Ende des Ticks, damit eine Lernrunde mit
 * vielen schnellen Antworten nicht dutzendfach serialisiert.
 */

import { todayKey, addDays, daysBetween } from './dates.js';
import { createCard, review as reviewCard, masteredCount } from './srs.js';
import { MASTERY_HITS, COGNATE_WORDS, masteredPatterns } from './cognates.js';

const STORAGE_KEY = 'ganbatte.state.v1';

/** Meilensteine, die eine Feier wert sind. */
export const VOCAB_MILESTONES = [10, 25, 50, 100, 250];
export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 365];

function emptyState() {
  return {
    version: 1,
    streak: { current: 0, longest: 0, lastLoggedDate: null },
    speakingLog: [],
    vocab: [],
    cognatesProgress: { masteredIds: [], hits: {} },
    mnemonics: [],
    goal: null,
    celebrated: [],
    createdAt: todayKey(),
  };
}

/**
 * Gelesenes JSON auf die erwartete Form bringen. Alles, was fehlt oder den
 * falschen Typ hat, wird ersetzt - eine halb kaputte Datei darf die App nicht
 * am Starten hindern, dafür sind die Daten zu schwer wiederzubeschaffen.
 */
function normalize(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const streak = raw.streak && typeof raw.streak === 'object' ? raw.streak : {};
  const cognates = raw.cognatesProgress && typeof raw.cognatesProgress === 'object' ? raw.cognatesProgress : {};
  const knownIds = new Set(COGNATE_WORDS.map((w) => w.id));
  return {
    version: 1,
    streak: {
      current: Number(streak.current) || 0,
      longest: Number(streak.longest) || 0,
      lastLoggedDate: typeof streak.lastLoggedDate === 'string' ? streak.lastLoggedDate : null,
    },
    speakingLog: Array.isArray(raw.speakingLog)
      ? raw.speakingLog
          .filter((e) => e && typeof e.date === 'string')
          .map((e) => ({ date: e.date, note: typeof e.note === 'string' ? e.note : '' }))
      : [],
    vocab: Array.isArray(raw.vocab)
      ? raw.vocab
          .filter((c) => c && typeof c.es === 'string' && typeof c.translation === 'string')
          .map((c) => ({
            id: String(c.id || `v${Math.random().toString(36).slice(2)}`),
            es: c.es,
            translation: c.translation,
            mnemonic: typeof c.mnemonic === 'string' ? c.mnemonic : '',
            step: Number(c.step) || 0,
            interval: Number(c.interval) || 0,
            nextReview: typeof c.nextReview === 'string' ? c.nextReview : todayKey(),
            added: typeof c.added === 'string' ? c.added : todayKey(),
            history: Array.isArray(c.history) ? c.history.slice(-20) : [],
          }))
      : [],
    cognatesProgress: {
      // Wörter, die es nicht mehr gibt, fallen raus - sonst zeigt die
      // Fortschrittsleiste irgendwann mehr als 100 %.
      masteredIds: Array.isArray(cognates.masteredIds)
        ? cognates.masteredIds.filter((id) => knownIds.has(id))
        : [],
      hits: cognates.hits && typeof cognates.hits === 'object' ? { ...cognates.hits } : {},
    },
    mnemonics: Array.isArray(raw.mnemonics)
      ? raw.mnemonics
          .filter((m) => m && typeof m.text === 'string')
          .map((m) => ({
            id: String(m.id || `m${Math.random().toString(36).slice(2)}`),
            term: typeof m.term === 'string' ? m.term : '',
            text: m.text,
            added: typeof m.added === 'string' ? m.added : todayKey(),
          }))
      : [],
    goal:
      raw.goal && typeof raw.goal === 'object' && typeof raw.goal.targetLevel === 'string'
        ? {
            startLevel: typeof raw.goal.startLevel === 'string' ? raw.goal.startLevel : 'A1',
            targetLevel: raw.goal.targetLevel,
            targetDate: typeof raw.goal.targetDate === 'string' ? raw.goal.targetDate : '',
            motivation: typeof raw.goal.motivation === 'string' ? raw.goal.motivation : '',
            startedDate: typeof raw.goal.startedDate === 'string' ? raw.goal.startedDate : todayKey(),
          }
        : null,
    celebrated: Array.isArray(raw.celebrated) ? raw.celebrated.map(String) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    // Privater Modus, volle Quote, kaputtes JSON: lieber leer starten als weiß.
    return emptyState();
  }
}

export function createStore() {
  let state = load();
  /** @type {Set<(state:object)=>void>} */
  const listeners = new Set();
  let writeScheduled = false;

  function persist() {
    if (writeScheduled) return;
    writeScheduled = true;
    queueMicrotask(() => {
      writeScheduled = false;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Kein Speicher, kein Drama - die Sitzung läuft im Arbeitsspeicher weiter.
      }
    });
  }

  function emit() {
    for (const listener of listeners) listener(state);
  }

  function update(mutator) {
    const party = [];
    state = mutator(state, (kind, text) => party.push({ kind, text }));
    persist();
    emit();
    return party;
  }

  /** Meilenstein nur beim ersten Mal feiern. */
  function celebrate(next, token, kind, text, party) {
    if (next.celebrated.includes(token)) return next;
    party(kind, text);
    return { ...next, celebrated: [...next.celebrated, token] };
  }

  return {
    get state() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Heutigen Sprech-Tag eintragen. Zweimaliges Tippen ändert nichts. */
    logSpeaking(note = '', today = todayKey()) {
      return update((prev, party) => {
        if (prev.speakingLog.some((e) => e.date === today)) {
          return note ? withNote(prev, today, note) : prev;
        }
        const last = prev.streak.lastLoggedDate;
        const continues = last !== null && daysBetween(last, today) === 1;
        const current = continues ? prev.streak.current + 1 : 1;
        let next = {
          ...prev,
          speakingLog: [...prev.speakingLog, { date: today, note }].sort((a, b) =>
            a.date < b.date ? -1 : 1,
          ),
          streak: {
            current,
            longest: Math.max(prev.streak.longest, current),
            lastLoggedDate: today,
          },
        };
        party('speaking', current === 1 ? '¡Vamos! Tag 1 🔥' : `¡Olé! Tag ${current} 🔥`);
        if (STREAK_MILESTONES.includes(current)) {
          next = celebrate(
            next,
            `streak-${current}`,
            'milestone',
            `${current} Tage am Stück - ¡increíble! 🎉`,
            party,
          );
        }
        return next;
      });
    },

    /** Notiz zum Tag nachtragen oder ändern. */
    setNote(note, day = todayKey()) {
      update((prev) => withNote(prev, day, note));
    },

    addVocab(fields, today = todayKey()) {
      return update((prev, party) => {
        const card = createCard(fields, today);
        let next = { ...prev, vocab: [card, ...prev.vocab] };
        const count = next.vocab.length;
        party('vocab', `¡Vamos! Vokabel Nr. ${count}`);
        if (VOCAB_MILESTONES.includes(count)) {
          next = celebrate(
            next,
            `vocab-${count}`,
            'milestone',
            `${count} Vokabeln gesammelt - ¡qué crack! 🎉`,
            party,
          );
        }
        return next;
      });
    },

    updateVocab(id, fields) {
      update((prev) => ({
        ...prev,
        vocab: prev.vocab.map((c) => (c.id === id ? { ...c, ...fields } : c)),
      }));
    },

    removeVocab(id) {
      update((prev) => ({ ...prev, vocab: prev.vocab.filter((c) => c.id !== id) }));
    },

    /** Antwort in der Lernrunde verbuchen. */
    reviewVocab(id, known, today = todayKey()) {
      return update((prev, party) => {
        const before = masteredCount(prev.vocab);
        const vocab = prev.vocab.map((c) => (c.id === id ? reviewCard(c, known, today, addDays) : c));
        let next = { ...prev, vocab };
        const after = masteredCount(vocab);
        if (after > before && VOCAB_MILESTONES.includes(after)) {
          next = celebrate(
            next,
            `mastered-${after}`,
            'milestone',
            `${after} Vokabeln sitzen fest - ¡olé! 🎉`,
            party,
          );
        }
        return next;
      });
    },

    /** Cognate-Quiz: Antwort verbuchen, ggf. Muster abhaken. */
    answerCognate(wordId, correct) {
      return update((prev, party) => {
        const hits = { ...prev.cognatesProgress.hits };
        hits[wordId] = correct ? (hits[wordId] || 0) + 1 : 0;
        const masteredIds = [...prev.cognatesProgress.masteredIds];
        if (correct && hits[wordId] >= MASTERY_HITS && !masteredIds.includes(wordId)) {
          masteredIds.push(wordId);
        }
        let next = { ...prev, cognatesProgress: { masteredIds, hits } };
        const patternsBefore = masteredPatterns(prev.cognatesProgress.masteredIds).length;
        const patternsNow = masteredPatterns(masteredIds).length;
        if (patternsNow > patternsBefore) {
          next = celebrate(
            next,
            `pattern-${patternsNow}`,
            'milestone',
            `Muster ${patternsNow} gemeistert - ¡fantástico! 🎉`,
            party,
          );
        }
        return next;
      });
    },

    resetCognates() {
      update((prev) => ({ ...prev, cognatesProgress: { masteredIds: [], hits: {} } }));
    },

    addMnemonic(term, text, today = todayKey()) {
      update((prev) => ({
        ...prev,
        mnemonics: [
          {
            id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            term: term.trim(),
            text: text.trim(),
            added: today,
          },
          ...prev.mnemonics,
        ],
      }));
    },

    removeMnemonic(id) {
      update((prev) => ({ ...prev, mnemonics: prev.mnemonics.filter((m) => m.id !== id) }));
    },

    setGoal(goal, today = todayKey()) {
      update((prev) => ({
        ...prev,
        goal: {
          startLevel: goal.startLevel,
          targetLevel: goal.targetLevel,
          targetDate: goal.targetDate,
          motivation: goal.motivation,
          startedDate: prev.goal?.startedDate || today,
        },
      }));
    },

    clearGoal() {
      update((prev) => ({ ...prev, goal: null }));
    },

    /** Kompletter Export - die einzige Sicherung, die es ohne Cloud gibt. */
    exportJson() {
      return JSON.stringify(state, null, 2);
    },

    importJson(text) {
      const parsed = normalize(JSON.parse(text));
      update(() => parsed);
    },

    resetAll() {
      update(() => emptyState());
    },
  };
}

function withNote(prev, day, note) {
  const exists = prev.speakingLog.some((e) => e.date === day);
  const speakingLog = exists
    ? prev.speakingLog.map((e) => (e.date === day ? { ...e, note } : e))
    : [...prev.speakingLog, { date: day, note }].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { ...prev, speakingLog };
}

/**
 * Streak fürs Display. Der gespeicherte Zähler ändert sich nur beim Eintragen;
 * ob er *heute* noch gilt, hängt am Datum. Zwei Tage Pause heißt: bei 0
 * anfangen - aber ohne Drama, das macht die Oberfläche.
 */
export function activeStreak(state, today = todayKey()) {
  const last = state.streak.lastLoggedDate;
  if (!last) return 0;
  const gap = daysBetween(last, today);
  return gap === 0 || gap === 1 ? state.streak.current : 0;
}

export function loggedToday(state, today = todayKey()) {
  return state.speakingLog.some((e) => e.date === today);
}

export function noteFor(state, day = todayKey()) {
  return state.speakingLog.find((e) => e.date === day)?.note || '';
}

/** Zahlen, die Dashboard und Zielschirm gemeinsam brauchen. */
export function activityStats(state) {
  return {
    speakingDays: state.speakingLog.length,
    masteredVocab: masteredCount(state.vocab),
    masteredCognates: state.cognatesProgress.masteredIds.length,
  };
}
