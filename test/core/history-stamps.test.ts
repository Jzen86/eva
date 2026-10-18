import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { stampHistory } from "../../src/core/prompt.js";
import { stripReplyStamp } from "../../src/core/memory/time-words.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

/**
 * The clock in front of the window.
 *
 * Measured live on 18.10: his last message at 15:45, the next at 18:00, and her answer
 * built as if it were 15:50 — "осталось ровно 6 часов 10 минут" is 22:00 minus 15:50 —
 * while the real figure was four hours. The same day she called a morning of server work
 * "ты только что ковырял" eight hours later. Both are the window's fault: forty messages
 * arrive with nothing saying when any of them happened.
 *
 * The owner's intent, in his words: "она берёт отсчёт от своего последнего ответа… если
 * прошло 5 минут, ничего страшного, а если 30 минут — это уже срок… если часы прошли,
 * тем более. Лишь бы понимала разницу именно во времени".
 */
describe("the clock on the window", () => {
  /** His zone (+4), so the expectations read the way he would. */
  const TZ = 4;
  /** 18.10.2026 18:00 for him. */
  const NOW = Date.UTC(2026, 9, 18, 14, 0);
  const at = (hh: number, mm: number, day = 18) => Math.floor(Date.UTC(2026, 9, day, hh - TZ, mm) / 1000);

  it("marks a message with its hour when it is from today", () => {
    const out = stampHistory([{ role: "user", content: "скоро вернусь", at: at(15, 45) }], TZ, NOW);
    expect(out[0].content).toBe("[15:45] скоро вернусь");
  });

  it("marks the day too when the message is older than today", () => {
    const out = stampHistory([{ role: "assistant", content: "жду", at: at(21, 40, 17) }], TZ, NOW);
    expect(out[0].content).toBe("[17.10 21:40] жду");
  });

  it("counts the day in his zone, not the box's", () => {
    // 21:30 UTC on the 17th is 01:30 on the 18th for him: a message from "today".
    const stamp = Math.floor(Date.UTC(2026, 9, 17, 21, 30) / 1000);
    const out = stampHistory([{ role: "user", content: "не спишь?", at: stamp }], TZ, NOW);
    expect(out[0].content).toBe("[01:30] не спишь?");
  });

  it("leaves alone what nobody said", () => {
    const messages: LLMMessage[] = [
      { role: "tool", content: "результат", toolCallId: "c1", at: at(15, 45) },
      { role: "assistant", content: "", at: at(15, 45) },
      { role: "user", content: "без времени" },
      {
        role: "user",
        content: [{ type: "text", text: "кадр" }],
        at: at(15, 45),
      },
    ];
    const out = stampHistory(messages, TZ, NOW);
    expect(out[0].content).toBe("результат");
    expect(out[1].content).toBe("");
    expect(out[2].content).toBe("без времени");
    expect(Array.isArray(out[3].content)).toBe(true);
  });

  it("does not touch what is stored — only what she is handed", () => {    // The stamp is a rendering of the request. The row keeps his words, so the memory
    // never learns that he writes with brackets, and the archive stays his.
    const out = stampHistory([{ role: "user", content: "ага", at: at(15, 45) }], TZ, NOW);
    expect(out[0].content).toContain("[15:45]");
    expect((out[0] as { at?: number }).at).toBe(at(15, 45));
  });

  /**
   * And the same clock must not come back in her reply.
   *
   * A model that reads forty lines of "[15:45] …" writes one of its own: on 18.10 two of
   * her answers began "[19:18] …" and the owner saw the mark in the chat. The prompt
   * already asked her not to — asking did not hold, so the engine takes it off. Twice in
   * one text is possible (stored once, stamped again on the way out), hence the loop.
   */
  it("takes the engine's own mark off a reply that came back wearing it", () => {
    expect(stripReplyStamp("[19:18] Ой, да шучу я, шучу.")).toBe("Ой, да шучу я, шучу.");
    expect(stripReplyStamp("[19:18] [19:18] дважды")).toBe("дважды");
    expect(stripReplyStamp("[18.10 19:18] с датой тоже")).toBe("с датой тоже");
    // Her own punctuation is hers: a bracket in the middle stays, and so does a line
    // that merely looks like a time without being one.
    expect(stripReplyStamp("ок, [19:18] внутри — не метка")).toBe("ок, [19:18] внутри — не метка");
    expect(stripReplyStamp("обычный ответ")).toBe("обычный ответ");
  });
});

describe("her reply never carries the mark", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-nostamp-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("strips it from what goes to him and from what is stored", async () => {
    const chat = async () => ({ text: "[19:18] Иди ко мне, кот!", stopReason: "end_turn" as const });
    const engine = new Engine({
      llm: { fast: () => ({ chat }), strong: () => ({ chat }) },
      config: { name: "Ева", timezoneOffsetHours: 4 },
      tools: new ToolRegistry(),
    });

    const out = await engine.process({ channelName: "telegram", userId: "u1", text: "привет", timestamp: Date.now() });
    expect(out.text).toBe("Иди ко мне, кот!");

    const stored = getDB()
      .prepare("SELECT content FROM conversations WHERE role = 'assistant'")
      .get() as { content: string };
    expect(stored.content).toBe("Иди ко мне, кот!");
  });
});

describe("the window in a real request", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-stamps-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("hands her the morning with its hours on, and stores it without", async () => {
    const fourHoursAgo = Math.floor(Date.now() / 1000) - 4 * 3600;
    const insert = getDB().prepare(
      "INSERT INTO conversations (user_id, channel, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("u1", "telegram", "user", "ковыряю сервер", fourHoursAgo);
    insert.run("u1", "telegram", "assistant", "удачи, кот", fourHoursAgo + 5);

    let request: LLMMessage[] = [];
    const chat = async (messages: LLMMessage[]) => {
      request = messages;
      return { text: "ок", stopReason: "end_turn" as const };
    };
    const engine = new Engine({
      llm: { fast: () => ({ chat }), strong: () => ({ chat }) },
      config: { name: "Ева", timezoneOffsetHours: 4 },
      tools: new ToolRegistry(),
    });
    await engine.process({ channelName: "telegram", userId: "u1", text: "привет", timestamp: Date.now() });

    const stamped = request.filter((m) => typeof m.content === "string" && /^\[\d{2}:\d{2}\]/.test(m.content));
    expect(stamped.map((m) => m.content)).toEqual([
      expect.stringContaining("] ковыряю сервер"),
      expect.stringContaining("] удачи, кот"),
      expect.stringContaining("] привет"),
    ]);

    // And the table still holds his words alone.
    const stored = getDB()
      .prepare("SELECT content FROM conversations ORDER BY id ASC")
      .all() as Array<{ content: string }>;
    expect(stored.map((r) => r.content)).toEqual(["ковыряю сервер", "удачи, кот", "привет", "ок"]);
  });
});
