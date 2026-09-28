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
        "SELECT topic, insight, her_move, context, his_reaction, conclusion FROM knowledge ORDER BY id",
      )
      .all() as Array<{
      topic: string;
      insight: string;
      her_move: string;
      context: string;
      his_reaction: string;
      conclusion: string;
    }>;
  }

  it("stores a conversation's subject and how it ended", async () => {
    const { result } = await session(
      JSON.stringify({
        facts: [
          {
            topic: "спор о нейросетях",
            fact: "сравнивали Gemini и DeepSeek",
            conclusion: "он остался на Gemini",
          },
        ],
      }),
    );

    expect(result.wrote).toBe(true);
    const row = rows()[0];
    expect(row.topic).toBe("спор о нейросетях");
    expect(row.conclusion).toBe("он остался на Gemini");
    // No case fields: nothing happened between them here, a subject was discussed.
    expect(row.her_move).toBe("");
  });

  it("takes a topic with no ending as readily as one with", async () => {
    // Most conversations decide nothing. A subject is still worth a row — it is
    // what lets her ask about the cats next week.
    const { result } = await session(
      JSON.stringify({
        facts: [{ topic: "кошки", fact: "рассказывал про свою кошку" }],
      }),
    );

    expect(result.wrote).toBe(true);
    expect(rows()[0].conclusion).toBe("");
  });

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

  it("keeps a case however much of it was filled in", async () => {
    // The three fields used to be all-or-nothing, and a row naming two of them was
    // dropped rather than stored. The shape was the problem, not the model: it
    // asked for the state he was in, and he does not write to her angry or sad, he
    // just writes to her. So nothing is guessed and nothing is thrown away — what
    // is there is kept, what is missing is simply absent.
    const { result } = await session(JSON.stringify({
      facts: [{
        topic: "шутки",
        fact: "назвала его ангелом, ему понравилось",
        her_move: "назвала его ангелом",
        his_reaction: "подхватил",
      }],
    }));

    expect(result.wrote).toBe(true);
    const row = rows()[0];
    expect(row.her_move).toBe("назвала его ангелом");
    expect(row.his_reaction).toBe("подхватил");
    expect(row.context).toBe("");
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

  it("asks for what is worth remembering, in a list", async () => {
    const text = await prompt();
    expect(text).toContain('"facts"');
    expect(text).toContain("her_move");
    // The old task line. It is what filled the base with self-descriptions.
    expect(text).not.toContain("вывести РОВНО ОДИН новый полезный вывод");
  });

  it("keeps the one rule that was holding the base together", async () => {
    // Everything else here has been simplified twice at the owner's request. This
    // is the one that cannot go: a row shaped like an instruction is obeyed by the
    // answering model instead of weighed, and the previous base was full of them —
    // "не стоит включать оборону", "обязана отбрасывать парную похвалу".
    const text = await prompt();
    expect(text).toContain("Не пиши выводы и правила");
  });

  it("still asks for something concrete and still asks for it briefly", async () => {
    // Both complaints from live rows, both kept through the simplification.
    // "рассказывал про кошку" is a row that takes space and gives nothing to
    // remember; and the first two live rows came back at 271 and 189 characters,
    // most of the longest being scaffolding. Twelve rows reach every answer.
    const text = await prompt();
    expect(text).toContain("рассказывал про кошку");
    expect(text).toContain("одно-два предложения");
  });

  it("says a contradiction is a second moment, and not only mistakes are worth it", async () => {
    const text = await prompt();
    expect(text).toContain("Противоречит старому — это разные");
    // The sampling bias: a window of chat is mostly his corrections, so a base fed
    // on that alone teaches one thing — to agree.
    expect(text).toContain("Где было хорошо — тоже");
  });

  it("treats the zone as where to look first, not as a prohibition", async () => {
    // It was a prohibition, and it cost a real conversation on a live run: the
    // session read two messages and returned "нет конкретных фактов или событий
    // из зоны «сервер и задрот»" — there was material, it was the wrong subject,
    // so it was thrown away, and the cursor had already moved past it.
    const text = await prompt();
    expect(text).toContain("это не запрет");
    expect(text).not.toContain("не пиши вообще");
  });

  it("no zone asks it for lessons any more", async () => {
    // "какие выводы и правила из этого следуют" is the sentence that produced
    // «Отказ от симметричной валидации» and «виртуальная пластичность».
    const text = await prompt();
    expect(text).not.toContain("какие выводы и правила");
    expect(text).not.toContain("сильные и слабые стороны");
  });
});
