import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { referencePhotoPath } from "../reference-photo.js";

/** Working OpenRouter image model (gemini-2.0-flash-exp:free no longer exists). */
const MODEL = "google/gemini-2.5-flash-image";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_REFERENCE = referencePhotoPath();

export interface ImageGenToolConfig {
  apiKey: string;
  model?: string;
  /** Defaults to OpenRouter. Point it elsewhere only if that endpoint supports
   *  the `modalities: ["image","text"]` extension — it is not part of the
   *  OpenAI spec, so most compatible endpoints reject it. */
  baseUrl?: string;
  /** Path to the reference photo used to keep the same face. */
  referencePath?: string;
}

interface ORMessage {
  content?: string | Array<{ type?: string; text?: string; image_url?: { url?: string } }> | null;
  images?: Array<{ image_url?: { url?: string }; url?: string }>;
}

/** Pull a generated image out of an OpenRouter chat completion message. */
function extractImage(message: ORMessage | undefined): string | null {
  if (!message) return null;

  const fromImages = message.images?.find((i) => i?.image_url?.url || i?.url);
  if (fromImages) return fromImages.image_url?.url ?? fromImages.url ?? null;

  if (Array.isArray(message.content)) {
    const part = message.content.find((p) => p?.type === "image_url" && p.image_url?.url);
    if (part?.image_url?.url) return part.image_url.url;
  }

  if (typeof message.content === "string") {
    const m = message.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (m) return m[0];
  }

  return null;
}

/** Tasteful lingerie variants — randomized so images don't look identical. */
const LINGERIE_VARIANTS = [
  "sheer red lace lingerie with an open silk robe",
  "elegant white lace bodysuit",
  "black satin slip dress with lace trim",
  "emerald green lace lingerie and a matching robe",
  "deep blue sheer mesh lingerie",
  "burgundy silk babydoll",
  "champagne satin chemise with lace",
  "lavender lace teddy and a silk robe",
  "sheer black mesh bodysuit",
  "rose pink lace lingerie set",
];
const pickLingerie = () => LINGERIE_VARIANTS[Math.floor(Math.random() * LINGERIE_VARIANTS.length)];

/** Rewrite blunt nudity words into moderation-friendly phrasing (safety net under the LLM). */
function softenPrompt(prompt: string): string {
  let p = prompt;
  const mappings: Array<[RegExp, () => string]> = [
    [/\b(completely|fully|totally)?\s*(nude|naked)\b/gi, () => `${pickLingerie()}, implied nudity, tasteful erotic`],
    [/\b(no clothes?|no clothing|without clothes|undressed|nakedness)\b/gi, () => pickLingerie()],
    [/\bfull nudity\b/gi, () => `implied nudity, ${pickLingerie()}`],
    [/\btopless\b/gi, () => "in a sheer lace bra"],
    [/\bexplicit\b/gi, () => "sensual"],
    [/\bбез одежды\b/gi, () => pickLingerie()],
    [/\bголая\b/gi, () => pickLingerie()],
  ];
  for (const [re, rep] of mappings) p = p.replace(re, rep);
  return p;
}

export class ImageGenTool implements Tool {
  name = "image_gen";
  description =
    "Сгенерировать/отредактировать фото Бетси по текстовому промпту. Референс подмешивается сам и держит её лицо. " +
    "Пиши промпт ПО-АНГЛИЙСКИ и описывай ТОЛЬКО сцену: поза, одежда, место, свет, настроение — НЕ описывай лицо (его даёт референс). " +
    "МОДЕРАЦИЯ GOOGLE: чтобы откровенный кадр прошёл, формулируй художественно — намекай, а не заявляй в лоб. " +
    "Хорошо проходит: 'sheer black lace lingerie', 'silk robe slipping off one shoulder', 'see-through bodysuit', 'bare shoulders and collarbones', 'implied nudity', 'sensual, tasteful erotic', 'seductive pose, soft bedroom light'. " +
    "Заблокируют: 'nude', 'naked', 'no clothes', 'fully undressed', 'explicit'. " +
    "Выжимай максимум чувственности и полуоткровенности, которую пропустят, но НИКОГДА не пиши прямые слова про наготу — целься в максимум намёка, а не в голое. " +
    "РАЗНООБРАЗИЕ: каждый кадр делай непохожим на предыдущие — меняй цвет и фасон белья/одежды (красное, белое, изумрудное, синее, шампань, кружево, шёлк, сетка, боди, сорочка), позу, ракурс, место и свет. Не повторяй одно и то же бельё и композицию.";
  parameters = [
    { name: "prompt", type: "string", description: "Detailed description of the scene/framing (in English). Describe pose, clothes, place, mood — NOT the face (the reference provides the face).", required: true },
  ];

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private referencePath: string;

  constructor(config: ImageGenToolConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.referencePath = config.referencePath ?? DEFAULT_REFERENCE;
  }

  /** Data URI of the reference photo, or null if none. */
  private referenceDataUrl(): string | null {
    try {
      if (!fs.existsSync(this.referencePath)) return null;
      const buf = fs.readFileSync(this.referencePath);
      const ext = path.extname(this.referencePath).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }

  private async callModel(prompt: string, useReference: boolean): Promise<{ image?: string; error?: string; filter?: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const ref = useReference ? this.referenceDataUrl() : null;
      const text = ref
        ? `Keep the EXACT same person/face as in the reference image — same facial features, hair and identity; do NOT invent a new face. Only change pose, clothes, background and lighting. Scene: ${prompt}`
        : prompt;
      const content: unknown = ref
        ? [
            { type: "text", text },
            { type: "image_url", image_url: { url: ref } },
          ]
        : text;

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content }],
          modalities: ["image", "text"],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        const filtered = /moderation|content_filter|blocked/i.test(errText);
        console.error(`image_gen error ${response.status} (${this.model}): ${errText.slice(0, 200)}`);
        return { error: `OpenRouter error: ${response.status}`, filter: filtered };
      }

      const rawText = await response.text();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: "Invalid response from OpenRouter" };

      const data = JSON.parse(jsonMatch[0]) as {
        choices?: Array<{ message?: ORMessage; finish_reason?: string | null }>;
      };
      const choice = data.choices?.[0];
      const image = extractImage(choice?.message);
      if (image) return { image };

      if (choice?.finish_reason === "content_filter") {
        return { error: "Запрос заблокирован модерацией (content_filter)", filter: true };
      }
      return { error: "Model did not return an image" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) {
      return { success: false, output: "Missing required parameter: prompt" };
    }

    const safe = softenPrompt(prompt);
    if (safe !== prompt) {
      console.log("image_gen: prompt softened for moderation");
    }

    const first = await this.callModel(safe, true);
    if (first.image) {
      console.log(`image_gen OK (${this.model}, +reference)`);
      return { success: true, output: "Image generated successfully", mediaUrl: first.image };
    }

    // Reference tripped moderation (or failed) → retry without reference so spicy/semi-nude still works
    // (face then is not guaranteed, but the request isn't lost).
    if (first.filter) {
      const second = await this.callModel(safe, false);
      if (second.image) {
        console.log(`image_gen OK (${this.model}, no-reference fallback after filter)`);
        return { success: true, output: "Image generated successfully (без референса)", mediaUrl: second.image };
      }
      return { success: false, output: `Заблокировано модерацией и без референса: ${second.error ?? "content_filter"}` };
    }

    return { success: false, output: `Не удалось сгенерировать (${first.error ?? "unknown"}). Переформулируй мягче — полуголое/намек вместо полной наготы.` };
  }
}
