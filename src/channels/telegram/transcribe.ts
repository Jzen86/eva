/**
 * Voice notes in, text out.
 *
 * The bot had handlers for text and for photos and nothing at all for voice: a
 * note from the owner arrived and stopped there — no transcription, no answer to
 * it, not even an "I did not understand". The owner, hearing nothing back, had no
 * way to tell a broken bot from a busy one.
 *
 * Gemini takes audio on the same key that already speaks her replies and reads
 * the pictures for the vision path, so this adds no vendor: the model answers with
 * a transcript of what it heard. Measured against a real note from the live bot:
 * about one second on `gemini-3.5-flash-lite`.
 *
 * The model list is a list for the same reason the TTS one is — a name that stops
 * being served, or a key whose allowance ran out for one model, should not take
 * voice input down with it.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash-lite"];

const PROMPT =
  "Распознай речь дословно. Верни только текст, без пояснений, без кавычек и без перевода.";

/** `voice.stt_models` (list), then `voice.stt_model`, then the defaults. */
export function sttModels(voiceConfig: Record<string, unknown>): string[] {
  const many = voiceConfig.stt_models;
  if (Array.isArray(many)) {
    const names = many.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
    if (names.length) return names;
  }
  const one = voiceConfig.stt_model;
  if (typeof one === "string" && one.trim()) return [one.trim()];
  return DEFAULT_MODELS;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  error?: { message?: string };
}

/**
 * Transcribe an OGG/Opus voice note, or null when no model could do it.
 *
 * The key is the voice one on purpose: this is the same Google endpoint and the
 * same free allowance that already carries her speech, and borrowing the image
 * route would put the transcription on a paid provider for no gain.
 */
export async function transcribeVoice(
  ogg: Buffer,
  voiceConfig?: Record<string, unknown>,
): Promise<string | null> {
  const cfg = voiceConfig ?? {};
  const key = (cfg.gemini_api_key ?? cfg.google_api_key) as string | undefined;
  if (!key) return null;

  const data = ogg.toString("base64");

  for (const model of sttModels(cfg)) {
    try {
      const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: "audio/ogg", data } },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        const detail = await res.text();
        console.error(`STT ${model}: ${res.status} ${detail.slice(0, 200)}`);
        continue;
      }

      const json = (await res.json()) as GeminiResponse;
      if (json.error) {
        console.error(`STT ${model}: ${json.error.message ?? "error"}`);
        continue;
      }

      // The reasoning part comes back alongside the answer on some models; only
      // the answer is the transcript.
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
    } catch (err) {
      console.error(`STT ${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return null;
}
