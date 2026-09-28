import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage } from "../../src/core/memory/conversations.js";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

const testConfig = { name: "Ева", personality: { tone: "friendly", responseStyle: "concise" } };
const USER = "align-user";

/**
 * What every provider checks before it reads a single token: the history
 * starts at a user turn, and each tool answer sits directly under a call that
 * asked for it. A 400 with no body is what you get when it doesn't hold.
 */
function expectParsable(messages: LLMMessage[]): void {
  const body = messages.filter((m) => m.role !== "system");
  expect(body[0]?.role, "history must start at a user message").toBe("user");

  for (let i = 0; i < body.length; i++) {
    const msg = body[i];
    if (msg.role !== "assistant" || !msg.toolCalls?.length) continue;

    const answered: string[] = [];
    let j = i + 1;
    while (j < body.length && body[j].role === "tool") {
      answered.push(body[j].toolCallId!);
      j++;
    }
    expect(
      msg.toolCalls.map((tc) => tc.id).sort(),
      `a call at ${i} has to be answered by exactly the results after it`,
    ).toEqual([...answered].sort());
    i = j - 1;
  }
}

/** An error shaped like the one an OpenAI-compatible endpoint throws. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("engine: a history that outgrew its buffer", () => {
  let dbPath: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-align-${crypto.randomUUID()}.db`);
    getDB(dbPath);
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {}
    }
  });

  /**
   * Forty rows, and every fifth one is part of a two-call tool block:
   *
   *   user · assistant(2 calls) · tool · tool · assistant — repeat
   *
   * The period is what decides where a raw `slice(-40)` lands. This one lands
   * on a `tool` result whose call was thrown away — the exact shape that
   * produced `400 status code (no body)` three times in a row on 27.09, after
   * which the recovery call sent the same broken history and Eva went quiet.
   */
  function seedFortyRows(): void {
    for (let i = 0; i < 40; i++) {
      const slot = i % 5;
      if (slot === 0) saveMessage(USER, "telegram", "user", `вопрос ${i}`);
      else if (slot === 1) {
        saveMessage(USER, "telegram", "assistant", "", undefined, [
          { id: `c${i}a`, name: "t", arguments: {} },
          { id: `c${i}b`, name: "t", arguments: {} },
        ]);
      } else if (slot === 2) saveMessage(USER, "telegram", "tool", "результат", `c${i - 1}a`);
      else if (slot === 3) saveMessage(USER, "telegram", "tool", "результат", `c${i - 2}b`);
      else saveMessage(USER, "telegram", "assistant", `ответ ${i}`);
    }
  }

  function makeEngine(chat: ReturnType<typeof vi.fn>, userId = USER): Engine {
    const llm = { fast: () => ({ chat }), strong: () => ({ chat }), hasRole: () => false };
    const tools = new ToolRegistry();
    tools.register({
      name: "t",
      description: "t",
      parameters: [],
      async execute() {
        return { success: true, output: "ок" };
      },
    });
    return new Engine({ llm, config: testConfig, tools });
  }

  it("never sends a request the provider would reject", async () => {
    seedFortyRows();
    // Set by the loop below, consumed by the first request of a process.
    let wantTool = false;
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      expectParsable(messages);
      if (wantTool) {
        wantTool = false;
        const id = `turn${chat.mock.calls.length}`;
        return {
          text: "",
          stopReason: "tool_use",
          toolCalls: [
            { id: `${id}a`, name: "t", arguments: {} },
            { id: `${id}b`, name: "t", arguments: {} },
          ],
        };
      }
      return { text: "ок", stopReason: "end_turn" };
    });
    const engine = makeEngine(chat);

    // The arithmetic that makes this a regression test and not a smoke test.
    // Forty rows load, and every process() call appends a block that starts
    // with a user message: two rows for a plain answer, five for a turn that
    // uses a tool (user · assistant(2 calls) · tool · tool · assistant).
    //
    //   8 tool turns   → 40 rows, total 80
    //   1 plain answer →  2 rows, total 82   (80 is not yet over the limit)
    //   the next one trips the hard truncation, and `slice(-40)` starts at row
    //   82 - 40 = 42 — the first tool result of the very first tool turn, whose
    //   call sits at row 41, one row outside the window.
    //
    // That is the 27.09 incident in miniature: an answer to a call the request
    // no longer contains. Without the border rules every following request is
    // rejected, the apology is rejected too, and Eva stops answering.
    for (let i = 0; i < 10; i++) {
      wantTool = i < 8;
      const res = await engine.process({
        channelName: "test",
        userId: USER,
        text: `сообщение ${i}`,
        timestamp: Date.now(),
      });
      expect(res.text).toBe("ок");
    }

    expect(logs.some((l) => l.includes('"tag":"engine:hard_truncate"'))).toBe(true);
    const repaired = logs.filter((l) => l.includes('"tag":"engine:history_align"'));
    expect(repaired.length).toBeGreaterThan(0);
    expect(repaired.some((l) => l.includes('"dropped":3'))).toBe(true);
  });

  it("repairs the history once and asks again when the answer is a bare 400", async () => {
    // With the borders checked before every request, a 400 means the cause
    // survives a resend, so there is no retry — this test holds that promise:
    // the apology that follows a failure is the one and only extra ask, and it
    // goes out on a history someone can parse.
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      expectParsable(messages);
      throw httpError(400, "400 status code (no body)");
    });
    const engine = makeEngine(chat, "explained-user");

    const res = await engine.process({
      channelName: "test",
      userId: "explained-user",
      text: "привет",
      timestamp: Date.now(),
    });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("sends a history that starts at a user turn even when the database is cut mid tool block", async () => {
    // The window opens on a tool result: the call it answers sat one row above
    // the limit and is not in the history at all. `loadHistory` trims borders
    // too (see conversations.test.ts), so this asserts the outcome the model
    // sees rather than which layer did the work.
    const owner = "orphan-user";
    saveMessage(owner, "telegram", "user", "на");
    saveMessage(owner, "telegram", "assistant", "сейчас гляну", undefined, [
      { id: "cut", name: "t", arguments: {} },
    ]);
    saveMessage(owner, "telegram", "tool", "результат", "cut");
    saveMessage(owner, "telegram", "user", "а это кто?");
    saveMessage(owner, "telegram", "assistant", "это tool");
    saveMessage(owner, "telegram", "user", "понятно");
    const seen: LLMMessage[][] = [];
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      seen.push(messages);
      expectParsable(messages);
      return { text: "да", stopReason: "end_turn" };
    });
    const engine = makeEngine(chat, owner);

    const res = await engine.process({
      channelName: "test",
      userId: owner,
      text: "ещё",
      timestamp: Date.now(),
    });

    expect(res.text).toBe("да");
    // The call survives here — it and its result are both inside the window —
    // so what the model reads is a whole conversation, not a severed one.
    expect(seen[0]!.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
