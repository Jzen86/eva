import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDB, closeDB } from "../../src/core/memory/db";
import { addKnowledge, searchKnowledge, buildMatchQuery, getKnowledgeCount } from "../../src/core/memory/knowledge";
import { stemRu, tokenize, stemsOf, stemsOfFiltered, indexText } from "../../src/core/memory/stem-ru";
import { SqliteShim } from "../shim/better-sqlite3";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-mem-"));
  getDB(path.join(dir, "t.db"));
});

afterEach(() => {
  closeDB();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- tokenizer / query builder ----------------------------------------------

describe("tokenize", () => {
  it("keeps only letters and digits, dropping FTS5 operators", () => {
    expect(tokenize("кот: кота* ~кот^ (кот) \"кот\" -кот")).toEqual([
      "кот", "кота", "кот", "кот", "кот", "кот",
    ]);
  });

  it("treats ё and е as the same letter", () => {
    expect(tokenize("ёж")).toEqual(["еж"]);
  });

  it("handles digits and underscores", () => {
    expect(tokenize("user_id 2024")).toEqual(["user_id", "2024"]);
  });
});

describe("buildMatchQuery", () => {
  it("never returns an empty query for a message full of operators", () => {
    expect(buildMatchQuery('"')).toBeNull();
    expect(buildMatchQuery("()")).toBeNull();
  });

  it("quotes every term so nothing is read as syntax", () => {
    const q = buildMatchQuery("кот")!;
    expect(q).toBe('"кот"*');
  });

  it("returns null when there is nothing searchable", () => {
    expect(buildMatchQuery("")).toBeNull();
    expect(buildMatchQuery("   ")).toBeNull();
    expect(buildMatchQuery("?!!")).toBeNull();
  });

  it("joins terms with OR so one hit still retrieves", () => {
    expect(buildMatchQuery("кот и собака")).toBe('"кот"* OR "собак"*');
  });

  it("skips stopwords that would only widen the query", () => {
    // "что", "ты", "про" and "знаешь" are all noise here.
    expect(buildMatchQuery("что ты знаешь про кота")).toBe('"кот"*');
  });

  it("drops a query made only of noise", () => {
    expect(buildMatchQuery("а и в с")).toBeNull();
  });
});

// --- stemming ----------------------------------------------------------------

describe("stemRu", () => {
  it("folds inflected forms of one word together or near-together", () => {
    // The point is not identical stems, it is that a stem is a prefix of the
    // inflected form, so "кот*" reaches all of them in the index.
    for (const [a, b] of [
      ["кот", "кота"],
      ["кот", "котом"],
      ["говорить", "говорю"],
      ["работать", "работаю"],
      ["делать", "делал"],
    ]) {
      expect(stemRu(a), `${a} vs ${b}`).toBe(stemRu(b));
    }
  });

  it("leaves short words alone", () => {
    expect(stemRu("да")).toBe("да");
    expect(stemRu("ок")).toBe("ок");
  });

  it("does not mangle non-Russian text", () => {
    expect(stemRu("HTTP")).toBe("http");
    expect(stemRu("README")).toBe("readme");
    expect(stemRu("user_id")).toBe("user_id");
  });

  it("never returns a stem too short to be a useful prefix", () => {
    for (const w of ["коты", "были", "жизнь", "привет", "новым"]) {
      expect(stemRu(w).length, w).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("stemsOf", () => {
  it("deduplicates and keeps order", () => {
    // It does not filter noise — that is stemsOfFiltered's job.
    expect(stemsOf("кот кота котик")).toEqual(["кот"]);
  });
});

describe("stemsOfFiltered", () => {
  it("drops stopwords before stemming, not after", () => {
    // The stop check has to see the original word. "знаешь" stems to "зна",
    // so a list keyed on the full word only works if it is consulted first.
    expect(stemsOfFiltered("что ты знаешь", new Set(["что", "ты"]))).toEqual(["зна"]);
  });
});

describe("indexText", () => {
  it("holds both the stem and the raw spelling", () => {
    const index = indexText("кот был рыжим").split(" ");
    expect(index).toContain("кот");
    expect(index).toContain("рыжим");
  });

  /**
   * The reason the index carries raw tokens as well as stems: a stemmed prefix
   * query for "кот" has to reach "котёнок", which no suffix rule reduces to
   * "кот", and the raw spelling starts with the same letters.
   */
  it("keeps a raw form the stemmer cannot reduce", () => {
    expect(indexText("котёнок").split(" ")).toContain("котенок");
  });
});

// --- end to end --------------------------------------------------------------

describe("memory search in Russian", () => {
  it("finds an entry through an inflected query", () => {
    addKnowledge({ topic: "про кота", insight: "кот был рыжим и толстым", source: "test" });
    expect(searchKnowledge("котом", 5)).toHaveLength(1);
    expect(searchKnowledge("котами", 5)).toHaveLength(0); // a different case
    expect(searchKnowledge("рыжим", 5)).toHaveLength(1);
  });

  it("finds the entry no matter which case the user writes", () => {
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    for (const q of ["кот", "КОТ", "Котом", "котом", "котик"]) {
      expect(searchKnowledge(q, 5), q).toHaveLength(1);
    }
  });

  /**
   * Diminutives and nests are the everyday case: people ask about a kitten and
   * the memory is about a cat.
   */
  it("finds the base noun from a derived-form query", () => {
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    for (const q of ["котик", "котика", "котёнок", "котенок", "котики", "котов", "КОТОМ"]) {
      expect(searchKnowledge(q, 5), q).toHaveLength(1);
    }
  });

  /**
   * Known gap, not an accident: a plural of a diminutive ("котята") is a
   * different stem again and no prefix of it lines up with "кот". The entry
   * would have to mention the word for this to hit. Recorded here so the
   * limitation is visible rather than discovered later.
   */
  it("does not match every conceivable derived form", () => {
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    expect(searchKnowledge("котята", 5)).toHaveLength(0);
  });

  it("matches on ё versus е", () => {
    addKnowledge({ topic: "про ежа", insight: "ежик колючий и тихий", source: "test" });
    expect(searchKnowledge("ёжик", 5)).toHaveLength(1);
  });

  /**
   * Regression. This threw `fts5: syntax error near ""` and
   * `no such column: кот` before the query was tokenized, and engine.ts hands
   * this function a raw user message.
   */
  it("survives special characters in the query", () => {
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    for (const q of [
      "кот:",
      "кот -",
      "кот~",
      "кот^",
      "что ты знаешь - про кота?",
      'он said "кот"',
      "(кот)",
      "к*т",
      "кот AND мяу",
      "кот OR собака",
      "NEAR(кот мяу)",
      "кот*",
      "кот; --",
      "1 OR 1=1",
    ]) {
      expect(() => searchKnowledge(q, 5), q).not.toThrow();
    }
  });

  it("does not let an injection reach the database", () => {
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    searchKnowledge("'; DROP TABLE knowledge; --", 5);
    searchKnowledge('" OR "1"="1', 5);
    searchKnowledge("кот OR 1=1", 5);
    expect(getKnowledgeCount()).toBe(1);
    expect(searchKnowledge("кот", 5)).toHaveLength(1);
  });

  it("still finds things on a query that is mostly stopwords", () => {
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    expect(searchKnowledge("кот", 5)).toHaveLength(1);
    expect(searchKnowledge("что", 5)).toHaveLength(0);
  });

  it("ranks a real match above an unrelated entry", () => {
    addKnowledge({ topic: "погода", insight: "дождь шёл весь день", source: "test" });
    addKnowledge({ topic: "питомцы", insight: "кот был рыжим и толстым", source: "test" });
    const hits = searchKnowledge("кот", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].topic).toBe("питомцы");
  });

  it("returns nothing for an empty query rather than everything", () => {
    addKnowledge({ topic: "a", insight: "b", source: "test" });
    expect(searchKnowledge("", 5)).toHaveLength(0);
    expect(searchKnowledge("   ", 5)).toHaveLength(0);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 10; i++) {
      addKnowledge({ topic: `тема ${i}`, insight: "кот рыжий и толстый", source: "test" });
    }
    expect(searchKnowledge("кот", 3)).toHaveLength(3);
    expect(getKnowledgeCount()).toBe(10);
  });
});

// --- index maintenance -------------------------------------------------------

describe("knowledge index stays in sync", () => {
  it("indexes a new entry without a rebuild", () => {
    expect(searchKnowledge("кот", 5)).toHaveLength(0);
    addKnowledge({ topic: "кошка", insight: "кошка мурчит", source: "test" });
    expect(searchKnowledge("кошка", 5)).toHaveLength(1);
  });

  it("stops finding a deleted entry", () => {
    addKnowledge({ topic: "кошка", insight: "кошка мурчит", source: "test" });
    const db = getDB();
    const id = (db.prepare("SELECT id FROM knowledge LIMIT 1").get() as { id: number }).id;
    db.prepare("DELETE FROM knowledge WHERE id = ?").run(id);
    expect(searchKnowledge("кошка", 5)).toHaveLength(0);
  });

  /**
   * An install upgrading from the original raw-text index must keep its memory
   * and start finding it. This is the case the live bot on the server is in.
   */
  it("rebuilds a database written by the old raw-text index", () => {
    const p = path.join(dir, "legacy.db");

    // Build the pre-migration layout by hand, straight through the driver.
    const legacy = new SqliteShim(p);
    legacy.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        insight TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        timestamp INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE knowledge_fts
        USING fts5(topic, insight, content='knowledge', content_rowid='id');
      CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, topic, insight)
          VALUES (new.id, new.topic, new.insight);
      END;
    `);
    legacy
      .prepare("INSERT INTO knowledge (topic, insight, source, timestamp) VALUES (?,?,?,0)")
      .run("про кота", "кот был рыжим", "legacy");
    legacy
      .prepare("INSERT INTO knowledge (topic, insight, source, timestamp) VALUES (?,?,?,0)")
      .run("про работу", "на работе много задач", "legacy");
    legacy.close();

    // Opening it with the app is what triggers the migration.
    closeDB();
    getDB(p);

    expect(getKnowledgeCount()).toBe(2);
    const hits = searchKnowledge("котом", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].insight).toBe("кот был рыжим");
  });

  it("is idempotent — reopening a migrated database changes nothing", () => {
    const p = path.join(dir, "twice.db");
    getDB(p);
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    closeDB();

    getDB(p);
    expect(searchKnowledge("котом", 5)).toHaveLength(1);
    expect(getKnowledgeCount()).toBe(1);

    // Still findable after new writes go through the rebuilt index.
    addKnowledge({ topic: "про погоду", insight: "дождь шёл весь день", source: "test" });
    expect(searchKnowledge("дождём", 5)).toHaveLength(1);
    expect(searchKnowledge("котом", 5)).toHaveLength(1);
  });

  it("reindexes when the index layout version changes", () => {
    const p = path.join(dir, "bumped.db");
    getDB(p);
    addKnowledge({ topic: "про кота", insight: "кот был рыжим", source: "test" });
    // Pretend the stored layout is older than the code.
    getDB(p).prepare("UPDATE eva_meta SET value = '1' WHERE key = 'knowledge_index_version'").run();
    closeDB();

    getDB(p);
    expect(searchKnowledge("котом", 5)).toHaveLength(1);
  });
});
