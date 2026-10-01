import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import {
  saveMessage,
  loadHistory,
  saveSummaryChunk,
  loadSummary,
  loadSummaryChunks,
  foldedUpTo,
} from "../../src/core/memory/conversations.js";
import { compactHistory } from "../../src/core/memory/compaction.js";
import type { LLMMessage } from "../../src/core/llm/types.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

/**
 * The window the model actually reads. `loadHistory` hands it the newest rows,
 * so everything older is what compaction owns — and it does not delete any of
 * it, because the digest is a view of the archive and the archive is the only
 * copy of the words the view was built from.
 */
const WINDOW = 4;

function mockLLM(summaryText: string) {
  return {
    chat: vi.fn().mockResolvedValue({
      text: summaryText,
      stopReason: "end_turn",
      usage: { promptTokens: 100, completionTokens: 50 },
    }),
    chatStream: vi.fn(),
  };
}

function rowCount(userId: string): number {
  return (
    getDB().prepare("SELECT COUNT(*) n FROM conversations WHERE user_id = ?").get(userId) as { n: number }
  ).n;
}

function contentOf(userId: string, order: "ASC" | "DESC", limit: number): string[] {
  return (
    getDB()
      .prepare(
        `SELECT content FROM conversations WHERE user_id = ? ORDER BY id ${order} LIMIT ?`,
      )
      .all(userId, limit) as { content: string }[]
  ).map((r) => r.content);
}

describe("Compaction", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-compact-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("folds what has fallen out of the window and leaves the window alone", async () => {
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    const llm = mockLLM("Пользователь задал 10 вопросов и получил ответы.");
    const result = await compactHistory("u1", llm, WINDOW);

    expect(loadSummary("u1")).toContain("10 вопросов");
    expect(result?.folded).toBe(16);

    // The four newest rows are what the model still reads, so they must survive
    // untouched. This is what the old split got backwards: it cut down the
    // middle of the table, which put the rows about to be dropped on the
    // untouched side and summarised rows that were still in the window.
    expect(contentOf("u1", "DESC", WINDOW)).toEqual(["Answer 9", "Question 9", "Answer 8", "Question 8"]);
    const { messages } = loadHistory("u1", WINDOW);
    expect(messages).toHaveLength(WINDOW);
  });

  it("keeps every row it summarised", async () => {
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    await compactHistory("u1", mockLLM("Свёрнуто."), WINDOW);

    // The fold used to delete exactly what it had just summarised, which made
    // the digest the last copy of it: a summary that dropped a fact dropped it
    // for good, with no way back to the words behind it. The rows are the
    // archive; the digest is a view that can be thrown away and rebuilt.
    expect(rowCount("u1")).toBe(20);
    expect(contentOf("u1", "ASC", 1)[0]).toBe("Question 0");
  });

  it("does nothing while the whole conversation still fits the window", async () => {
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    const llm = mockLLM("Саммари, которого быть не должно.");
    await compactHistory("u1", llm, 40);

    // Nothing has left the window, so there is nothing to carry forward. The
    // old version always split the table in half and spent a request on a
    // conversation the model could still read in full.
    expect(llm.chat).not.toHaveBeenCalled();
    expect(loadSummary("u1")).toBeNull();
    expect(rowCount("u1")).toBe(12);
  });

  it("never summarises the same stretch twice", async () => {
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    const first = mockLLM("Первые восемь.");
    await compactHistory("u1", first, WINDOW);
    const watermark = foldedUpTo("u1");
    expect(watermark).toBeGreaterThan(0);

    // A second fold with no new messages: everything under the cut is already
    // carried, so there is nothing left to summarise. The rolling summary it
    // replaced had no watermark, so it fed itself back in and reworded all of
    // itself on every single fold.
    const second = mockLLM("Пересказ того же самого.");
    const result = await compactHistory("u1", second, WINDOW);
    expect(second.chat).not.toHaveBeenCalled();
    expect(result).toBeNull();
    // Rendered with the day its rows were written, so the folded stretch keeps
    // a place in time instead of turning into an undated "как-то раз".
    expect(loadSummary("u1")).toMatch(/^\[\d{2}\.\d{2} \d{2}:\d{2}\] Первые восемь\.$/);
  });

  it("adds a new chunk instead of rewriting the old one", async () => {
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    await compactHistory("u1", mockLLM("Первые восемь."), WINDOW);
    for (let i = 10; i < 16; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    await compactHistory("u1", mockLLM("Следующие четыре."), WINDOW);

    // Each stretch is written once, from its own rows, and the earlier one is
    // still there word for word.
    const chunks = loadSummaryChunks("u1");
    expect(chunks.map((c) => c.summary)).toEqual(["Первые восемь.", "Следующие четыре."]);
    expect(chunks[0].toId).toBeLessThan(chunks[1].fromId);
    // The chunks stay undated in the table; the dates are added when the digest
    // is rendered, so a stored summary has no second, ageing copy of its range.
    expect(loadSummary("u1")).toMatch(
      /^\[\d{2}\.\d{2} \d{2}:\d{2}\] Первые восемь\.\n\n\[\d{2}\.\d{2} \d{2}:\d{2}\] Следующие четыре\.$/,
    );
  });

  it("retires an old install's summary into the first real fold", async () => {
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    // What an older install left behind: text with no range behind it.
    saveSummaryChunk("u1", { fromId: 0, toId: 0, summary: "Давно обсуждали TypeScript", tokenEstimate: 30 });
    const llm = mockLLM("Обновлённое саммари.");
    await compactHistory("u1", llm, WINDOW);

    const promptText = llm.chat.mock.calls[0][0][0].content as string;
    expect(promptText).toContain("Давно обсуждали TypeScript");
    // Absorbed, not kept forever next to the chunk that now says the same thing.
    expect(loadSummaryChunks("u1").map((c) => c.toId)).not.toContain(0);
  });

  it("aborts compaction if LLM returns empty summary", async () => {
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `msg ${i}`);
      saveMessage("u1", "tg", "assistant", `reply ${i}`);
    }
    const llm = mockLLM("   ");
    await expect(compactHistory("u1", llm, WINDOW)).rejects.toThrow("empty summary");
    // Nothing was summarised, so nothing is recorded and the watermark stays
    // put: the next fold reads those rows again rather than skipping them.
    expect(rowCount("u1")).toBe(12);
    expect(loadSummary("u1")).toBeNull();
    expect(foldedUpTo("u1")).toBe(0);
  });

  it("keeps the messages it did not put in front of the model", async () => {
    const big = "x".repeat(4_000);
    // 20 messages of ~4k chars = ~80k, well past the 30k summarising window.
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Q${i} ${big}`);
      saveMessage("u1", "tg", "assistant", `A${i} ${big}`);
    }

    const result = await compactHistory("u1", mockLLM("Сжатое саммари."), WINDOW);

    // The prompt saw only the newest ~30k chars, so the chunk it recorded stops
    // short of the window edge and the rows before it stay unread — the
    // watermark never reached them, so the next fold will.
    expect(result!.folded).toBeLessThan(20);
    expect(foldedUpTo("u1")).toBeGreaterThan(0);
    expect(contentOf("u1", "ASC", 1)[0]).toContain("Q0");
  });

  it("merges the oldest chunks only when the digest grows too big to keep", async () => {
    // Two real folds, each writing one 15k stretch. Together they pass the 24k
    // digest budget, and without a bound the digest would keep growing one chunk
    // per fold until it cost more than the window it exists to protect.
    let folds = 0;
    const llm = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      const prompt = messages[0].content as string;
      if (prompt.includes("Объедини их")) {
        return { text: "СЛИТО", stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 5 } };
      }
      return {
        text: folds++ === 0 ? "A".repeat(15_000) : "B".repeat(15_000),
        stopReason: "end_turn",
        usage: { promptTokens: 100, completionTokens: 5 },
      };
    });
    const client = { chat: llm } as unknown as Parameters<typeof compactHistory>[1];

    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    await compactHistory("u1", client, WINDOW);
    expect(loadSummaryChunks("u1").map((c) => c.summary)).toEqual(["A".repeat(15_000)]);

    for (let i = 10; i < 16; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    await compactHistory("u1", client, WINDOW);

    // The merge saw both chunks, and neither swallowed the new one.
    const mergePrompt = llm.mock.calls
      .map((c) => (c[0] as LLMMessage[])[0].content as string)
      .find((p) => p.includes("Объедини их"))!;
    expect(mergePrompt).toContain("A".repeat(15_000));
    expect(mergePrompt).toContain("B".repeat(15_000));
    expect(mergePrompt).not.toContain("B".repeat(15_000) + "\n---\nНОВОЕ");

    const chunks = loadSummaryChunks("u1");
    expect(chunks.map((c) => c.summary)).toEqual(["СЛИТО"]);
    // The merged chunk stands for everything both of the old ones did, so the
    // watermark does not move and nothing gets summarised a second time.
    expect(chunks[0]).toMatchObject({ fromId: 1, toId: 28 });
    expect(foldedUpTo("u1")).toBe(28);
  });

  it("leaves the digest alone when a merge comes back empty", async () => {
    let folds = 0;
    const llm = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      const prompt = messages[0].content as string;
      if (prompt.includes("Объедини их")) {
        return { text: "  ", stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 5 } };
      }
      return {
        text: folds++ === 0 ? "A".repeat(15_000) : "B".repeat(15_000),
        stopReason: "end_turn",
        usage: { promptTokens: 100, completionTokens: 5 },
      };
    });
    const client = { chat: llm } as unknown as Parameters<typeof compactHistory>[1];

    for (let i = 0; i < 16; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    // One fold covers the first 28 rows; a second one, after more turns, covers
    // the next stretch and leaves the digest two chunks past its budget.
    await compactHistory("u1", client, WINDOW);
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    await compactHistory("u1", client, WINDOW);

    // An empty merge retires nothing: the one real loss in this design must never
    // be the one a provider hiccup causes. The digest stays over budget instead,
    // and the next fold tries again.
    expect(loadSummaryChunks("u1").map((c) => c.summary)).toEqual([
      "A".repeat(15_000),
      "B".repeat(15_000),
    ]);
  });

  it("cuts on a turn boundary, so nothing is left answering a call that is gone", async () => {
    saveMessage("u1", "tg", "user", "Q1");
    saveMessage("u1", "tg", "assistant", "", undefined, [{ id: "tc1", name: "test", arguments: {} }]);
    saveMessage("u1", "tg", "tool", "result", "tc1");
    saveMessage("u1", "tg", "user", "Q2");
    saveMessage("u1", "tg", "assistant", "A2");
    saveMessage("u1", "tg", "user", "Q3");
    saveMessage("u1", "tg", "assistant", "A3");

    const llm = mockLLM("Summary of Q1 and tool use.");
    await compactHistory("u1", llm, WINDOW);

    // The window edge falls between the call and its result. Walking back to the
    // `user` that owns the turn takes the call, the result and the question
    // together, so what stays is whole and starts on a user turn.
    const { messages } = loadHistory("u1", WINDOW);
    expect(messages[0].role).toBe("user");
    expect(messages.map((m) => m.content)).toEqual(["Q2", "A2", "Q3", "A3"]);
    expect(llm.chat.mock.calls[0][0][0].content as string).toContain("result");
  });
});
