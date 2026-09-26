import { describe, it, expect } from "vitest";
import { ProviderRegistry, type RegistryConfig } from "../../src/core/llm/registry.js";
import { SwitchModelTool } from "../../src/core/tools/switch-model.js";
import type { LLMRouter } from "../../src/core/llm/router.js";
import type { LLMClient } from "../../src/core/llm/types.js";

/**
 * «Работай на любом провайдере и смени по просьбе» is the promise the whole
 * rewrite exists for, and this tool is the only thing on the machine that
 * fulfils it. So the tests are about the ways it can go wrong at 3am with the
 * owner asleep: a model that does not answer staying in the config, a bad
 * switch leaving the role empty, a provider missing its key being accepted
 * anyway, and the config on disk disagreeing with what the tool just said.
 */

const BASE: RegistryConfig = {
  providers: {
    openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-test" },
    broken: { base_url: "", api_key: "" },
  },
  models: {
    fast: { provider: "openrouter", model: "vendor/fast-1" },
    strong: { provider: "openrouter", model: "vendor/strong-1" },
  },
  fallbacks: [{ provider: "openrouter", model: "vendor/spare-1" }],
};

/** A registry whose clients answer or fail on command, with no network. */
function makeRegistry(cfg: RegistryConfig = BASE) {
  const registry = new ProviderRegistry(cfg);
  const calls: Array<{ model: string; ok: boolean }> = [];
  const broken = new Set<string>();

  (registry as unknown as { client: (ref: { model: string }) => LLMClient }).client = (ref) =>
    ({
      chat: async () => {
        calls.push({ model: ref.model, ok: !broken.has(ref.model) });
        if (broken.has(ref.model)) throw new Error("503 model is overloaded");
        return { text: "ок", toolCalls: [] };
      },
    }) as unknown as LLMClient;

  return { registry, calls, breakModel: (m: string) => broken.add(m) };
}

/** The router is only read for its mode; nothing here switches on it. */
const router = { mode: "normal" } as unknown as LLMRouter;

describe("switch_model — what is in use", () => {
  it("names every role, and says whether a fallback chain exists", async () => {
    const { registry } = makeRegistry();
    const tool = new SwitchModelTool({ registry, router });
    const out = await tool.execute({ action: "current" });
    expect(out.success).toBe(true);
    expect(out.output).toContain("fast:");
    expect(out.output).toContain("strong:");
    expect(out.output).toContain("spare-1");
    expect(out.output).toContain("основной");
  });

  it("says plainly when no role is configured at all", async () => {
    // The honest failure is "nothing is set up", not a table of undefined.
    const { registry } = makeRegistry({ providers: {}, models: {}, fallbacks: [] });
    const out = await new SwitchModelTool({ registry, router }).execute({ action: "current" });
    expect(out.output).toContain("Ни одна роль не настроена");
  });

  it("tells a ready provider from one that was never filled in", async () => {
    const { registry } = makeRegistry();
    const out = await new SwitchModelTool({ registry, router }).execute({ action: "providers" });
    expect(out.output).toContain("openrouter — готов");
    expect(out.output).toContain("broken — НЕ ЗАПОЛНЕН");
  });
});

describe("switch_model — the switch itself", () => {
  it("moves a role onto another model and says the new lineup", async () => {
    const { registry } = makeRegistry();
    const out = await new SwitchModelTool({ registry, router }).execute({
      action: "switch",
      role: "fast",
      provider: "openrouter",
      model: "vendor/fast-2",
    });
    expect(out.success).toBe(true);
    expect(registry.role("fast")?.model).toBe("vendor/fast-2");
    expect(out.output).toContain("vendor/fast-2");
    // The other role is untouched: switching one thing must not disturb the rest.
    expect(registry.role("strong")?.model).toBe("vendor/strong-1");
  });

  it("actually talks to the new model before keeping it", async () => {
    const { registry, calls } = makeRegistry();
    await new SwitchModelTool({ registry, router }).execute({
      action: "switch", role: "fast", provider: "openrouter", model: "vendor/fast-2",
    });
    expect(calls).toEqual([{ model: "vendor/fast-2", ok: true }]);
  });

  it("keeps the old model when the new one does not answer", async () => {
    // The whole reason a switch is verified: a model that 503s at switch time
    // would otherwise be written into the config, and Eva would go silent on
    // every message from then on with nothing in the log to explain it.
    const { registry, breakModel } = makeRegistry();
    breakModel("vendor/fast-2");
    const out = await new SwitchModelTool({ registry, router }).execute({
      action: "switch", role: "fast", provider: "openrouter", model: "vendor/fast-2",
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain("не подошла");
    expect(out.error).toContain("503");
    expect(registry.role("fast")?.model).toBe("vendor/fast-1");
  });

  it("never writes the rejected model to disk, not even briefly", async () => {
    // onChange is the write-through to config.yaml. A switch that assigns first
    // and rolls back after a failed check puts the model that does not answer
    // on disk for a moment, and the rollback is a second write that can itself
    // fail. Kill the process between them and the bad model is permanent, with
    // Eva silent on every message and nothing in the log to say why.
    const { registry, breakModel } = makeRegistry();
    const written: string[] = [];
    registry.onChange(() => written.push(registry.toConfig().models.fast.model));
    breakModel("vendor/fast-2");
    await new SwitchModelTool({ registry, router }).execute({
      action: "switch", role: "fast", provider: "openrouter", model: "vendor/fast-2",
    });
    expect(written, "a rejected switch must not write at all").toEqual([]);
    expect(registry.role("fast")?.model).toBe("vendor/fast-1");
  });

  it("writes exactly once when the switch is good", async () => {
    const { registry } = makeRegistry();
    const written: string[] = [];
    registry.onChange(() => written.push(registry.toConfig().models.fast.model));
    await new SwitchModelTool({ registry, router }).execute({
      action: "switch", role: "fast", provider: "openrouter", model: "vendor/fast-2",
    });
    expect(written).toEqual(["vendor/fast-2"]);
  });

  it("refuses a provider that was never filled in, and lists the ready ones", async () => {
    const { registry } = makeRegistry();
    const out = await new SwitchModelTool({ registry, router }).execute({
      action: "switch", role: "fast", provider: "broken", model: "whatever",
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain("openrouter");
    expect(registry.role("fast")?.model).toBe("vendor/fast-1");
  });

  it("refuses a provider it has never heard of", async () => {
    const { registry } = makeRegistry();
    const out = await new SwitchModelTool({ registry, router }).execute({
      action: "switch", role: "fast", provider: "nope", model: "whatever",
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain("nope");
  });

  it("puts a new role on a model that answers", async () => {
    // Roles beyond the four known ones are legitimate: an owner with a 'vision'
    // role is using the registry as what it is.
    const { registry } = makeRegistry();
    const out = await new SwitchModelTool({ registry, router }).execute({
      action: "switch", role: "vision", provider: "openrouter", model: "vendor/eyes-1",
    });
    expect(out.success).toBe(true);
    expect(registry.role("vision")?.model).toBe("vendor/eyes-1");
  });
});

describe("switch_model — the surface the model actually calls", () => {
  it("defaults to reporting what is in use, so a bare call is harmless", async () => {
    const { registry } = makeRegistry();
    const out = await new SwitchModelTool({ registry, router }).execute({});
    expect(out.success).toBe(true);
    expect(out.output).toContain("fast:");
  });

  it("rejects an action it does not know, by name", async () => {
    const { registry } = makeRegistry();
    const out = await new SwitchModelTool({ registry, router }).execute({ action: "swap" });
    expect(out.success).toBe(false);
    expect(out.error).toContain("Неизвестное action");
    expect(out.error).toContain("current, providers, available, switch");
  });

  it("names the four actions in its description, so the model can find them", () => {
    const { registry } = makeRegistry();
    const d = new SwitchModelTool({ registry, router }).description;
    for (const a of ["action=current", "action=providers", "action=available", "action=switch"]) {
      expect(d, a).toContain(a);
    }
  });

  it("tells the model to list models instead of guessing an id", () => {
    // A guessed id is the failure that a verification step then has to catch.
    const { registry } = makeRegistry();
    expect(new SwitchModelTool({ registry, router }).description).toMatch(/prefer|list first/i);
  });
});
