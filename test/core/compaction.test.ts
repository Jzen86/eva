import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage, loadHistory, saveSummary, loadSummary } from "../../src/core/memory/conversations.js";
import { compactHistory } from "../../src/core/memory/compaction.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

/**
 * The window the model actually reads. `loadHistory` hands it the newest rows,
 * so everything older is what compaction owns — those rows are the only copy of
 * themselves, and this is the only thing that carries them forward.
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
    await compactHistory("u1", llm, WINDOW);

    expect(loadSummary("u1")?.summary).toContain("10 вопросов");

    // The four newest rows are what the model still reads, so they must survive
    // untouched. This is what the old split got backwards: it cut down the
    // middle of the table, which put the rows about to be dropped on the
    // untouched side and summarised rows that were still in the window.
    expect(contentOf("u1", "DESC", WINDOW)).toEqual(["Answer 9", "Question 9", "Answer 8", "Question 8"]);
    expect(rowCount("u1")).toBe(WINDOW);

    const { messages } = loadHistory("u1");
    expect(messages).toHaveLength(WINDOW);
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

  it("preserves existing summary in compaction prompt", async () => {
    saveSummary("u1", "Ранее обсуждали TypeScript", 30);
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `msg ${i}`);
      saveMessage("u1", "tg", "assistant", `reply ${i}`);
    }
    const llm = mockLLM("Обновлённое саммари.");
    await compactHistory("u1", llm, WINDOW);
    const callArgs = llm.chat.mock.calls[0][0];
    const promptText = callArgs[0].content as string;
    expect(promptText).toContain("Ранее обсуждали TypeScript");
  });

  it("aborts compaction if LLM returns empty summary", async () => {
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `msg ${i}`);
      saveMessage("u1", "tg", "assistant", `reply ${i}`);
    }
    const llm = mockLLM("   ");
    await expect(compactHistory("u1", llm, WINDOW)).rejects.toThrow("empty summary");
    // A summary that failed to come back leaves nothing to carry the old messages
    // forward with, so they have to stay.
    expect(rowCount("u1")).toBe(12);
    expect(loadSummary("u1")).toBeNull();
  });

  it("keeps the messages it did not put in front of the model", async () => {
    const big = "x".repeat(4_000);
    // 20 messages of ~4k chars = ~80k, well past the 30k summarising window.
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Q${i} ${big}`);
      saveMessage("u1", "tg", "assistant", `A${i} ${big}`);
    }

    const llm = mockLLM("Сжатое саммари.");
    await compactHistory("u1", llm, WINDOW);

    // The prompt saw only the newest ~30k chars, so the rows before that window
    // must still exist: they were never summarised, so they are the only copy.
    expect(rowCount("u1")).toBeLessThan(20);
    expect(contentOf("u1", "ASC", 1)[0]).toContain("Q0");
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
    const { messages } = loadHistory("u1");
    expect(messages[0].role).toBe("user");
    expect(messages.map((m) => m.content)).toEqual(["Q2", "A2", "Q3", "A3"]);
    expect(llm.chat.mock.calls[0][0][0].content as string).toContain("result");
  });
});
