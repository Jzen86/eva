import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";
const GEMINI_DEFAULT_VOICE = "Aoede";

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
): Promise<Buffer | null> {
  const provider = (voiceConfig.tts_provider as string) ?? "openai";
  if (provider === "gemini") {
    const raw = await synthesizeGemini(text, voiceConfig);
    return raw ? raw.buffer : null;
  }
  if (provider === "minimax") {
    return synthesizeMiniMax(text, voiceConfig, falApiKey);
  }
  return synthesizeOpenAI(text, voiceConfig);
}

/** Gemini TTS via Google AI Studio (generateContent + AUDIO modality). */
async function synthesizeGemini(
  text: string,
  voiceConfig: Record<string, unknown>,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const apiKey = (voiceConfig.gemini_api_key ?? voiceConfig.google_api_key) as string | undefined;
  if (!apiKey) return null;

  const model = (voiceConfig.gemini_model as string) ?? GEMINI_DEFAULT_MODEL;
  const voiceName = (voiceConfig.voice_id as string) ?? GEMINI_DEFAULT_VOICE;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
      },
    );
    if (!res.ok) return null;

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
  } catch {
    return null;
  }
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
): Promise<Buffer | null> {
  const provider = (voiceConfig.tts_provider as string) ?? "openai";
  if (provider === "gemini") {
    const raw = await synthesizeGemini(text, voiceConfig);
    if (!raw) return null;
    return toOggOpus(raw.buffer, raw.mimeType);
  }
  if (provider === "minimax") {
    const mp3 = await synthesizeMiniMax(text, voiceConfig, falApiKey);
    if (!mp3) return null;
    return toOggOpus(mp3, "audio/mpeg");
  }
  // OpenAI TTS with response_format=opus already yields OGG/Opus
  return synthesizeOpenAI(text, voiceConfig);
}

/** Send a voice response through a grammY context. Always delivers real OGG/Opus. */
export async function sendVoiceResponse(
  ctx: { replyWithVoice: (file: unknown) => Promise<unknown> },
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
): Promise<boolean> {
  const ogg = await synthesizeVoiceOgg(text, voiceConfig, falApiKey);
  if (!ogg) return false;

  const tmpFile = path.join(os.tmpdir(), `betsy-tts-${Date.now()}.ogg`);
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
