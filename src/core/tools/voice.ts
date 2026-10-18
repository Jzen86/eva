import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { synthesizeVoiceOgg, geminiKeys } from "../../channels/telegram/voice.js";
import { checkVoiceBudget, VOICE_PER_DAY } from "../voice-budget.js";

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
    // Asked of the same resolver the synthesizer uses. The gate read
    // `voice.gemini_api_key` alone, while the synthesizer also reads the
    // `gemini_api_keys` array (documented in config.example.yaml) and
    // `google_api_key` — so a config with only the array was reported as
    // "voice is off: no key" while her voice worked perfectly.
    const keys = geminiKeys(voiceConfig);
    return keys.length
      ? { ok: true, backend: "gemini", why: `tts_provider=gemini, ключей: ${keys.length}` }
      : {
          ok: false,
          backend: "gemini",
          why: "tts_provider=gemini, но нет voice.gemini_api_key / voice.gemini_api_keys / voice.google_api_key",
        };
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
    "Отправить голосовое сообщение: озвучить текст своим голосом. Используй, когда просят сказать/наговорить голосом, отправить голосовое или озвучку. " +
    "Задавай `tone` под смысл реплики (например «тепло и нежно, тихо» для признания, «дерзко, с усмешкой» для подколки) — не один тон на всё. " +
    "В `text` клади свою реплику ЦЕЛИКОМ — то самое сообщение, которое хочешь отправить, со всей сценой и деталями, а не короткий пересказ для озвучки. " +
    "После озвучки отдельную письменную реплику не пиши: ход — это одно голосовое, а не два. Если добавить к голосу нечего — ничего и не пиши. " +
    "Не анонсируй: «сейчас скажу голосом» без вызова — это голосовое, которого нет. Позвала — оно уходит в этом же ходу.";
  parameters = [
    { name: "text", type: "string", description: "Твоя реплика целиком (на русском) — не короткая версия для озвучки", required: true },
    {
      name: "tone",
      type: "string",
      description:
        "Как произнести: интонация и эмоция под смысл реплики (например «тепло и нежно, тихо», «дерзко, с усмешкой», «устало и тихо»). Кратко, по-русски.",
      required: true,
    },
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
    const tone = String(params.tone ?? "").trim();

    // Her own voice is rationed; his request is not. See voice-budget.ts for why
    // the gap is the part that holds and a daily ceiling alone does not.
    const requested = params._voiceRequested === true;
    const budget = checkVoiceBudget(requested);
    if (!budget.allow) {
      return {
        success: false,
        output: budget.reason,
        error: budget.reason,
      };
    }

    const ogg = await synthesizeVoiceOgg(text, this.config.voiceConfig, this.config.falApiKey, tone || undefined);
    if (!ogg) {
      return { success: false, output: "Не удалось синтезировать голос (проверь ключ/модель TTS)." };
    }

    const file = path.join(os.tmpdir(), `eva-voice-${Date.now()}.ogg`);
    fs.writeFileSync(file, ogg);
    // The budget is spent when the voice actually leaves (voice-budget.ts, called by
    // the Telegram channel), not here: recording it at synthesis charged her for a
    // send that might never happen — she said "отправлено", and the honest place for
    // that sentence is after the send. What she is told here is what will be left
    // once this one goes, so the number in front of her is still true.
    const left = Math.max(0, budget.remaining - 1);
    return {
      success: true,
      output: `Голосовое готово и уходит в этом же ходу. Останется сегодня: ${left} из ${VOICE_PER_DAY}.`,
      mediaPath: file,
      mediaText: text,
    };
  }
}
