import { describe, it, expect } from "vitest";
import { EmptyResponseError, failureReason, failureSentence } from "../../src/core/llm/errors.js";

/**
 * The reason has to be in the sentence (owner, 19.10): a 503, a 429, a spent key
 * and a dead model id need different actions, and "Прости, что-то у меня
 * зависло. Повтори" told him nothing. The old code fed the recovery call one
 * vague phrase and told the model not to use technical terms.
 */
describe("failureSentence: the reason is said out loud", () => {
  const unavailable = (last: string, models = "google/gemini-3.5-flash-lite") =>
    new Error(`Роль "fast": все модели не ответили. Перепробовано: ${models}. Последняя ошибка: ${last}`);

  it("names an overload with its code and says to wait", () => {
    const s = failureSentence(unavailable("503 status code (no body)"));
    expect(s).toContain("Гугл");
    expect(s).toContain("503");
    expect(s).toMatch(/перегрузка/);
    expect(s).toMatch(/Подожди/);
    expect(s).toMatch(/повтори/);
  });

  it("tells a spent minute limit apart from a spent key", () => {
    // 429 without quota words: wait a couple of minutes.
    const limit = failureSentence(unavailable("429 Too Many Requests"));
    expect(limit).toMatch(/лимит запросов/);
    expect(limit).toContain("429");

    // 429 with quota words: the key is out, and waiting will not fix it.
    const quota = failureSentence(Object.assign(new Error("429 insufficient_quota: quota exceeded"), { status: 429 }));
    expect(quota).toMatch(/лимит ключа/);
    expect(quota).toMatch(/поправить/);
  });

  it("says a timeout is a timeout, not a mystery", () => {
    const s = failureSentence(unavailable("Model timed out"));
    expect(s).toMatch(/не ответила вовремя/);
  });

  it("calls an empty 200 what it is", () => {
    const s = failureSentence(new EmptyResponseError("gemini-3.5-flash-lite", "stop"));
    expect(s).toMatch(/пустой ответ/);
  });

  it("separates a dead model id from a bad key", () => {
    expect(failureSentence(unavailable("404 model not found"))).toMatch(/не отдаёт модель/);
    expect(failureSentence(Object.assign(new Error("Unauthorized"), { status: 401 }))).toMatch(/по ключу/);
  });

  it("does not pretend to know when it does not", () => {
    const s = failureSentence(unavailable("something odd"));
    expect(s).toMatch(/что-то сломалось/);
    // No provider prefix is invented either.
    expect(s).not.toContain("Гугл");
  });

  it("classifies without a message body, from the status alone", () => {
    expect(failureReason(Object.assign(new Error(""), { status: 503 })).kind).toBe("overloaded");
    expect(failureReason(Object.assign(new Error(""), { status: 429 })).kind).toBe("limit");
    expect(failureReason(Object.assign(new Error(""), { status: 404 })).kind).toBe("gone");
  });
});
