import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage, loadSummary, countMessages } from "../../src/core/memory/conversations.js";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

const testConfig = { name: "Ева", personality: { tone: "friendly", responseStyle: "concise" } };

/**
 * A model that answers with a summary when it is asked to summarise one, and
 * with a plain reply otherwise. The two are told apart by the request itself:
 * compaction sends a single user message with no conversation in it.
 */
function llmThatAnswers(summaryText: string) {
  const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
    const askedToSummarise = messages.length === 1 && messages[0].role === "user";
    if (askedToSummarise) {
      return { text: summaryText, stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 20 } };
    }
    return { text: "ок", stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 20 } };
  });
  return { chat, client: { fast: () => ({ chat }), strong: () => ({ chat }), hasRole: () => false } };
}

function seedTurns(userId: string, turns: number): void {
  for (let i = 0; i < turns; i++) {
    saveMessage(userId, "telegram", "user", `вопрос ${i}`);
    saveMessage(userId, "telegram", "assistant", `ответ ${i}`);
  }
}

describe("engine: compaction", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-compact-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("leaves an ordinary message alone", async () => {
    // A conversation that still fits the window has nothing to carry forward, so
    // compaction must not cost a request. It used to fire on a prompt-token
    // budget that 40 messages of chat never reach, which is why the messages
    // that did fall out of the window were dropped with nothing in their place.
    const { chat, client } = llmThatAnswers("Саммари, которого быть не должно.");
    const engine = new Engine({ llm: client, config: testConfig, tools: new ToolRegistry() });

    await engine.process({ channelName: "test", userId: "u1", text: "привет", timestamp: Date.now() });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(loadSummary("u1")).toBeNull();
  });

  it("folds the messages that fall out of the window, and puts the summary in the next answer", async () => {
    const user = "forgetful";
    // 45 turns: the 40 newest are the window, the 5 oldest have fallen out of it.
    seedTurns(user, 45);
    const { chat, client } = llmThatAnswers("Обсуждали первые пять вопросов.");
    const engine = new Engine({ llm: client, config: testConfig, tools: new ToolRegistry() });
    const folded: number[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      const entry = String(line);
      if (entry.includes('"tag":"engine:compaction"')) {
        folded.push(JSON.parse(entry).folded);
      }
    });

    // Nothing yet — the window is full but the cut has not been reached, and a
    // background fold would run a model for nothing.
    await engine.process({ channelName: "test", userId: user, text: "ещё", timestamp: Date.now() });
    expect(loadSummary(user)).toBeNull();

    // Push the history past the hard truncation.
    for (let i = 0; i < 25; i++) {
      await engine.process({ channelName: "test", userId: user, text: `ещё ${i}`, timestamp: Date.now() });
    }

    // The next message waits for the fold at the top of the turn, so the summary
    // is in that prompt rather than some turn after it.
    const seen: LLMMessage[][] = [];
    chat.mockImplementation(async (messages: LLMMessage[]) => {
      if (messages.length === 1 && messages[0].role === "user") {
        return { text: "Обсуждали первые пять вопросов.", stopReason: "end_turn" };
      }
      seen.push(messages);
      return { text: "ок", stopReason: "end_turn" };
    });
    await engine.process({ channelName: "test", userId: user, text: "а что мы обсуждали?", timestamp: Date.now() });

    expect(loadSummary(user)?.summary).toContain("первые пять вопросов");
    const system = seen.at(-1)?.find((m) => m.role === "system");
    expect(system?.content).toContain("Краткое содержание предыдущего разговора");
    expect(system?.content).toContain("первые пять вопросов");

    // What the fold covered is gone from the table and present in the prompt —
    // carried forward, not silently dropped. The window is still read raw.
    const oldest = getDB()
      .prepare("SELECT content FROM conversations WHERE user_id = ? ORDER BY id ASC LIMIT 1")
      .get(user) as { content: string };
    expect(oldest.content).not.toBe("вопрос 0");
    expect(countMessages(user)).toBeLessThan(45 + 26 * 2);

    // And it says so in the log, with the number of rows it actually carried
    // over — a fold that folded nothing is the failure worth noticing.
    expect(folded.length).toBeGreaterThan(0);
    expect(Math.max(...folded)).toBeGreaterThan(40);
    logSpy.mockRestore();
  });

  it("keeps answering when the fold fails", async () => {
    const user = "broken-folder";
    seedTurns(user, 45);
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      if (messages.length === 1 && messages[0].role === "user") throw new Error("provider is down");
      return { text: "ок", stopReason: "end_turn" };
    });
    const client = { fast: () => ({ chat }), strong: () => ({ chat }), hasRole: () => false };
    const engine = new Engine({ llm: client, config: testConfig, tools: new ToolRegistry() });

    for (let i = 0; i < 25; i++) {
      const res = await engine.process({ channelName: "test", userId: user, text: `ещё ${i}`, timestamp: Date.now() });
      expect(res.text).toBe("ок");
    }

    // Nothing was summarised, so nothing was deleted: a failed fold costs the
    // old messages their summary, not the conversation its history.
    expect(loadSummary(user)).toBeNull();
    expect(countMessages(user)).toBeGreaterThan(45);
  });
});
