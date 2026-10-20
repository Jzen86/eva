import { describe, it, expect } from "vitest";
import http from "node:http";
import { LLMRouter } from "../../src/core/llm/router.js";
import { ProviderRegistry } from "../../src/core/llm/registry.js";
import { createOpenAICompatClient } from "../../src/core/llm/providers/openai-compat.js";
import {
  ContentFilteredError,
  EmptyResponseError,
  failureReason,
  failureSentence,
  isPolicyRefusal,
  isRetryableError,
  isTransientError,
} from "../../src/core/llm/errors.js";

/**
 * A refusal is not an outage.
 *
 * Live, 17.10–20.10: Google answered a request it would not answer with a 200
 * and a finish reason that says so — `content_filter: PROHIBITED_CONTENT`. It
 * was counted as an ordinary empty answer, and three things followed.
 *
 * The router read it as a provider failure and degraded the whole chain, so the
 * owner was told "модель недоступна — временно работаю на …" about a model
 * that was answering fine a second later. The reason that reached him was
 * "вернула пустой ответ. Повтори, пожалуйста!" — advice that cannot work,
 * because the same words are refused the same way every time. And the recovery
 * call, which asked the model to explain the failure in her own words, carried
 * the same history and was refused too: two more calls and two more full
 * prompts spent on an answer that could not arrive.
 *
 * The numbers, off the live journal: 37 refusals and 25 turns that ended in an
 * error between 17.10 and 20.10, all of them on one kind of conversation, and
 * both Google models in the chain refuse it identically.
 *
 * The endpoint here is a real one on 127.0.0.1 rather than a stubbed `fetch`:
 * the OpenAI SDK is the transport and does not go through the global fetch in
 * this build, so a test that quietly tested nothing would be worse than none.
 */

const filteredBody = {
  choices: [
    { index: 0, finish_reason: "content_filter: PROHIBITED_CONTENT", message: { content: "" } },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 0 },
};

const goodBody = {
  choices: [{ index: 0, finish_reason: "stop", message: { content: "Я тут." } }],
  usage: { prompt_tokens: 1200, completion_tokens: 4 },
};

async function serve(answers: Record<string, unknown>): Promise<{
  baseURL: string;
  asked: string[];
  close: () => Promise<void>;
}> {
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

describe("a provider that refuses the request", () => {
  it("is named a refusal, not an empty answer", async () => {
    const endpoint = await serve({ "model-1": filteredBody });
    try {
      const client = createOpenAICompatClient({
        apiKey: "k",
        baseURL: endpoint.baseURL,
        model: "model-1",
      });
      await expect(client.chat([{ role: "user", content: "привет" }])).rejects.toBeInstanceOf(
        ContentFilteredError,
      );
      // It is still its own kind of empty answer, and the two must not be
      // confused: only the refusal carries the policy in its name.
      await expect(client.chat([{ role: "user", content: "привет" }])).rejects.not.toBeInstanceOf(
        EmptyResponseError,
      );
    } finally {
      await endpoint.close();
    }
  });

  it("is not an outage of the provider", () => {
    const refusal = new ContentFilteredError("gemini-3.5-flash-lite", "content_filter: PROHIBITED_CONTENT");
    expect(isTransientError(refusal)).toBe(false);
    // Another model may carry a different policy, so the chain still gets its
    // turn — that is a question asked of a different model, not a retry.
    expect(isRetryableError(refusal)).toBe(true);
    expect(isPolicyRefusal(refusal)).toBe(true);
  });

  it("does not degrade the router over it", async () => {
    const endpoint = await serve({ "fast-1": filteredBody, "backup-1": goodBody });
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
      // The model was never unavailable, so nothing is announced and the router
      // stays where it was: the next turn starts on the primary again.
      expect(response.text).not.toContain("недоступна");
      expect(router.mode).toBe("normal");
      router.destroy();
    } finally {
      await endpoint.close();
    }
  });

  it("tells the owner the filter refused it, and does not advise a retry", () => {
    const refusal = new ContentFilteredError("gemini-3.5-flash-lite", "content_filter: PROHIBITED_CONTENT");
    expect(failureReason(refusal).kind).toBe("refused");
    const sentence = failureSentence(refusal);
    expect(sentence).toContain("фильтр");
    // "Повтори, пожалуйста!" on a refusal is advice that cannot work.
    expect(sentence).not.toContain("Повтори");
  });
});
