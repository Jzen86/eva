import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";
const GEMINI_DEFAULT_VOICE = "Aoede";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Convert arbitrary audio bytes to OGG/Opus (Telegram voice note format) via ffmpeg. */
function toOggOpus(buffer: Buffer, mimeType: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const mt = (mimeType || "").toLowerCase();
    const isWav = buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF";
    const rate = /rate=(\d+)/.exec(mt)?.[1] ?? "24000";

    const args = ["-hide_banner", "-loglevel", "error"];
    // Raw PCM (Gemini preview TTS) has no container — describe it for ffmpeg.
    if (!isWav && (mt.includes("l16") || mt.includes("pcm") || mt.includes("wav"))) {
      args.push("-f", "s16le", "-ar", rate, "-ac", "1");
    }
    args.push("-i", "pipe:0", "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", "-f", "ogg", "pipe:1");

    let ff;
    try {
      ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.on("error", () => resolve(null));
    ff.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    ff.stdin.on("error", () => { /* ignore EPIPE */ });
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/** Synthesize speech as raw provider bytes (kept for backwards compatibility). */
export async function synthesizeSpeech(
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
  style?: string,
): Promise<Buffer | null> {
  const provider = (voiceConfig.tts_provider as string) ?? "openai";
  if (provider === "gemini") {
    const raw = await synthesizeGemini(text, voiceConfig, style);
    return raw ? raw.buffer : null;
  }
  if (provider === "minimax") {
    return synthesizeMiniMax(text, voiceConfig, falApiKey);
  }
  return synthesizeOpenAI(text, voiceConfig);
}

/**
 * The TTS models to try, in order.
 *
 * A Gemini TTS model is limited per day (10 requests on the flash-lite tier),
 * and a spent model does not come back until tomorrow. One model therefore means
 * voice dies for the rest of the day; a list lets a second model — with its own
 * daily allowance — take over.
 */
function geminiModels(voiceConfig: Record<string, unknown>): string[] {
  const many = voiceConfig.gemini_models;
  if (Array.isArray(many)) {
    const list = many.filter((m): m is string => typeof m === "string" && m.trim() !== "");
    if (list.length) return list;
  }
  const one = voiceConfig.gemini_model;
  return typeof one === "string" && one.trim() ? [one] : [GEMINI_DEFAULT_MODEL];
}

/** The Gemini keys to try. A key carries its own allowance, so a second key is a second bucket. */
function geminiKeys(voiceConfig: Record<string, unknown>): string[] {
  const many = voiceConfig.gemini_api_keys;
  if (Array.isArray(many)) {
    const list = many.filter((k): k is string => typeof k === "string" && k.trim() !== "");
    if (list.length) return list;
  }
  const one = (voiceConfig.gemini_api_key ?? voiceConfig.google_api_key) as string | undefined;
  return typeof one === "string" && one ? [one] : [];
}

/**
 * The newer `/interactions` endpoint. It is the only one that accepts a
 * per-turn `style`, which is what makes her delivery follow the meaning of the
 * sentence rather than a single voice setting applied to everything.
 */
async function geminiInteractions(
  model: string,
  apiKey: string,
  text: string,
  voiceName: string,
  style?: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const content: Record<string, unknown> = { type: "text", text };
    if (style) content.annotations = [{ type: "speech_metadata", style }];
    const res = await fetch(`${GEMINI_BASE}/interactions`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ type: "user_input", content: [content] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: voiceName }] },
      }),
    });
    if (!res.ok) {
      const quota = res.status === 429 ? " (лимит на сегодня)" : "";
      console.warn(`🔇 TTS ${model}: HTTP ${res.status}${quota}`);
      return null;
    }

    const data = (await res.json()) as {
      steps?: Array<{ content?: Array<{ type?: string; data?: string; mime_type?: string }> }>;
    };
    for (const s of data.steps ?? []) {
      for (const c of s.content ?? []) {
        if (c.data && (c.type === "audio" || c.mime_type)) {
          return { buffer: Buffer.from(c.data, "base64"), mimeType: c.mime_type ?? "audio/wav" };
        }
      }
    }
    return null;
  } catch (err) {
    console.warn(`🔇 TTS ${model}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The older generateContent path. No style, but some models still only answer here. */
async function geminiGenerateContent(
  model: string,
  apiKey: string,
  text: string,
  voiceName: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    });
    if (!res.ok) {
      const quota = res.status === 429 ? " (лимит на сегодня)" : "";
      console.warn(`🔇 TTS ${model} (generateContent): HTTP ${res.status}${quota}`);
      return null;
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
    };
    for (const c of data.candidates ?? []) {
      for (const p of c.content?.parts ?? []) {
        if (p.inlineData?.data) {
          return {
            buffer: Buffer.from(p.inlineData.data, "base64"),
            mimeType: p.inlineData.mimeType ?? "audio/wav",
          };
        }
      }
    }
    return null;
  } catch (err) {
    console.warn(`🔇 TTS ${model} (generateContent): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** One call: styled if possible, plain if the model only answers the old way. */
async function geminiGenerate(
  model: string,
  apiKey: string,
  text: string,
  voiceName: string,
  style?: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const viaInteractions = await geminiInteractions(model, apiKey, text, voiceName, style);
  if (viaInteractions) return viaInteractions;
  return geminiGenerateContent(model, apiKey, text, voiceName);
}

/** Gemini TTS via Google AI Studio, with model fallback and an optional per-turn style. */
async function synthesizeGemini(
  text: string,
  voiceConfig: Record<string, unknown>,
  style?: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const keys = geminiKeys(voiceConfig);
  if (!keys.length) return null;
  const voiceName = (voiceConfig.voice_id as string) ?? GEMINI_DEFAULT_VOICE;

  for (const model of geminiModels(voiceConfig)) {
    for (let ki = 0; ki < keys.length; ki++) {
      const raw = await geminiGenerate(model, keys[ki], text, voiceName, style);
      if (raw) {
        console.log(
          `🔊 TTS ${model}: ok | тон: ${style ?? "без стиля"} | ключ ${ki + 1}/${keys.length}`,
        );
        return raw;
      }
    }
  }
  return null;
}

async function synthesizeMiniMax(
  text: string,
  voiceConfig: Record<string, unknown>,
  falKey?: string,
): Promise<Buffer | null> {
  if (!falKey) return null;

  const voiceId = (voiceConfig.voice_id as string) ?? "Calm_Woman";
  const speed = (voiceConfig.speed as number) ?? 1.0;
  const pitch = (voiceConfig.pitch as number) ?? 0;
  const emotion = (voiceConfig.emotion as string) ?? "happy";

  try {
    const body: Record<string, unknown> = {
      text,
      voice_setting: { voice_id: voiceId, speed, pitch, vol: 1, emotion },
      output_format: "url",
    };

    const norm = voiceConfig.normalization as Record<string, unknown> | undefined;
    if (norm?.enabled) {
      body.normalization_setting = {
        enabled: true,
        target_loudness: norm.target_loudness ?? -18,
        target_range: norm.target_range ?? 8,
        target_peak: norm.target_peak ?? -0.5,
      };
    }

    const mod = voiceConfig.voice_modify as Record<string, unknown> | undefined;
    if (mod) {
      (body.voice_setting as Record<string, unknown>).voice_modify = {
        pitch: mod.pitch ?? 0,
        intensity: mod.intensity ?? 0,
        timbre: mod.timbre ?? 0,
      };
    }

    const res = await fetch("https://fal.run/fal-ai/minimax/speech-02-hd", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    const audioUrl = (data.audio as Record<string, unknown>)?.url as string | undefined;
    if (!audioUrl) return null;

    const audioRes = await fetch(audioUrl);
    return Buffer.from(await audioRes.arrayBuffer());
  } catch {
    return null;
  }
}

async function synthesizeOpenAI(
  text: string,
  voiceConfig: Record<string, unknown>,
): Promise<Buffer | null> {
  const apiKey = voiceConfig.openai_key as string | undefined;
  if (!apiKey) return null;

  const voiceId = (voiceConfig.voice_id as string) ?? "nova";

  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey });
    const response = await client.audio.speech.create({
      model: "tts-1",
      voice: voiceId as "alloy",
      input: text.slice(0, 4096),
      response_format: "opus",
    });

    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** Synthesize text to OGG/Opus bytes for any configured provider (gemini/minimax/openai). */
export async function synthesizeVoiceOgg(
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
  style?: string,
): Promise<Buffer | null> {
  const provider = (voiceConfig.tts_provider as string) ?? "openai";
  if (provider === "gemini") {
    const raw = await synthesizeGemini(text, voiceConfig, style);
    if (!raw) return null;
    return toOggOpus(raw.buffer, raw.mimeType);
  }
  if (provider === "minimax") {
    const mp3 = await synthesizeMiniMax(text, voiceConfig, falApiKey);
    if (!mp3) return null;
    console.log("🔊 TTS minimax: ok");
    return toOggOpus(mp3, "audio/mpeg");
  }
  // OpenAI TTS with response_format=opus already yields OGG/Opus
  const ogg = await synthesizeOpenAI(text, voiceConfig);
  if (ogg) console.log("🔊 TTS openai: ok");
  return ogg;
}

/** Send a voice response through a grammY context. Always delivers real OGG/Opus. */
export async function sendVoiceResponse(
  ctx: { replyWithVoice: (file: unknown) => Promise<unknown> },
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
  style?: string,
): Promise<boolean> {
  const ogg = await synthesizeVoiceOgg(text, voiceConfig, falApiKey, style);
  if (!ogg) return false;

  const tmpFile = path.join(os.tmpdir(), `eva-tts-${Date.now()}.ogg`);
  try {
    fs.writeFileSync(tmpFile, ogg);
    const { InputFile } = await import("grammy");
    await ctx.replyWithVoice(new InputFile(tmpFile));
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
