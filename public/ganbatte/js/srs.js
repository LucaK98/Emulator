/**
 * Spaced Repetition, bewusst schlicht (Leitner-Prinzip).
 *
 * Eine Karte wandert bei "gewusst" eine Stufe hoch und wird nach dem
 * zugehörigen Intervall wieder vorgelegt. Bei "nochmal" fällt sie auf Stufe 0
 * zurück und ist sofort wieder fällig - sie kommt also noch in derselben
 * Lernrunde erneut dran, statt erst morgen. Das hält die Runde kurz und das
 * Gefühl positiv: man verlässt die Session mit lauter Karten, die saßen.
 */

/** Intervalle in Tagen, Stufe 0 .. 4. */
export const STEPS = [1, 3, 7, 14, 30];

/** Ab diesem Intervall gilt eine Vokabel als "sitzt" (Langzeitgedächtnis). */
export const MASTER_STEP = 2;

/** @param {{es:string, translation:string, mnemonic?:string}} fields */
export function createCard(fields, today) {
  return {
    id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    es: fields.es.trim(),
    translation: fields.translation.trim(),
    mnemonic: (fields.mnemonic || '').trim(),
    step: 0,
    interval: 0,
    nextReview: today, // Neue Karten sind sofort fällig.
    added: today,
    history: [],
  };
}

/**
 * Antwort verbuchen. Gibt eine *neue* Karte zurück, mutiert nichts.
 * @param {object} card
 * @param {boolean} known
 * @param {string} today Tagesschlüssel
 * @param {(key:string, days:number)=>string} addDays
 */
export function review(card, known, today, addDays) {
  const history = [...card.history, { date: today, known }].slice(-20);
  if (!known) {
    return { ...card, step: 0, interval: 0, nextReview: today, history };
  }
  const interval = STEPS[Math.min(card.step, STEPS.length - 1)];
  return {
    ...card,
    step: Math.min(card.step + 1, STEPS.length),
    interval,
    nextReview: addDays(today, interval),
    history,
  };
}

/** Karten, die heute dran sind - älteste Fälligkeit zuerst. */
export function dueCards(cards, today, daysBetween) {
  return cards
    .filter((c) => daysBetween(c.nextReview, today) >= 0)
    .sort((a, b) => (a.nextReview < b.nextReview ? -1 : a.nextReview > b.nextReview ? 1 : 0));
}

/** Vokabeln, die mindestens ein 7-Tage-Intervall überstanden haben. */
export function masteredCount(cards) {
  return cards.filter((c) => c.step >= MASTER_STEP).length;
}

/** Trefferquote über die gesamte Historie, für die Statistik. */
export function accuracy(cards) {
  let hits = 0;
  let total = 0;
  for (const card of cards) {
    for (const entry of card.history) {
      total += 1;
      if (entry.known) hits += 1;
    }
  }
  return total === 0 ? null : hits / total;
}
