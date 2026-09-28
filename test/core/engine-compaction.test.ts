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

    expect(loadSummary(user)).toContain("первые пять вопросов");
    const system = seen.at(-1)?.find((m) => m.role === "system");
    expect(system?.content).toContain("Краткое содержание предыдущего разговора");
    expect(system?.content).toContain("первые пять вопросов");

    // The fold covered the rows that fell out of the window and left them in the
    // table to be covered again if the digest ever has to be rebuilt. The window
    // is still read raw.
    const oldest = getDB()
      .prepare("SELECT content FROM conversations WHERE user_id = ? ORDER BY id ASC LIMIT 1")
      .get(user) as { content: string };
    expect(oldest.content).toBe("вопрос 0");
    // 45 seeded turns and 27 more answers, two rows each, and a fold that no
    // longer takes any of them away.
    expect(countMessages(user)).toBe((45 + 27) * 2);

    // And it says so in the log, with the number of rows it actually carried
    // over — a fold that carried nothing is the failure worth noticing.
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

    // Nothing was summarised, so nothing was recorded and the watermark stayed
    // put: a failed fold costs the old messages their digest, and the next fold
    // reads those rows again rather than skipping past them.
    expect(loadSummary(user)).toBeNull();
    expect(countMessages(user)).toBeGreaterThan(45);
  });

  it("does not take the history away from a turn that is still running", async () => {
    // The fold is in flight when the turn that triggered it reaches its tool,
    // and it lands there: between the call and its result, while the engine is
    // holding a history array and about to keep appending to it. Reloading the
    // history on the way out would put a *different* array into the map — one
    // read from a table whose tail stops at the unanswered call, because the
    // result has not been written yet. The turn itself would not notice; the
    // next message would, because it starts from the map and would find the
    // previous exchange missing its own tool result. That is the hazard
    // `turnLocks` was added for, and the fold only appends a chunk, so it has no
    // reason to write to the history at all.
    const user = "mid-turn";
    seedTurns(user, 45);

    let releaseFold: (() => void) | undefined;
    const foldInFlight = new Promise<void>((resolve) => {
      releaseFold = resolve;
    });
    const isSummaryRequest = (m: LLMMessage[]) => m.length === 1 && m[0].role === "user";

    let wantTool = false;
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      if (isSummaryRequest(messages)) {
        await foldInFlight;
        return { text: "Свернуто.", stopReason: "end_turn" };
      }
      if (wantTool) {
        wantTool = false;
        return { text: "", stopReason: "tool_use", toolCalls: [{ id: "mid1", name: "t", arguments: {} }] };
      }
      return { text: "ок", stopReason: "end_turn" };
    });
    const tools = new ToolRegistry();
    tools.register({
      name: "t",
      description: "t",
      parameters: [],
      async execute() {
        // Let the fold finish right here, mid tool block: the assistant row with
        // the call is already saved, this result is not.
        releaseFold!();
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        return { success: true, output: "ок" };
      },
    });
    const engine = new Engine({
      llm: { fast: () => ({ chat }), strong: () => ({ chat }), hasRole: () => false },
      config: testConfig,
      tools,
    });

    // 40 messages load, two per answer, so 21 plain answers put the history at
    // 82 and the turn that trips the cut is the next one.
    for (let i = 0; i < 21; i++) {
      await engine.process({ channelName: "test", userId: user, text: `ещё ${i}`, timestamp: Date.now() });
    }
    const next: LLMMessage[][] = [];
    wantTool = true;
    await engine.process({ channelName: "test", userId: user, text: "сделай", timestamp: Date.now() });
    wantTool = false;
    chat.mockImplementation(async (messages: LLMMessage[]) => {
      if (isSummaryRequest(messages)) return { text: "Свернуто.", stopReason: "end_turn" };
      next.push(messages);
      return { text: "ок", stopReason: "end_turn" };
    });

    await engine.process({ channelName: "test", userId: user, text: "а ты?", timestamp: Date.now() });

    // The fold did happen — this is not a test that passes because nothing ran.
    expect(loadSummary(user)).not.toBeNull();
    // And the next message still sees the tool result the fold landed on top of.
    expect(next.at(-1)?.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
