import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { runStudy } from "../../src/core/memory/study-runner.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

/**
 * What a study session is allowed to leave in the base.
 *
 * The base this repo shipped held 45 rows, and reading them was the argument for
 * all of this: "не стоит включать оборону", "обязана отбрасывать парную похвалу",
 * "Отказ от симметричной валидации". A model handed five of those obeys them, and
 * almost all of them were her own past mistakes, which is a machine for agreeing.
 *
 * The prompt asks for facts. These tests are for the part it cannot be trusted to
 * do itself.
 */
describe("study: what a session may leave in the base", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-fact-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  /** Run one session against a canned model answer, and hand back the prompt. */
  async function session(answer: string) {
    let prompt = "";
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      prompt = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      return { text: answer, stopReason: "end_turn" };
    });
    const result = await runStudy({
      clients: [{ chat } as never],
      agentName: "Ева",
      userId: "u1",
      learning: { learningEnabled: true, studyIntervalMs: 0, specialties: [] },
      maxKnowledge: 50,
    });
    return { result, prompt };
  }

  function rows() {
    return getDB()
      .prepare(
        "SELECT topic, insight, her_move, context, his_reaction FROM knowledge ORDER BY id",
      )
      .all() as Array<{
      topic: string;
      insight: string;
      her_move: string;
      context: string;
      his_reaction: string;
    }>;
  }

  it("stores a case with the state it happened in", async () => {
    const { result } = await session(JSON.stringify({
      facts: [{
        topic: "шутки",
        fact: "околололо",
        her_move: "назвала его ангелом и пошутила про облако",
        context: "был весёлый",
        his_reaction: "подхватил, отвечал тепло",
      }],
    }));

    expect(result.wrote).toBe(true);
    const row = rows()[0];
    expect(row.her_move).toBe("назвала его ангелом и пошутила про облако");
    expect(row.context).toBe("был весёлый");
    expect(row.his_reaction).toBe("подхватил, отвечал тепло");
  });

  it("drops a rule and says why", async () => {
    // The exact shape the base was full of. A rule here is not a slightly worse
    // row: it is an instruction the answering model will obey.
    const { result } = await session(JSON.stringify({
      facts: [{
        topic: "её ошибки",
        fact: "Вывод: не стоит включать логику и самооборону",
        her_move: null,
        context: null,
        his_reaction: null,
      }],
    }));

    expect(result.wrote).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(result.report).toContain("правило, а не факт");
  });

  it("drops a case with only half of it filled in", async () => {
    // Completing the missing half would mean guessing, and a guess is stored the
    // same as a memory of something that happened.
    const { result } = await session(JSON.stringify({
      facts: [{
        topic: "шутки",
        fact: "околололо",
        her_move: "назвала его ангелом",
        context: "был занят",
        his_reaction: null,
      }],
    }));

    expect(result.wrote).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(result.report).toContain("наполовину");
  });

  it("takes every fact of a multi-fact answer, not just the first", async () => {
    const { result } = await session(JSON.stringify({
      facts: [
        { topic: "техника", fact: "Женя не любит айфоны", her_move: null, context: null, his_reaction: null },
        {
          topic: "шутки",
          fact: "околололо",
          her_move: "назвала его ангелом",
          context: "был весёлый",
          his_reaction: "подхватил",
        },
        { topic: "её ошибки", fact: "не стоит защищаться", her_move: null, context: null, his_reaction: null },
      ],
    }));

    expect(result.wrote).toBe(true);
    // Two of three: the rule is gone, the other two stayed.
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.topic).sort()).toEqual(["техника", "шутки"]);
    expect(result.report).toContain("записано 2 из 3");
  });

  it("refuses the old single-insight answer and names the reason", async () => {
    // The model answering in the format this base moved off is not a parse error:
    // that answer is a conclusion by construction, and the report has to say so
    // rather than leaving an empty session unexplained.
    const { result } = await session(
      JSON.stringify({ topic: "выводы", insight: "нельзя оправдываться", reason: "новое" }),
    );

    expect(result.wrote).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(result.reason).toContain("вывод, а не факт");
  });

  it("does not store two near-identical facts from one answer", async () => {
    const { result } = await session(JSON.stringify({
      facts: [
        { topic: "техника", fact: "Женя любит андроид", her_move: null, context: null, his_reaction: null },
        { topic: "техника", fact: "Женя предпочитает андроид", her_move: null, context: null, his_reaction: null },
      ],
    }));

    expect(result.wrote).toBe(true);
    expect(rows()).toHaveLength(1);
  });
});

describe("study: the prompt it is asked with", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-prompt-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  async function prompt() {
    let text = "";
    const chat = vi.fn().mockImplementation(async (messages: LLMMessage[]) => {
      text = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      return { text: "{}", stopReason: "end_turn" };
    });
    await runStudy({
      clients: [{ chat } as never],
      agentName: "Ева",
      userId: "u1",
      learning: { learningEnabled: true, studyIntervalMs: 0, specialties: [] },
      maxKnowledge: 50,
    });
    return text;
  }

  it("asks for facts and cases, not for a conclusion", async () => {
    const text = await prompt();
    expect(text).toContain('"facts"');
    expect(text).toContain("her_move");
    expect(text).toContain("Выводы и правила не пиши");
    // The old task line. It is what filled the base with self-descriptions.
    expect(text).not.toContain("вывести РОВНО ОДИН новый полезный вывод");
  });

  it("tells it to look past the corrections", async () => {
    // The sampling bias, named in the prompt: a window of chat is mostly his
    // corrections to her, and a base of nothing but those teaches one thing.
    const text = await prompt();
    expect(text).toContain("где она была права");
    expect(text).toContain("учится только соглашаться");
  });

  it("says a contradiction is a second moment, not a correction", async () => {
    const text = await prompt();
    expect(text).toContain("разные моменты, а не исправление");
  });

  it("no zone asks it for lessons any more", async () => {
    // "какие выводы и правила из этого следуют" is the sentence that produced
    // «Отказ от симметричной валидации» and «виртуальная пластичность».
    const text = await prompt();
    expect(text).not.toContain("какие выводы и правила");
    expect(text).not.toContain("сильные и слабые стороны");
  });
});
