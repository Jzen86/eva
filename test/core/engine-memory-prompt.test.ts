import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { addKnowledge } from "../../src/core/memory/knowledge.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

/**
 * Which turns get her memory in front of them.
 *
 * Memory is not something she goes and fetches: the engine searches by the
 * incoming message and puts the result in the system prompt. That makes *when*
 * it is injected a decision, and the decision has one exception — a planned
 * check reads a log and a diff, and twelve lines about what he likes are not
 * input to that work. They are an invitation to write a report about a
 * regression in the register of a love letter.
 *
 * Measured before the split, on the live install: a `self_watch` turn pulled
 * ["Критерий полной проверки его реализаций", "механизм ошибок и извинений"] from
 * a message about a scheduled task — nothing to do with the check, occupying
 * slots.
 */

let dbPath: string;
let captured: LLMMessage[][] = [];

function captureLlm() {
  const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
    captured.push(messages);
    return { text: "ок", stopReason: "end_turn" };
  });
  return { fast: () => ({ chat }), strong: () => ({ chat }), hasRole: () => false };
}

const testConfig = {
  name: "Ева",
  gender: "female" as const,
  personality: { tone: "friendly", responseStyle: "concise" },
};

describe("memory in the prompt", () => {
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-mem-prompt-${crypto.randomUUID()}.db`);
    getDB(dbPath);
    captured = [];
    addKnowledge({
      topic: "грибы",
      insight: "мы любим шампиньоны",
      source: "test",
    });
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("puts what she remembers in front of a normal turn", async () => {
    const engine = new Engine({ llm: captureLlm(), config: testConfig, tools: new ToolRegistry() });
    await engine.process({
      channelName: "test",
      userId: "mem-chat",
      text: "что-нибудь про грибы",
      timestamp: Date.now(),
    });

    const system = captured[0]?.[0]?.content;
    expect(String(system)).toContain("Что было раньше");
    expect(String(system)).toContain("шампиньоны");
  });

  it("leaves it out of a check turn", async () => {
    const engine = new Engine({ llm: captureLlm(), config: testConfig, tools: new ToolRegistry() });
    await engine.process({
      channelName: "test",
      userId: "mem-check",
      text: "что-нибудь про грибы",
      timestamp: Date.now(),
      metadata: { scheduledTask: true, reportTask: true },
    });

    const system = captured[0]?.[0]?.content;
    expect(String(system)).not.toContain("Что было раньше");
    expect(String(system)).not.toContain("шампиньоны");
  });

  it("shows her the picture she just made — for that turn only", async () => {
    // She generated blind: the picture went to the channel, and the model that
    // wrote the prompt never saw it. Live: the same request produced both hands
    // on her chest in one frame and her own hand there a minute later, and only
    // someone looking at the result can tell which is which.
    const tools = new ToolRegistry();
    tools.register({
      name: "selfie",
      description: "selfie",
      parameters: [],
      async execute() {
        return { success: true, output: "Селфи отправлено в чат", mediaUrl: "data:image/png;base64,AAAA" };
      },
    });
    const chat = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "c1", name: "selfie", arguments: {} }],
      })
      .mockResolvedValue({ text: "готово", stopReason: "end_turn" });
    const llm = { fast: () => ({ chat }), strong: () => ({ chat }), hasRole: () => false };
    const engine = new Engine({ llm, config: testConfig, tools });

    await engine.process({
      channelName: "test",
      userId: "eyes",
      text: "сделай кадр",
      timestamp: Date.now(),
    });

    // The request that follows the tool call carries the picture itself, and the
    // note that tells her to look at it. What is pinned here is that the frame
    // travels and that the note names the task ("есть ли анатомические дефекты")
    // and the one who decides ("решает он"): the first version of the note listed
    // the defects to look for and she recited them, the second listed the ones to
    // ignore and she recited those — the inventory was mine both times. There is no
    // retry to pin, and that is deliberate: a second frame is his call, not hers.
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("data:image/png;base64,AAAA");
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("анатомических дефектов");
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("решает он");

    chat.mockClear();
    await engine.process({
      channelName: "test",
      userId: "eyes",
      text: "ага",
      timestamp: Date.now(),
    });

    // And the next turn does not: it is there to be judged, not to be paid for
    // on every message of the session.
    expect(JSON.stringify(chat.mock.calls[0]?.[0])).not.toContain("base64,AAAA");
  });

  it("puts his profile in front of a chat turn, with the rule that it wins", async () => {
    // The always-on block. A preference is true whatever the topic is, so it is
    // not searched for — and the sentence after the list is the part the live
    // runs asked for: with the fact merely present, she read "he dislikes green"
    // and praised a green shirt, twice.
    addKnowledge({ topic: "вкусы", insight: "Не любит зелёный цвет.", source: "test", kind: "profile" });

    const engine = new Engine({ llm: captureLlm(), config: testConfig, tools: new ToolRegistry() });
    await engine.process({
      channelName: "test",
      userId: "mem-profile",
      text: "чем заняться вечером?",
      timestamp: Date.now(),
    });

    const system = String(captured[0]?.[0]?.content);
    expect(system).toContain("Что я о нём знаю");
    expect(system).toContain("Не любит зелёный цвет");
    expect(system).toMatch(/опирайся на запись, а не на свой вкус/);
    // An episode is not part of the always-on block: it is looked up when the
    // conversation comes near it.
    expect(system).not.toContain("мы любим шампиньоны");
  });
});
