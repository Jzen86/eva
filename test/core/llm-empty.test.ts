import { describe, it, expect } from "vitest";
import http from "node:http";
import { LLMRouter } from "../../src/core/llm/router.js";
import { ProviderRegistry } from "../../src/core/llm/registry.js";
import { createOpenAICompatClient } from "../../src/core/llm/providers/openai-compat.js";
import { EmptyResponseError, isRetryableError } from "../../src/core/llm/errors.js";

/**
 * A 200 with nothing in it is not an answer.
 *
 * Live, on 15.10: the provider flapped (a 503, then a 200 whose choice carried
 * neither text nor a tool call), and every turn of hers ended in "повтори" —
 * twelve minutes of it. Nothing treated the empty 200 as a failure, so the
 * fallback chain was never consulted, although the next model in it answered
 * the same message fine. Measured with her real prompt against the real
 * endpoint before the fix: primary 0 tokens, fallback 299 characters.
 *
 * The endpoint here is a real one on 127.0.0.1 rather than a stubbed `fetch`:
 * the OpenAI SDK is the transport, it does not go through the global fetch in
 * this build, and a test that quietly tested nothing would be worse than none.
 * Without the change the first test never rejects and the second answers from
 * the silent model.
 */

const emptyBody = {
  choices: [{ index: 0, finish_reason: "stop", message: { content: "" } }],
  usage: { prompt_tokens: 1200, completion_tokens: 0 },
};

const goodBody = {
  choices: [{ index: 0, finish_reason: "stop", message: { content: "Я тут." } }],
  usage: { prompt_tokens: 1200, completion_tokens: 4 },
};

const toolCallBody = {
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "web", arguments: "{}" } }],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 3 },
};

/** What the endpoint answers with, per model name it was asked for. */
type Answers = Record<string, unknown>;

async function serve(answers: Answers): Promise<{ baseURL: string; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: string };
      asked.push(String(body.model ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answers[String(body.model)] ?? goodBody));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    asked,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe("a provider that answers with nothing", () => {
  it("is a failure, not a reply", async () => {
    const endpoint = await serve({ "model-1": emptyBody });
    try {
      const client = createOpenAICompatClient({
        apiKey: "k",
        baseURL: endpoint.baseURL,
        model: "model-1",
      });
      await expect(client.chat([{ role: "user", content: "привет" }])).rejects.toBeInstanceOf(
        EmptyResponseError,
      );
      // The router only tries the next model for a retryable failure; a name the
      // classifier does not know would end the turn with an error instead.
      expect(isRetryableError(new EmptyResponseError("model-1"))).toBe(true);
    } finally {
      await endpoint.close();
    }
  });

  it("hands the turn to the next model in the chain", async () => {
    const endpoint = await serve({ "fast-1": emptyBody, "backup-1": goodBody });
    try {
      const registry = new ProviderRegistry({
        providers: { test: { base_url: endpoint.baseURL, api_key: "k" } },
        models: { fast: { provider: "test", model: "fast-1" } },
        fallbacks: [{ provider: "test", model: "backup-1" }],
      });
      const router = new LLMRouter(registry, { perModelTimeoutMs: 5_000, chainBudgetMs: 12_000 });

      const response = await router.fast().chat([{ role: "user", content: "привет" }]);

      expect(endpoint.asked).toEqual(["fast-1", "backup-1"]);
      expect(response.text).toContain("Я тут.");
      // And the owner is told why the voice changed, instead of wondering.
      expect(response.text).toContain("недоступна");
      expect(router.mode).toBe("degraded");
      router.destroy();
    } finally {
      await endpoint.close();
    }
  });

  it("still accepts a reply that is only a tool call", async () => {
    const endpoint = await serve({ "model-1": toolCallBody });
    try {
      const client = createOpenAICompatClient({
        apiKey: "k",
        baseURL: endpoint.baseURL,
        model: "model-1",
      });
      const response = await client.chat([{ role: "user", content: "поищи" }], [
        { name: "web", description: "поиск", parameters: [] },
      ]);
      expect(response.toolCalls?.[0]?.name).toBe("web");
    } finally {
      await endpoint.close();
    }
  });
});
