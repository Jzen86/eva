import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selfConfigTool } from "../../src/core/tools/self-config";
import { loadConfig, patchConfig } from "../../src/core/config";
import type { ToolResult } from "../../src/core/tools/types";

/**
 * The tool writes to the real config path, so every test runs against a
 * throwaway directory. EVA_CONFIG_PATH is read at call time by getConfigPath(),
 * which is what makes this safe.
 */
let tmpDir: string;
let prevPath: string | undefined;

const BASE = {
  agent: { name: "Eva", gender: "female" },
  owner: { name: "Женя" },
  telegram: { token: "123456:SUPERSECRETTOKENVALUE", owner_id: "42" },
  providers: { openrouter: { api_key: "sk-or-v1-abcdef0123456789" } },
  models: { fast: { provider: "openrouter", model: "x/y" } },
};

function writeBase(): void {
  const { stringify } = require("yaml") as typeof import("yaml");
  fs.writeFileSync(path.join(tmpDir, "config.yaml"), stringify(BASE));
}

async function run(action: string, key?: string, value?: string): Promise<ToolResult> {
  return selfConfigTool.execute({
    action,
    ...(key === undefined ? {} : { key }),
    ...(value === undefined ? {} : { value }),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-cfg-"));
  prevPath = process.env.EVA_CONFIG_PATH;
  process.env.EVA_CONFIG_PATH = path.join(tmpDir, "config.yaml");
  writeBase();
});

afterEach(() => {
  if (prevPath === undefined) delete process.env.EVA_CONFIG_PATH;
  else process.env.EVA_CONFIG_PATH = prevPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- secrets -----------------------------------------------------------------

describe("self_config never leaks secrets", () => {
  /** The original action=list printed the Telegram token and every API key
   *  straight into the conversation, and from there into the LLM provider. */
  it("action=list masks the telegram token", async () => {
    const res = await run("list");
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("SUPERSECRETTOKENVALUE");
    expect(res.output).toContain("telegram.token = ***");
  });

  it("action=list masks provider api keys", async () => {
    const res = await run("list");
    expect(res.output).not.toContain("sk-or-v1-abcdef0123456789");
    expect(res.output).toContain("providers.openrouter.api_key = ***");
  });

  it("shows only the length of a secret, never the value", async () => {
    const res = await run("list");
    expect(res.output).toMatch(/api_key = \*\*\* \(задано, \d+ символов\)/);
  });

  it("action=get on a secret masks it too", async () => {
    const res = await run("get", "telegram.token");
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("SUPERSECRETTOKENVALUE");
    expect(res.output).toContain("***");
  });

  it("refuses to write a secret-looking key", async () => {
    const res = await run("set", "telegram.token", "hijacked");
    expect(res.success).toBe(false);
    const onDisk = loadConfig() as unknown as Record<string, { token: string }>;
    expect(onDisk.telegram!.token).toBe("123456:SUPERSECRETTOKENVALUE");
  });
});

// --- write allowlist ---------------------------------------------------------

describe("self_config write allowlist", () => {
  it("allows personality keys", async () => {
    const res = await run("set", "agent.personality.tone", "dry");
    expect(res.success).toBe(true);
    const cfg = loadConfig() as any;
    expect(cfg.agent.personality.tone).toBe("dry");
  });

  it("allows owner facts via append", async () => {
    await run("append", "owner.facts", "Любит пиццу");
    await run("append", "owner.facts", "Не ест грибы");
    const cfg = loadConfig() as any;
    expect(cfg.owner.facts).toEqual(["Любит пиццу", "Не ест грибы"]);
  });

  it("refuses to rewrite the telegram token", async () => {
    const res = await run("set", "telegram.token", "nope");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/служебная настройка/i);
  });

  it("refuses to write infrastructure sections and says which are allowed", async () => {
    const res = await run("set", "selfies.fal_api_key", "k");
    expect(res.success).toBe(false);
    expect(res.error).toContain("agent");
  });

  it("refuses an unknown root section", async () => {
    const res = await run("set", "whatever.x", "1");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/нельзя менять/);
  });

  it("append is guarded the same way set is", async () => {
    const res = await run("append", "telegram.facts", "x");
    expect(res.success).toBe(false);
  });
});

// --- model changes go through switch_model ----------------------------------

describe("self_config refuses provider plumbing", () => {
  /** Writing models.* straight to YAML bypasses the smoke test in
   *  switch_model, so a typo would leave Eva unable to answer at all. */
  it("refuses to write models.* and points at switch_model", async () => {
    const res = await run("set", "models.fast.model", "typo/nonexistent");
    expect(res.success).toBe(false);
    expect(res.error).toContain("switch_model");
  });

  it("refuses to write providers.* and points at switch_model", async () => {
    const res = await run("set", "providers.openrouter.base_url", "http://evil");
    expect(res.success).toBe(false);
    expect(res.error).toContain("switch_model");
  });

  it("refuses to rewrite fallbacks", async () => {
    const res = await run("set", "fallbacks", "a/b");
    expect(res.success).toBe(false);
  });

  it("leaves the model config untouched after a refused write", async () => {
    await run("set", "models.fast.model", "typo/nonexistent");
    const cfg = loadConfig() as any;
    expect(cfg.models.fast.model).toBe("x/y");
  });
});

// --- values ------------------------------------------------------------------

describe("self_config value handling", () => {
  /** Sliders are numbers in the schema, so a numeric string becomes a number. */
  it("coerces a number for a slider field", async () => {
    await run("set", "agent.personality.humor", "4");
    expect((loadConfig() as any).agent.personality.humor).toBe(4);
  });

  /**
   * Regression. `personality` used to be a `string | object` union. Writing
   * `tone: 42` failed the union, loadConfig's repair pass saw the issue at
   * `agent.personality` instead of at the leaf, deleted the whole block, and
   * Eva lost her tone, style and every slider — with no error anywhere.
   */
  it("a numeric string in a text field stays a string", async () => {
    await run("set", "agent.personality.tone", "3");
    expect((loadConfig() as any).agent.personality.tone).toBe("3");
  });

  it("a bad value cannot take the rest of personality down with it", async () => {
    await run("set", "agent.personality.style", "warm and dry");
    await run("set", "agent.personality.humor", "3");

    // Slider is 0-4; 99 is not a valid slider.
    const bad = await run("set", "agent.personality.humor", "99");
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/Проверка схемы/);

    const p = (loadConfig() as any).agent.personality;
    expect(p.style).toBe("warm and dry");
    expect(p.humor).toBe(3);
  });

  it("rejects an out-of-range slider without saving", async () => {
    const res = await run("set", "agent.personality.humor", "17");
    expect(res.success).toBe(false);
    expect((loadConfig() as any).agent.personality?.humor).toBeUndefined();
  });

  it("keeps non-numeric strings as strings", async () => {
    await run("set", "agent.personality.style", "dry and short");
    const cfg = loadConfig() as any;
    expect(cfg.agent.personality.style).toBe("dry and short");
  });

  it("reports an unset key without inventing one", async () => {
    const res = await run("get", "agent.personality.nope");
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/не задано/);
  });

  it("rejects an unknown action", async () => {
    const res = await run("delete", "agent.name");
    expect(res.success).toBe(false);
    expect(res.error).toBe("invalid_action");
  });

  it("requires a key for get", async () => {
    const res = await run("get");
    expect(res.success).toBe(false);
    expect(res.error).toBe("missing_param");
  });
});

// --- patchConfig -------------------------------------------------------------

// --- legacy personality shape ------------------------------------------------

describe("personality stored as a bare string", () => {
  /** Installs from before the object schema stored personality as free text. */
  it("is folded into custom_instructions instead of being dropped", () => {
    const { stringify } = require("yaml") as typeof import("yaml");
    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      stringify({ agent: { name: "Eva", personality: "говорю коротко и по делу" } }),
    );
    const cfg = loadConfig() as any;
    expect(cfg.agent.personality.custom_instructions).toBe("говорю коротко и по делу");
  });

  it("survives a write to another key", async () => {
    const { stringify } = require("yaml") as typeof import("yaml");
    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      stringify({ agent: { name: "Eva", personality: "я ласковая" } }),
    );
    await run("set", "owner.name", "Женя");
    const cfg = loadConfig() as any;
    expect(cfg.agent.personality.custom_instructions).toBe("я ласковая");
    expect(cfg.owner.name).toBe("Женя");
  });
});

describe("patchConfig", () => {
  it("applies the change to the file", () => {
    patchConfig((c) => {
      c.agent = { ...(c.agent as object), name: "Renamed" };
    });
    expect((loadConfig() as any).agent.name).toBe("Renamed");
  });

  /**
   * The whole reason it exists: two writers, one file. A registry write and a
   * self_config write must both survive.
   */
  it("keeps a sibling section written by someone else", () => {
    patchConfig((c) => {
      c.personality_note = "written by A";
    });
    patchConfig((c) => {
      c.agent = { ...(c.agent as object), gender: "male" };
    });
    const cfg = loadConfig() as any;
    expect(cfg.personality_note).toBe("written by A");
    expect(cfg.agent.gender).toBe("male");
  });

  it("keeps secrets intact while patching something else", () => {
    patchConfig((c) => {
      c.agent = { ...(c.agent as object), name: "Still Eva" };
    });
    expect((loadConfig() as any).telegram.token).toBe("123456:SUPERSECRETTOKENVALUE");
  });

  it("creates the file when none exists", () => {
    fs.rmSync(path.join(tmpDir, "config.yaml"));
    patchConfig((c) => {
      c.agent = { name: "Fresh" };
    });
    expect((loadConfig() as any).agent.name).toBe("Fresh");
  });
});
