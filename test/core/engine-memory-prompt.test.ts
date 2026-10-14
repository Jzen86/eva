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
});
