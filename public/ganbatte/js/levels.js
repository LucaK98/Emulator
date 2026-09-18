/**
 * SMART-Ziel: von einem Startniveau auf ein Zielniveau der GER-Skala.
 *
 * Ein echtes Sprachniveau kann diese App nicht messen - sie hört ja nicht zu.
 * Statt eine Messung vorzutäuschen, schätzt sie aus dem, was sie sieht:
 * gesprochene Tage, gefestigte Vokabeln, gemeisterte Cognate-Muster. Die Zahl
 * ist ausdrücklich als Schätzung beschriftet. Sie soll Fortschritt sichtbar
 * machen, nicht ein Zertifikat ersetzen.
 */

export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** Punkte pro Niveaustufe. ~100 Sprechtage pro Stufe, durch Lernen schneller. */
export const XP_PER_LEVEL = 1000;

export const XP = {
  speakingDay: 10,
  masteredVocab: 2,
  masteredCognate: 5,
};

export function levelIndex(level) {
  const i = LEVELS.indexOf(level);
  return i === -1 ? 0 : i;
}

/**
 * @param {{speakingDays:number, masteredVocab:number, masteredCognates:number}} activity
 */
export function totalXp(activity) {
  return (
    activity.speakingDays * XP.speakingDay +
    activity.masteredVocab * XP.masteredVocab +
    activity.masteredCognates * XP.masteredCognate
  );
}

/**
 * Geschätzte Position auf der Skala, als Kommazahl:
 * 1.5 heißt "auf halbem Weg von A2 nach B1".
 */
export function estimatedLevel(startLevel, activity) {
  const start = levelIndex(startLevel);
  const gained = totalXp(activity) / XP_PER_LEVEL;
  return Math.min(LEVELS.length - 1, start + gained);
}

export function levelLabel(position) {
  const whole = Math.floor(position);
  const rest = position - whole;
  const level = LEVELS[Math.min(whole, LEVELS.length - 1)];
  if (rest < 0.15) return level;
  if (rest > 0.85) return `${level}+`;
  const next = LEVELS[Math.min(whole + 1, LEVELS.length - 1)];
  return `${level} → ${next}`;
}

/**
 * Fortschritt vom Start- zum Zielniveau, 0 .. 1.
 * Ist das Ziel schon erreicht oder identisch mit dem Start, sind es 1.
 */
export function goalProgress(goal, activity) {
  const start = levelIndex(goal.startLevel);
  const target = levelIndex(goal.targetLevel);
  const now = estimatedLevel(goal.startLevel, activity);
  if (target <= start) return 1;
  return Math.max(0, Math.min(1, (now - start) / (target - start)));
}

/**
 * Wie viele Punkte fehlen noch bis zum Ziel - und wie viele pro verbleibendem
 * Tag. Daraus wird auf dem Zielschirm ein freundlicher Tempo-Hinweis.
 */
export function pace(goal, activity, daysLeft) {
  const start = levelIndex(goal.startLevel);
  const target = levelIndex(goal.targetLevel);
  const needed = Math.max(0, (target - start) * XP_PER_LEVEL - totalXp(activity));
  if (needed === 0) return { needed: 0, perDay: 0, done: true };
  if (daysLeft <= 0) return { needed, perDay: needed, done: false };
  return { needed, perDay: needed / daysLeft, done: false };
}
