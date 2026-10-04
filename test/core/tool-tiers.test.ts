import { describe, it, expect } from "vitest";
import { isHeavyToolCall } from "../../src/core/tool-tiers.js";

describe("tool tiers", () => {
  it("counts the server and maintenance tools as heavy", () => {
    for (const name of ["shell", "browser", "npm_install", "self_config", "doctor"]) {
      expect(isHeavyToolCall(name)).toBe(true);
    }
  });

  it("keeps the conversation and lookup tools light", () => {
    for (const name of [
      "memory",
      "web",
      "http",
      "send_file",
      "voice",
      "selfie",
      "image_gen",
      "scheduler",
      "switch_model",
    ]) {
      expect(isHeavyToolCall(name)).toBe(false);
    }
  });

  it("judges files by its action, not by name", () => {
    expect(isHeavyToolCall("files", { action: "write" })).toBe(true);
    expect(isHeavyToolCall("files", { action: "read" })).toBe(false);
    expect(isHeavyToolCall("files", { action: "list" })).toBe(false);
    // A missing action is not a reason to lift the turn.
    expect(isHeavyToolCall("files")).toBe(false);
  });

  it("treats an unknown tool as light", () => {
    expect(isHeavyToolCall("nope")).toBe(false);
  });
});
