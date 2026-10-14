import { describe, it, expect } from "vitest";
import { SILENCE_REPLY, saidNothing } from "../../src/core/silence.js";

describe("saidNothing", () => {
  it("reads the marker however the model hands it over", () => {
    // Punctuation and brackets, not prose: a newline or a capital means the same
    // thing, and sending either as a message would be the bug the convention
    // exists to prevent.
    expect(saidNothing(SILENCE_REPLY)).toBe(true);
    expect(saidNothing("  [тишина]\n")).toBe(true);
    expect(saidNothing("[Тишина]")).toBe(true);
  });

  it("does not mistake a failed turn for a decision", () => {
    // An empty answer is not silence. It is the state the engine turns into
    // "осталось без ответа", and reading it as a decision would swallow a
    // failure — the class of bug that put "Прости, я прослушала" into the report
    // archive on 13.10.
    expect(saidNothing("")).toBe(false);
    expect(saidNothing("   ")).toBe(false);
    expect(saidNothing(undefined)).toBe(false);
    expect(saidNothing(null)).toBe(false);
    expect(saidNothing("⚠️ Плановое задание осталось без ответа")).toBe(false);
    expect(saidNothing("На сервере всё штатно")).toBe(false);
  });
});
