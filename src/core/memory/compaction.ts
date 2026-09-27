import { getDB } from "./db.js";
import { loadSummary, saveSummary } from "./conversations.js";
import type { LLMClient } from "../llm/types.js";

interface CompactionRow {
  id: number;
  role: string;
  content: string;
  tool_calls: string | null;
}

export async function compactHistory(userId: string, llm: LLMClient): Promise<void> {
  const db = getDB();
  const existing = loadSummary(userId);

  const allRows = db.prepare(
    "SELECT id, role, content, tool_calls FROM conversations WHERE user_id = ? ORDER BY timestamp ASC, id ASC",
  ).all(userId) as CompactionRow[];

  if (allRows.length < 4) return;

  const mid = Math.floor(allRows.length / 2);
  let splitIdx = -1;

  for (let i = mid; i < allRows.length; i++) {
    if (allRows[i].role === "user") { splitIdx = i; break; }
  }
  if (splitIdx === -1) {
    for (let i = mid - 1; i >= 0; i--) {
      if (allRows[i].role === "user") { splitIdx = i; break; }
    }
  }
  if (splitIdx === -1) return;

  const oldPart = allRows.slice(0, splitIdx);
  if (oldPart.length === 0) return;

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
