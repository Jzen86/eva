import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { buildTools, describeToolset, type ToolsetResult } from "../../src/core/toolsets.js";
import { ProviderRegistry, type RegistryConfig } from "../../src/core/llm/registry.js";
import { SchedulerService } from "../../src/core/tools/scheduler.js";
import { SchedulerStore } from "../../src/core/tools/scheduler-store.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import type { EvaConfig } from "../../src/core/config.js";
import type Database from "better-sqlite3";

/**
 * The promise this file enforces: a bare install is a working bot.
 *
 * Telegram token and one provider key, nothing else. Every assertion below is a
 * way that promise used to be breakable without anybody noticing — the tool was
 * advertised to the model, the model reached for it, and the failure looked like
 * a broken bot rather than a missing service.
 */

const MINIMAL: EvaConfig = {
  agent: { name: "Ева" },
  telegram: { token: "123456:AAA" },
  owner: {},
  providers: { openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "sk-x" } },
  models: { fast: { provider: "openrouter", model: "google/gemini-2.5-flash" } },
  fallbacks: [],
  plugins: [],
} as unknown as EvaConfig;

function registryFor(cfg: EvaConfig): ProviderRegistry {
  const rc: RegistryConfig = {
    providers: Object.fromEntries(
      Object.entries(cfg.providers ?? {}).map(([id, p]) => [
        id,
        { base_url: p.base_url, api_key: p.api_key },
      ]),
    ),
    models: (cfg.models ?? {}) as RegistryConfig["models"],
    fallbacks: (cfg.fallbacks ?? []) as RegistryConfig["fallbacks"],
  };
  return new ProviderRegistry(rc);
}

describe("buildTools", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let scheduler: SchedulerService;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `eva-toolsets-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    dbPath = path.join(dir, "eva.db");
    db = getDB(dbPath);
    const store = new SchedulerStore(db);
    store.init();
    scheduler = new SchedulerService(store);
  });

  afterEach(() => {
    closeDB();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(config: EvaConfig, withRouter = true): ToolsetResult {
    const registry = registryFor(config);
    return buildTools({
      config,
      registry,
      router: withRouter ? ({ hasRole: () => true } as never) : null,
      scheduler,
      passwordHash: "hash",
      embedding: null,
    });
  }

  function reason(result: ToolsetResult, name: string): string | undefined {
    return result.decisions.find((d) => d.name === name)?.reason;
  }

  // --- the bare install ---------------------------------------------------

  it("registers a working core on a telegram token and one provider key alone", () => {
    const result = build(MINIMAL);
    for (const name of [
      "shell", "send_file", "files", "self_config", "scheduler",
      "http", "memory", "doctor", "switch_model",
    ]) {
      expect(result.registered, `${name} должен быть в голом установке`).toContain(name);
    }
  });

  it("does not advertise a service that is not configured", () => {
    const result = build(MINIMAL);
    // The whole point. Each of these used to be registered unconditionally and
    // failed at call time. `web` is not in the list any more: search has a
    // keyless backend, so needing a Google credential to have a search tool is
    // the bug, not the guarantee.
    for (const name of ["skill_search", "skill_install", "selfie", "voice", "browser", "ssh", "npm_install"]) {
      expect(result.registered, `${name} не должен регистрироваться без своего сервиса`).not.toContain(name);
      expect(reason(result, name), `${name} должен объяснить, почему выключен`).toBeTruthy();
    }
  });

  it("explains every absence, so nothing is missing silently", () => {
    const result = build(MINIMAL);
    for (const d of result.disabled) {
      expect(d.reason.length).toBeGreaterThan(3);
    }
  });

  it("puts the whole picture on one startup line", () => {
    const line = describeToolset(build(MINIMAL));
    expect(line).toMatch(/Инструментов: \d+/);
    expect(line).toContain("отключено");
    // `voice` is here because it used to be reported missing on a machine whose
    // TTS worked, over a gate that had nothing to do with TTS. `web` is here
    // because it used to be reported missing on every plain install, over a
    // credential nobody had. A list that cries wolf is a list nobody reads.
    expect(line).toContain("voice");
  });

  // --- keyed tools: a key turns them on ----------------------------------

  it("turns web search on with a google key and a cx", () => {
    const cfg = { ...MINIMAL, google: { api_key: "k", cx: "cx" } } as unknown as EvaConfig;
    expect(build(cfg).registered).toContain("web");
  });

  it("gives a plain install a working search, with no credentials at all", () => {
    // The bug this closes. `web` needed a Google key AND a `cx` from a search
    // engine a person builds by hand, so a normal install had no search at all
    // and the startup line said so every time. What she did instead was try
    // `browser`, then `http`, then `shell` with curl — three tools to fake a
    // search, which reads as a model that has forgotten how to use the internet.
    const result = build(MINIMAL);
    expect(result.registered).toContain("web");
    expect(result.disabled.map((d) => d.name)).not.toContain("web");
  });

  it("keeps web on with only half a Google credential, and simply does not use it", () => {
    // Half a key is half a key: the tool stays registered on the keyless
    // engine, and the unused Google path is not reported as a broken tool.
    const cfg = { ...MINIMAL, google: { api_key: "k" } } as unknown as EvaConfig;
    expect(build(cfg).registered).toContain("web");
  });

  it("turns skills on with a skillsmp key", () => {
    const cfg = { ...MINIMAL, skillsmp: { api_key: "k" } } as unknown as EvaConfig;
    expect(build(cfg).registered).toEqual(expect.arrayContaining(["skill_search", "skill_install"]));
  });

  it("turns image generation on from the provider key already in use", () => {
    // No separate image service, no fal: the LLM provider that speaks the chat
    // API is enough. This is the "no mandatory vendor" requirement, in a test.
    expect(build(MINIMAL).registered).toContain("image_gen");
  });

  it("turns selfies on from a reference photo plus an image provider", () => {
    const cfg = { ...MINIMAL, selfies: { reference_photo_url: "https://x/ref.jpg" } } as unknown as EvaConfig;
    expect(build(cfg).registered).toContain("selfie");
  });

  it("turns voice on when the configured TTS backend can answer", () => {
    // A fal key used to be the whole test. It is not: the synthesizer reaches
    // fal only through minimax, so a fal key with the default
    // tts_provider=openai registered a tool that could only ever fail.
    const cfg = {
      ...MINIMAL,
      selfies: { fal_api_key: "fal-key" },
      voice: { tts_provider: "minimax" },
    } as unknown as EvaConfig;
    const result = build(cfg);
    expect(result.registered).toContain("voice");
    expect(result.registered).toContain("selfie");
  });

  it("turns voice on through Gemini with no fal account anywhere", () => {
    // The feature that worked and was reported as missing, because the gate
    // asked about fal and nothing else.
    const cfg = {
      ...MINIMAL,
      voice: { tts_provider: "gemini", gemini_api_key: "goog-key" },
    } as unknown as EvaConfig;
    expect(build(cfg).registered).toContain("voice");
  });

  it("says which key is missing instead of just that voice is off", () => {
    // "voice is off" is useless to whoever has to fix it.
    const cfg = {
      ...MINIMAL,
      voice: { tts_provider: "gemini" },
    } as unknown as EvaConfig;
    expect(reason(build(cfg), "voice")).toContain("gemini_api_key");
  });

  it("does not register voice on a fal key alone", () => {
    // A registered tool that always fails is worse than an absent one: the model
    // calls it, it errors, and the feature looks broken rather than unconfigured.
    const cfg = { ...MINIMAL, selfies: { fal_api_key: "fal-key" } } as unknown as EvaConfig;
    expect(build(cfg).registered).not.toContain("voice");
  });

  // --- opt-in tools: a deliberate decision --------------------------------

  it("keeps the browser off until it is asked for by name", () => {
    const cfg = { ...MINIMAL, tools: { browser: true } } as unknown as EvaConfig;
    const result = build(cfg);
    expect(result.registered).toContain("browser");
    expect(reason(build(MINIMAL), "browser")).toContain("tools.browser");
  });

  it("does not treat a non-boolean as consent", () => {
    const cfg = { ...MINIMAL, tools: { browser: "true", ssh: 1 } } as unknown as EvaConfig;
    const result = build(cfg);
    expect(result.registered).not.toContain("browser");
    expect(result.registered).not.toContain("ssh");
  });

  it("turns ssh and npm_install on only when named", () => {
    const cfg = { ...MINIMAL, tools: { ssh: true, npm_install: true } } as unknown as EvaConfig;
    expect(build(cfg).registered).toEqual(expect.arrayContaining(["ssh", "npm_install"]));
  });

  it("gives the channel layer back the instances it has to reach later", () => {
    // The reference-photo command runs after the toolset is built and has to
    // reach the selfie tool; without this it would be silently dead.
    const cfg = { ...MINIMAL, selfies: { fal_api_key: "k" } } as unknown as EvaConfig;
    const result = build(cfg);
    expect(result.instances.selfie).toBeDefined();
    expect(result.instances.selfie).toBe(result.tools.get("selfie"));
  });

  it("has no instance to hand over when the tool is not there", () => {
    expect(build(MINIMAL).instances.selfie).toBeUndefined();
  });

  // --- degraded states ----------------------------------------------------

  it("still offers a diagnosis when there is no model at all", () => {
    const result = build(MINIMAL, false);
    expect(result.registered).toContain("doctor");
    // Switching models genuinely has nothing to work with, so it is the one
    // tool that stays out.
    expect(result.registered).not.toContain("switch_model");
    expect(reason(result, "switch_model")).toContain("модел");
  });

  it("survives a config missing every optional block", () => {
    const bare = { telegram: { token: "t" } } as unknown as EvaConfig;
    const result = build(bare);
    expect(result.registered).toContain("doctor");
    expect(result.registered).toContain("memory");
    expect(result.disabled.length).toBeGreaterThan(0);
  });

  it("has every core tool in a stable order so the prompt does not shuffle", () => {
    const first = build(MINIMAL).registered;
    const second = build(MINIMAL).registered;
    expect(first).toEqual(second);
  });
});
