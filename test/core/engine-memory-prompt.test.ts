import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { addKnowledge } from "../../src/core/memory/knowledge.js";
import { recordScene } from "../../src/core/memory/scene-log.js";
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

    // The request that follows the tool call carries the picture itself and the
    // note that tells her what to do with it. Pinned: the frame travels; the note
    // gives her the call ("переделай один раз" on a gross defect) and tells her to
    // answer in her own words, not to review the picture ("не описывай"). It no
    // longer says "решает он" — since 16.10 the redo is hers (silently; the engine
    // replaces the rejected frame), and what stays his is the picture itself.
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("data:image/png;base64,AAAA");
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("переделай один раз");
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("не описывай");
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).not.toContain("решает он");

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
    // And the third responsibility, from the owner's own example (18.10): "сегодня я
    // работаю, и она не станет говорить идём посидим на диване, это невозможно" — a
    // standing arrangement has to be checked against the clock before anything is
    // proposed, or the offer is made to an empty room.
    expect(system).toMatch(/сверься с ним и с текущим временем/);
    expect(system).toMatch(/предложение в пустоту/);
    // An episode is not part of the always-on block: it is looked up when the
    // conversation comes near it.
    expect(system).not.toContain("мы любим шампиньоны");
  });

  it("puts today's shift in front of her, counted from the cycle in the config", async () => {
    // The dossier holds the rule ("2/2, с 8 до 22"); the day itself is counted here,
    // because a day changes at midnight and a small model doing modular date
    // arithmetic gets it wrong exactly when it matters — the owner's own reason:
    // "сегодня я работаю, и она не станет говорить идём посидим на диване".
    const engine = new Engine({
      llm: captureLlm(),
      config: {
        ...testConfig,
        timezoneOffsetHours: 4,
        workSchedule: { workDays: 2, restDays: 2, anchor: "2026-10-18", shift: "8:00–22:00" },
      },
      tools: new ToolRegistry(),
    });

    await engine.process({
      channelName: "test",
      userId: "mem-shift",
      text: "привет",
      timestamp: Date.UTC(2026, 9, 18, 6),
    });

    const system = String(captured[0]?.[0]?.content);
    expect(system).toContain("Его график: сегодня 18.10.2026");
    expect(system).toContain("рабочий день, смена 8:00–22:00");
  });

  it("puts her own last frames in front of her, and not in front of a check", async () => {
    recordScene("frames-chat", "спальня, пучок, ухмылка, утро");
    recordScene("frames-chat", "кухня, распущенные волосы, улыбка, вечер");

    const engine = new Engine({ llm: captureLlm(), config: testConfig, tools: new ToolRegistry() });
    await engine.process({ channelName: "test", userId: "frames-chat", text: "привет", timestamp: Date.now() });

    const system = String(captured.at(-1)?.[0]?.content);
    expect(system).toContain("Твои последние кадры");
    expect(system).toContain("кухня, распущенные волосы");
    expect(system).toContain("спальня, пучок");
    // Newest first: the freshest frame is the one she is told hardest not to
    // repeat, because that is the one she would otherwise reach for again.
    expect(system.indexOf("кухня")).toBeLessThan(system.indexOf("спальня"));
    expect(system).toMatch(/не должен повторять/);

    // A check reads a log and a diff; there is no picture in it. The frames are
    // kept out of it for the same reason the profile block is.
    await engine.process({
      channelName: "test",
      userId: "frames-check",
      text: "плановая проверка",
      timestamp: Date.now(),
      metadata: { scheduledTask: true, reportTask: true },
    });
    expect(String(captured.at(-1)?.[0]?.content)).not.toContain("Твои последние кадры");
  });

  it("says nothing about a schedule when the config has none", async () => {
    const engine = new Engine({ llm: captureLlm(), config: testConfig, tools: new ToolRegistry() });
    await engine.process({ channelName: "test", userId: "mem-noshift", text: "привет", timestamp: Date.now() });
    expect(String(captured[0]?.[0]?.content)).not.toContain("Его график");
  });

  it("gives a check the skeleton of a report, and a conversation none", async () => {
    // The owner asked for a structure he can verify — what was checked, what was found,
    // what she recommends, the verdict — and for it in her own words rather than as a form:
    // "весь отчет она пишет своими словами, а не по моему шаблону. это примерный каркас".
    // One skeleton in one place: three checks read it, so the shape cannot drift apart.
    const engine = new Engine({ llm: captureLlm(), config: testConfig, tools: new ToolRegistry() });

    await engine.process({
      channelName: "test",
      userId: "mem-check",
      text: "плановая проверка",
      timestamp: Date.now(),
      metadata: { scheduledTask: true, reportTask: true },
    });
    const reportPrompt = String(captured.at(-1)?.[0]?.content);
    expect(reportPrompt).toContain("## Отчёт");
    expect(reportPrompt).toContain("своими словами");
    expect(reportPrompt).toContain("что ты проверяла");
    expect(reportPrompt).toContain("твой вердикт");
    // A check still gets no profile and no memory search — the skeleton is not memory.
    expect(reportPrompt).not.toContain("Что я о нём знаю");

    await engine.process({
      channelName: "test",
      userId: "mem-chat-2",
      text: "привет",
      timestamp: Date.now(),
    });
    expect(String(captured.at(-1)?.[0]?.content)).not.toContain("## Отчёт");
  });
});
