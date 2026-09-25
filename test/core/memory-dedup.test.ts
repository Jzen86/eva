import { describe, it, expect, beforeEach, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  addKnowledge,
  getAllKnowledge,
  getKnowledgeCount,
  retireKnowledge,
  searchKnowledge,
  trimKnowledge,
  touchKnowledge,
  getZoneCoverage,
  getZoneLastStudied,
  markZoneStudied,
} from "../../src/core/memory/knowledge";
import {
  contentStems,
  coverageOf,
  findDuplicate,
  findLexicalDuplicate,
  learnInsight,
  LEXICAL_DUPLICATE_THRESHOLD,
} from "../../src/core/memory/dedup";
import { closeDB, getDB } from "../../src/core/memory/db";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-dedup-"));
  closeDB();
  getDB(path.join(dir, "eva.db"));
});

afterAll(() => {
  closeDB();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every word the base has ever stored, retired ones included. */
function rawCount(): number {
  const row = getDB()
    .prepare("SELECT COUNT(*) as c FROM knowledge")
    .get() as { c: number };
  return row.c;
}

describe("contentStems", () => {
  it("reduces inflected forms to one stem", () => {
    // The old local tokenizer in study-runner left these as separate words, so
    // "пицца" and "пиццу" never matched each other.
    expect(contentStems("пицца")).toEqual(contentStems("пиццу"));
    expect(contentStems("работаю")).toEqual(contentStems("работать"));
  });

  it("folds ё to е", () => {
    expect(contentStems("котёнок")).toContain("кот");
  });
});

describe("coverageOf", () => {
  it("measures how much of the candidate is already covered", () => {
    const candidate = new Set(["любит", "пицц", "кажд", "день"]);
    const existing = new Set(["пицц"]);
    expect(coverageOf(candidate, existing)).toBe(0.25);
  });

  it("is 1 when the candidate adds nothing", () => {
    const candidate = new Set(["любит", "пицц"]);
    const existing = new Set(["пицц", "любит", "каждый", "день", "и", "ещё"]);
    expect(coverageOf(candidate, existing)).toBe(1);
  });

  it("is 0 for empty input rather than NaN", () => {
    expect(coverageOf(new Set(), new Set(["a"]))).toBe(0);
    expect(coverageOf(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("findLexicalDuplicate", () => {
  it("catches an exact repeat", () => {
    addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    const hit = findLexicalDuplicate("Женя любит пиццу", getAllKnowledge());
    expect(hit?.how).toBe("exact");
  });

  it("catches a repeat written with different inflection", () => {
    addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    const hit = findLexicalDuplicate("Женя любила пиццу", getAllKnowledge());
    expect(hit).not.toBeNull();
  });

  /**
   * The regression that mattered. Dividing by the smaller set made a long,
   * informative insight score 1.0 against a one-word entry and get discarded.
   */
  it("does not discard a richer insight that mentions a known word", () => {
    addKnowledge({ topic: "еда", insight: "пицца", source: "test" });
    const richer = "Женя любит пиццу и берёт её по пятницам";
    const hit = findLexicalDuplicate(richer, getAllKnowledge());
    expect(hit).toBeNull();
  });

  it("ignores retired entries", () => {
    const id = addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    retireKnowledge(id);
    expect(findLexicalDuplicate("Женя любит пиццу", getAllKnowledge(true))).toBeNull();
  });

  it("says nothing about text that is all noise", () => {
    addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    expect(findLexicalDuplicate("и в на с", getAllKnowledge())).toBeNull();
  });
});

describe("findDuplicate", () => {
  it("stops at the lexical check when no endpoint is configured", async () => {
    addKnowledge({ topic: "еда", insight: "Женя не ест грибы", source: "test" });
    const hit = await findDuplicate("Женя не ест грибы", { known: getAllKnowledge() });
    expect(hit?.how).toBe("exact");
    expect(hit?.id).toBe(1);
  });

  /**
   * Without an embedding endpoint this must not throw and must not block the
   * write — a base on a machine with no embedding provider is a normal setup.
   */
  it("survives an endpoint that is not reachable", async () => {
    const hit = await findDuplicate("что-то новое про погоду", {
      known: [],
      embedding: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", model: "m" },
    });
    expect(hit).toBeNull();
  });
});

describe("learnInsight", () => {
  it("writes and reports the id", async () => {
    const outcome = await learnInsight(
      { topic: "еда", insight: "Женя любит пиццу", source: "test" },
      { known: [] },
    );
    expect(outcome.written).toBe(true);
    expect(getKnowledgeCount()).toBe(1);
  });

  it("refuses a repeat and says which entry already holds it", async () => {
    await learnInsight({ topic: "еда", insight: "Женя любит пиццу", source: "test" }, { known: [] });
    const again = await learnInsight(
      { topic: "еда", insight: "Женя любит пиццу", source: "test" },
      { known: getAllKnowledge() },
    );
    expect(again.written).toBe(false);
    expect(getKnowledgeCount()).toBe(1);
    if (!again.written) expect(again.duplicate?.id).toBe(1);
  });

  /** The point of routing every writer through one function. */
  it("is the only path that can tell two writers apart", async () => {
    await learnInsight(
      { topic: "еда", insight: "Женя не ест грибы", source: "study_session" },
      { known: [] },
    );
    const fromTool = await learnInsight(
      { topic: "еда", insight: "Женя не ест грибы", source: "memory_tool" },
      { known: getAllKnowledge() },
    );
    expect(fromTool.written).toBe(false);
  });
});

describe("retireKnowledge", () => {
  it("stops answering but keeps the row", () => {
    const id = addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    retireKnowledge(id);

    expect(searchKnowledge("пиццу", 5)).toHaveLength(0);
    expect(getKnowledgeCount()).toBe(0);
    expect(rawCount()).toBe(1);
  });

  it("records what replaced it", () => {
    const old = addKnowledge({ topic: "еда", insight: "Женя ест грибы", source: "test" });
    const fresh = addKnowledge({ topic: "еда", insight: "Женя не ест грибы", source: "test" });
    retireKnowledge(old, fresh);

    const row = getAllKnowledge(true).find((r) => r.id === old);
    expect(row?.superseded_by).toBe(fresh);
  });
});

describe("trimKnowledge", () => {
  const study = "study_session";

  it("does nothing when under budget", () => {
    addKnowledge({ topic: "a", insight: "что-то одно", source: study });
    expect(trimKnowledge(10, study).retired).toBe(0);
    expect(rawCount()).toBe(1);
  });

  it("keeps the budget without deleting rows", () => {
    for (let i = 0; i < 6; i++) {
      addKnowledge({ topic: `t${i}`, insight: `запись номер ${i} про разное`, source: study });
    }
    const result = trimKnowledge(3, study);
    expect(result.retired).toBe(3);
    expect(getKnowledgeCount()).toBe(3);
    // The history stays, which is the whole reason for retiring over deleting.
    expect(rawCount()).toBe(6);
  });

  /**
   * The defect a recency-only trim could not avoid: a fact stated once and
   * used for a year lost its slot to yesterday's trivia.
   */
  it("retires an unused memory before one that is in use", () => {
    const old = addKnowledge({ topic: "old", insight: "давний факт про дом", source: study });
    addKnowledge({ topic: "new", insight: "свежий факт про погоду", source: study });
    touchKnowledge([old]);

    trimKnowledge(1, study);
    const live = getAllKnowledge();
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(old);
  });

  it("gives study rows first claim on the budget", () => {
    for (let i = 0; i < 4; i++) {
      addKnowledge({ topic: `c${i}`, insight: `из чата запись ${i} про кота`, source: "memory_tool" });
    }
    for (let i = 0; i < 4; i++) {
      addKnowledge({ topic: `s${i}`, insight: `вывод сессии ${i} про работу`, source: study });
    }

    trimKnowledge(4, study);
    const live = getAllKnowledge();
    expect(live).toHaveLength(4);
    expect(live.every((r) => r.source === study)).toBe(true);
  });

  it("does not count retired rows against the budget", () => {
    for (let i = 0; i < 5; i++) {
      addKnowledge({ topic: `t${i}`, insight: `запись ${i} про разное`, source: study });
    }
    trimKnowledge(2, study);
    expect(getKnowledgeCount()).toBe(2);

    // A second pass must not retire anything more.
    expect(trimKnowledge(2, study).retired).toBe(0);
    expect(rawCount()).toBe(5);
  });
});

describe("usage tracking", () => {
  it("counts a memory as used when it answers a question", () => {
    addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    expect(searchKnowledge("пиццу", 5)).toHaveLength(1);

    // Read back from the table: the row a search returns was read before the
    // counter was bumped, so it reports the count as it was.
    const row = getAllKnowledge()[0];
    expect(row.access_count).toBe(1);
    expect(row.last_used).not.toBeNull();
  });

  it("does not count a query that missed", () => {
    addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    expect(searchKnowledge("велосипед", 5)).toHaveLength(0);
    expect(getAllKnowledge()[0].access_count).toBe(0);
  });

  it("accumulates across repeated hits", () => {
    const id = addKnowledge({ topic: "еда", insight: "Женя любит пиццу", source: "test" });
    searchKnowledge("пиццу", 5);
    searchKnowledge("пиццу", 5);
    touchKnowledge([id]);
    expect(getAllKnowledge()[0].access_count).toBe(3);
  });
});

describe("threshold sanity", () => {
  it("keeps the lexical threshold where it was", () => {
    // Widening or narrowing this changes what study is allowed to write, so it
    // is pinned rather than left to drift.
    expect(LEXICAL_DUPLICATE_THRESHOLD).toBe(0.6);
  });
});

describe("zone coverage", () => {
  it("counts live entries per zone", async () => {
    await learnInsight(
      { topic: "t", insight: "про сервер", source: "study_session", zone: "сервер" },
      { known: [] },
    );
    await learnInsight(
      { topic: "t", insight: "про работу", source: "study_session", zone: "работа" },
      { known: [] },
    );
    const coverage = getZoneCoverage();
    expect(coverage.get("сервер")).toBe(1);
    expect(coverage.get("работа")).toBe(1);
  });

  it("does not count retired entries", () => {
    const id = addKnowledge({
      topic: "t",
      insight: "про сервер был",
      source: "study_session",
      zone: "сервер",
    });
    expect(getZoneCoverage().get("сервер")).toBe(1);
    retireKnowledge(id);
    expect(getZoneCoverage().get("сервер")).toBeUndefined();
  });

  it("ignores entries with no zone", () => {
    addKnowledge({ topic: "t", insight: "без зоны вовсе", source: "study_session" });
    expect(getZoneCoverage().size).toBe(0);
  });
});

describe("zone rotation cursor", () => {
  it("survives a reopen, which a module variable would not", () => {
    markZoneStudied("владелец");
    expect(getZoneLastStudied()["владелец"]).toBeGreaterThan(0);

    // Reopening is what a restart does; the cursor has to still be there.
    closeDB();
    getDB(path.join(dir, "eva.db"));
    expect(getZoneLastStudied()["владелец"]).toBeGreaterThan(0);
  });

  it("keeps several zones at once", () => {
    markZoneStudied("владелец");
    markZoneStudied("она сама");
    const seen = getZoneLastStudied();
    expect(seen["владелец"]).toBeGreaterThan(0);
    expect(seen["она сама"]).toBeGreaterThan(0);
  });

  it("returns nothing instead of throwing on a corrupt cursor", () => {
    getDB().prepare("UPDATE eva_meta SET value = ? WHERE key = ?").run("не json", "study_zone_seen");
    expect(getZoneLastStudied()).toEqual({});
  });
});
