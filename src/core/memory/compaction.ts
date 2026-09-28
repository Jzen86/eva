import { getDB } from "./db.js";
import { loadSummary, saveSummary, countMessages } from "./conversations.js";
import type { LLMClient } from "../llm/types.js";

interface CompactionRow {
  id: number;
  role: string;
  content: string;
  tool_calls: string | null;
}

/**
 * Fold everything that has fallen out of the live window into one summary.
 *
 * The boundary is the window, not the middle of the table. `loadHistory` hands
 * the model the newest `keepMessages` rows, so those are the only ones still
 * seen raw — everything before them is either in the summary or in nothing at
 * all, and splitting the table down the middle instead (as this used to) put
 * the cut in the wrong place: the oldest half of a 1700-row table, while the
 * messages that had actually just been dropped sat in the untouched newer half.
 *
 * The window edge is usually not a `user` message, so the split walks back to
 * the turn that owns the cut rather than leaving a `tool` result at the top of
 * what stays — the same rule `alignHistory` enforces on the other side.
 *
 * The summarising input is capped at `MAX_COMPACTION_CHARS` so one long message
 * cannot blow up the request, and only the rows that reached the model are
 * deleted. Anything older than that cap was not summarised, so it is still the
 * only copy of itself — it stays, and a later compaction reaches it once the
 * rows in front of it have been folded away.
 */
export async function compactHistory(
  userId: string,
  llm: LLMClient,
  keepMessages: number,
): Promise<void> {
  // Cheap guard before the full read: when the whole conversation still fits the
  // window there is nothing to fold, and answering that must not cost a table
  // scan of the history, let alone a request to the model. Nothing writes
  // between this count and the read below, so it is the row count either way.
  if (countMessages(userId) <= keepMessages) return;

  const existing = loadSummary(userId);
  const db = getDB();

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
  if (splitIdx <= 0) return;

  const oldPart = allRows.slice(0, splitIdx);

  const MAX_COMPACTION_CHARS = 30_000;
  const render = (m: CompactionRow) => `${m.role}: ${m.content}`;

  // Take the newest messages that fit the window and summarise exactly those.
  // The old code truncated the text to the last 30k chars but still deleted the
  // whole oldPart (id <= maxOldId), so everything before the window was erased
  // without ever reaching the model — the one copy, gone.
  const summarized: CompactionRow[] = [];
  let used = 0;
  for (let i = oldPart.length - 1; i >= 0; i--) {
    const piece = render(oldPart[i]);
    if (summarized.length > 0 && used + piece.length > MAX_COMPACTION_CHARS) break;
    summarized.unshift(oldPart[i]);
    used += piece.length + 1;
  }
  if (summarized.length === 0) return;
  const oldText = summarized.map(render).join("\n");

  const promptText = `Ты — помощник, который суммаризирует разговоры.

Предыдущее саммари (если есть):
${existing?.summary ?? "Нет"}

Новые сообщения для включения в саммари:
${oldText}

Обнови саммари, сохранив все важные факты, решения, контекст и предпочтения пользователя.
Пиши кратко, но не теряй важную информацию. Пиши на русском.`;

  const response = await llm.chat([{ role: "user", content: promptText }]);
  const newSummary = response.text.trim();

  if (!newSummary) {
    throw new Error("Compaction aborted: LLM returned empty summary");
  }

  const estimatedTokens = response.usage?.completionTokens ?? Math.ceil(newSummary.length / 4);
  const firstSummarizedId = summarized[0].id;
  const lastSummarizedId = summarized[summarized.length - 1].id;

  db.transaction(() => {
    saveSummary(userId, newSummary, estimatedTokens);
    // Delete exactly what went into the model, not everything before it: the
    // rows before the window were never summarised and are still the only copy.
    db.prepare("DELETE FROM conversations WHERE user_id = ? AND id >= ? AND id <= ?").run(
      userId,
      firstSummarizedId,
      lastSummarizedId,
    );
  })();
}
