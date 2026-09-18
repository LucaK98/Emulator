/**
 * Cognate-Muster: spanische Endungen, die sich fast eins zu eins ins Deutsche
 * übersetzen lassen. Wer die elf Muster kennt, versteht schlagartig ein paar
 * tausend Wörter, ohne eines davon gelernt zu haben - genau der "Cognates
 * nutzen"-Hebel aus den 12 Regeln.
 *
 * Jedes Muster hat drei Beispielwörter. `bridge` ist die Eselsbrücke, die nach
 * der Antwort eingeblendet wird.
 */

export const PATTERNS = [
  {
    id: 'cion',
    label: '-ción → -tion',
    rule: 'Fast jedes deutsche Wort auf -tion gibt es im Spanischen auf -ción. Immer feminin: la nación.',
    words: [
      { id: 'cion-1', es: 'la información', de: 'die Information' },
      { id: 'cion-2', es: 'la situación', de: 'die Situation' },
      { id: 'cion-3', es: 'la revolución', de: 'die Revolution' },
    ],
  },
  {
    id: 'dad',
    label: '-dad → -tät',
    rule: 'Deutsch -tät wird spanisch -dad. Auch hier: immer feminin.',
    words: [
      { id: 'dad-1', es: 'la universidad', de: 'die Universität' },
      { id: 'dad-2', es: 'la actividad', de: 'die Aktivität' },
      { id: 'dad-3', es: 'la realidad', de: 'die Realität' },
    ],
  },
  {
    id: 'mente',
    label: '-mente → Adverb',
    rule: 'Adjektiv + -mente ergibt das Adverb, wie deutsch -erweise oder -lich.',
    words: [
      { id: 'mente-1', es: 'normalmente', de: 'normalerweise' },
      { id: 'mente-2', es: 'exactamente', de: 'genau', bridge: 'exakt' },
      { id: 'mente-3', es: 'perfectamente', de: 'perfekt' },
    ],
  },
  {
    id: 'oso',
    label: '-oso → -ös / -reich',
    rule: 'Adjektive auf -oso entsprechen oft deutschem -ös oder -voll.',
    words: [
      { id: 'oso-1', es: 'famoso', de: 'berühmt', bridge: 'famos' },
      { id: 'oso-2', es: 'nervioso', de: 'nervös' },
      { id: 'oso-3', es: 'generoso', de: 'großzügig', bridge: 'generös' },
    ],
  },
  {
    id: 'al',
    label: '-al → -al / -ell',
    rule: 'Adjektive auf -al bleiben meist unverändert oder werden zu -ell.',
    words: [
      { id: 'al-1', es: 'natural', de: 'natürlich', bridge: 'natural' },
      { id: 'al-2', es: 'social', de: 'sozial' },
      { id: 'al-3', es: 'especial', de: 'speziell' },
    ],
  },
  {
    id: 'ivo',
    label: '-ivo → -iv',
    rule: 'Adjektive auf -ivo sind im Deutschen fast immer -iv.',
    words: [
      { id: 'ivo-1', es: 'activo', de: 'aktiv' },
      { id: 'ivo-2', es: 'positivo', de: 'positiv' },
      { id: 'ivo-3', es: 'creativo', de: 'kreativ' },
    ],
  },
  {
    id: 'ismo',
    label: '-ismo → -ismus',
    rule: 'Alle -ismus-Wörter funktionieren auch auf Spanisch, männlich: el turismo.',
    words: [
      { id: 'ismo-1', es: 'el turismo', de: 'der Tourismus' },
      { id: 'ismo-2', es: 'el optimismo', de: 'der Optimismus' },
      { id: 'ismo-3', es: 'el realismo', de: 'der Realismus' },
    ],
  },
  {
    id: 'ista',
    label: '-ista → -ist',
    rule: 'Berufe und Anhänger:innen auf -ista. Die Form gilt für alle Geschlechter: el/la artista.',
    words: [
      { id: 'ista-1', es: 'el/la artista', de: 'der/die Künstler:in', bridge: 'Artist' },
      { id: 'ista-2', es: 'el/la turista', de: 'der/die Tourist:in' },
      { id: 'ista-3', es: 'el/la pianista', de: 'der/die Pianist:in' },
    ],
  },
  {
    id: 'ia',
    label: '-ia / -ía → -ie',
    rule: 'Deutsch -ie wird spanisch -ia oder -ía. Der Akzent verschiebt nur die Betonung.',
    words: [
      { id: 'ia-1', es: 'la familia', de: 'die Familie' },
      { id: 'ia-2', es: 'la energía', de: 'die Energie' },
      { id: 'ia-3', es: 'la geografía', de: 'die Geografie' },
    ],
  },
  {
    id: 'encia',
    label: '-encia / -ancia → -enz / -anz',
    rule: 'Aus -enz und -anz wird -encia und -ancia.',
    words: [
      { id: 'encia-1', es: 'la diferencia', de: 'der Unterschied', bridge: 'Differenz' },
      { id: 'encia-2', es: 'la experiencia', de: 'die Erfahrung', bridge: 'Experienz' },
      { id: 'encia-3', es: 'la importancia', de: 'die Wichtigkeit', bridge: 'Importanz' },
    ],
  },
  {
    id: 'ar',
    label: 'Verben -ar → -ieren',
    rule: 'Deutsche Verben auf -ieren enden spanisch auf -ar. Der halbe Fremdwortschatz ist damit erledigt.',
    words: [
      { id: 'ar-1', es: 'organizar', de: 'organisieren' },
      { id: 'ar-2', es: 'estudiar', de: 'studieren' },
      { id: 'ar-3', es: 'controlar', de: 'kontrollieren' },
    ],
  },
];

/** Alle Wörter flach, jeweils mit Muster-Kontext. */
export const COGNATE_WORDS = PATTERNS.flatMap((pattern) =>
  pattern.words.map((word) => ({ ...word, patternId: pattern.id, patternLabel: pattern.label })),
);

/**
 * Falsche Freunde - die Kehrseite der Cognate-Abkürzung. Rein zum Nachlesen,
 * nicht im Quiz: sie sollen warnen, nicht Punkte kosten.
 */
export const FALSE_FRIENDS = [
  { es: 'la carta', de: 'der Brief', not: 'nicht: die Karte (das ist el mapa / la tarjeta)' },
  { es: 'el compromiso', de: 'die Verpflichtung', not: 'nicht: der Kompromiss' },
  { es: 'la firma', de: 'die Unterschrift', not: 'nicht: die Firma (das ist la empresa)' },
  { es: 'el gimnasio', de: 'das Fitnessstudio', not: 'nicht: das Gymnasium' },
  { es: 'largo', de: 'lang', not: 'nicht: large / groß (das ist grande)' },
  { es: 'el vaso', de: 'das Glas', not: 'nicht: die Vase (das ist el jarrón)' },
];

/** Ab so vielen richtigen Antworten gilt ein Wort als gemeistert. */
export const MASTERY_HITS = 2;

/** Wie viele der elf Muster sitzen komplett? */
export function masteredPatterns(masteredIds) {
  const done = new Set(masteredIds);
  return PATTERNS.filter((p) => p.words.every((w) => done.has(w.id))).map((p) => p.id);
}

/**
 * Nächstes Quizwort: was noch nicht sitzt, kommt zuerst - in zufälliger
 * Reihenfolge, damit die Runde nicht jedes Mal gleich abläuft.
 */
export function pickWord(masteredIds, lastId = null, random = Math.random) {
  const done = new Set(masteredIds);
  let pool = COGNATE_WORDS.filter((w) => !done.has(w.id) && w.id !== lastId);
  if (pool.length === 0) pool = COGNATE_WORDS.filter((w) => w.id !== lastId);
  if (pool.length === 0) pool = COGNATE_WORDS;
  return pool[Math.floor(random() * pool.length)];
}

/** Kopie in zufälliger Reihenfolge (Fisher-Yates). */
function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Drei Antwortmöglichkeiten: die richtige plus zwei plausible Ablenker. */
export function buildOptions(word, random = Math.random) {
  const others = shuffled(COGNATE_WORDS.filter((w) => w.de !== word.de), random);
  // Ablenker bevorzugt aus demselben Muster - sonst verrät die Wortform zu viel.
  const sameShape = others.filter((w) => w.patternId === word.patternId);
  const pool = [...sameShape, ...others.filter((w) => w.patternId !== word.patternId)];
  const picked = [];
  for (const candidate of pool) {
    if (picked.length === 2) break;
    if (picked.some((p) => p.de === candidate.de)) continue;
    picked.push(candidate);
  }
  // Mischen, damit die richtige Antwort nicht immer vorne steht.
  return shuffled([word.de, ...picked.map((p) => p.de)], random);
}
