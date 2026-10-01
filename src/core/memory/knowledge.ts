import { getDB, readMeta, writeMeta } from "./db.js";
import { stemsOfFiltered } from "./stem-ru.js";
import { searchableText } from "./knowledge-text.js";
import { relativeAge, shortDate } from "./time-words.js";

/**
 * The wording of "how long ago" lives in `time-words.ts`, with the same
 * vocabulary the dialog gap uses — an age and a silence are the same quantity
 * and must not be phrased in two different voices. Re-exported here because
 * every caller that has a row in hand reaches for it from this module.
 */
export { relativeAge };

export interface KnowledgeRow {
  id: number;
  topic: string;
  insight: string;
  source: string;
  confidence: number;
  timestamp: number;
  /** How often this memory has actually been pulled into a conversation. */
  access_count: number;
  last_used: number | null;
  /** Set when a newer entry replaced this one. Retired rows stay in the table. */
  superseded_at: number | null;
  superseded_by: number | null;
  /**
   * What she was in the middle of, for a row that records a case. Empty on a
   * statement about a person, which is not a case and needs no context.
   */
  her_move: string;
  /**
   * The state he was in when it happened: busy, cheerful, in an argument.
   *
   * A case without this is a superstition waiting to happen. "Answered coldly"
   * alone reads as a rule; "he was busy, answered coldly" reads as one Tuesday.
   * The prompt builder refuses to render a case that lacks it — see
   * renderKnowledge.
   */
  context: string;
  /** What he did about it: warmed up, went cold, laughed it off, let it go. */
  his_reaction: string;
  /**
   * How it ended, when there was an end.
   *
   * Belongs to this row and to no other: "Gemini лучше DeepSeek" is the result of
   * one argument, not a fact and not a rule, and it is only readable next to the
   * row that says which argument it came from. A conclusion stored away from its
   * moment is the thing this base was rebuilt to stop holding.
   */
  conclusion: string;
}

/**
 * A row is a case when it records something she did, not a statement about
 * someone. The three case fields ride on the same table as plain facts on
 * purpose: one place to look, one index, one prompt section, and a fact stated
 * once in a chat keeps working without being migrated anywhere.
 */
export function isCase(row: KnowledgeRow): boolean {
  return row.her_move.trim() !== "";
}

/**
 * A row that records something that happened, rather than a standing property.
 *
 * A conclusion is the mark of an event: it answers "и чем кончилось", which only
 * a dated occasion has. A fact about a person has no ending. This matters beyond
 * bookkeeping — the duplicate check treats the two differently, see identityOf.
 */
export function isEvent(row: KnowledgeRow): boolean {
  return isCase(row) || row.conclusion.trim() !== "";
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
  "id, topic, insight, source, confidence, timestamp, access_count, last_used, superseded_at, superseded_by, her_move, context, his_reaction, conclusion";

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
  /** What she did, when this row is a case rather than a statement. */
  her_move?: string | null;
  /** The state he was in. See KnowledgeRow.context — a case reads as a rule without it. */
  context?: string | null;
  /** What he did about it. */
  his_reaction?: string | null;
  /**
   * How it ended: what was decided, what came of it. Empty when there was no ending.
   *
   * Not a fact about a person and never rendered as one — it is the result of one
   * particular conversation, and it is read only beside the row that says which.
   */
  conclusion?: string | null;
  /**
   * When it happened, in unix seconds.
   *
   * Omitted by a writer who is recording the moment it is in — she does, in chat.
   * Supplied by the study session, which reads a stretch of transcript after the
   * fact: without it every row recovered from an old conversation would be
   * stamped today, and "мы говорили об этом неделю назад" would become a lie the
   * base tells about itself. See loadChatSince.
   */
  timestamp?: number;
  /** Pre-computed semantic vector, when an embedding endpoint is configured. */
  embedding?: Buffer | null;
  confidence?: number;
}

/**
 * Everything a row is searchable by is assembled in knowledge-text.ts, so that
 * db.ts can reindex an old row into exactly the same shape a live write makes.
 */

/**
 * Add a knowledge entry to the database.
 * @param entry - The knowledge entry (topic, insight, source).
 * @param confidence - Confidence score between 0 and 1 (default 0.5).
 */
export function addKnowledge(entry: AddKnowledgeInput, confidence = entry.confidence ?? 0.5): number {
  const db = getDB();
  const result = db
    .prepare(
      `INSERT INTO knowledge (topic, insight, source, confidence, timestamp, stems, embedding,
                              her_move, context, his_reaction, conclusion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.topic,
      entry.insight,
      entry.source,
      confidence,
      entry.timestamp ?? Math.floor(Date.now() / 1000),
      searchableText(entry),
      entry.embedding ?? null,
      entry.her_move ?? "",
      entry.context ?? "",
      entry.his_reaction ?? "",
      entry.conclusion ?? "",
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
                k.access_count, k.last_used, k.superseded_at, k.superseded_by,
                k.her_move, k.context, k.his_reaction, k.conclusion
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
 * How many rows the answer prompt gets.
 *
 * Was 5, which was sized for the essays the base used to hold: a conclusion in
 * three sentences needs a slot of its own, and five of them already filled the
 * budget. A case is a line, and the value of the base is that the same thing
 * happened more than once in more than one state — five rows cannot show a
 * pattern, they can only show five examples and let the model guess.
 */
export const KNOWLEDGE_PROMPT_LIMIT = 12;

/**
 * The knowledge base as the answering model should read it.
 *
 * Three rules live here and nowhere else, because they are about form, and a form
 * rule left in a prompt is a rule the next prompt rewrite forgets:
 *
 * 1. A case never appears without its state. "Answered coldly" on its own is a
 *    rule, and rules are what this base stopped storing on purpose — the point
 *    is the choice made in the moment, not a precedent obeyed. "He was busy, so
 *    he answered coldly" is one Tuesday, and a second case about the same joke
 *    in a different state is free to contradict it.
 *
 *    The state is *added*, not substituted. A case used to render as the scene
 *    alone — состояние, она, ты — with `insight` dropped entirely, and on the live
 *    base that was 25 rows of 35 arriving as a scene with no subject: something
 *    happened, somebody reacted, and she could not say what it had been about.
 *    The one thing a person says when they remember you is what it was about.
 * 2. Nothing is phrased as an instruction. The rows are what happened, in the
 *    words of whoever wrote them down. Whoever answers draws the conclusion for
 *    the moment in front of them, which is the only place a conclusion belongs.
 * 3. Every row says when it happened and what it was about. Both were on the row
 *    from the first version and neither was ever shown, so she had no way to know
 *    that the planes were last week or that a row was about work and not about
 *    her. "Мы говорили о самолётах" and "помнишь, ты рассказывал про кошку" are
 *    the two things a person says when they remember you, and neither is
 *    answerable from rows that carry no subject and no date.
 * 4. A conclusion is printed on its row, never on its own. "Gemini лучше" is the
 *    end of one argument and is only true of it; peeled off the row it came from
 *    it becomes a law, which is what the previous version of this base was full
 *    of. The note below the rows says as much, because the model reads it there
 *    rather than here.
 *
 * A case with no recorded state says so rather than being hidden: rows written
 * before these fields existed have none, and dropping them quietly would make
 * the base look emptier every time the schema grew.
 */
export function renderKnowledge(
  rows: KnowledgeRow[],
  opts: { offsetHours?: number; now?: number } = {},
): string {
  if (rows.length === 0) return "";

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const offsetHours = opts.offsetHours ?? 4;

  const lines = rows.map((row, i) => {
    const when = `${shortDate(row.timestamp, offsetHours)}, ${relativeAge(row.timestamp, now)}`;
    const head = `[${when}${row.topic ? ` · ${row.topic}` : ""}]`;
    // "итог", not "вывод": a вывод is what one draws and generalises, and this is
    // only ever how that one conversation ended.
    const outcome = row.conclusion.trim() ? ` итог: ${row.conclusion.trim()}` : "";
    if (!isCase(row)) return `${i + 1}. ${head} ${row.insight}${outcome}`;
    const state = row.context.trim() || "не определяется";
    const about = row.insight.trim() ? `${row.insight.trim()} ` : "";
    return `${i + 1}. ${head} ${about}состояние: ${state}. она: ${row.her_move}. ты: ${row.his_reaction}${outcome}`;
  });

  lines.push(
    "",
    "Это записи из прошлого, а не правила. Первая скобка — когда это было и о чём.",
    "На один и тот же повод в разных состояниях реакция была разной — так и есть,",
    "выбирай под то, что происходит сейчас. Если он спрашивает «помнишь» или «когда» —",
    "у тебя есть и тема, и дата, отвечай по ним.",
    "«итог» — это чем кончился тот конкретный разговор, а не истина. Другой спор на ту",
    "же тему мог кончиться наоборот, и это нормально: опирайся, но не как на закон.",
  );

  return lines.join("\n");
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
export function retireKnowledge(id: number, supersededBy?: number): boolean {
  const db = getDB();
  const result = db
    .prepare(
      "UPDATE knowledge SET superseded_at = ?, superseded_by = ? WHERE id = ? AND superseded_at IS NULL",
    )
    .run(Math.floor(Date.now() / 1000), supersededBy ?? null, id);
  // False means the row was already retired or never existed. Retiring it twice
  // would stamp a second timestamp and, worse, leave a correction pointing at
  // itself — so the guard is in the WHERE, not only in the caller.
  return result.changes > 0;
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
    const studyCount = studyRow.count ?? 0;
    const otherCount = Math.max(0, total - studyCount);

    // Study rows get first claim on the budget, but never the whole budget while
    // chat rows exist. "First claim" used to become "only claim" the moment
    // study filled the budget: with studyKeep = max, otherKeep = 0, every fact
    // the owner stated by hand was retired on the next session. Reserve a
    // quarter of the budget for the chat side so neither source can starve.
    const reserved = Math.min(otherCount, Math.max(1, Math.ceil(max / 4)));
    const studyKeep = Math.min(studyCount, Math.max(0, max - reserved));
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
