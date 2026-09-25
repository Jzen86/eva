import { getDB } from "./db.js";
import { indexText, stemsOfFiltered } from "./stem-ru.js";

export interface KnowledgeRow {
  id: number;
  topic: string;
  insight: string;
  source: string;
  confidence: number;
  timestamp: number;
}

/** Words that carry no retrieval signal and would only widen the query. */
const QUERY_STOPWORDS = new Set([
  "the", "and", "for", "you", "are", "was", "were", "but", "not", "what",
  "when", "where", "who", "how", "why", "did", "does", "can", "could", "about",
  "это", "как", "что", "для", "или", "не", "но", "же", "бы", "ли", "вот",
  "все", "всё", "уже", "ещё", "еще", "там", "тут", "мне", "меня", "тебе",
  "его", "её", "их", "нас", "вас", "быть", "есть", "скажи", "знаешь",
  "ты", "вы", "мы", "он", "она", "они", "оно", "про", "из", "по", "за", "о",
  "об", "у", "а", "и", "в", "с", "к", "на", "до", "из", "над", "под",
]);

/**
 * Build a safe FTS5 MATCH expression from free text.
 *
 * User text must never reach MATCH raw. FTS5 reads `:`, `~`, `^`, `"`, `*`,
 * `AND`, `NEAR` and unbalanced parentheses as query syntax, and any of them
 * turns an ordinary message into `fts5: syntax error near ...` or
 * `no such column: ...`. Every term here comes from the tokenizer, so it can
 * only contain letters and digits, and each is quoted before use.
 *
 * Terms are stemmed and matched as prefixes. A Russian stem is a prefix of the
 * inflected form, so `кот*` also finds "кота", "котом" and "коты".
 */
export function buildMatchQuery(text: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();

  // Filtered on the raw token, not on the stem — see stemsOfFiltered.
  for (const token of stemsOfFiltered(text, QUERY_STOPWORDS)) {
    if (token.length < 2) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    // Quote so nothing inside can be read as syntax; the trailing * is FTS5's
    // own prefix operator and is the one character added on purpose.
    terms.push(`"${token}"*`);
  }

  if (terms.length === 0) return null;
  // OR keeps recall up: a long message with one relevant word should still hit.
  return terms.join(" OR ");
}

/**
 * Add a knowledge entry to the database.
 * @param entry - The knowledge entry (topic, insight, source).
 * @param confidence - Confidence score between 0 and 1 (default 0.5).
 */
export function addKnowledge(
  entry: { topic: string; insight: string; source: string },
  confidence = 0.5,
): void {
  const db = getDB();
  const stems = indexText(`${entry.topic} ${entry.insight}`);
  db.prepare(
    "INSERT INTO knowledge (topic, insight, source, confidence, timestamp, stems) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    entry.topic,
    entry.insight,
    entry.source,
    confidence,
    Math.floor(Date.now() / 1000),
    stems,
  );
}

/**
 * Search the knowledge base.
 *
 * The text is stemmed and escaped by buildMatchQuery, so any input is safe: a
 * raw user message no longer risks a SQLite syntax error, and Russian
 * inflections reach the same entry.
 */
export function searchKnowledge(query: string, limit = 5): KnowledgeRow[] {
  const match = buildMatchQuery(query);
  if (!match) return [];

  const db = getDB();
  try {
    return db
      .prepare(
        `SELECT k.id, k.topic, k.insight, k.source, k.confidence, k.timestamp
         FROM knowledge_fts fts
         JOIN knowledge k ON k.id = fts.rowid
         WHERE knowledge_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as KnowledgeRow[];
  } catch (err) {
    // A search miss must never take down the turn that asked for it.
    console.warn(
      `⚠️ Поиск по памяти не удался (${err instanceof Error ? err.message : err}), пропускаю`,
    );
    return [];
  }
}

/**
 * Retrieve all knowledge entries, ordered by most recent first.
 */
export function getAllKnowledge(): KnowledgeRow[] {
  const db = getDB();
  return db
    .prepare("SELECT id, topic, insight, source, confidence, timestamp FROM knowledge ORDER BY timestamp DESC")
    .all() as KnowledgeRow[];
}

/**
 * Get the total number of knowledge entries.
 */
export function getKnowledgeCount(): number {
  const db = getDB();
  const row = db.prepare("SELECT COUNT(*) as count FROM knowledge").get() as { count: number };
  return row.count;
}
