import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { addKnowledge, profileKnowledge, knowledgeOfKind } from "../../src/core/memory/knowledge.js";
import {
  PROFILE_SECTIONS,
  BLOCK_LABELS,
  renderProfileDossier,
  renderFlatBlock,
  profileDocPath,
  writeProfileDoc,
} from "../../src/core/profile-dossier.js";

/**
 * The dossier — "анкета, автобиография обо мне", in the owner's words.
 *
 * Two things are tested here that a list cannot do: that a known fact is shown
 * under the section a person would look in, and that a section with nothing
 * known in it says so. The second one is the whole point of the artefact: the
 * live base knew he goes to work and did not know where or in what schedule, and
 * from the outside "есть 191 запись" and "о работе не знаю ничего" look the
 * same.
 */

let dbPath: string;

describe("profile dossier", () => {
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `eva-dossier-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("groups facts by section, in the order a person asks about them", () => {
    addKnowledge({ topic: "вкусы", insight: "Не любит зелёный.", source: "test", kind: "profile" });
    addKnowledge({ topic: "работа", insight: "Работает на складе, ночная смена.", source: "test", kind: "profile" });

    const text = renderProfileDossier(profileKnowledge(), { includeHoles: true });

    expect(text.indexOf("### работа")).toBeLessThan(text.indexOf("### вкусы"));
    expect(text).toContain("Работает на складе, ночная смена.");
    expect(text).toContain("Не любит зелёный.");
  });

  it("says so when a section is empty", () => {
    addKnowledge({ topic: "работа", insight: "Работает.", source: "test", kind: "profile" });

    const withHoles = renderProfileDossier(profileKnowledge(), { includeHoles: true });
    expect(withHoles).toContain("### где живёт\n— пока не знаю");

    // And not in the prompt: a wall of "не знаю" on every turn is noise she
    // cannot act on — she is told to ask instead.
    const withoutHoles = renderProfileDossier(profileKnowledge());
    expect(withoutHoles).not.toContain("не знаю");
    expect(withoutHoles).not.toContain("### досуг");
  });

  it("prints the fact, not the story", () => {
    // The owner read the first version of the dossier and said: "много воды и
    // бесполезной инфы". The rows carried their own narration ("он уточнил,
    // что…") and, for a case, the ending of one particular conversation — which
    // is how a questionnaire turns into a retelling. A dossier line is a fact.
    addKnowledge({
      topic: "работа",
      insight: "Работает на складе, ночная смена.",
      source: "test",
      kind: "profile",
      conclusion: "Об этом говорили после смены.",
    });

    const text = renderProfileDossier(profileKnowledge(), { includeHoles: true });
    expect(text).toContain("- Работает на складе, ночная смена.");
    expect(text).not.toContain("Об этом говорили после смены");
  });

  it("shows a fact whose topic is not one of the sections", () => {
    // A row that exists must never become invisible to the person reading the
    // dossier: the sections are a shape, not a filter.
    addKnowledge({ topic: "энергетик", insight: "Банка энергетика для него как лимонад.", source: "test", kind: "profile" });

    const text = renderProfileDossier(profileKnowledge(), { includeHoles: true });
    expect(text).toContain("### энергетик");
    expect(text).toContain("как лимонад");
  });

  it("writes the dossier beside the config, where the install can find it", () => {
    const configPath = path.join(os.tmpdir(), `eva-dossier-cfg-${crypto.randomUUID()}`, "config.yaml");
    const dest = writeProfileDoc("# Что я о нём знаю\n\n### работа\n- Работает.", configPath);
    expect(dest).toBe(profileDocPath(configPath));
    expect(fs.readFileSync(dest, "utf8")).toContain("Работает.");
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  });

  it("keeps the section list short enough to be asked for by name", () => {
    // The study prompt tells the writer to choose from this list. If it grows,
    // the writer has to guess, and guessing is how the topics drifted apart.
    expect(PROFILE_SECTIONS.length).toBeLessThanOrEqual(8);
  });

  it("renders rules and lessons as their own blocks, not as sections", () => {
    // They have no questionnaire shape: a requirement and an explanation are
    // each their own line. But they are always in front of her for the same
    // reason a preference is — a rule applies to every kind of work, and a word
    // of his means the same thing in every conversation.
    addKnowledge({ topic: "правки", insight: "Новых файлов не создавать.", source: "test", kind: "rules" });
    addKnowledge({ topic: "его слова", insight: "«Моё» — как «моя школа»: гордость, а не собственность.", source: "test", kind: "lesson" });
    addKnowledge({ topic: "работа", insight: "Работает на складе.", source: "test", kind: "profile" });

    const rules = knowledgeOfKind("rules");
    const lessons = knowledgeOfKind("lesson");
    expect(renderFlatBlock(rules)).toBe("- Новых файлов не создавать.");
    expect(renderFlatBlock(lessons)).toContain("как «моя школа»");

    // And they stay out of the profile sections: mixing them back in is how the
    // questionnaire fills up with work instructions instead of the person.
    const profile = renderProfileDossier(profileKnowledge(), { includeHoles: true });
    expect(profile).not.toContain("Новых файлов");
    expect(profile).not.toContain("моя школа");
  });

  it("names all four blocks in the owner's language", () => {
    expect(Object.keys(BLOCK_LABELS).sort()).toEqual(["episode", "lesson", "profile", "rules"]);
    expect(BLOCK_LABELS.lesson).toBe("чему он меня научил");
  });
});
