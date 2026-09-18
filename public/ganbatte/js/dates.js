/**
 * Datums-Helfer.
 *
 * Alles rechnet in *lokaler* Zeit. `toISOString()` wäre verlockend, liefert
 * aber UTC: wer abends um 23:30 in Mitteleuropa auf "Heute gesprochen" tippt,
 * bekäme den Eintrag auf den Folgetag gebucht und damit eine kaputte Streak.
 * Deshalb bauen wir den Tagesschlüssel "YYYY-MM-DD" selbst.
 */

/** @param {Date} [date] */
export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Tagesschlüssel -> Date (lokale Mitternacht). @param {string} key */
export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** @param {string} key @param {number} days */
export function addDays(key, days) {
  const date = fromKey(key);
  date.setDate(date.getDate() + days);
  return todayKey(date);
}

/**
 * Ganze Tage zwischen zwei Tagesschlüsseln (b - a).
 * Über lokale Mitternacht gerechnet, damit Sommerzeit-Sprünge (23- bzw.
 * 25-Stunden-Tage) nicht zu 0 oder 2 Tagen Differenz führen.
 */
export function daysBetween(a, b) {
  const ms = fromKey(b).getTime() - fromKey(a).getTime();
  return Math.round(ms / 86400000);
}

/** true, wenn `key` heute oder früher fällig ist. */
export function isDue(key, today = todayKey()) {
  return !key || daysBetween(key, today) >= 0;
}

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** Montag zuerst - so sieht ein deutscher Kalender aus. */
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export function monthName(monthIndex) {
  return MONTHS[monthIndex];
}

/** @param {string} key */
export function formatDay(key) {
  const d = fromKey(key);
  return `${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Wie viele Tage liegt `key` in der Zukunft? Negativ = Vergangenheit. */
export function daysUntil(key, today = todayKey()) {
  return daysBetween(today, key);
}

/**
 * Raster für die Monatsansicht: immer volle Wochen ab Montag.
 * Liefert Tagesschlüssel plus Flag, ob der Tag zum Monat gehört.
 */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  // getDay(): 0 = Sonntag. Wir wollen 0 = Montag.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ key: todayKey(d), day: d.getDate(), inMonth: d.getMonth() === month });
    // Nach einer vollen Woche abbrechen, sobald der Monat durch ist.
    if (i >= 27 && (i + 1) % 7 === 0 && d.getMonth() !== month) break;
  }
  return cells;
}
