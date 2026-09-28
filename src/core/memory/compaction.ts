import { getDB } from "./db.js";
import {
  countMessages,
  dropSummaryChunks,
  foldedUpTo,
  loadSummaryChunks,
  saveSummaryChunk,
} from "./conversations.js";
import type { LLMClient } from "../llm/types.js";

interface CompactionRow {
  id: number;
  role: string;
  content: string;
  tool_calls: string | null;
}

/** How much conversation one fold is allowed to put in front of the model. */
const MAX_COMPACTION_CHARS = 30_000;

/**
 * How big the whole digest is allowed to get before the oldest chunks are merged
 * into each other. Generous, because merging *is* a rewrite and a rewrite is
 * what loses detail — but it cannot be unbounded either, or the digest would
 * eventually cost more than the window it exists to protect.
 */
const MAX_DIGEST_CHARS = 24_000;

/** What one fold did, for the log line. */
export interface CompactionResult {
  /** Raw rows this fold carried into a summary. */
  folded: number;
  /** Summarised stretches on record after it. */
  chunks: number;
  digestChars: number;
}

/**
 * Carry what has fallen out of the live window forward into the digest.
 *
 * The boundary is the window, not the middle of the table. `loadHistory` hands
 * the model the newest `keepMessages` rows, so those are the only ones still
 * seen raw — everything before them is either in the digest or in nothing at
 * all, and splitting the table down the middle instead (as this used to) put
 * the cut in the wrong place: the oldest half of a 1700-row table, while the
 * messages that had actually just been dropped sat in the untouched newer half.
 *
 * The window edge is usually not a `user` message, so the split walks back to
 * the turn that owns the cut rather than leaving a `tool` result at the top of
 * what stays — the same rule `alignHistory` enforces on the other side.
 *
 * **Nothing is deleted.** A fold used to remove the rows it had just summarised,
 * which made the digest the last copy of them: a summary that dropped a fact
 * dropped it for good, and there was no way back to the words it was built from.
 * The rows are the archive; the digest is a view of it, and a view can be thrown
 * away and rebuilt. They stay.
 *
 * **Each stretch is summarised once.** A fold starts above the watermark
 * (`foldedUpTo`) and records the range it covered, so a stretch never enters the
 * digest twice. The old rolling summary had no watermark: every fold fed the
 * previous summary back in, reworded all of it, and deleted the newest slice of
 * rows — so a fact from a year ago had been paraphrased once per fold since,
 * each pass a fresh chance to lose it, with the original already gone from disk.
 * That, more than the window, is what dementia in a chat looks like.
 *
 * **The summarising input is capped** at `MAX_COMPACTION_CHARS` so one long
 * message cannot blow up the request. Rows older than the cap are simply not
 * part of this fold; they are still unread as far as the watermark goes, so the
 * next fold reaches them once the ones in front of them have been carried.
 */
export async function compactHistory(
  userId: string,
  llm: LLMClient,
  keepMessages: number,
): Promise<CompactionResult | null> {
  // Cheap guard before the full read: when the whole conversation still fits the
  // window there is nothing to fold, and answering that must not cost a table
  // scan of the history, let alone a request to the model. Nothing writes
  // between this count and the read below, so it is the row count either way.
  if (countMessages(userId) <= keepMessages) return null;

  const db = getDB();
  const watermark = foldedUpTo(userId);

  const allRows = db.prepare(
    "SELECT id, role, content, tool_calls FROM conversations WHERE user_id = ? ORDER BY timestamp ASC, id ASC",
  ).all(userId) as CompactionRow[];

  // Walk back from the window edge to the `user` message that opens the turn
  // crossing it, so what remains starts on a user turn. Zero means the cut lands
  // on the very first message: the conversation fits, there is nothing older.
  let splitIdx = -1;
  for (let i = allRows.length - keepMessages; i >= 0; i--) {
    if (allRows[i].role === "user") {
      splitIdx = i;
      break;
    }
  }
  if (splitIdx <= 0) return null;

  // Everything between the watermark and the cut, newest first, stopping at the
  // cap. Walking down from the cut and stopping at the watermark is what makes
  // each row fold exactly once: a range already summarised is not read again, and
  // rows the cap could not reach keep an unread watermark behind them.
  const toFold: CompactionRow[] = [];
  let used = 0;
  for (let i = splitIdx - 1; i >= 0; i--) {
    const row = allRows[i];
    if (row.id <= watermark) break;
    const piece = `${row.role}: ${row.content}`;
    if (toFold.length > 0 && used + piece.length > MAX_COMPACTION_CHARS) break;
    toFold.unshift(row);
    used += piece.length + 1;
  }
  if (toFold.length === 0) return null;

  // The carry: text an older install wrote before the watermark existed. It
  // covers no rows of its own, so it is handed to this fold as context and
  // retired in the same transaction — otherwise the digest would keep it forever
  // alongside the chunk that already says the same thing.
  const carry = loadSummaryChunks(userId).filter((chunk) => chunk.toId === 0);

  const oldText = toFold.map((row) => `${row.role}: ${row.content}`).join("\n");

  const promptText = `Ты — помощник, который суммаризирует разговоры.

Ранее известное из более старого разговора (учти, но не пересказывай целиком):
${carry.map((c) => c.summary).join("\n\n") || "Нет"}

Новые сообщения, которые сейчас уходят из окна диалога:
${oldText}

Сделай саммари ТОЛЬКО этих новых сообщений. Сохрани факты, решения, контекст,
предпочтения и обещания пользователя, имена, даты, и то, к чему вы пришли.
Не выдумывай того, чего в сообщениях нет. Пиши кратко, по-русски, без вступлений.`;

  const response = await llm.chat([{ role: "user", content: promptText }]);
  const newSummary = response.text.trim();

  if (!newSummary) {
    throw new Error("Compaction aborted: LLM returned empty summary");
  }

  const estimatedTokens = response.usage?.completionTokens ?? Math.ceil(newSummary.length / 4);
  const fromId = toFold[0].id;
  const toId = toFold[toFold.length - 1].id;

  db.transaction(() => {
    saveSummaryChunk(userId, { fromId, toId, summary: newSummary, tokenEstimate: estimatedTokens });
    if (carry.length > 0) dropSummaryChunks(userId, 0);
  })();

  await mergeOldestChunks(userId, llm);

  const chunks = loadSummaryChunks(userId);
  return {
    folded: toFold.length,
    chunks: chunks.length,
    digestChars: chunks.reduce((n, c) => n + c.summary.length, 0),
  };
}

/**
 * Fold the two oldest chunks into one until the digest fits `MAX_DIGEST_CHARS`.
 *
 * Merging is the one place the digest is rewritten, so it happens as rarely as it
 * can: only when the digest is genuinely oversized, only on the oldest pair, and
 * a merge that fails or comes back empty stops the whole thing rather than
 * leaving the chunks half-retired. A chunk lost here is the one real loss in this
 * design, and it is bounded by how long it takes to fill 24k characters of
 * digest.
 */
async function mergeOldestChunks(userId: string, llm: LLMClient): Promise<void> {
  const db = getDB();

  for (;;) {
    const chunks = loadSummaryChunks(userId).filter((chunk) => chunk.toId > 0);
    if (chunks.length < 2) return;
    const total = chunks.reduce((n, c) => n + c.summary.length, 0);
    if (total <= MAX_DIGEST_CHARS) return;

    const [older, newer] = chunks;
    const response = await llm.chat([
      {
        role: "user",
        content: `Ты — помощник, который суммаризирует разговоры.

Два куска хронологического саммари одного разговора, ранний и следующий за ним:

--- РАННИЙ ---
${older.summary}

--- СЛЕДУЮЩИЙ ---
${newer.summary}

Объедини их в один связный текст, сохранив все факты, решения, имена, даты и
предпочтения пользователя. Не выдумывай. Пиши кратко, по-русски, без вступлений.`,
      },
    ]);
    const merged = response.text.trim();
    if (!merged) return;

    db.transaction(() => {
      dropSummaryChunks(userId, older.toId);
      saveSummaryChunk(userId, {
        fromId: older.fromId,
        toId: newer.toId,
        summary: merged,
        tokenEstimate: response.usage?.completionTokens ?? Math.ceil(merged.length / 4),
      });
    })();
  }
}
