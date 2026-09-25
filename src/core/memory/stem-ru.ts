/**
 * Russian stemmer — Porter 1980, the same algorithm the Snowball project ships
 * as the `russian` stemmer.
 *
 * Why this exists: SQLite's FTS5 has no Russian support out of the box. Its
 * default tokenizer splits on non-word characters and does nothing about
 * inflection, so a memory about "кот был рыжим" was invisible to any search
 * that said "котом", "коты" or "котов". The knowledge base looked empty.
 *
 * The useful property here is that a suffix-stripping stemmer returns a
 * *prefix* of the original word. That means a stemmed search term can be used
 * as an FTS5 prefix term (`кот*`) and still match every inflected form sitting
 * in the index — no re-tokenising, no migration, existing data just starts
 * working.
 *
 * Not a full linguistic stemmer: it is the standard suffix-stripping one, and
 * it over-stems some words. That is harmless for recall, which is what a
 * memory lookup needs.
 */

/** Consonant letters, used to compute the RV region. */
const CONSONANTS = new Set([
  "б", "в", "г", "д", "ж", "з", "й", "к", "л", "м", "н", "п", "р", "с", "т",
  "ф", "х", "ц", "ч", "ш", "щ", "ъ", "ы", "ь",
]);

const VOWELS = new Set(["а", "е", "ё", "и", "о", "у", "ы", "э", "ю", "я"]);

const PERFECTIVE_GERUND_1 = ["вшись", "вши", "в"];
const PERFECTIVE_GERUND_2 = ["ывшись", "ывши", "ыв", "ившись", "ивши", "ив"];
const ADJECTIVE = [
  "ими", "ыми", "его", "ого", "ему", "ому", "ее", "ие", "ые", "ое", "ими",
  "ыми", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "их", "ых", "ую",
  "юю", "ая", "яя", "ою", "ею",
];
const PARTICIPLE = ["ем", "нн", "вш", "ющ", "щ"];
const REFLEXIVE = ["ся", "сь"];
const VERB_1 = [
  "ешь", "ете", "йте", "ла", "на", "ли", "ем", "ло", "но", "ет", "ют", "ны",
  "ть", "л", "н", "й",
];
const VERB_2 = [
  "ейте", "уйте", "ила", "ыла", "ена", "ите", "или", "ыли", "ило", "ыло",
  "ено", "ует", "уют", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ят", "ыт",
  "ены", "ить", "ыть", "ишь", "ит", "и", "ю",
];
const NOUN = [
  "иями", "ями", "ами", "ией", "иям", "ием", "еи", "ии", "ией", "ев", "ов",
  "ие", "ье", "ей", "ой", "ий", "ям", "ем", "ам", "ом", "ах", "ия", "ья",
  "и", "й", "а", "е", "о", "у", "ю", "я", "ь",
];
const DERIVATIONAL = ["ост", "ость"];
const SUPERLATIVE = ["ейше", "ейш"];

/**
 * Diminutive endings, which the base steps do not touch.
 *
 * Without this pass "котик" and "кот" are different stems, and asking about a
 * kitty would not find a memory about a cat. Porter treats these as a separate
 * step precisely because they are the common case in everyday Russian.
 */
const DIMINUTIVE_R1 = ["ик", "ек", "ык", "ун", "юн", "ая", "яя", "ое", "ее"];
const DIMINUTIVE_R2 = ["ик", "ек", "ык", "ун", "юн", "ей", "ой", "ий", "яй", "ое", "ее", "ье"];

/**
 * Nest endings, which Porter's diminutive list does not carry.
 *
 * "котёнок" is a different stem from "кот" without these, and asking about a
 * kitten would miss a memory about a cat.
 */
const NEST_ENDINGS = ["онок", "енок", "атка", "атко"];

function isVowel(ch: string): boolean {
  return VOWELS.has(ch);
}

/**
 * RV: the region after the first "non-prefix" letter, per Porter's rules.
 * Words starting with a vowel have RV = 1. Otherwise skip back over up to two
 * consonants following the first vowel.
 */
function computeRV(word: string): number {
  if (word.length === 0) return 0;
  if (isVowel(word[0]!)) return 1;
  for (let i = 1; i < word.length; i++) {
    if (!isVowel(word[i]!)) continue;
    // Found the first vowel; step back over the preceding consonants.
    let j = i - 1;
    let consonants = 0;
    while (j >= 0 && consonants < 2 && !isVowel(word[j]!)) {
      consonants++;
      j--;
    }
    return j + 1;
  }
  return word.length;
}

/** R1: the position right after the first vowel. */
function computeR1(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (isVowel(word[i]!)) return i + 1;
  }
  return word.length;
}

/** R2: the position after the next vowel following R1. */
function computeR2(word: string): number {
  const r1 = computeR1(word);
  for (let i = r1; i < word.length; i++) {
    if (isVowel(word[i]!)) return i + 1;
  }
  return word.length;
}

/** Strip `suffix` when it starts at or after `minStart`, i.e. the region is inside it. */
function cut(word: string, suffix: string, minStart: number): string | null {
  const start = word.length - suffix.length;
  if (start < minStart) return null;
  if (!word.startsWith(suffix, start)) return null;
  return word.slice(0, start);
}

/** Find the first suffix in the list that is present and satisfies the region rule. */
function tryCut(word: string, suffixes: string[], region: number): string | null {
  for (const suffix of suffixes) {
    const result = cut(word, suffix, region);
    if (result !== null) return result;
  }
  return null;
}

/** Diminutives run after the endings: "котика" → "котик" → "кот". */
function stepDiminutive(word: string, r1: number, r2: number): string {
  const out = tryCut(word, DIMINUTIVE_R1, r1);
  if (out !== null) return out;
  const second = tryCut(word, DIMINUTIVE_R2, r2);
  if (second !== null) return second;
  return tryCut(word, NEST_ENDINGS, r1) ?? word;
}

function step1(word: string, r2: number): string {
  let out = tryCut(word, PERFECTIVE_GERUND_2, r2);
  if (out !== null) return out;
  out = tryCut(word, PERFECTIVE_GERUND_1, r2);
  if (out !== null) return out;
  // A bare "в"/"вши"/"вшись" also counts when there is a vowel inside it.
  for (const suffix of ["в", "вши", "вшись"]) {
    const start = word.length - suffix.length;
    if (start < 0 || !word.startsWith(suffix, start)) continue;
    if (/[аеёиоуыэюя]/.test(word.slice(start))) return word.slice(0, start);
  }
  return word;
}

function step2(word: string, r1: number): string {
  return tryCut(word, REFLEXIVE, r1) ?? word;
}

function step3(word: string, r1: number, r2: number): string {
  let out = tryCut(word, ADJECTIVE, r2);
  if (out !== null) return out;

  // Participles: strip the adjective ending first, then the participle ending.
  const adjectiveCut = tryCut(word, ADJECTIVE, r1);
  if (adjectiveCut !== null) {
    const partCut = tryCut(adjectiveCut, PARTICIPLE, r1);
    if (partCut !== null) return partCut;
  }

  out = tryCut(word, VERB_2, computeRV(word));
  if (out !== null) return out;
  out = tryCut(word, VERB_1, r1);
  if (out !== null) return out;
  return tryCut(word, NOUN, computeRV(word)) ?? word;
}

function step4(word: string, r2: number): string {
  const superlative = tryCut(word, SUPERLATIVE, r2);
  if (superlative !== null) return superlative;

  // YY* → Y (гриб → гри, зверь → звер)
  if (/([бвгджзклмнпрстфхцчшщ])\1$/.test(word)) return word.slice(0, -1);

  // A trailing soft sign: грибь → гриб, but not when it is the whole word.
  if (word.endsWith("ь") && word.length > 1) return word.slice(0, -1);
  return word;
}

function step5(word: string, rv: number): string {
  for (const suffix of DERIVATIONAL) {
    const out = cut(word, suffix, rv);
    if (out !== null) return out;
  }
  return word;
}

/** Words the stemmer must not touch — they are already their own root. */
const STOPWORDS = new Set([
  "он", "она", "они", "оно", "ты", "вы", "мы", "вы", "это", "эта", "эти", "тут",
  "там", "туда", "сюда", "как", "что", "все", "всё", "она", "еще", "ещё", "уже",
  "там", "тогда", "потом", "если", "чтобы", "потому", "очень", "просто", "если",
]);

/**
 * Reduce a Russian word to its stem. Non-Russian words and very short words are
 * returned unchanged, which is the safe default for mixed-language content.
 */
export function stemRu(word: string): string {
  const lower = normalizeWord(word);
  if (lower.length <= 3) return lower;
  if (STOPWORDS.has(lower)) return lower;
  // Only stem words that look Russian. Latin text (product names, URLs) goes
  // through untouched — the suffix tables would mangle it.
  if (!/[аеёиоуыэюя]/.test(lower)) return lower;

  const r1 = computeR1(lower);
  const r2 = computeR2(lower);
  const rv = computeRV(lower);

  // Order matters. Diminutives run after the endings are cut, otherwise
  // "котика" stops at "котик" and never reaches "кот".
  let stem = step1(lower, r2);
  stem = step2(stem, r1);
  stem = step3(stem, r1, r2);
  stem = stepDiminutive(stem, r1, r2);
  stem = step4(stem, r2);
  stem = step5(stem, rv);

  // Never return something so short that prefix search becomes a wildcard.
  return stem.length >= 3 ? stem : lower;
}

/** ё and е are the same letter for search purposes. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/ё/g, "е");
}

/**
 * Split text into searchable word tokens. Anything that is not a letter or a
 * digit is a separator, which also removes every FTS5 operator character —
 * that is the whole point: user text must never reach MATCH unescaped.
 */
export function tokenize(text: string): string[] {
  const normalized = normalizeWord(text);
  const out: string[] = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    out.push(match[0]);
  }
  return out;
}

/** Every distinct stem in the text, in order of appearance. */
export function stemsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    seen.add(stemRu(token));
  }
  return [...seen];
}

/**
 * The text that goes into the search index: stems *and* the raw tokens.
 *
 * Stems alone lose anything the stemmer cannot see through. Indexing both
 * means a single stemmed prefix query covers the whole family: for "кот" the
 * column holds "кот" (stem), "котов" and "котенок" (raw), so `"кот"*` reaches
 * the plural, the diminutive and the ё-form in one go. Diminutives and
 * irregular forms stay reachable through their raw spelling.
 *
 * Cheap at this scale — a memory base holds tens of entries, not millions.
 */
export function indexText(text: string): string {
  const tokens = tokenize(text);
  const seen = new Set<string>();
  for (const token of tokens) {
    seen.add(stemRu(token));
  }
  for (const token of tokens) {
    seen.add(token);
  }
  return [...seen].join(" ");
}

/**
 * Stems of the text, skipping words the caller considers noise.
 *
 * The stop check has to run on the original token, not on the stem: "знаешь"
 * stems to "знаеш", so a list keyed on the full word would never match it.
 */
export function stemsOfFiltered(text: string, stopwords: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    if (stopwords.has(token)) continue;
    seen.add(stemRu(token));
  }
  return [...seen];
}
