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
 * Lets Betsy send a voice message on her own initiative (not only via /voice).
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

    const file = path.join(os.tmpdir(), `betsy-voice-${Date.now()}.ogg`);
    fs.writeFileSync(file, ogg);
    return { success: true, output: "Голосовое готово и отправлено.", mediaPath: file };
  }
}
