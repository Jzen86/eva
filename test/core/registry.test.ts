import { describe, it, expect, afterEach, vi } from "vitest";
import { listProviderModels } from "../../src/core/llm/registry.js";

/**
 * This is the front door of «работай на любом провайдере»: the model reads the
 * list, picks a name from it, and hands that name to action=switch. So the only
 * property that matters is that every entry it prints can be used as-is.
 *
 * Google is why that is not free. Its OpenAI-compatible endpoint lists
 * `models/gemini-2.5-flash`; the chat endpoint 400s on that. Found by running
 * the real thing on a real server: the tool printed a confident menu of 61
 * models, every one of them unusable, and the switch failed on the name the tool
 * had just produced.
 */

const SPEC = { base_url: "https://example.test/v1", api_key: "k" };

/** Answer /models with this JSON, and remember what was asked. */
function stubModels(body: unknown, ok = true, status = 200) {
  const asked: string[] = [];
  const headers: Record<string, string>[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    asked.push(String(url));
    if (init?.headers) headers.push(init.headers);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  });
  return { asked, headers };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listProviderModels", () => {
  it("returns OpenRouter-style ids untouched, prefix and all", async () => {
    // The prefix here is part of the model name. Stripping it would produce a
    // name the provider has never heard of.
    stubModels({ data: [{ id: "openai/gpt-4o" }, { id: "deepseek/deepseek-v4.1-flash" }] });
    const models = await listProviderModels(SPEC);
    expect(models).toEqual(["deepseek/deepseek-v4.1-flash", "openai/gpt-4o"]);
  });

  it("strips Google's resource-path prefix, which the chat endpoint rejects", async () => {
    stubModels({
      data: [{ id: "models/gemini-2.5-flash" }, { id: "models/gemini-2.5-pro" }],
    });
    const models = await listProviderModels(SPEC);
    expect(models).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(models.every((m) => !m.startsWith("models/"))).toBe(true);
  });

  it("leaves a models/ that appears later in the name alone", async () => {
    // Only the leading segment is a path. `vendor/models/thing` is a name.
    stubModels({ data: [{ id: "vendor/models/thing" }] });
    expect(await listProviderModels(SPEC)).toEqual(["vendor/models/thing"]);
  });

  it("reads the {models:[{name}]} shape too, for endpoints that use it", async () => {
    stubModels({ models: [{ name: "llama3.1:8b" }, { name: "qwen2.5:14b" }] });
    expect(await listProviderModels(SPEC)).toEqual(["llama3.1:8b", "qwen2.5:14b"]);
  });

  it("prefers id over name when a row has both", async () => {
    stubModels({ data: [{ id: "the-id", name: "the-name" }] });
    expect(await listProviderModels(SPEC)).toEqual(["the-id"]);
  });

  it("drops rows that name nothing, rather than printing an empty choice", async () => {
    stubModels({ data: [{ id: "good" }, {}, { name: "also-good" }] });
    expect(await listProviderModels(SPEC)).toEqual(["also-good", "good"]);
  });

  it("returns an empty list when the provider has nothing, without throwing", async () => {
    // An endpoint that answers with an empty menu is a fact to report, not a
    // crash: the model can say so and the old assignment stays.
    stubModels({ data: [] });
    expect(await listProviderModels(SPEC)).toEqual([]);
  });

  it("asks /models and sends the key, without a trailing slash doubling up", async () => {
    const { asked, headers } = stubModels({ data: [{ id: "x" }] });
    await listProviderModels({ base_url: "https://example.test/v1/", api_key: "secret" });
    expect(asked).toEqual(["https://example.test/v1/models"]);
    expect(headers[0]?.Authorization).toBe("Bearer secret");
  });

  it("reports the status and the endpoint when the provider says no", async () => {
    // Without this the model sees a bare failure and cannot tell a wrong key
    // from a wrong path from a provider that is simply down.
    const { asked } = stubModels("no models for you", false, 401);
    await expect(listProviderModels(SPEC)).rejects.toThrow(/HTTP 401/);
    await expect(listProviderModels(SPEC)).rejects.toThrow(/no models for you/);
    expect(asked[0]).toContain("/models");
  });
});
