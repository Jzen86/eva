import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { isBillingError, isTransientError, isRetryableError } from "../../src/core/llm/errors";
import { LLMRouter } from "../../src/core/llm/router";
import { ProviderRegistry, PROVIDER_PRESETS, UnknownProviderError } from "../../src/core/llm/registry";
import { ToolCallAccumulator } from "../../src/core/llm/providers/openai-compat";
import type { LLMClient, LLMResponse, LLMMessage, ToolDefinition, StreamCallback } from "../../src/core/llm/types";
import type { ModelRef } from "../../src/core/llm/registry";

// --- helpers -----------------------------------------------------------------

function apiError(status: number, message: string): OpenAI.APIError {
  return new OpenAI.APIError(status, { message }, message, {});
}

function mockResponse(text: string): LLMResponse {
  return { text, stopReason: "end_turn" };
}

/** A registry that hands out whatever client the test wants, per model ref. */
class MockRegistry extends ProviderRegistry {
  constructor(
    cfg: ConstructorParameters<typeof ProviderRegistry>[0],
    private readonly impl: (ref: ModelRef) => LLMClient,
  ) {
    super(cfg);
  }
  override client(ref: ModelRef): LLMClient {
    return this.impl(ref);
  }
}

function streaming(client: LLMClient): LLMClient {
  return {
    chat: client.chat,
    chatStream: async (msgs: LLMMessage[], onChunk: StreamCallback, tools?: ToolDefinition[]) => {
      const res = await client.chat(msgs, tools);
      if (res.text) onChunk(res.text);
      return res;
    },
  };
}

const BASE_CFG = {
  providers: { test: { base_url: "http://localhost:1/v1", api_key: "k" } },
  models: {
    fast: { provider: "test", model: "fast-1" },
    strong: { provider: "test", model: "strong-1" },
  },
  fallbacks: [{ provider: "test", model: "free-1" }],
};

function makeRouter(
  chat: (ref: ModelRef) => Promise<LLMResponse>,
  cfg = BASE_CFG,
): { router: LLMRouter; calls: string[] } {
  const calls: string[] = [];
  const reg = new MockRegistry(cfg, (ref) =>
    streaming({
      chat: (m, t) => {
        calls.push(ref.model);
        return chat(ref);
      },
      chatStream: async () => mockResponse("unused"),
    }),
  );
  return { router: new LLMRouter(reg, { perModelTimeoutMs: 500, chainBudgetMs: 3_000 }), calls };
}

// --- error classification ----------------------------------------------------

describe("error classification", () => {
  it("402 is billing", () => {
    expect(isBillingError(apiError(402, "Payment required"))).toBe(true);
  });

  it("429 with insufficient_quota is billing, not transient", () => {
    const err = apiError(429, "insufficient_quota: you have run out of credits");
    expect(isBillingError(err)).toBe(true);
    expect(isTransientError(err)).toBe(false);
  });

  it("plain 429 is transient, not billing", () => {
    const err = apiError(429, "Rate limit exceeded");
    expect(isBillingError(err)).toBe(false);
    expect(isTransientError(err)).toBe(true);
  });

  it("404 (dead model) is transient", () => {
    expect(isTransientError(apiError(404, "Model not found"))).toBe(true);
  });

  /**
   * The old classifier only knew about billing, 429 and timeouts, so a plain
   * 500 killed the whole request instead of moving to the next model.
   */
  it("5xx is transient, not billing", () => {
    for (const status of [500, 502, 503, 504, 529]) {
      const err = apiError(status, "upstream blew up");
      expect(isBillingError(err), `status ${status}`).toBe(false);
      expect(isTransientError(err), `status ${status}`).toBe(true);
    }
  });

  it("network failures are transient even without an HTTP status", () => {
    const err = new Error("fetch failed: ECONNRESET");
    expect(isTransientError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
  });

  it("a bad request the user caused is not retryable", () => {
    const err = apiError(400, "Invalid value for parameter 'model'");
    expect(isRetryableError(err)).toBe(false);
  });

  it("isRetryableError covers timeout errors by name", () => {
    const err = new Error("Model timed out");
    err.name = "ModelTimeoutError";
    expect(isRetryableError(err)).toBe(true);
  });
});

// --- provider registry -------------------------------------------------------

describe("ProviderRegistry", () => {
  it("fills base_url from a preset when the config omits it", () => {
    const reg = new ProviderRegistry({
      providers: { openrouter: { api_key: "or-key" } },
      models: { fast: { provider: "openrouter", model: "x/y" } },
      fallbacks: [],
    });
    expect(reg.isUsable("openrouter")).toBe(true);
    expect(reg.client({ provider: "openrouter", model: "x/y" })).toBeDefined();
  });

  it("merges custom headers over the preset headers", () => {
    const reg = new ProviderRegistry({
      providers: { openrouter: { api_key: "k", headers: { "X-Title": "MyBot" } } },
      models: {},
      fallbacks: [],
    });
    const cfg = reg.toConfig();
    expect(cfg.providers.openrouter.headers?.["X-Title"]).toBe("MyBot");
    expect(cfg.providers.openrouter.headers?.["HTTP-Referer"]).toBe(PROVIDER_PRESETS.openrouter.headers?.["HTTP-Referer"]);
  });

  it("rejects a provider with no base_url or key", () => {
    const reg = new ProviderRegistry({ providers: { x: {} }, models: {}, fallbacks: [] });
    expect(reg.isUsable("x")).toBe(false);
    expect(() => reg.client({ provider: "x", model: "m" })).toThrow(/base_url|api_key/);
  });

  it("rejects an unknown provider by name", () => {
    const reg = new ProviderRegistry({ providers: {}, models: {}, fallbacks: [] });
    expect(() => reg.client({ provider: "nope", model: "m" })).toThrow(UnknownProviderError);
  });

  it("caches one client per provider+model", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    const a = reg.client({ provider: "test", model: "fast-1" });
    const b = reg.client({ provider: "test", model: "fast-1" });
    const c = reg.client({ provider: "test", model: "strong-1" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("setRole changes what the role resolves to, no rebuild needed", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    expect(reg.role("fast")?.model).toBe("fast-1");
    reg.setRole("fast", { provider: "test", model: "swapped" });
    expect(reg.role("fast")?.model).toBe("swapped");
  });

  it("notifies on change so the caller can persist", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    let changed = 0;
    reg.onChange(() => changed++);
    reg.setRole("fast", { provider: "test", model: "z" });
    expect(changed).toBe(1);
  });

  it("skips fallbacks whose provider is not configured", () => {
    const reg = new ProviderRegistry({
      ...BASE_CFG,
      fallbacks: [
        { provider: "ghost", model: "m1" },
        { provider: "test", model: "m2" },
      ],
    });
    expect(reg.usableFallbacks().map((f) => f.model)).toEqual(["m2"]);
  });

  it("round-trips through toConfig", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    const cfg = reg.toConfig();
    expect(cfg.models.fast).toEqual({ provider: "test", model: "fast-1" });
    expect(cfg.fallbacks[0].model).toBe("free-1");
  });
});

// --- router ------------------------------------------------------------------

describe("LLMRouter", () => {
  it("exposes mode normal before anything fails", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    const router = new LLMRouter(reg);
    expect(router.mode).toBe("normal");
    expect(router.fast()).toBeDefined();
    expect(router.strong()).toBeDefined();
    router.destroy();
  });

  it("returns the same proxy object for the same role", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    const router = new LLMRouter(reg);
    expect(router.fast()).toBe(router.fast());
    router.destroy();
  });

  it("hasRole and describe report what is configured", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    const router = new LLMRouter(reg);
    expect(router.hasRole("fast")).toBe(true);
    expect(router.hasRole("study")).toBe(false);
    expect(router.describe("fast")).toBe("fast: test/fast-1");
    router.destroy();
  });

  it("sends the fast role to its own model and strong to its own", async () => {
    const { router, calls } = makeRouter(async () => mockResponse("ok"));
    await router.fast().chat([{ role: "user", content: "x" }]);
    await router.strong().chat([{ role: "user", content: "x" }]);
    expect(calls).toEqual(["fast-1", "strong-1"]);
    router.destroy();
  });

  it("uses the fallback and says so, then goes degraded", async () => {
    const { router, calls } = makeRouter(async (ref) => {
      if (ref.model === "fast-1") throw apiError(402, "Payment required");
      return mockResponse("fallback works");
    });
    const res = await router.fast().chat([{ role: "user", content: "hello" }]);
    expect(calls).toEqual(["fast-1", "free-1"]);
    expect(res.text).toContain("fallback works");
    expect(res.text).toContain("недоступна");
    expect(router.mode).toBe("degraded");
    router.destroy();
  });

  it("announces the switch exactly once", async () => {
    const { router } = makeRouter(async (ref) => {
      if (ref.model === "fast-1") throw apiError(402, "Payment required");
      return mockResponse("ok");
    });
    const first = await router.fast().chat([{ role: "user", content: "a" }]);
    const second = await router.fast().chat([{ role: "user", content: "b" }]);
    expect(first.text).toContain("недоступна");
    expect(second.text).toBe("ok");
    expect(second.text).not.toContain("недоступна");
    router.destroy();
  });

  it("walks past a failing fallback to the next one", async () => {
    const cfg = {
      ...BASE_CFG,
      fallbacks: [
        { provider: "test", model: "free-1" },
        { provider: "test", model: "free-2" },
      ],
    };
    const { router, calls } = makeRouter(async (ref) => {
      if (ref.model === "fast-1") throw apiError(402, "Payment required");
      if (ref.model === "free-1") throw apiError(503, "upstream down");
      return mockResponse("second fallback works");
    }, cfg);
    const res = await router.fast().chat([{ role: "user", content: "hello" }]);
    expect(calls).toEqual(["fast-1", "free-1", "free-2"]);
    expect(res.text).toContain("second fallback works");
    router.destroy();
  });

  /** The old router collapsed fast and strong onto one delegate on fallback, so
   *  a request that should have used the strong model silently used a free one. */
  it("keeps fast and strong distinct on the primary model", async () => {
    const { router, calls } = makeRouter(async () => mockResponse("ok"));
    await router.strong().chat([{ role: "user", content: "x" }]);
    expect(calls).toEqual(["strong-1"]);
    router.destroy();
  });

  it("gives up with a readable error when nothing works", async () => {
    const { router } = makeRouter(async () => {
      throw apiError(500, "everything is on fire");
    });
    await expect(router.fast().chat([{ role: "user", content: "x" }])).rejects.toThrow(
      /Роль "fast"/,
    );
    router.destroy();
  });

  it("does not retry a request error — that would fail 50 times identically", async () => {
    const { router, calls } = makeRouter(async () => {
      throw apiError(400, "Invalid value for parameter");
    });
    await expect(router.fast().chat([{ role: "user", content: "x" }])).rejects.toThrow();
    expect(calls).toEqual(["fast-1"]);
    router.destroy();
  });

  it("role() returns a non-fallback client and complains when unconfigured", () => {
    const reg = new ProviderRegistry(BASE_CFG);
    const router = new LLMRouter(reg);
    expect(router.role("strong")).toBeDefined();
    expect(() => router.role("study")).toThrow(/не настроена/);
    router.destroy();
  });
});

// --- streamed tool calls -----------------------------------------------------

describe("ToolCallAccumulator", () => {
  it("keeps calls apart by index", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: "a", function: { name: "one", arguments: '{"x":' } });
    acc.add({ index: 1, id: "b", function: { name: "two", arguments: '{"y":' } });
    acc.add({ index: 0, function: { arguments: "1}" } });
    acc.add({ index: 1, function: { arguments: "2}" } });
    const out = acc.finish()!;
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "a", name: "one", arguments: { x: 1 } });
    expect(out[1]).toEqual({ id: "b", name: "two", arguments: { y: 2 } });
  });

  /** Some providers send parallel calls without an index field at all. */
  it("splits on a new id when the index is missing", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ id: "a", function: { name: "one", arguments: '{"x":' } });
    acc.add({ function: { arguments: "1}" } });
    acc.add({ id: "b", function: { name: "two", arguments: "{}" } });
    const out = acc.finish()!;
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out[0].arguments).toEqual({ x: 1 });
  });

  it("returns nothing when no tool calls arrived", () => {
    expect(new ToolCallAccumulator().finish()).toBeUndefined();
  });

  it("survives truncated JSON instead of throwing away the response", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: "a", function: { name: "one", arguments: '{"x":' } });
    const out = acc.finish()!;
    expect(out[0].arguments).toEqual({});
  });
});
