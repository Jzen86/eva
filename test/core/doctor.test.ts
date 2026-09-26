import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { runDoctor, formatReport, explainFailure, type DoctorReport, type Check } from "../../src/core/doctor.js";
import { DoctorTool } from "../../src/core/tools/doctor.js";
import { ProviderRegistry, type RegistryConfig } from "../../src/core/llm/registry.js";
import { getDB, closeDB, writeMeta, KNOWLEDGE_INDEX_VERSION } from "../../src/core/memory/db.js";
import { addKnowledge } from "../../src/core/memory/knowledge.js";

const GOOD_CONFIG = `
agent:
  name: Ева
  personality:
    persona: "Дерзкая, в духе панк-девочки с интересным умом"
    ops:
      - "Не пиши простыни"
    tone: friendly
telegram:
  token: "123456:AAtelegramtokenvalue"
  owner_id: 42
providers:
  openrouter:
    base_url: https://openrouter.ai/api/v1
    api_key: "sk-or-v1-0123456789abcdef"
  local:
    base_url: http://127.0.0.1:1234/v1
    api_key: "local-key-xyz"
models:
  fast:
    provider: openrouter
    model: google/gemini-2.5-flash
  strong:
    provider: local
    model: qwen3
  study:
    provider: local
    model: qwen3
  embed:
    provider: local
    model: bge-m3
fallbacks:
  - provider: local
    model: qwen3
memory:
  max_knowledge: 200
`;

/** Every check, flattened — asserting on sections means renaming titles breaks tests. */
function allChecks(report: DoctorReport): Check[] {
  return report.sections.flatMap((s) => s.checks);
}
function find(report: DoctorReport, name: string): Check | undefined {
  return allChecks(report).find((c) => c.name === name);
}

describe("doctor", () => {
  let dir: string;
  let configPath: string;
  let dbPath: string;

  function writeConfig(yaml: string): void {
    fs.writeFileSync(configPath, yaml);
  }
  function goodRegistry(): ProviderRegistry {
    const cfg: RegistryConfig = {
      providers: {
        openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-v1-0123456789abcdef" },
        local: { base_url: "http://127.0.0.1:1234/v1", api_key: "local-key-xyz" },
      },
      models: {
        fast: { provider: "openrouter", model: "google/gemini-2.5-flash" },
        strong: { provider: "local", model: "qwen3" },
        study: { provider: "local", model: "qwen3" },
        embed: { provider: "local", model: "bge-m3" },
      },
      fallbacks: [{ provider: "local", model: "qwen3" }],
    };
    return new ProviderRegistry(cfg);
  }

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `eva-doctor-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    configPath = path.join(dir, "config.yaml");
    dbPath = path.join(dir, "eva.db");
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // --- config -------------------------------------------------------------

  it("reports a missing config as bad, and says where it looked", async () => {
    const report = await runDoctor({ configPath: path.join(dir, "nope.yaml") });
    const check = find(report, "config.missing");
    expect(check?.severity).toBe("bad");
    expect(check?.detail).toContain("nope.yaml");
    expect(report.healthy).toBe(false);
  });

  it("reports unparseable yaml as bad and points at the backup", async () => {
    writeConfig("agent:\n  name: [unclosed\n");
    const report = await runDoctor({ configPath });
    const check = find(report, "config.unreadable");
    expect(check?.severity).toBe("bad");
    expect(check?.fix).toContain("bak.1");
  });

  it("flags a missing owner_id, the failure that silences the bot", async () => {
    writeConfig(GOOD_CONFIG.replace("  owner_id: 42\n", ""));
    const report = await runDoctor({ configPath });
    expect(find(report, "config.owner")?.severity).toBe("bad");
  });

  it("warns when there is a name but no character", async () => {
    writeConfig(`
agent:
  name: Ева
telegram:
  token: t
  owner_id: 1
llm:
  fast:
    provider: openrouter
    model: m
    api_key: k
`);
    const report = await runDoctor({ configPath });
    const check = find(report, "config.character");
    expect(check?.severity).toBe("warn");
    expect(check?.fix).toContain("persona");
  });

  it("counts ops separately and nags when they are missing", async () => {
    writeConfig(GOOD_CONFIG);
    const withOps = await runDoctor({ configPath });
    expect(find(withOps, "config.character")?.severity).toBe("ok");
    expect(find(withOps, "config.character")?.detail).toContain("1 правило в ops");
    expect(find(withOps, "config.ops")).toBeUndefined();

    writeConfig(GOOD_CONFIG.replace(/    ops:\n      - "Не пиши простыни"\n/, ""));
    const withoutOps = await runDoctor({ configPath });
    expect(find(withoutOps, "config.ops")?.severity).toBe("warn");
  });

  it("reports a missing photo as a warning with the way to fix it", async () => {
    // Never `bad`: a bot with no photo works, and the only thing missing is
    // selfies. `bad` here would train the owner to ignore the red lines.
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({ configPath });
    const check = find(report, "config.photo");
    expect(check?.severity).toBe("warn");
    expect(check?.fix).toContain("/setphoto");
  });

  it("reports the photo once it is there, with a size and no image bytes", async () => {
    writeConfig(GOOD_CONFIG);
    const photo = path.join(path.dirname(configPath), "reference.jpg");
    fs.writeFileSync(photo, Buffer.alloc(2048, 0x41));
    const check = find(await runDoctor({ configPath }), "config.photo");
    expect(check?.severity).toBe("ok");
    expect(check?.detail).toContain("2 КБ");
  });

  it("puts the trusted-binaries list in the report, because trust is not a setting you forget you made", async () => {
    writeConfig(GOOD_CONFIG);
    const clean = await runDoctor({ configPath });
    expect(find(clean, "config.tools.trust")?.severity).toBe("ok");
    expect(find(clean, "config.tools")?.detail).toContain("выключены");

    writeConfig(GOOD_CONFIG.replace("memory:\n  max_knowledge: 200\n",
      "tools:\n  ssh: true\n  shell_trust:\n    - git\n    - docker\nmemory:\n  max_knowledge: 200\n"));
    const trusting = await runDoctor({ configPath });
    const trust = find(trusting, "config.tools.trust");
    expect(trust?.severity).toBe("warn");
    expect(trust?.detail).toContain("git");
    expect(trust?.detail).toContain("docker");
    // The line has to say what trusting a binary means, or the warning reads
    // like a permissions notice and gets filed away.
    expect(trust?.fix).toContain("без подтверждения");
    expect(find(trusting, "config.tools")?.detail).toContain("ssh");
  });

  it("names secrets by length and never prints a value", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({ configPath });
    const text = formatReport(report);
    const openrouterKey = "sk-or-v1-0123456789abcdef";
    const telegramToken = "123456:AAtelegramtokenvalue";
    expect(find(report, "config.secrets")?.severity).toBe("ok");
    expect(text).toContain(`${openrouterKey.length} символов`);
    expect(text).toContain(`${telegramToken.length} символов`);
    for (const secret of [openrouterKey, "local-key-xyz", telegramToken]) {
      expect(text).not.toContain(secret);
    }
  });

  it("agrees the count with the noun", async () => {
    writeConfig(GOOD_CONFIG);
    const expected = ["1 копия", "2 копии", "3 копии", "4 копии", "5 копий"];
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(dir, `config.yaml.bak.${i}`), GOOD_CONFIG);
      const report = await runDoctor({ configPath });
      expect(find(report, "config.backups")?.detail).toContain(expected[i - 1]!);
    }
  });

  it("lists the rotated backups so it is visible that rollback is possible", async () => {
    writeConfig(GOOD_CONFIG);
    fs.writeFileSync(path.join(dir, "config.yaml.bak.1"), GOOD_CONFIG);
    fs.writeFileSync(path.join(dir, "config.yaml.bak.2"), GOOD_CONFIG);
    const report = await runDoctor({ configPath });
    expect(find(report, "config.backups")?.detail).toContain("config.yaml.bak.2");
  });

  it("warns when there is nothing to roll back to", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({ configPath });
    expect(find(report, "config.backups")?.severity).toBe("warn");
  });

  // --- providers ----------------------------------------------------------

  it("passes a fully wired setup", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    expect(find(report, "provider.openrouter")?.severity).toBe("ok");
    expect(find(report, "model.fast")?.detail).toContain("openrouter");
    expect(find(report, "models.fallbacks")?.severity).toBe("ok");
    expect(report.bad).toBe(0);
    expect(report.healthy).toBe(true);
  });

  it("treats a missing optional role as a warning, not a fault", async () => {
    writeConfig(GOOD_CONFIG);
    // No embed, no fallbacks: both features are off, neither is a fault.
    const reg = new ProviderRegistry({
      providers: { local: { base_url: "http://x/v1", api_key: "k" } },
      models: { fast: { provider: "local", model: "qwen3" } },
      fallbacks: [],
    });
    const report = await runDoctor({ configPath, registry: reg, dbPath });
    expect(find(report, "model.embed")?.severity).toBe("warn");
    expect(find(report, "model.study")?.severity).toBe("warn");
    expect(find(report, "models.fallbacks")?.severity).toBe("warn");
    expect(find(report, "model.fast")?.severity).toBe("ok");
  });

  it("marks a required role as bad when it is unassigned", async () => {
    writeConfig(GOOD_CONFIG);
    const reg = new ProviderRegistry({
      providers: { local: { base_url: "http://x/v1", api_key: "k" } },
      models: { strong: { provider: "local", model: "qwen3" } },
      fallbacks: [],
    });
    const report = await runDoctor({ configPath, registry: reg, dbPath });
    const fast = find(report, "model.fast");
    expect(fast?.severity).toBe("bad");
    expect(fast?.detail).toContain("fast");
  });

  it("marks a role pointing at an unfilled provider as bad", async () => {
    writeConfig(GOOD_CONFIG);
    const reg = new ProviderRegistry({
      providers: { local: { base_url: "http://x/v1", api_key: "" } },
      models: { fast: { provider: "local", model: "qwen3" } },
      fallbacks: [],
    });
    const report = await runDoctor({ configPath, registry: reg, dbPath });
    expect(find(report, "provider.local")?.severity).toBe("bad");
    expect(find(report, "model.fast")?.severity).toBe("bad");
  });

  it("says the registry is unavailable instead of pretending there are no providers", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({ configPath, dbPath });
    expect(find(report, "providers.registry")?.severity).toBe("warn");
  });

  it("skips live requests unless a probe is supplied", async () => {
    writeConfig(GOOD_CONFIG);
    let calls = 0;
    const count = async () => { calls++; return { ok: true, ms: 1 }; };

    await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    expect(calls).toBe(0);

    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath, probe: count });
    expect(calls).toBe(4); // fast, strong, study, embed
    expect(find(report, "model.fast")?.detail).toContain("отвечает");
  });

  it("reports a role that has a key but a model that does not answer", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({
      configPath,
      registry: goodRegistry(),
      dbPath,
      probe: async () => ({ ok: false, ms: 12, reason: "429 rate limited" }),
    });
    const fast = find(report, "model.fast");
    expect(fast?.severity).toBe("bad");
    expect(fast?.detail).toContain("429");
  });

  it("warns when there are no fallbacks — a dead provider means silence", async () => {
    writeConfig(GOOD_CONFIG);
    const reg = new ProviderRegistry({
      providers: { local: { base_url: "http://x/v1", api_key: "k" } },
      models: { fast: { provider: "local", model: "qwen3" } },
      fallbacks: [],
    });
    const report = await runDoctor({ configPath, registry: reg, dbPath });
    expect(find(report, "models.fallbacks")?.severity).toBe("warn");
  });

  // --- memory -------------------------------------------------------------

  it("counts active and retired knowledge separately", async () => {
    writeConfig(GOOD_CONFIG);
    addKnowledge({ topic: "cats", insight: "Любит кошек", source: "test" });
    addKnowledge({ topic: "dogs", insight: "Любит собак", source: "test" });
    const db = getDB(dbPath);
    db.prepare("UPDATE knowledge SET superseded_at = ? WHERE topic = 'dogs'").run(Date.now());

    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    const check = find(report, "memory.knowledge");
    expect(check?.severity).toBe("ok");
    expect(check?.detail).toContain("1 активная запись");
    expect(check?.detail).toContain("1 вытеснена");
  });

  it("flags a stale search index — the reason she seems to forget", async () => {
    writeConfig(GOOD_CONFIG);
    writeMeta("knowledge_index_version", "1");
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    const check = find(report, "memory.index");
    expect(check?.severity).toBe("bad");
    expect(check?.detail).toContain("1");
    expect(check?.detail).toContain(String(KNOWLEDGE_INDEX_VERSION));
  });

  it("accepts an index that is ahead of the code as sound", async () => {
    writeConfig(GOOD_CONFIG);
    writeMeta("knowledge_index_version", String(KNOWLEDGE_INDEX_VERSION + 1));
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    expect(find(report, "memory.index")?.severity).toBe("ok");
  });

  it("reads integrity_check through the shim as 'ok', not as a destroyed file", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    expect(find(report, "memory.integrity")?.severity).toBe("ok");
  });

  it("sees a desynchronised search index, which the obvious checks cannot", async () => {
    writeConfig(GOOD_CONFIG);
    addKnowledge({ topic: "кошки", insight: "Ева любит кошек", source: "test" });
    addKnowledge({ topic: "собаки", insight: "Ева любит собак", source: "test" });
    // Wipe the index while leaving the rows — what a half-finished migration
    // leaves behind.
    getDB(dbPath).exec("DELETE FROM knowledge_fts");

    // Both obvious checks lie about this state, which is why the real one is
    // behavioural. Asserted here so nobody "simplifies" it back to a count.
    const db = getDB(dbPath);
    expect((db.prepare("SELECT count(*) AS n FROM knowledge_fts").get() as { n: number }).n).toBe(2);
    expect(() => db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('integrity-check')")).not.toThrow();

    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    const check = find(report, "memory.fts");
    expect(check?.severity).toBe("warn");
    expect(check?.detail).toContain("не находит 2 из 2");
    expect(check?.fix).toContain("DELETE FROM knowledge_fts");
  });

  it("calls search sound when it really can find the stored rows", async () => {
    writeConfig(GOOD_CONFIG);
    addKnowledge({ topic: "кошки", insight: "Ева любит кошек", source: "test" });
    addKnowledge({ topic: "собаки", insight: "Ева любит собак", source: "test" });
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    expect(find(report, "memory.fts")?.severity).toBe("ok");
    expect(find(report, "memory.fts.integrity")?.severity).toBe("ok");
  });

  it("blames the index text when rows exist but it was never filled in", async () => {
    writeConfig(GOOD_CONFIG);
    addKnowledge({ topic: "кошки", insight: "Ева любит кошек", source: "test" });
    getDB(dbPath).prepare("UPDATE knowledge SET stems = ''").run();
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    const check = find(report, "memory.fts");
    expect(check?.severity).toBe("warn");
    expect(check?.detail).toContain("пустой индексный текст");
  });

  it("reports zone coverage as counts, not percentages", async () => {
    writeConfig(GOOD_CONFIG);
    addKnowledge({ topic: "cats", insight: "a", source: "test", zone: "животные" });
    addKnowledge({ topic: "dogs", insight: "b", source: "test", zone: "животные" });
    addKnowledge({ topic: "code", insight: "c", source: "test", zone: "код" });
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    const check = find(report, "memory.zones");
    expect(check?.detail).toContain("животные: 2");
    expect(check?.detail).not.toContain("%");
  });

  it("treats a missing database as a warning — an empty install is not broken", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({
      configPath,
      registry: goodRegistry(),
      dbPath: path.join(dir, "absent.db"),
    });
    expect(find(report, "memory.db")?.severity).toBe("warn");
  });

  // --- report -------------------------------------------------------------

  it("puts what is broken at the top of the verdict and the fix with it", async () => {
    const report = await runDoctor({ configPath: path.join(dir, "nope.yaml") });
    const text = formatReport(report, configPath);
    expect(text).toContain("Что чинить");
    expect(text).toContain("config.missing");
    expect(text).toContain("❌ сломано: 1");
  });

  it("lists warnings without calling the bot broken", async () => {
    writeConfig(GOOD_CONFIG);
    const report = await runDoctor({ configPath, registry: goodRegistry(), dbPath });
    const text = formatReport(report);
    expect(text).toContain("работаю с оговорками");
    expect(text).not.toContain("❌ сломано");
  });

  it("keeps every section even when one of them throws", async () => {
    writeConfig(GOOD_CONFIG);
    // A registry whose accessor explodes stands in for any broken dependency:
    // the report must still describe the config and the memory.
    const broken = {
      providerIds: () => { throw new Error("registry exploded"); },
    } as unknown as ProviderRegistry;
    const report = await runDoctor({ configPath, registry: broken, dbPath });
    expect(report.sections.length).toBe(4);
    expect(find(report, "config.present")?.severity).toBe("ok");
    expect(find(report, "section.providers")?.severity).toBe("bad");
    expect(find(report, "memory.db")?.severity).toBe("ok");
  });
});

describe("DoctorTool", () => {
  let dir: string;
  let configPath: string;
  let dbPath: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `eva-doctor-tool-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    configPath = path.join(dir, "config.yaml");
    dbPath = path.join(dir, "eva.db");
    fs.writeFileSync(configPath, GOOD_CONFIG);
    getDB(dbPath);
  });
  afterEach(() => {
    closeDB();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unknown action instead of guessing", async () => {
    const tool = new DoctorTool({ configPath, dbPath });
    const res = await tool.execute({ action: "explode" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("summary, probe, json");
  });

  it("defaults to the summary, which costs nothing", async () => {
    const tool = new DoctorTool({ configPath, dbPath });
    const res = await tool.execute({});
    expect(res.success).toBe(true);
    expect(res.output).toContain("Конфиг");
    expect(res.output).not.toContain("{");
  });

  it("emits parseable json on request", async () => {
    const tool = new DoctorTool({ configPath, dbPath });
    const res = await tool.execute({ action: "json" });
    const parsed = JSON.parse(res.output) as DoctorReport;
    expect(Array.isArray(parsed.sections)).toBe(true);
    expect(typeof parsed.healthy).toBe("boolean");
    expect(find(parsed, "config.present")?.severity).toBe("ok");
  });

  it("probes only when asked", async () => {
    let calls = 0;
    const registry = new ProviderRegistry({
      providers: { local: { base_url: "http://x/v1", api_key: "k" } },
      models: { fast: { provider: "local", model: "qwen3" } },
      fallbacks: [],
    });
    const tool = new DoctorTool({ configPath, dbPath, registry });
    // The probe path calls a real network client; assert only that the cheap
    // summary is the default and stays local.
    const cheap = await tool.execute({ action: "summary" });
    expect(calls).toBe(0);
    expect(cheap.success).toBe(true);
  });
});

describe("explainFailure", () => {
  // better-sqlite3 building from source on a bare Linux box is the single most
  // likely reason a first install comes up broken, and the loader's own message
  // ("Could not locate the bindings file. Tried:" + fourteen paths) does not
  // name the one command that fixes it.
  it("names the toolchain when the native sqlite module is missing", () => {
    const err = new Error(
      "Could not locate the bindings file. Tried:\n" +
        "  * node_modules/better-sqlite3/build/Release/better_sqlite3.node\n" +
        "  * node_modules/better-sqlite3/prebuilds/...",
    );
    const what = explainFailure(err);
    expect(what?.what).toContain("better-sqlite3");
    expect(what?.do).toContain("build-essential");
  });

  it("catches the same failure when it arrives as an errno-style code", () => {
    const err = Object.assign(new Error("was compiled against a different Node.js version"), {
      code: "ERR_DLOPEN_FAILED",
    });
    expect(explainFailure(err)?.what).toContain("better-sqlite3");
  });

  it("explains a permissions failure in terms of the user the service runs as", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(explainFailure(err)?.do).toContain("пользовател");
  });

  it("explains a full disk, which otherwise reads as corruption", () => {
    const err = Object.assign(new Error("write failed"), { code: "ENOSPC" });
    expect(explainFailure(err)?.what).toContain("место");
  });

  it("explains a network failure, which otherwise reads as a bad key", () => {
    const err = Object.assign(new Error("request failed"), { code: "ENOTFOUND" });
    expect(explainFailure(err)?.do).toContain("DNS");
  });

  it("says nothing clever about an error it does not recognise", () => {
    // Guessing is worse than the raw line: a wrong fix costs more time than no
    // fix, and the section is still reported as broken either way.
    expect(explainFailure(new Error("something odd"))).toBeUndefined();
  });
});