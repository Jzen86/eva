import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selfConfigTool } from "../../src/core/tools/self-config";
import { loadConfig, patchConfig } from "../../src/core/config";
import { applyPending, discard, peek, propose } from "../../src/core/pending";
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

/** As the engine calls it, with the chat id the engine injects. */
async function runAs(ownerId: string, action: string, key?: string, value?: string): Promise<ToolResult> {
  return selfConfigTool.execute({
    action,
    _userId: ownerId,
    ...(key === undefined ? {} : { key }),
    ...(value === undefined ? {} : { value }),
  });
}

const OWNER = "owner-1";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eva-cfg-"));
  prevPath = process.env.EVA_CONFIG_PATH;
  process.env.EVA_CONFIG_PATH = path.join(tmpDir, "config.yaml");
  writeBase();
  // The proposal store is module-global and outlives the temp dir, so a parked
  // change from an earlier test would leak into this one.
  discard(OWNER);
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

  it("allows owner facts via append, once the owner confirms", async () => {
    // owner.facts is identity, not flavour: what she knows about the owner
    // follows every message after it. Parked, then applied by /yes.
    await runAs(OWNER, "append", "owner.facts", "Любит пиццу");
    await runAs(OWNER, "append", "owner.facts", "Не ест грибы");
    // The second proposal replaced the first — one pending change per owner.
    await applyPending(OWNER);
    const cfg = loadConfig() as any;
    expect(cfg.owner.facts).toEqual(["Не ест грибы"]);
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
    await runAs(OWNER, "set", "owner.name", "Женя");
    await applyPending(OWNER);
    const cfg = loadConfig() as any;
    expect(cfg.agent.personality.custom_instructions).toBe("я ласковая");
    expect(cfg.owner.name).toBe("Женя");
  });
});

/**
 * Two classes of write, and the difference has to be a real one.
 *
 * Flavour applies at once. Identity does not: it waits for a /yes from the
 * owner, in a channel of their own, not from the conversation that wanted the
 * change. These check that the second class really does not touch the file.
 */
describe("self_config approval gate", () => {
  it("applies a tone change immediately", async () => {
    const res = await runAs(OWNER, "set", "agent.personality.tone", "сухой");
    expect(res.success).toBe(true);
    expect((loadConfig() as any).agent.personality.tone).toBe("сухой");
    expect(peek(OWNER)).toBeUndefined();
  });

  it("applies a slider immediately", async () => {
    await runAs(OWNER, "set", "agent.personality.humor", "4");
    expect((loadConfig() as any).agent.personality.humor).toBe(4);
  });

  it("does NOT apply a rename without confirmation", async () => {
    const res = await runAs(OWNER, "set", "agent.name", "Ксюша");
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/Жду подтверждения/);
    expect(res.output).toMatch(/НЕ ПРИМЕНЕНО/);
    // The point of the gate.
    expect((loadConfig() as any).agent.name).toBe("Eva");
    expect(peek(OWNER)?.key).toBe("agent.name");
  });

  it("does NOT apply a persona change without confirmation", async () => {
    await runAs(OWNER, "set", "agent.personality.persona", "Саркастичная стерва");
    expect((loadConfig() as any).agent.personality?.persona).toBeUndefined();
    await applyPending(OWNER);
    expect((loadConfig() as any).agent.personality.persona).toBe("Саркастичная стерва");
  });

  it("does NOT apply a new standing rule without confirmation", async () => {
    await runAs(OWNER, "append", "agent.personality.ops", "Всегда на ты");
    expect((loadConfig() as any).agent.personality?.ops).toBeUndefined();
    await applyPending(OWNER);
    expect((loadConfig() as any).agent.personality.ops).toEqual(["Всегда на ты"]);
  });

  it("does NOT apply a gender change without confirmation", async () => {
    await runAs(OWNER, "set", "agent.gender", "male");
    expect((loadConfig() as any).agent.gender).toBe("female");
    await applyPending(OWNER);
    expect((loadConfig() as any).agent.gender).toBe("male");
  });

  it("refuses a sensitive write with nothing to confirm through", async () => {
    // No chat means no /yes can arrive, so the change would sit forever.
    const res = await run("set", "agent.name", "Ксюша");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/подтверждени/i);
    expect((loadConfig() as any).agent.name).toBe("Eva");
  });

  it("still validates before parking, so /yes cannot land a doomed write", async () => {
    const res = await runAs(OWNER, "set", "agent.gender", "banana");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Проверка схемы/);
    expect(peek(OWNER)).toBeUndefined();
  });

  it("carries the model's stated reason through to the approval line", async () => {
    await selfConfigTool.execute({
      action: "set",
      _userId: OWNER,
      key: "agent.name",
      value: "Ксюша",
      reason: "он попросил переименовать",
    });
    expect(peek(OWNER)?.reason).toBe("он попросил переименовать");
  });

  it("a rejection leaves the config untouched and clears the proposal", async () => {
    await runAs(OWNER, "set", "agent.name", "Ксюша");
    const dropped = discard(OWNER);
    expect(dropped?.key).toBe("agent.name");
    expect((loadConfig() as any).agent.name).toBe("Eva");
    expect((await applyPending(OWNER)).ok).toBe(false);
  });

  it("cannot be applied twice", async () => {
    await runAs(OWNER, "set", "owner.address_as", "Женька");
    expect((await applyPending(OWNER)).ok).toBe(true);
    expect((await applyPending(OWNER)).ok).toBe(false);
  });

  it("a newer proposal replaces the older one instead of queueing", async () => {
    // A queue would need an id on every /yes, and approving whichever came
    // first is how the wrong change gets approved.
    await runAs(OWNER, "set", "agent.name", "Ксюша");
    await runAs(OWNER, "set", "agent.name", "Аня");
    expect(peek(OWNER)?.value).toBe("Аня");
    await applyPending(OWNER);
    expect((loadConfig() as any).agent.name).toBe("Аня");
  });

  it("keeps proposals separate per owner", async () => {
    await runAs("owner-a", "set", "agent.name", "Ксюша");
    await runAs("owner-b", "set", "agent.name", "Аня");
    await applyPending("owner-a");
    expect((loadConfig() as any).agent.name).toBe("Ксюша");
    expect(peek("owner-b")?.value).toBe("Аня");
  });

  it("applies onto the config as it is now, not as it was when proposed", async () => {
    // Five minutes of conversation happen between proposing and /yes. The
    // approval must land on top of them, not roll them back.
    await runAs(OWNER, "set", "agent.name", "Ксюша");
    await runAs(OWNER, "set", "agent.personality.tone", "сухой");
    await applyPending(OWNER);
    const cfg = loadConfig() as any;
    expect(cfg.agent.name).toBe("Ксюша");
    expect(cfg.agent.personality.tone).toBe("сухой");
  });

  it("reports a failed write instead of consuming the proposal silently", async () => {
    // The proposal is consumed either way, so a schema failure has to be said
    // out loud — otherwise the owner gets a /yes that appears to work.
    const { stringify } = require("yaml") as typeof import("yaml");
    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      stringify({ agent: { name: "Eva" }, telegram: { token: "t" } }),
    );
    const bad = propose(OWNER, {
      kind: "config_set",
      key: "telegram.streaming",
      value: "not-a-boolean",
      summary: "telegram.streaming = not-a-boolean",
      reason: "",
    });
    expect(bad.key).toBe("telegram.streaming");
    const res = await applyPending(OWNER);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Не получилось|Не применилось/);
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
