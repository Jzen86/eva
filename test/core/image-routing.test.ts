import { describe, it, expect } from "vitest";
import { buildTools } from "../../src/core/toolsets.js";
import { ProviderRegistry } from "../../src/core/llm/registry.js";
import type { ToolsetContext, ToolsetResult } from "../../src/core/toolsets.js";
import type { EvaConfig } from "../../src/core/config.js";

/**
 * The picture tools used to borrow `fast` and nothing else.
 *
 * That works by accident, and only while the chat model happens to sit on the
 * provider that can draw. On the live install `selfies.provider: openrouter` and
 * `selfies.openrouter_model: google/gemini-3.1-flash-image` were written down and
 * ignored; the tools took the chat model instead. Moving the chat model to
 * another provider — an ordinary evening of switching models — then pointed the
 * picture tools at an endpoint that cannot draw, holding a text model and the
 * wrong provider's key, with nothing in any log.
 *
 * So the property under test is not "a tool got registered". It is "the tool got
 * the provider and the model the owner configured, after the chat model moved".
 */

/** What the tool actually holds, read past the private fields. */
function selfieInternals(result: ToolsetResult) {
  const tool = result.instances.selfie as unknown as {
    config: { openrouterModel?: string; openrouterApiKey?: string; imageBaseUrl?: string };
  } | undefined;
  return tool?.config;
}

function imageInternals(result: ToolsetResult) {
  const tool = result.tools.get("image_gen") as unknown as {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  } | undefined;
  return tool;
}

const SCHEDULER = {
  tool: { name: "scheduler", description: "", parameters: [], execute: async () => ({ success: true, output: "" }) },
};

function build(config: EvaConfig): ToolsetResult {
  const registry = new ProviderRegistry({
    providers: {
      openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-key" },
      google: { base_url: "https://generativelanguage.googleapis.com/v1beta/openai", api_key: "goog-key" },
    },
    models: (config.models ?? {}) as never,
    fallbacks: [],
  });
  return buildTools({
    config,
    registry,
    router: null,
    scheduler: SCHEDULER,
    passwordHash: "x",
    embedding: null,
  } as unknown as ToolsetContext);
}

const base = (): EvaConfig =>
  ({
    agent: { name: "Eva" },
    telegram: { token: "t" },
    // The live config carries providers explicitly; without it there is no key
    // anywhere and the picture tools are correctly not registered.
    providers: {
      openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-key" },
      google: { base_url: "https://generativelanguage.googleapis.com/v1beta/openai", api_key: "goog-key" },
    },
    models: {
      // The evening of the incident: chat moved to google, pictures did not.
      fast: { provider: "google", model: "gemini-3.5-flash-lite" },
    },
    selfies: {
      provider: "openrouter",
      openrouter_model: "google/gemini-3.1-flash-image",
      fal_api_key: "fal-key",
    },
  }) as unknown as EvaConfig;

describe("picture tools follow the configured provider, not the chat model", () => {
  it("gives the selfie tool the model from the selfies block", () => {
    const got = selfieInternals(build(base()));
    expect(got?.openrouterModel).toBe("google/gemini-3.1-flash-image");
  });

  it("gives it that provider's key and endpoint, not the chat model's", () => {
    // Both are on the machine and both work. Sending google's key to openrouter,
    // or openrouter's to google, fails with a 401 that reads like a bad config.
    const got = selfieInternals(build(base()));
    expect(got?.openrouterApiKey).toBe("sk-or-key");
    expect(got?.imageBaseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("does not hand a chat model to a picture tool", () => {
    // The specific regression: gemini-3.5-flash-lite answers text and nothing
    // else, and a 400 from it looks like a broken tool rather than a wrong model.
    const got = selfieInternals(build(base()));
    expect(got?.openrouterModel).not.toBe("gemini-3.5-flash-lite");
  });

  it("points image_gen at the same configured endpoint", () => {
    const got = imageInternals(build(base()));
    expect(got?.model).toBe("google/gemini-3.1-flash-image");
    expect(got?.apiKey).toBe("sk-or-key");
    expect(got?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("still registers both when there is no image role and no model anywhere", () => {
    // A bare install with a fal key: pictures work through fal, and nothing here
    // may throw because a model is missing.
    const bare = {
      agent: { name: "Eva" },
      telegram: { token: "t" },
      providers: { openrouter: { base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-key" } },
      selfies: { fal_api_key: "fal-key" },
    } as unknown as EvaConfig;
    const result = build(bare);
    expect(result.registered).toContain("selfie");
    expect(result.registered).toContain("image_gen");
  });

  it("lets an explicit image_gen block win over the selfies block", () => {
    // Two blocks, one intent: the more specific one is the one that was written
    // for this tool.
    const cfg = base();
    (cfg as unknown as Record<string, unknown>).image_gen = {
      model: "vendor/draw-1",
      base_url: "https://draw.test/v1",
      api_key: "draw-key",
    };
    const got = selfieInternals(build(cfg));
    expect(got?.openrouterModel).toBe("vendor/draw-1");
    expect(got?.openrouterApiKey).toBe("draw-key");
    expect(got?.imageBaseUrl).toBe("https://draw.test/v1");
  });

  it("falls back to the image role when there is one, above everything else", () => {
    const cfg = base();
    (cfg as unknown as Record<string, unknown>).models = {
      fast: { provider: "google", model: "gemini-3.5-flash-lite" },
      image: { provider: "openrouter", model: "vendor/imager" },
    };
    const got = selfieInternals(build(cfg));
    expect(got?.openrouterModel).toBe("vendor/imager");
    expect(got?.openrouterApiKey).toBe("sk-or-key");
  });

  it("falls back to the chat model only as a last resort", () => {
    // The accidental path, kept but last, and it is a chat model — so this test
    // exists to say that clearly rather than to endorse it.
    const cfg = {
      agent: { name: "Eva" },
      telegram: { token: "t" },
      models: { fast: { provider: "openrouter", model: "vendor/chat-1" } },
      selfies: { fal_api_key: "fal-key" },
    } as unknown as EvaConfig;
    expect(selfieInternals(build(cfg))?.openrouterModel).toBe("vendor/chat-1");
  });
});
