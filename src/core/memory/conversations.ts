import { getDB, readMeta, writeMeta } from "./db.js";
import { alignHistory } from "../llm/history.js";
import type { LLMMessage, ContentPart, ToolUseRequest } from "../llm/types.js";

/**
 * Extracts plain text from a string or ContentPart array.
 */
export function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("");
}

/**
 * Saves a message to the conversations table.
 * Returns the inserted row id.
 */
export function saveMessage(
  userId: string,
  channel: string,
  role: string,
  content: string | ContentPart[],
  toolCallId?: string,
  toolCalls?: ToolUseRequest[],
): number {
  const db = getDB();
  const contentStr = typeof content === "string" ? content : JSON.stringify(content);
  const toolCallsStr = toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null;
  const result = db
    .prepare(
      `INSERT INTO conversations (user_id, channel, role, content, tool_call_id, tool_calls, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      channel,
      role,
      contentStr,
      toolCallId ?? null,
      toolCallsStr,
      Math.floor(Date.now() / 1000),
    );
  return result.lastInsertRowid as number;
}

interface ConversationRow {
  id: number;
  user_id: string;
  channel: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: string | null;
  timestamp: number;
}

/**
 * Loads the last N messages for a user, with boundary trimming, and the summary if any.
 */
export function loadHistory(
  userId: string,
  limit = 40,
): { messages: LLMMessage[]; summary: string | null } {
  const db = getDB();

  const rows = db
    .prepare(
      `SELECT * FROM conversations
       WHERE user_id = ?
       ORDER BY timestamp ASC, id ASC
       LIMIT ?
       OFFSET (SELECT MAX(0, COUNT(*) - ?) FROM conversations WHERE user_id = ?)`,
    )
    .all(userId, limit, limit, userId) as ConversationRow[];

  const messages: LLMMessage[] = [];

  for (const row of rows) {
    let toolCalls: ToolUseRequest[] | undefined;

    if (row.tool_calls) {
      try {
        toolCalls = JSON.parse(row.tool_calls) as ToolUseRequest[];
      } catch {
        // Skip corrupt rows
        continue;
      }
    }

    const msg: LLMMessage = {
      role: row.role as LLMMessage["role"],
      content: row.content,
    };

    if (toolCalls && toolCalls.length > 0) {
      msg.toolCalls = toolCalls;
    }

    if (row.tool_call_id) {
      msg.toolCallId = row.tool_call_id;
    }

    messages.push(msg);
  }

  // The same border rules the live history gets, see `llm/history.ts`: this
  // window starts and ends wherever SQLite felt like, not where a tool call
  // and its result do.
  const result = alignHistory(messages);

  return {
    messages: result,
    summary: loadSummary(userId),
  };
}

interface SummaryRow {
  from_id: number;
  to_id: number;
  summary: string;
  token_estimate: number;
}

/**
 * One summarised stretch of the conversation, and the `conversations.id` range
 * it stands for. `toId` is what makes forgetting undoable: the rows themselves
 * stay in the table, so a summary that lost something can be thrown away and
 * rebuilt from them.
 */
export interface SummaryChunk {
  fromId: number;
  toId: number;
  summary: string;
  tokenEstimate: number;
}

/**
 * Every fold ever made for a user, oldest first.
 */
export function loadSummaryChunks(userId: string): SummaryChunk[] {
  const rows = getDB()
    .prepare(
      `SELECT from_id, to_id, summary, token_estimate FROM conversation_summaries
       WHERE user_id = ? ORDER BY to_id ASC`,
    )
    .all(userId) as SummaryRow[];

  return rows.map((row) => ({
    fromId: row.from_id,
    toId: row.to_id,
    summary: row.summary,
    tokenEstimate: row.token_estimate,
  }));
}

/**
 * The highest `conversations.id` already covered by a summary, or 0.
 *
 * This is the watermark a fold reads: everything at or below it has been
 * summarised once, and summarising it again would be a second, differently
 * worded copy of the same stretch — the drift that made a rolling summary lose
 * its contents one rewrite at a time.
 */
export function foldedUpTo(userId: string): number {
  const row = getDB()
    .prepare("SELECT MAX(to_id) AS m FROM conversation_summaries WHERE user_id = ?")
    .get(userId) as { m: number | null } | undefined;
  return row?.m ?? 0;
}

/**
 * Records a summarised stretch, replacing any chunk that already ends at the
 * same row.
 */
export function saveSummaryChunk(userId: string, chunk: SummaryChunk): void {
  getDB()
    .prepare(
      `INSERT INTO conversation_summaries (user_id, from_id, to_id, summary, token_estimate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, to_id) DO UPDATE SET
         from_id = excluded.from_id,
         summary = excluded.summary,
         token_estimate = excluded.token_estimate,
         updated_at = excluded.updated_at`,
    )
    .run(
      userId,
      chunk.fromId,
      chunk.toId,
      chunk.summary,
      chunk.tokenEstimate,
      Math.floor(Date.now() / 1000),
    );
}

/**
 * Drops chunks that end at or before `toId`. Used to absorb the carry left by an
 * older install, and to retire chunks that have been merged into an older one.
 */
export function dropSummaryChunks(userId: string, toId: number): void {
  getDB()
    .prepare("DELETE FROM conversation_summaries WHERE user_id = ? AND to_id <= ?")
    .run(userId, toId);
}

/**
 * The digest the prompt gets: every chunk, oldest first, in the order they
 * happened. The model reads it as one account of the conversation that came
 * before the raw window.
 */
export function loadSummary(userId: string): string | null {
  const text = loadSummaryChunks(userId)
    .map((chunk) => chunk.summary)
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
  return text.length > 0 ? text : null;
}

/**
 * How many rows of raw conversation a user has.
 *
 * Compaction asks for this instead of the prompt's token count, because a
 * conversation's size is driven by how many messages it has, not by how many
 * tokens they happen to weigh — and only the first number knows what is about
 * to fall out of the live window.
 */
export function countMessages(userId: string): number {
  const row = getDB()
    .prepare("SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?")
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * The study cursor: the highest `conversations.id` a study session has read for
 * this user.
 *
 * A study run used to take the last N messages. That is a window, not a cursor,
 * and the difference is the whole bug: a correction said forty messages ago was
 * in the table the entire time and no session ever looked at it, because by the
 * next run it had scrolled out of the window. Rows age out of a window. They do
 * not age out of a cursor.
 *
 * Persisted rather than held in memory, and this is the second half of the same
 * point. The study timer deliberately resets on boot (`primeStudyTimer`), which
 * is right for a cooldown and would be wrong for a cursor: a restart would forget
 * what had been read and send the next session back over the same messages.
 */
export function studyCursor(userId: string): number {
  return Number(readMeta(`study_cursor:${userId}`) ?? "0") || 0;
}

/** Never moves backwards — the cursor only ever means "read up to here". */
export function setStudyCursor(userId: string, id: number): void {
  if (id > studyCursor(userId)) writeMeta(`study_cursor:${userId}`, String(id));
}

/**
 * How much of the recent past a session may read before it starts following live.
 *
 * A cursor of zero is correct on a fresh install and wrong on one that has been
 * talking for weeks. Started at zero, the first session would read the oldest
 * messages there are — already distilled into `knowledge`, already standing in the
 * digest — and at one budget an hour it would grind forward for days before
 * reaching anything current, refusing its own duplicates the whole way. So the
 * absent cursor starts here instead: near the end, with enough room behind it to
 * re-read the last few days under the current rules. This is the newest-N window
 * the study prompt used to have, kept as a starting point rather than as the
 * thing that decides what gets read.
 */
const BACKFILL_MESSAGES = 200;

/**
 * Where a session should start reading: the cursor, or the seeded backfill point
 * on an install that has never had one.
 *
 * Re-derived on each call until a session succeeds and the cursor is written, so
 * a first run that errors leaves the start pointing at the newest messages rather
 * than at the beginning of time. The cost is that a long failure can push the
 * start forward past a stretch that was never read; the stretch is the same
 * recent one the old window kept re-reading, so it is a smaller loss than the
 * grind the seed exists to avoid.
 */
export function studyStart(userId: string): number {
  const cursor = studyCursor(userId);
  if (cursor > 0) return cursor;
  const row = getDB()
    .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM conversations WHERE user_id = ?")
    .get(userId) as { m: number } | undefined;
  return Math.max(0, (row?.m ?? 0) - BACKFILL_MESSAGES);
}

/**
 * Raw transcript newer than the cursor, oldest first.
 *
 * Bounded by `limit` rows so that a long silence cannot make one session pull the
 * whole table into memory. Whatever does not fit stays above the cursor and the
 * next run picks it up, because the caller advances the cursor only as far as it
 * actually read — see the note on `coveredTo` in the study prompt builder.
 */
export function messagesSince(
  userId: string,
  sinceId: number,
  limit: number,
): Array<{ id: number; role: string; content: string; timestamp: number }> {
  return getDB()
    .prepare(
      `SELECT id, role, content, timestamp FROM conversations
       WHERE user_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(userId, sinceId, limit) as Array<{
    id: number;
    role: string;
    content: string;
    timestamp: number;
  }>;
}
