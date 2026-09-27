import { describe, it, expect, vi, afterEach } from "vitest";
import { synthesizeSpeech } from "../../src/channels/telegram/voice.js";

/**
 * Gemini TTS is limited per day per model (10 on the flash-lite tier) and has no
 * recovery until tomorrow. One model means voice dies for the rest of the day,
 * so the caller must be able to hand over to a second model — and a second key,
 * which carries its own allowance.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function audio(ok: boolean, status = 200) {
  return {
    ok,
    status,
    json: async () => ({
      candidates: [
        { content: { parts: [{ inlineData: { data: Buffer.from("abc").toString("base64"), mimeType: "audio/wav" } }] } },
      ],
    }),
    text: async () => "",
  };
}

describe("Gemini TTS fallback", () => {
  it("falls to the next model when the first is out of quota", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(String(url));
      return String(url).includes("first-tts") ? audio(false, 429) : audio(true);
    });

    const buf = await synthesizeSpeech("привет", {
      tts_provider: "gemini",
      gemini_api_key: "k",
      gemini_models: ["first-tts", "second-tts"],
    });

    expect(buf).not.toBeNull();
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("second-tts");
  });

  it("tries a second key when the first is spent", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
      const key = init?.headers?.["x-goog-api-key"] ?? "";
      asked.push(key);
      return key === "k1" ? audio(false, 429) : audio(true);
    });

    const buf = await synthesizeSpeech("привет", {
      tts_provider: "gemini",
      gemini_api_keys: ["k1", "k2"],
      gemini_models: ["one-tts"],
    });

    expect(buf).not.toBeNull();
    expect(asked).toEqual(["k1", "k2"]);
  });

  it("returns null when every model is spent", async () => {
    vi.stubGlobal("fetch", async () => audio(false, 429));
    const buf = await synthesizeSpeech("привет", {
      tts_provider: "gemini",
      gemini_api_key: "k",
      gemini_models: ["a", "b"],
    });
    expect(buf).toBeNull();
  });
});
