import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FilesTool } from "../../../src/core/tools/files.js";
import { defaultPathPolicy } from "../../../src/core/path-policy.js";
import { discard } from "../../../src/core/pending.js";
import { userFilesPath } from "../../../src/core/user-files.js";
import { buildSystemPrompt, type PromptConfig } from "../../../src/core/prompt.js";

/**
 * The reads that make the vault work: .xlsx flattened to text, long files
 * paged with a footer that names the next offset, and the standing prompt
 * section that tells her the vault exists. The policy itself is exercised in
 * path-policy.test.ts — here only one case guards that the new paging did not
 * loosen it.
 */

let root: string;
let outside: string;

// The config file itself is the denied secret; the root is the only allowed root.
const tool = () => new FilesTool({ policy: defaultPathPolicy(path.join(root, "config.yaml"), [root]) });

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "..", "..", "fixtures", name);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eva-files-read-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "eva-files-out-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("files read paging", () => {
  it("returns a whole small file in one page, no footer", async () => {
    const p = path.join(root, "small.txt");
    fs.writeFileSync(p, "alpha\nbeta\ngamma", "utf-8");
    const res = await tool().execute({ action: "read", path: p });
    expect(res.success).toBe(true);
    expect(res.output).toBe("alpha\nbeta\ngamma");
  });

  it("pages a long file by characters and names the continuing offset", async () => {
    const p = path.join(root, "long.txt");
    const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(4, "0")} ${"x".repeat(20)}`);
    fs.writeFileSync(p, lines.join("\n"), "utf-8");

    const first = await tool().execute({ action: "read", path: p });
    expect(first.success).toBe(true);
    expect(first.output).toContain("line 0001");
    expect(first.output).not.toContain("line 0600");
    const m = first.output!.match(/offset=(\d+)\)$/);
    expect(m).not.toBeNull();
    const offset = Number(m![1]);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(600);

    // Every page names the next offset until the file is exhausted; the tail
    // page says so and carries the last line.
    let output = first.output!;
    let cursor = offset;
    for (let hops = 0; hops < 20 && output.includes("(показаны строки"); hops++) {
      const next = await tool().execute({ action: "read", path: p, offset: cursor });
      expect(next.success).toBe(true);
      output = next.output!;
      const m2 = output.match(/offset=(\d+)\)$/);
      if (m2) cursor = Number(m2[1]);
    }
    expect(output).not.toContain("(показаны строки");
    expect(output).toContain("(конец файла");
    expect(output).toContain("line 0600");
  });

  it("offset past the end reports the real size instead of crashing", async () => {
    const p = path.join(root, "short.txt");
    fs.writeFileSync(p, "one\ntwo", "utf-8");
    const res = await tool().execute({ action: "read", path: p, offset: 100 });
    expect(res.success).toBe(true);
    expect(res.output).toContain("2 строк");
  });
});

describe("files read xlsx", () => {
  it("flattens every sheet with headings, joined cells and ISO dates", async () => {
    const res = await tool().execute({ action: "read", path: fixture("stalker-mini.xlsx") });
    expect(res.success).toBe(true);
    expect(res.output).toContain("### Лист: Артефакты");
    expect(res.output).toContain("Слизь | Свалка | В радиоактивном автобусе");
    // Empty cells drop out, the row still reads as a row.
    expect(res.output).toContain("Душа | Химический завод");
    expect(res.output).toContain("Затон | Только имя в ячейке");
    expect(res.output).toContain("### Лист: Локации");
    expect(res.output).toContain("2026-10-06");
    // The fully empty row left no blank line of its own.
    expect(res.output).not.toMatch(/\n\n\n/);
  });

  it("reports the sheet-reading failure as a tool error, not a throw", async () => {
    const p = path.join(root, "fake.xlsx");
    fs.writeFileSync(p, "not a zip", "utf-8");
    const res = await tool().execute({ action: "read", path: p });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("policy stays armed under paging", () => {
  it("still refuses secrets inside the roots", async () => {
    const p = path.join(root, "config.yaml");
    fs.writeFileSync(p, "token: x", "utf-8");
    const res = await tool().execute({ action: "read", path: p });
    expect(res.success).toBe(false);
    expect(res.error).toContain("запрещён");
  });

  it("still writes inside a root without a gate", async () => {
    const p = path.join(root, "note.txt");
    const res = await tool().execute({ action: "write", path: p, content: "привет" });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe("привет");
  });
});

describe("user files vault path", () => {
  it("derives from the config path, not from home", () => {
    expect(userFilesPath(path.join("cfg", "eva", "config.yaml"))).toBe(path.join("cfg", "eva", "files"));
  });
});

describe("prompt vault section", () => {
  const base: PromptConfig = { name: "Ева" };

  it("renders the standing section with the path when configured", () => {
    const prompt = buildSystemPrompt({ ...base, filesVaultPath: "/root/.eva/files" });
    expect(prompt).toContain("## Кладовая файлов");
    expect(prompt).toContain("/root/.eva/files");
    expect(prompt).toContain('files(action: "list"');
  });

  it("renders nothing when there is no vault", () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).not.toContain("Кладовая");
  });
});

describe("files edit", () => {
  const seed = (name: string, content: string) => {
    const p = path.join(root, name);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  };

  it("replaces one fragment and leaves the rest of a big file alone", async () => {
    const p = seed(
      "guide.md",
      Array.from({ length: 200 }, (_, i) => `строка ${i + 1} пустая`).join("\n") + "\nВихрь: 2.5/с\n",
    );
    const before = fs.readFileSync(p, "utf-8");
    const res = await tool().execute({ action: "edit", path: p, old: "Вихрь: 2.5/с", new: "Вихрь: 1.5/с" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("1");
    const after = fs.readFileSync(p, "utf-8");
    expect(after).toContain("Вихрь: 1.5/с");
    // everything that was not the fragment is byte-identical
    expect(after.replace("Вихрь: 1.5/с", "Вихрь: 2.5/с")).toBe(before);
  });

  it("refuses to guess: a missing fragment changes nothing", async () => {
    const p = seed("nofind.txt", "альфа\nбета\n");
    const res = await tool().execute({ action: "edit", path: p, old: "гамма", new: "дельта" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Не найдено");
    expect(fs.readFileSync(p, "utf-8")).toBe("альфа\nбета\n");
  });

  it("refuses an ambiguous fragment unless replace_all is set", async () => {
    const p = seed("ambig.txt", "кот и кот\n");
    const res = await tool().execute({ action: "edit", path: p, old: "кот", new: "пёс" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("2 раз");
    expect(fs.readFileSync(p, "utf-8")).toBe("кот и кот\n");

    const all = await tool().execute({ action: "edit", path: p, old: "кот", new: "пёс", replace_all: true });
    expect(all.success).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe("пёс и пёс\n");
  });

  it("deletes a fragment when new is empty", async () => {
    const p = seed("del.txt", "оставить\nубрать это\n");
    const res = await tool().execute({ action: "edit", path: p, old: "убрать это\n", new: "" });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe("оставить\n");
  });

  it("refuses to touch a binary .xlsx table", async () => {
    // A copy inside the root, so the .xlsx refusal is what answers — not the
    // out-of-roots gate that would fire first for the fixture's own path.
    const p = path.join(root, "table.xlsx");
    fs.copyFileSync(fixture("stalker-mini.xlsx"), p);
    const res = await tool().execute({ action: "edit", path: p, old: "Слизь", new: "Слизень" });
    expect(res.success).toBe(false);
    expect(res.error).toContain(".xlsx");
  });

  it("walks through the same gate as a write outside the roots", async () => {
    const p = path.join(outside, "note.txt");
    fs.writeFileSync(p, "тут был текст\n", "utf-8");
    const res = await tool().execute({ action: "edit", path: p, old: "текст", new: "мусор" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("подтверждения");
    expect(fs.readFileSync(p, "utf-8")).toBe("тут был текст\n");
  });

  it("parks for /yes with a chat and names the edit for the owner", async () => {
    const p = path.join(outside, "note2.txt");
    fs.writeFileSync(p, "старое\n", "utf-8");
    const res = await tool().execute({
      action: "edit",
      path: p,
      old: "старое",
      new: "новое",
      _userId: "test-owner-edit",
      reason: "исправить число по слову владельца",
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("Жду подтверждения");
    expect(res.output).toContain("исправить файл");
    expect(fs.readFileSync(p, "utf-8")).toBe("старое\n"); // not applied until /yes
    discard("test-owner-edit");
  });
});
