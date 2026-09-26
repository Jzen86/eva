import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { synthesizeVoiceOgg } from "../../channels/telegram/voice.js";

export interface VoiceToolConfig {
  voiceConfig: Record<string, unknown>;
  falApiKey?: string;
}

/**
 * Is there a TTS backend that can actually answer?
 *
 * The gate used to be "is there a fal key", which is neither necessary nor
 * sufficient. Not necessary: this machine synthesizes perfectly well through
 * Gemini, and the tool was left unregistered because no fal key was configured —
 * so a feature that works was reported as missing. Not sufficient: a fal key on
 * a locked account passes the check and then fails on every call.
 *
 * So the question is asked of the synthesizer's own preconditions, per provider,
 * and the answer carries the reason — because "voice is off" is useless to
 * whoever has to fix it and "voice is off: tts_provider=gemini but no
 * gemini_api_key" is a five-minute job.
 */
export function voiceBackendAvailable(
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
): { ok: boolean; backend: string; why: string } {
  const provider = ((voiceConfig.tts_provider as string) ?? "openai").toLowerCase();

  if (provider === "gemini") {
    return voiceConfig.gemini_api_key
      ? { ok: true, backend: "gemini", why: "tts_provider=gemini, ключ есть" }
      : { ok: false, backend: "gemini", why: "tts_provider=gemini, но нет voice.gemini_api_key" };
  }
  if (provider === "minimax") {
    return falApiKey
      ? { ok: true, backend: "minimax", why: "tts_provider=minimax, fal-ключ есть" }
      : { ok: false, backend: "minimax", why: "tts_provider=minimax, но нет fal-ключа" };
  }
  if (provider === "openai") {
    return voiceConfig.openai_key
      ? { ok: true, backend: "openai", why: "tts_provider=openai, ключ есть" }
      : { ok: false, backend: "openai", why: "tts_provider=openai, но нет voice.openai_key" };
  }
  return { ok: false, backend: provider, why: `неизвестный tts_provider: ${provider}` };
}

/**
 * Lets Eva send a voice message on her own initiative (not only via /voice).
 * Synthesizes OGG/Opus and returns it as mediaPath; the Telegram channel
 * delivers .ogg mediaPath as a real voice note.
 */
export class VoiceTool implements Tool {
  name = "voice";
  description =
    "Отправить голосовое сообщение: озвучить текст своим голосом. Используй, когда просят сказать/наговорить голосом, отправить голосовое или озвучку.";
  parameters = [
    { name: "text", type: "string", description: "Текст, который нужно озвучить (на русском)", required: true },
  ];

  private config: VoiceToolConfig;

  constructor(config: VoiceToolConfig) {
    this.config = config;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const text = String(params.text ?? "").trim();
    if (!text) {
      return { success: false, output: "Missing required parameter: text" };
    }

    const ogg = await synthesizeVoiceOgg(text, this.config.voiceConfig, this.config.falApiKey);
    if (!ogg) {
      return { success: false, output: "Не удалось синтезировать голос (проверь ключ/модель TTS)." };
    }

    const file = path.join(os.tmpdir(), `eva-voice-${Date.now()}.ogg`);
    fs.writeFileSync(file, ogg);
    return { success: true, output: "Голосовое готово и отправлено.", mediaPath: file };
  }
}
