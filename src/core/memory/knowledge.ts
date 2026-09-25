import { getDB, readMeta, writeMeta } from "./db.js";
import { indexText, stemsOfFiltered } from "./stem-ru.js";

export interface KnowledgeRow {
  id: number;
  topic: string;
  insight: string;
  source: string;
  confidence: number;
  timestamp: number;
  /** Subject area, used by study to rotate over what it is weakest in. */
  zone: string;
  /** How often this memory has actually been pulled into a conversation. */
  access_count: number;
  last_used: number | null;
  /** Set when a newer entry replaced this one. Retired rows stay in the table. */
  superseded_at: number | null;
  superseded_by: number | null;
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

const SELECT_COLUMNS =
  "id, topic, insight, source, confidence, timestamp, zone, access_count, last_used, superseded_at, superseded_by";

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

export interface AddKnowledgeInput {
  topic: string;
  insight: string;
  source: string;
  zone?: string;
  /** Pre-computed semantic vector, when an embedding endpoint is configured. */
  embedding?: Buffer | null;
  confidence?: number;
}

/**
 * Add a knowledge entry to the database.
 * @param entry - The knowledge entry (topic, insight, source).
 * @param confidence - Confidence score between 0 and 1 (default 0.5).
 */
export function addKnowledge(entry: AddKnowledgeInput, confidence = entry.confidence ?? 0.5): number {
  const db = getDB();
  const stems = indexText(`${entry.topic} ${entry.insight}`);
  const result = db
    .prepare(
      `INSERT INTO knowledge (topic, insight, source, confidence, timestamp, stems, zone, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.topic,
      entry.insight,
      entry.source,
      confidence,
      Math.floor(Date.now() / 1000),
      stems,
      entry.zone ?? "",
      entry.embedding ?? null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Search the knowledge base.
 *
 * The text is stemmed and escaped by buildMatchQuery, so any input is safe: a
 * raw user message no longer risks a SQLite syntax error, and Russian
 * inflections reach the same entry. Retired entries are excluded — a
 * superseded fact that keeps answering is worse than no memory at all.
 *
 * Returned rows get their usage counters bumped. This is a write on what looks
 * like a read path, but it is the only way to learn which memories earn their
 * place: the trim used to go by recency alone and deleted facts that were
 * being used daily.
 */
export function searchKnowledge(query: string, limit = 5): KnowledgeRow[] {
  const match = buildMatchQuery(query);
  if (!match) return [];

  const db = getDB();
  try {
    const rows = db
      .prepare(
        `SELECT k.id, k.topic, k.insight, k.source, k.confidence, k.timestamp,
                k.zone, k.access_count, k.last_used, k.superseded_at, k.superseded_by
         FROM knowledge_fts fts
         JOIN knowledge k ON k.id = fts.rowid
         WHERE knowledge_fts MATCH ?
           AND k.superseded_at IS NULL
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as KnowledgeRow[];

    if (rows.length > 0) touchKnowledge(rows.map((r) => r.id));
    return rows;
  } catch (err) {
    // A search miss must never take down the turn that asked for it.
    console.warn(
      `⚠️ Поиск по памяти не удался (${err instanceof Error ? err.message : err}), пропускаю`,
    );
    return [];
  }
}

/** Record that these memories were pulled into a conversation. */
export function touchKnowledge(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(
    "UPDATE knowledge SET access_count = access_count + 1, last_used = ? WHERE id = ?",
  );
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const id of ids) stmt.run(now, id);
  })();
}

/**
 * Retrieve knowledge entries, most recent first. Retired rows are left out
 * unless asked for explicitly.
 */
export function getAllKnowledge(includeSuperseded = false): KnowledgeRow[] {
  const db = getDB();
  const where = includeSuperseded ? "" : " WHERE superseded_at IS NULL";
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM knowledge${where} ORDER BY timestamp DESC`)
    .all() as KnowledgeRow[];
}

/**
 * Get the total number of live knowledge entries.
 */
export function getKnowledgeCount(includeSuperseded = false): number {
  const db = getDB();
  const where = includeSuperseded ? "" : " WHERE superseded_at IS NULL";
  const row = db.prepare(`SELECT COUNT(*) as count FROM knowledge${where}`).get() as {
    count: number;
  };
  return row.count;
}

/**
 * Retire a memory: it stops answering, but the row and its history stay.
 *
 * Used both for trimming and for retiring a fact a newer one corrected. The
 * difference is that trimming passes no replacement, so `superseded_by` stays
 * null and it is clear the row was dropped for space rather than contradicted.
 *
 * The row is deliberately left in the FTS index and filtered out at query time
 * by `superseded_at IS NULL`. Removing it from the index by hand is not an
 * option: the UPDATE trigger already takes the old values out of the index, and
 * doing it twice corrupts the table — `database disk image is malformed` on the
 * next read.
 */
export function retireKnowledge(id: number, supersededBy?: number): void {
  const db = getDB();
  db.prepare(
    "UPDATE knowledge SET superseded_at = ?, superseded_by = ? WHERE id = ?",
  ).run(Math.floor(Date.now() / 1000), supersededBy ?? null, id);
}

/**
 * Keep the base inside its budget.
 *
 * Rows are retired, not deleted, and the ones chosen are not simply the oldest:
 * a memory that was never used competes with another that was never used only
 * when the budget actually forces a choice, and a memory that gets used keeps
 * its place. That is the behaviour the old recency-only trim could not produce —
 * a fact stated once and used for a year lost its slot to yesterday's trivia.
 *
 * Study rows still get first claim on the budget: chat-driven writes are far
 * denser, so a plain trim would evict the study insights first.
 */
export function trimKnowledge(max: number, studySource: string): { retired: number } {
  if (max <= 0) return { retired: 0 };
  try {
    const db = getDB();
    const total = getKnowledgeCount();
    if (total <= max) return { retired: 0 };

    const studyRow = db
      .prepare("SELECT COUNT(*) AS count FROM knowledge WHERE source IS ? AND superseded_at IS NULL")
      .get(studySource) as { count: number };
    const studyKeep = Math.min(studyRow.count ?? 0, max);
    const otherKeep = Math.max(0, max - studyKeep);

    // Oldest and least used first, so a memory that helped is never the victim
    // while an untouched one of the same age survives.
    const doomed: number[] = [
      ...rowsToRetire(db, "source IS ?", [studySource], studyKeep),
      ...rowsToRetire(db, "source IS NOT ?", [studySource], otherKeep),
    ];

    if (doomed.length === 0) return { retired: 0 };
    for (const id of doomed) retireKnowledge(id);
    purgeRetired();
    return { retired: doomed.length };
  } catch (err) {
    console.error(
      "⚠️ не удалось ужать базу знаний:",
      err instanceof Error ? err.message : err,
    );
    return { retired: 0 };
  }
}

/** How long a retired row is kept before it is actually deleted. */
const RETIRED_KEEP_DAYS = 30;

/**
 * Drop retired rows once they are old enough that nobody will ask about them.
 *
 * Retiring instead of deleting is what makes a correction traceable, but it is
 * not a reason to keep every superseded fact forever: without this the table
 * would grow by a few rows per study session for the lifetime of the install.
 * Thirty days is long enough to answer "why did Eva once believe that".
 */
function purgeRetired(): void {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - RETIRED_KEEP_DAYS * 86_400;
    getDB()
      .prepare("DELETE FROM knowledge WHERE superseded_at IS NOT NULL AND superseded_at < ?")
      .run(cutoff);
  } catch (err) {
    console.warn(
      `⚠️ не удалось вычистить старые записи (${err instanceof Error ? err.message : err})`,
    );
  }
}

const ZONE_STUDY_META = "study_zone_seen";

/** Live entries per zone. Retired rows do not count — they are not what Eva knows. */
export function getZoneCoverage(): Map<string, number> {
  const rows = getDB()
    .prepare(
      `SELECT zone, COUNT(*) AS count FROM knowledge
       WHERE superseded_at IS NULL AND zone != ''
       GROUP BY zone`,
    )
    .all() as Array<{ zone: string; count: number }>;
  return new Map(rows.map((r) => [r.zone, r.count]));
}

/**
 * When each zone was last handed to a study session, as unix seconds.
 *
 * Kept in the database rather than in a module variable: a module-level cursor
 * resets on every restart, which is what once sent two consecutive sessions
 * back to the same empty zone.
 */
export function getZoneLastStudied(): Record<string, number> {
  try {
    const raw = readMeta(ZONE_STUDY_META);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

export function markZoneStudied(zone: string): void {
  const seen = getZoneLastStudied();
  seen[zone] = Math.floor(Date.now() / 1000);
  try {
    writeMeta(ZONE_STUDY_META, JSON.stringify(seen));
  } catch (err) {
    console.warn(
      `⚠️ не удалось запомнить зону ${zone} (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * The rows that have to go: everything past the first `keep`.
 *
 * The ordering is the whole point. Most-used and most recent first, so the rows
 * skipped by OFFSET are the ones worth keeping and the remainder — untouched and
 * old — is what gets retired. Sorting the other way round and offsetting by
 * `keep` retires precisely the memories that are earning their place, which is
 * what an earlier version of this did.
 */
function rowsToRetire(
  db: ReturnType<typeof getDB>,
  where: string,
  params: unknown[],
  keep: number,
): number[] {
  const sql = `SELECT id FROM knowledge WHERE ${where} AND superseded_at IS NULL
               ORDER BY COALESCE(access_count, 0) DESC, timestamp DESC, id DESC`;
  if (keep <= 0) {
    return (db.prepare(sql).all(...params) as Array<{ id: number }>).map((r) => r.id);
  }
  return (db.prepare(`${sql} LIMIT -1 OFFSET ?`).all(...params, keep) as Array<{ id: number }>).map(
    (r) => r.id,
  );
}
