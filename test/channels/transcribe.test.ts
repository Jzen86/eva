import { describe, it, expect, vi, afterEach } from "vitest";
import { transcribeVoice, sttModels } from "../../src/channels/telegram/transcribe.js";

const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53]);

function reply(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

afterEach(() => vi.unstubAllGlobals());

describe("sttModels", () => {
  it("prefers the configured list, then a single name, then the defaults", () => {
    expect(sttModels({ stt_models: ["a", "b"] })).toEqual(["a", "b"]);
    expect(sttModels({ stt_model: "c" })).toEqual(["c"]);
    expect(sttModels({})).toContain("gemini-3.5-transcribe");
  });
});

describe("transcribeVoice", () => {
  it("returns what the model heard", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reply({ candidates: [{ content: { parts: [{ text: "Давай, ковыряйся в своём коде, технарь." }] } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await transcribeVoice(ogg, { gemini_api_key: "k", stt_model: "gemini-3.5-flash-lite" });
    expect(text).toBe("Давай, ковыряйся в своём коде, технарь.");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const parts = body.contents[0].parts;
    expect(parts[1].inline_data.mime_type).toBe("audio/ogg");
    expect(parts[1].inline_data.data).toBe(ogg.toString("base64"));
  });

  it("drops the reasoning part and keeps the transcript", async () => {
    // Some models answer with a thought part first, in English, and the answer
    // second. Joining both would hand the bot a monologue to reply to.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      reply({ candidates: [{ content: { parts: [
        { text: "The user is speaking Russian about code.", thought: true },
        { text: "Пиши текстом, я жду." },
      ] } }] }),
    ));

    expect(await transcribeVoice(ogg, { gemini_api_key: "k" })).toBe("Пиши текстом, я жду.");
  });

  it("tries the next model when one is gone", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ error: { message: "no longer available" } }, false, 404))
      .mockResolvedValueOnce(reply({ candidates: [{ content: { parts: [{ text: "Второй раз получилось" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await transcribeVoice(ogg, { gemini_api_key: "k", stt_models: ["gone", "alive"] });
    expect(text).toBe("Второй раз получилось");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads a transcribe model's answer out of audioTranscription", async () => {
    // The dedicated transcribe models do not answer in `text`: they put the
    // transcript in `audioTranscription.text`. Reading only `text` gets an empty
    // string with a 200 — the same shape as a note nobody spoke into.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      reply({ candidates: [{ content: { parts: [
        { audioTranscription: { text: "Давай, ковыряйся в своём коде." } },
      ] } }] }),
    ));

    expect(await transcribeVoice(ogg, { gemini_api_key: "k", stt_models: ["gemini-3.5-transcribe"] }))
      .toBe("Давай, ковыряйся в своём коде.");
  });

  it("says nothing when there is no key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribeVoice(ogg, {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the keys array her speech uses", async () => {
    // The transcription read `gemini_api_key ?? google_api_key` while the
    // synthesizer also accepted the `gemini_api_keys` array — so a config carrying
    // only the array had working speech and dead hearing, which the owner saw as
    // "не разобрала голосовое": a lie about the audio rather than about the key.
    const fetchMock = vi.fn().mockResolvedValue(
      reply({ candidates: [{ content: { parts: [{ text: "Слышу тебя." }] } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await transcribeVoice(ogg, { gemini_api_keys: ["first", "second"] })).toBe("Слышу тебя.");
    expect(String(fetchMock.mock.calls[0][0])).toContain("key=first");
  });

  it("tries the next key when one is out of allowance", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ error: { message: "quota" } }, false, 429))
      .mockResolvedValueOnce(reply({ candidates: [{ content: { parts: [{ text: "Со второй попытки." }] } }] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await transcribeVoice(ogg, { gemini_api_keys: ["spent", "fresh"], stt_models: ["m"] }))
      .toBe("Со второй попытки.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
