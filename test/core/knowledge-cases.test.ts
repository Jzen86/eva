import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDB, closeDB } from "../../src/core/memory/db";
import {
  addKnowledge,
  searchKnowledge,
  renderKnowledge,
  isCase,
  relativeAge,
  KNOWLEDGE_PROMPT_LIMIT,
} from "../../src/core/memory/knowledge";
import { createMemoryTool } from "../../src/core/tools/memory";
import { retireKnowledge } from "../../src/core/memory/knowledge";
import { learnInsight } from "../../src/core/memory/dedup";
import { SqliteShim } from "../shim/better-sqlite3";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-cases-"));
  closeDB();
  getDB(path.join(dir, "t.db"));
});

afterEach(() => {
  closeDB();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The case log: what she did, the state he was in, what he did about it.
 *
 * The point of the three fields is that the reaction is unreadable without the
 * state, and these tests are mostly about that staying true on the way into the
 * prompt — the read side is the only place the base can turn back into rules.
 */
describe("cases", () => {
  it("tells a case from a plain statement", () => {
    const statement = addKnowledge({
      topic: "техника",
      insight: "Женя не любит айфоны",
      source: "memory_tool",
    });
    const recorded = addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом и пошутила про облако",
      context: "был весёлый",
      his_reaction: "подхватил, отвечал тепло",
    });

    expect(isCase(byId(statement))).toBe(false);
    expect(isCase(byId(recorded))).toBe(true);
  });

  it("renders a case with the state it happened in", () => {
    addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом",
      context: "был весёлый",
      his_reaction: "подхватил, тепло",
    });

    const out = renderKnowledge(searchKnowledge("ангелом", 5));
    expect(out).toContain("состояние: был весёлый");
    expect(out).toContain("она: назвала его ангелом");
    expect(out).toContain("ты: подхватил, тепло");
  });

  it("keeps what the case was about, not only the scene", () => {
    // A case used to render as состояние/она/ты with the subject dropped, and on
    // the live base that was 25 rows of 35 arriving like that: something happened,
    // somebody reacted, and she could not say what it had been about — the one
    // thing a person says when they remember you.
    addKnowledge({
      topic: "шутки",
      insight: "жгут про облако",
      source: "memory_tool",
      her_move: "назвала его ангелом",
      context: "был весёлый",
      his_reaction: "подхватил, тепло",
    });

    const out = renderKnowledge(searchKnowledge("облако", 5));
    expect(out).toContain("жгут про облако");
    expect(out).toContain("состояние: был весёлый");
  });

  it("says so when a case has no recorded state instead of dropping it", () => {
    // The danger is the silent one: rendering the reaction alone turns a
    // moment into a rule. Marking it unknown keeps the case usable and keeps
    // the absence visible, where hiding it would make the base look smaller
    // every time the schema grew.
    addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом",
      context: "",
      his_reaction: "ответил холодно",
    });

    const out = renderKnowledge(searchKnowledge("ангелом", 5));
    expect(out).toContain("состояние: не определяется");
    expect(out).toContain("ты: ответил холодно");
  });

  it("tells the model these are examples and not rules", () => {
    addKnowledge({
      topic: "шутки",
      insight: "околололо",
      source: "memory_tool",
      her_move: "назвала его ангелом",
      context: "был весёлый",
      his_reaction: "подхватил, тепло",
    });

    const out = renderKnowledge(searchKnowledge("ангелом", 5));
    expect(out).toContain("а не правила");
    expect(out).toContain("выбирай");
  });

  it("keeps a statement readable as itself, with no case fields invented", () => {
    addKnowledge({ topic: "техника", insight: "Женя не любит айфоны", source: "memory_tool" });

    const out = renderKnowledge(searchKnowledge("айфон", 5));
    expect(out).toContain("Женя не любит айфоны");
    expect(out).not.toContain("состояние:");
  });

/**
 * What a row says about itself besides its content: when it happened and what it
 * was about.
 *
 * Both were on the row from the first version and neither was ever shown, so she
 * had no way to know that the planes were last week or that a row was about work
 * rather than about her. These are also the two things a person says when they
 * remember you — "мы говорили о самолётах" and "помнишь, неделю назад".
 */
describe("dates and subjects", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("says how long ago a row happened", () => {
    addKnowledge({
      topic: "самолёты",
      insight: "летал в Саратов, вспоминал посадку в грозу",
      source: "memory_tool",
      timestamp: now() - 5 * 86_400,
    });

    const out = renderKnowledge(searchKnowledge("Саратов", 5));
    expect(out).toContain("5 дней назад");
    // The subject, in the same bracket, so the row is findable by it and she can
    // name what was discussed.
    expect(out).toContain("· самолёты]");
  });

  it("calls today today", () => {
    addKnowledge({ topic: "еда", insight: "сегодня готовил борщ", source: "memory_tool" });

    const out = renderKnowledge(searchKnowledge("борщ", 5));
    expect(out).toContain("сегодня");
    expect(out).toContain("· еда]");
  });

  it("agrees the noun with the number", () => {
    // "1 дней назад" is the kind of detail that makes the whole block read as
    // machine output, and it is four lines to avoid.
    expect(relativeAge(now())).toBe("сегодня");
    expect(relativeAge(now() - 86_400)).toBe("вчера");
    expect(relativeAge(now() - 2 * 86_400)).toBe("2 дня назад");
    expect(relativeAge(now() - 5 * 86_400)).toBe("5 дней назад");
    expect(relativeAge(now() - 10 * 86_400)).toBe("неделю назад");
    expect(relativeAge(now() - 20 * 86_400)).toBe("3 недели назад");
    expect(relativeAge(now() - 70 * 86_400)).toBe("2 месяца назад");
  });

  it("tells the model it has the date and may use it", () => {
    addKnowledge({ topic: "самолёты", insight: "летал в Саратов", source: "memory_tool" });

    const out = renderKnowledge(searchKnowledge("Саратов", 5));
    expect(out).toContain("а не правила");
    expect(out).toContain("когда");
  });
});

  it("is found by what she did, not only by the sentence about it", () => {
    // The note is written around the moment, so the words that will come up
    // next time are the ones in her_move and his_reaction. Without them in the
    // index every fresh phrasing of the same observation is a fact nothing can
    // reach.
    addKnowledge({
      topic: "общее",
      insight: "заметка",
      source: "memory_tool",
      her_move: "обозвала его подлизателем",
      context: "был занят",
      his_reaction: "отшутился, но голосом посадил",
    });

    expect(searchKnowledge("подлизателем", 5)).toHaveLength(1);
    expect(searchKnowledge("занят", 5)).toHaveLength(1);
    expect(searchKnowledge("отшутился", 5)).toHaveLength(1);
  });

  it("gives the prompt room for a spread of cases", () => {
    // Five slots was sized for three-sentence conclusions. A case is a line, and
    // the base is only worth anything if the same thing can show up more than
    // once in more than one state.
    expect(KNOWLEDGE_PROMPT_LIMIT).toBeGreaterThanOrEqual(10);
  });
});

describe("memory tool, case fields", () => {
  it("refuses a case with no state rather than storing a rule", async () => {
    const tool = createMemoryTool();

    const result = await tool.execute({
      action: "save",
      content: "околололо",
      her_move: "назвала его ангелом",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("incomplete_case");
    expect(getDB().prepare("SELECT COUNT(*) c FROM knowledge").get()).toEqual({ c: 0 });
  });

  it("saves the whole trio when it is there", async () => {
    const tool = createMemoryTool();

    const result = await tool.execute({
      action: "save",
      content: "околололо",
      her_move: "назвала его ангелом",
      context: "был весёлый",
      his_reaction: "подхватил, тепло",
    });

    expect(result.success).toBe(true);
    const row = getAll()[0];
    expect(row.her_move).toBe("назвала его ангелом");
    expect(row.context).toBe("был весёлый");
    expect(row.his_reaction).toBe("подхватил, тепло");
  });

  it("still saves a plain fact about a person with no case fields", async () => {
    const tool = createMemoryTool();

    const result = await tool.execute({
      action: "save",
      content: "Женя гомофоб, не упоминать пидоров",
      topic: "тема",
    });

    expect(result.success).toBe(true);
    const row = getAll()[0];
    expect(row.her_move).toBe("");
    expect(isCase(row)).toBe(false);
  });
});

/**
 * The one thing that may retire a fact: he corrected it.
 *
 * Until this existed, `superseded_by` was written by nobody in the whole life of
 * the install. Not one of the 45 rows had ever been superseded, because the only
 * caller passed no replacement — so the columns that say "this was corrected"
 * were indistinguishable from the ones that say "this was dropped for space", and
 * in practice neither ever fired.
 */
describe("memory tool, a corrected fact", () => {
  it("shows stable entry IDs in search results", async () => {
    const tool = createMemoryTool();
    await tool.execute({ action: "save", content: "Женя любит старые самолёты", topic: "хобби" });
    const id = getAll()[0].id;

    const result = await tool.execute({ action: "search", query: "самолёты" });

    expect(result.output).toContain(`#${id}`);
  });

  it("does not save anything when supersedes is not a live numeric ID", async () => {
    const tool = createMemoryTool();
    await tool.execute({ action: "save", content: "Женя любит самолёты", topic: "хобби" });
    const before = getAll().length;

    const result = await tool.execute({
      action: "save",
      content: "Женя любит старые самолёты",
      topic: "хобби",
      supersedes: "memory-unknown-id",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_id");
    expect(getAll()).toHaveLength(before);
  });

  it("deduplicates identical facts that have a conclusion", async () => {
    const tool = createMemoryTool();
    const input = {
      action: "save",
      content: "Оператор отключил домашний интернет",
      topic: "интернет",
      conclusion: "Женя злился на оператора, а не без причины",
    };
    await tool.execute(input);
    const id = getAll()[0].id;

    const result = await tool.execute(input);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Not saved");
    expect(result.output).toContain(`#${id}`);
    expect(getAll()).toHaveLength(1);
  });

  it("rolls back the replacement if retiring its old row fails", async () => {
    await expect(
      learnInsight(
        { topic: "интернет", insight: "Оператор отключил домашний интернет", source: "memory_tool" },
        { afterWrite: () => { throw new Error("retirement failed"); } },
      ),
    ).rejects.toThrow("retirement failed");

    expect(getAll()).toHaveLength(0);
  });

  it("retires the old row and points it at the new one", async () => {
    const tool = createMemoryTool();
    await tool.execute({ action: "save", content: "Женя пьёт энергетики 10-15 лет", topic: "привычки" });
    const oldId = byId(getAll()[0].id).id;

    const result = await tool.execute({
      action: "save",
      content: "Женя бросил энергетики полгода назад",
      topic: "привычки",
      supersedes: String(oldId),
    });

    expect(result.success).toBe(true);
    const db = getDB();
    const old = db.prepare("SELECT superseded_at, superseded_by FROM knowledge WHERE id = ?").get(oldId) as {
      superseded_at: number | null;
      superseded_by: number | null;
    };
    const newRow = getAll()[0];
    expect(old.superseded_at).not.toBeNull();
    expect(old.superseded_by).toBe(newRow.id);

    // And the retired one stops answering: it is out of the search index.
    expect(searchKnowledge("энергетики", 5).map((r) => r.id)).not.toContain(oldId);
  });

  it("keeps the old fact when the new one is refused as a duplicate", async () => {
    // The order matters. Retiring first and writing second would leave the base
    // with neither version of the fact.
    const tool = createMemoryTool();
    await tool.execute({ action: "save", content: "Женя пьёт энергетики 10-15 лет", topic: "привычки" });
    const oldId = getAll()[0].id;

    const result = await tool.execute({
      action: "save",
      content: "Женя пьёт энергетики 10-15 лет",
      topic: "привычки",
      supersedes: String(oldId),
    });

    expect(result.success).toBe(true);
    const row = byId(oldId);
    expect(row.superseded_at).toBeNull();
  });

  it("says so when the row it was told to retire is not live", async () => {
    const tool = createMemoryTool();
    await tool.execute({ action: "save", content: "Женя пьёт энергетики", topic: "привычки" });
    const oldId = getAll()[0].id;
    retireKnowledge(oldId);

    const result = await tool.execute({
      action: "save",
      content: "Женя бросил энергетики",
      topic: "привычки",
      supersedes: String(oldId),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_id");
    expect(result.output).toContain("live memory entry");
    expect(getAll()).toHaveLength(0);
  });
});

describe("migration", () => {
  it("adds the case columns to an install that predates them", () => {
    // The live install: 45 rows written by the memory tool and by study, none of
    // them with a case field, and an index built from topic and insight alone.
    const p = path.join(dir, "legacy.db");
    const legacy = new SqliteShim(p);
    legacy.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        insight TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        timestamp INTEGER NOT NULL DEFAULT 0,
        stems TEXT NOT NULL DEFAULT '',
        zone TEXT NOT NULL DEFAULT '',
        access_count INTEGER NOT NULL DEFAULT 0,
        last_used INTEGER,
        superseded_at INTEGER,
        superseded_by INTEGER
      );
    `);
    legacy
      .prepare(
        "INSERT INTO knowledge (topic, insight, source, timestamp) VALUES (?,?,?,0)",
      )
      .run("техника", "Женя не любит айфоны", "memory_tool");
    legacy.close();

    closeDB();
    getDB(p);

    const cols = (getDB().pragma("table_info(knowledge)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("her_move");
    expect(cols).toContain("context");
    expect(cols).toContain("his_reaction");
    expect(cols).toContain("conclusion");
    // And the zone column is gone, not left behind for the next reader to wonder
    // about. This schema is the one the live install actually had.
    expect(cols).not.toContain("zone");

    // The old rows are statements, not broken cases, and the index still finds
    // them by the words they always answered to.
    const row = getAll()[0];
    expect(row.her_move).toBe("");
    expect(isCase(row)).toBe(false);
    expect(searchKnowledge("айфон", 5)).toHaveLength(1);
  });
});

/** Live rows, oldest first. */
function getAll() {
  return getDB()
    .prepare(
      "SELECT id, topic, insight, source, confidence, timestamp, access_count, " +
        "last_used, superseded_at, superseded_by, her_move, context, his_reaction, conclusion " +
        "FROM knowledge WHERE superseded_at IS NULL ORDER BY id ASC",
    )
    .all() as CaseRow;
}

/**
 * By row id, not by position. Ids start at 1, so indexing a list of rows with
 * one silently returns the neighbouring row and the test passes on the wrong
 * thing.
 */
function byId(id: number): CaseRow {
  const row = getAll().find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

interface CaseRow {
  id: number;
  her_move: string;
  context: string;
  his_reaction: string;
  conclusion: string;
  superseded_at: number | null;
  superseded_by: number | null;
}

/**
 * The итог of a row: how that one conversation ended.
 *
 * It exists because the owner drew the base as four columns and this was the one
 * missing — date, subject, description, outcome. What makes it safe where the old
 * conclusions were not is that it lives on the row: "Gemini лучше DeepSeek" is
 * printed next to the argument it came from, dated, so it reads as one dispute's
 * result. Stored away from its moment it would be a law again.
 */
describe("the итог of a row", () => {
  it("is printed on the row it belongs to", () => {
    addKnowledge({
      topic: "спор о нейросетях",
      insight: "сравнивали Gemini и DeepSeek",
      source: "memory_tool",
      conclusion: "он остался на Gemini",
    });

    const out = renderKnowledge(searchKnowledge("DeepSeek", 5));
    expect(out).toContain("итог: он остался на Gemini");
    // Beside what it came from, in the same entry, not on a line of its own.
    expect(out).toContain("сравнивали Gemini и DeepSeek");
  });

  it("is reachable by what was decided, not only by what was discussed", () => {
    addKnowledge({
      topic: "спор о нейросетях",
      insight: "сравнивали модели",
      source: "memory_tool",
      conclusion: "он остался на Gemini",
    });

    expect(searchKnowledge("Gemini", 5)).toHaveLength(1);
  });

  it("does not appear on a fact", () => {
    // A fact about a person has no ending. An итог on one would be advice.
    addKnowledge({ topic: "техника", insight: "не любит айфоны", source: "memory_tool" });

    expect(getAll()[0].conclusion).toBe("");
    expect(renderKnowledge(searchKnowledge("айфон", 5))).not.toContain("итог:");
  });

  it("keeps two arguments that ended differently", async () => {
    // The one thing it must not do is collapse into a verdict. Tuesday's argument
    // concluded one way, Friday's the other, so the base holds two results —
    // otherwise it holds whichever was written first, and that is a law.
    const a = await learnInsight(
      {
        topic: "нейросети",
        insight: "сравнивали Gemini и DeepSeek",
        source: "memory_tool",
        conclusion: "он остался на Gemini",
      },
      {},
    );
    const b = await learnInsight(
      {
        topic: "нейросети",
        insight: "сравнивали Gemini и DeepSeek",
        source: "memory_tool",
        conclusion: "на этот раз выбрал DeepSeek",
      },
      {},
    );

    expect(a.written).toBe(true);
    expect(b.written).toBe(true);
    expect(getAll()).toHaveLength(2);
  });

  it("tells the model in the prompt that it is not a law", () => {
    addKnowledge({
      topic: "нейросети",
      insight: "сравнивали",
      source: "memory_tool",
      conclusion: "остался на Gemini",
    });

    const out = renderKnowledge(searchKnowledge("сравнивали", 5));
    expect(out).toContain("не как на закон");
  });
});

/**
 * What counts as "we already have this" for a case.
 *
 * A case is identified by its whole moment and only exactly. Measured like a
 * fact, two moments with the same trigger and opposite reactions score about
 * 0.75 against each other and the second is refused — so the base holds one
 * answer per trigger, which is a rule, and a rule is what this layer was rebuilt
 * to stop storing.
 */
describe("cases and the duplicate check", () => {
  async function save(input: {
    topic: string;
    insight: string;
    her_move?: string;
    context?: string;
    his_reaction?: string;
  }) {
    return learnInsight({ source: "study_session", ...input }, {});
  }

  it("keeps both halves of a pair that contradicts itself", async () => {
    const a = await save({
      topic: "шутки",
      insight: "она пошутила про ангела, он отреагировал холодно",
      her_move: "пошутила про ангела",
      context: "был занят",
      his_reaction: "ответил холодно",
    });
    const b = await save({
      topic: "шутки",
      insight: "она пошутила про ангела, он подхватил",
      her_move: "пошутила про ангела",
      context: "был весёлый",
      his_reaction: "подхватил, отвечал тепло",
    });

    expect(a.written).toBe(true);
    expect(b.written).toBe(true);
    expect(getAll()).toHaveLength(2);
  });

  it("still refuses the identical moment twice", async () => {
    const moment = {
      topic: "шутки",
      insight: "она пошутила про ангела, он отреагировал холодно",
      her_move: "пошутила про ангела",
      context: "был занят",
      his_reaction: "ответил холодно",
    };

    expect((await save(moment)).written).toBe(true);
    expect((await save(moment)).written).toBe(false);
    expect(getAll()).toHaveLength(1);
  });

  it("does not hold a case against a fact", async () => {
    // A statement about someone and a recorded moment are different kinds of
    // thing, and neither makes the other a repeat.
    expect((await save({ topic: "характер", insight: "она пошутила про ангела" })).written).toBe(true);
    expect(
      (
        await save({
          topic: "шутки",
          insight: "она пошутила про ангела",
          her_move: "пошутила про ангела",
          context: "был весёлый",
          his_reaction: "подхватил",
        })
      ).written,
    ).toBe(true);
    expect(getAll()).toHaveLength(2);
  });

  it("still collapses near-identical facts", async () => {
    // The fact rule is untouched: five wordings of one fact is one fact.
    expect(
      (await save({ topic: "техника", insight: "Женя не любит айфоны и не хочет их видеть" }))
        .written,
    ).toBe(true);
    expect((await save({ topic: "техника", insight: "Женя не любит айфоны" })).written).toBe(false);
    expect(getAll()).toHaveLength(1);
  });
});
