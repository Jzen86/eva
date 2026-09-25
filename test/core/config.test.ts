import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  loadConfig,
  saveConfig,
  patchConfig,
  patchConfigOrThrow,
  getPersonality,
  getLLMApiKey,
  getAgentName,
} from "../../src/core/config.js";

const TEST_DIR = path.join(os.tmpdir(), `betsy-config-test-${Date.now()}`);

describe("Config", () => {
  beforeEach(() => fs.mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns null when no config exists", () => {
    const config = loadConfig(path.join(TEST_DIR, "nonexistent.yaml"));
    expect(config).toBeNull();
  });

  it("loads old format config (nested llm)", () => {
    const configPath = path.join(TEST_DIR, "config.yaml");
    fs.writeFileSync(configPath, `
agent:
  name: Betsy
  personality:
    tone: friendly
    style: detailed
    custom_instructions: "Be helpful"
telegram:
  token: test-token
llm:
  fast:
    provider: openrouter
    model: google/gemini-2.5-flash
    api_key: sk-test-key
  strong:
    provider: openrouter
    model: anthropic/claude-sonnet-4
    api_key: sk-test-key
memory:
  max_knowledge: 200
  study_interval_min: 30
  learning_enabled: true
plugins: []
`);
    const config = loadConfig(configPath);
    expect(config).not.toBeNull();
    expect(getAgentName(config!)).toBe("Betsy");
    expect(getLLMApiKey(config!)).toBe("sk-test-key");
    expect(getPersonality(config!).tone).toBe("friendly");
    expect(getPersonality(config!).customInstructions).toBe("Be helpful");
    expect(config!.telegram?.token).toBe("test-token");
  });

  it("loads new format config (flat llm)", () => {
    const configPath = path.join(TEST_DIR, "config.yaml");
    fs.writeFileSync(configPath, `
agent:
  name: Test
llm:
  provider: openrouter
  api_key: sk-new-key
  fast_model: test/fast
  strong_model: test/strong
`);
    const config = loadConfig(configPath);
    expect(config).not.toBeNull();
    expect(getLLMApiKey(config!)).toBe("sk-new-key");
  });

  it("includes context_budget in memory schema with default 40000", () => {
    const tmpPath = path.join(os.tmpdir(), `betsy-cfg-${crypto.randomUUID()}.yaml`);
    fs.writeFileSync(tmpPath, "agent:\n  name: Test\nllm:\n  provider: openrouter\n  api_key: test\n");
    const config = loadConfig(tmpPath);
    fs.unlinkSync(tmpPath);
    expect(config?.memory?.context_budget).toBe(40000);
  });

  it("accepts fallback_models in flat llm format", () => {
    const yaml = `
agent:
  name: Test
llm:
  provider: openrouter
  api_key: test-key
  fast_model: test/fast
  fallback_models:
    - free/model-1
    - free/model-2
`;
    const tmpPath = path.join(os.tmpdir(), "betsy-test-fallback.yaml");
    fs.writeFileSync(tmpPath, yaml);
    const config = loadConfig(tmpPath);
    expect(config).not.toBeNull();
    const llm = config!.llm as any;
    expect(llm.fallback_models).toEqual(["free/model-1", "free/model-2"]);
    fs.unlinkSync(tmpPath);
  });

  it("preserves fallback_models through normalizeConfig (flat format)", () => {
    const yaml = `
name: Test
provider: openrouter
api_key: test-key
model: test/fast
fallback_models:
  - free/model-1
`;
    const tmpPath = path.join(os.tmpdir(), "betsy-test-fallback-flat.yaml");
    fs.writeFileSync(tmpPath, yaml);
    const config = loadConfig(tmpPath);
    expect(config).not.toBeNull();
    const llm = config!.llm as any;
    expect(llm.fallback_models).toEqual(["free/model-1"]);
    fs.unlinkSync(tmpPath);
  });
});

/**
 * Writing the config used to be one unguarded writeFileSync. These cover what
 * replaced it: nothing half-written, a bounded set of backups, and a rejected
 * value that leaves the working config alone.
 */
describe("saveConfig", () => {
  const DIR = path.join(os.tmpdir(), `eva-save-test-${process.pid}-${Date.now()}`);

  beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

  const target = (): string => path.join(DIR, "config.yaml");

  const base = () => ({
    agent: { name: "Eva", personality: { tone: "friendly" } },
    telegram: { token: "t" },
  }) as any;

  it("round-trips a config through the schema", () => {
    const p = target();
    saveConfig(base(), p);
    const back = loadConfig(p);
    expect(getAgentName(back!)).toBe("Eva");
    expect(getPersonality(back!).tone).toBe("friendly");
  });

  it("refuses to write a config that would not load back, leaving the old one intact", () => {
    const p = target();
    saveConfig(base(), p);
    const before = fs.readFileSync(p, "utf-8");

    const broken = base();
    broken.agent.personality.humor = 99; // above the 0-4 ceiling
    expect(() => saveConfig(broken, p)).toThrow(/not saved|would not load/i);
    expect(fs.readFileSync(p, "utf-8")).toBe(before);
  });

  it("leaves no temp files behind, on success or on refusal", () => {
    const p = target();
    saveConfig(base(), p);
    const broken = base();
    broken.agent.personality.humor = 99;
    expect(() => saveConfig(broken, p)).toThrow();

    const strays = fs.readdirSync(DIR).filter((f) => f.includes(".tmp"));
    expect(strays).toEqual([]);
  });

  it("keeps a bounded, rotating set of backups instead of one file per save", () => {
    const p = target();
    for (let i = 0; i < 12; i++) {
      const cfg = base();
      cfg.agent.name = `Eva${i}`;
      saveConfig(cfg, p);
    }
    const files = fs.readdirSync(DIR);
    const backups = files.filter((f) => f.includes(".bak."));
    // Bounded by design: the live install had 19 timestamped copies, the
    // oldest of which was the least useful.
    expect(backups.length).toBeLessThanOrEqual(5);
    expect(backups.length).toBeGreaterThan(0);
    // The newest backup holds the second-newest state, the oldest the oldest
    // one still kept.
    expect(fs.readFileSync(`${p}.bak.1`, "utf-8")).toContain("Eva10");
  });

  it("survives a round-trip of a real-shaped config with all blocks", () => {
    const p = target();
    const full = {
      agent: {
        name: "Eva",
        gender: "female",
        personality: {
          tone: "warm",
          style: "short",
          custom_instructions: "be a person",
          humor: 3,
          empathy: 4,
        },
      },
      owner: { name: "Jzen86", address_as: "Женя", facts: ["любит котиков"] },
      security: { password_hash: "x", tools: { shell: true, ssh: false } },
      providers: {
        main: { base_url: "https://api.example.com/v1", api_key: "k", provider: "openai" },
      },
      models: { fast: { provider: "main", model: "m1" } },
      fallbacks: [{ provider: "main", model: "m2" }],
      telegram: { token: "tok", owner_id: 42, streaming: true },
      memory: { max_knowledge: 200, study_interval_min: 60, learning_enabled: true },
      plugins: [],
    } as any;
    expect(() => saveConfig(full, p)).not.toThrow();
    const back = loadConfig(p)!;
    expect(back.telegram?.owner_id).toBe(42);
    expect(back.providers?.main?.api_key).toBe("k");
    expect(back.owner?.facts).toEqual(["любит котиков"]);
    expect(back.models?.fast?.model).toBe("m1");
  });
});

/**
 * Everything that feeds the config is a string at the edges: env vars, YAML
 * written by hand, a self_config call from chat. Zod does not coerce, so a
 * quoted number used to fail validation and then get dropped by the repair
 * path — a bot with no owner id, announced only by a log line nobody reads.
 */
describe("numeric strings in the config", () => {
  const DIR = path.join(os.tmpdir(), `eva-coerce-test-${process.pid}-${Date.now()}`);

  beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

  const write = (yaml: string): string => {
    const p = path.join(DIR, "config.yaml");
    fs.writeFileSync(p, yaml);
    return p;
  };

  it("keeps a quoted owner_id instead of dropping it", () => {
    const config = loadConfig(
      write('agent:\n  name: Eva\ntelegram:\n  token: t\n  owner_id: "424242"\n'),
    );
    expect(config?.telegram?.owner_id).toBe(424242);
  });

  it("coerces quoted memory limits", () => {
    const config = loadConfig(
      write('agent:\n  name: Eva\nmemory:\n  max_knowledge: "500"\n  study_interval_min: "15"\n'),
    );
    expect(config?.memory?.max_knowledge).toBe(500);
    expect(config?.memory?.study_interval_min).toBe(15);
  });

  it("coerces quoted sliders", () => {
    const config = loadConfig(
      write('agent:\n  name: Eva\n  personality:\n    humor: "3"\n'),
    );
    expect((config?.agent?.personality as any).humor).toBe(3);
  });

  it("leaves free-text personality fields as strings, numeric-looking or not", () => {
    // The bug this guards: coercing every key under personality turned a tone
    // of "3" into the number 3, and the schema then rejected the config.
    const config = loadConfig(
      write('agent:\n  name: Eva\n  personality:\n    tone: "3"\n    style: "42"\n'),
    );
    const p = config?.agent?.personality as any;
    expect(p.tone).toBe("3");
    expect(p.style).toBe("42");
  });

  it("still refuses a value that is not a number at all", () => {
    // A typo should be reported, not guessed at.
    const config = loadConfig(
      write('agent:\n  name: Eva\ntelegram:\n  token: t\n  owner_id: "12abc"\n'),
    );
    // Dropped by the repair path, but the config still loads.
    expect(config).not.toBeNull();
    expect(config?.telegram?.owner_id).toBeUndefined();
  });
});

describe("patchConfig", () => {
  const DIR = path.join(os.tmpdir(), `eva-patch-test-${process.pid}-${Date.now()}`);

  beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

  it("writes the mutation through to disk", () => {
    const p = path.join(DIR, "config.yaml");
    fs.writeFileSync(p, "agent:\n  name: Eva\ntelegram:\n  token: t\n");
    const ok = patchConfig((cfg) => {
      cfg.agent = { ...(cfg.agent as any), name: "Renamed" };
    }, p);
    expect(ok).toBe(true);
    expect(getAgentName(loadConfig(p)!)).toBe("Renamed");
  });

  it("patchConfig reports failure as false instead of throwing", () => {
    const p = path.join(DIR, "config.yaml");
    fs.writeFileSync(p, "agent:\n  name: Eva\ntelegram:\n  token: t\n");
    const ok = patchConfig((cfg) => {
      cfg.agent = { name: 123 } as any; // not a string
    }, p);
    expect(ok).toBe(false);
  });

  it("patchConfigOrThrow throws so a caller that can talk to a human can explain", () => {
    const p = path.join(DIR, "config.yaml");
    fs.writeFileSync(p, "agent:\n  name: Eva\ntelegram:\n  token: t\n");
    expect(() =>
      patchConfigOrThrow((cfg) => {
        cfg.agent = { name: 123 } as any;
      }, p),
    ).toThrow();
  });

  it("keeps the previous contents when a patch is refused", () => {
    const p = path.join(DIR, "config.yaml");
    fs.writeFileSync(p, "agent:\n  name: Eva\ntelegram:\n  token: t\n");
    patchConfig((cfg) => {
      cfg.agent = { name: 123 } as any;
    }, p);
    expect(getAgentName(loadConfig(p)!)).toBe("Eva");
  });
});
