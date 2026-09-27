import { describe, it, expect, vi, afterEach } from "vitest";
import { synthesizeSpeech } from "../../src/channels/telegram/voice.js";

/**
 * Gemini TTS is limited per day per model (10 on the flash-lite tier) and has no
 * recovery until tomorrow, so the caller must be able to hand over to a second
 * model — and a second key, which carries its own allowance. The delivery style
 * is per turn: one tone for everything would make her a robot.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const b64 = (s: string) => Buffer.from(s).toString("base64");

const okInteractions = () => ({
  ok: true,
  status: 200,
  json: async () => ({ steps: [{ content: [{ type: "audio", data: b64("abc"), mime_type: "audio/wav" }] }] }),
  text: async () => "",
});
const okLegacy = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ inlineData: { data: b64("abc"), mimeType: "audio/wav" } }] } }],
  }),
  text: async () => "",
});
const spent = () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "" });

interface Log {
  models: string[];
  keys: string[];
  bodies: string[];
}

/** Answer interactions/generateContent, marking models and keys the test declares spent. */
function stub(expired: { models?: string[]; keys?: string[] } = {}, log: Log = { models: [], keys: [], bodies: [] }): Log {
  const spentModels = new Set(expired.models ?? []);
  const spentKeys = new Set(expired.keys ?? []);
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const key = init?.headers?.["x-goog-api-key"] ?? "";
    const body = init?.body ?? "";
    let model = "";
    try { model = (JSON.parse(body).model as string) ?? ""; } catch { /* generateContent has no body model */ }
    const m = /\/models\/([^:]+):generateContent/.exec(String(url));
    if (m) model = m[1];
    if (model) log.models.push(model);
    if (key) log.keys.push(key);
    if (body) log.bodies.push(body);

    if (spentModels.has(model) || spentKeys.has(key)) return spent();
    return String(url).includes("/interactions") ? okInteractions() : okLegacy();
  });
  return log;
}

describe("Gemini TTS fallback", () => {
  it("falls to the next model when the first is out of quota", async () => {
    const log = stub({ models: ["first-tts"] });
    const buf = await synthesizeSpeech("привет", {
      tts_provider: "gemini",
      gemini_api_key: "k",
      gemini_models: ["first-tts", "second-tts"],
    });

    expect(buf).not.toBeNull();
    expect(log.models[0]).toBe("first-tts");
    expect(log.models).toContain("second-tts");
  });

  it("tries a second key when the first is spent", async () => {
    const log = stub({ keys: ["k1"] });
    const buf = await synthesizeSpeech("привет", {
      tts_provider: "gemini",
      gemini_api_keys: ["k1", "k2"],
      gemini_models: ["one-tts"],
    });

    expect(buf).not.toBeNull();
    expect(log.keys).toContain("k2");
  });

  it("returns null when every model is spent", async () => {
    stub({ models: ["a", "b"] });
    const buf = await synthesizeSpeech("привет", {
      tts_provider: "gemini",
      gemini_api_key: "k",
      gemini_models: ["a", "b"],
    });
    expect(buf).toBeNull();
  });

  it("carries the per-turn style to the model", async () => {
    const log = stub();
    await synthesizeSpeech(
      "иди сюда, мой хороший",
      { tts_provider: "gemini", gemini_api_key: "k", gemini_models: ["m"] },
      undefined,
      "тепло и нежно, тихо",
    );
    expect(log.bodies.some((b) => b.includes("тепло и нежно, тихо"))).toBe(true);
  });
});
