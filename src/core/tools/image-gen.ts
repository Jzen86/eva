import type { Tool, ToolResult } from "./types.js";
import { checkImagePrompt } from "./prompt-check.js";
import { buildWorkflow, sizeFor, type ComfyClient } from "../comfy.js";

/** Working OpenRouter image model (gemini-2.0-flash-exp:free no longer exists). */
const MODEL = "google/gemini-2.5-flash-image";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface ImageGenToolConfig {
  apiKey: string;
  model?: string;
  /** Defaults to OpenRouter. Point it elsewhere only if that endpoint supports
   *  the `modalities: ["image","text"]` extension — it is not part of the
   *  OpenAI spec, so most compatible endpoints reject it. */
  baseUrl?: string;
  /** Local ComfyUI, tried first. Any failure falls through to the hosted path. */
  comfy?: ComfyClient;
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

/**
 * Any picture, and only a picture.
 *
 * This tool draws whatever she describes — a stranger, a city, an object — and
 * never her. The reference photo and the appearance canon belong to the selfie
 * tool; when the picture happens to be a woman, she writes the whole of her in
 * the prompt: face, features, figure and build, colours, clothes, scene. So the
 * prompt travels exactly as written, no image rides along, and nothing is
 * prepended. That is the difference from the selfie, and it is the point.
 *
 * There used to be a `softenPrompt` here: it rewrote `nude` into "implied
 * nudity" and kept a pile of lingerie substitutions, back when the picture
 * models refused blunt words. The model this install runs now is not moderated —
 * checked on the live key — so the rewrite would only quietly downgrade a
 * request to the ceiling of a model that is no longer in use.
 */

/**
 * Is this the provider saying "wrong door, use the other one"?
 *
 * Dedicated image models — the cheap and free ones — refuse `chat/completions`
 * in so many words and name the endpoint they do accept. Matching on their own
 * sentence rather than on a list of model ids means a model that is renamed, or
 * one that moves from the premium set to the cheap set, keeps working without
 * anyone editing this file. Every id in this area has turned over at least once
 * today. A plain 404 counts as well: on this path a 404 is the door, not the
 * model.
 */
const WRONG_DOOR = /cannot be used with the chat\/completions endpoint|image generation model|use the \/api\/v1\/images|support the requested output modalities/i;

export class ImageGenTool implements Tool {
  name = "image_gen";
  description =
    "Сгенерировать ЛЮБОЕ изображение, НЕ тебя: пёс, дерево, дождь, синяя лягушка с кирпичным крыльцом, чужая девушка, вещь, сцена, сюжет. Если в кадре должна быть ТЫ — это тул selfie, а не этот. " +
    "Пиши промпт ПО-АНГЛИЙСКИ и описывай всё, что нужно в кадре: кто, внешность (лицо, черты, фигура, телосложение и размеры, цвет кожи и волос), причёска, поза, одежда или её отсутствие, место, свет, настроение. " +
    "РАЗНООБРАЗИЕ: каждая картинка непохожа на предыдущие — разные лица, цвета волос и кожи, одежда, поза, ракурс, место и свет. Не повторяй одну и ту же композицию. У этой модели нет модерации — проходит и нагота. " +
    "Формат кадра можно задать: 1:1 (по умолчанию), 3:4 или 4:3. Но пиши художественно: сцена, поза и свет важнее перечисления частей тела.";
  parameters = [
    { name: "prompt", type: "string", description: "Full description of the picture (in English). For a person, write the whole of them — face, figure, colours, pose, clothes; for anything else, whatever is in frame.", required: true },
    { name: "format", type: "string", description: "Ориентация: 1:1 (квадрат, по умолчанию), 2:3 (высокий), 3:4 (вертикаль), 4:5 (портрет), 4:3 (горизонталь) или 5:4 (альбом). Выбери под сцену.", required: false },
  ];

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private comfy?: ComfyClient;
  /**
   * Set once the provider has said this model lives on `/images/generations`.
   * Cached because a chat bot generates more than one picture.
   */
  private dedicatedEndpoint = false;
  /**
   * The last prompt this tool refused to send, verbatim.
   *
   * The check below exists to catch a mistake before it costs a picture, not to
   * stand in the way of one. A prompt that comes back unchanged a second time is
   * drawn as written: a check that can never be satisfied would trap her in a loop
   * of rewrites, and a bad picture is better than no picture. Cleared on every
   * success, so the guard covers the retry rather than the rest of the evening.
   */
  private rejectedOnce = "";

  constructor(config: ImageGenToolConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.comfy = config.comfy;
  }

  /** Local picture first — plain text-to-image, no reference in or out. */
  private async tryComfy(text: string, width: number, height: number): Promise<string | null> {
    if (!this.comfy) return null;
    try {
      const image = await this.comfy.generate(buildWorkflow({ prompt: text, filenamePrefix: "eva/img", width, height }));
      console.log("image_gen OK (comfy, qwen-image-2.1-turbo)");
      return image;
    } catch (err) {
      console.error(`image_gen comfy failed, фолбэк на облако: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * The cheap door: `POST /images/generations`.
   *
   * Free and much cheaper picture models live here, and the request is not the
   * chat one at all: a prompt, not a conversation, and the answer comes back as
   * `data[0].b64_json` instead of a message carrying an image.
   */
  private async callImagesEndpoint(prompt: string, controller: AbortController): Promise<{ image?: string; error?: string }> {
    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`image_gen images-endpoint error ${response.status} (${this.model}): ${text.slice(0, 200)}`);
      return { error: `OpenRouter error: ${response.status}` };
    }
    const json = JSON.parse(await response.text()) as {
      data?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
    };
    const first = json.data?.[0];
    if (first?.url) return { image: first.url };
    if (first?.b64_json) {
      return { image: `data:${first.media_type ?? "image/png"};base64,${first.b64_json}` };
    }
    return { error: "Модель не вернула картинку" };
  }

  private async callModel(prompt: string): Promise<{ image?: string; error?: string; filter?: boolean }> {
    const controller = new AbortController();
    // Generous, because the cheap models are slow: the free one takes ~37s, and
    // a timeout that fires mid-render is a paid-for picture nobody sees.
    const timer = setTimeout(() => controller.abort(), 150_000);
    try {
      if (this.dedicatedEndpoint) {
        return await this.callImagesEndpoint(prompt, controller);
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image", "text"],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        if (WRONG_DOOR.test(errText) || response.status === 404) {
          // The provider named the other endpoint. Take it, remember it, and say
          // so in the log rather than reporting a 404 to the model as a failure.
          this.dedicatedEndpoint = true;
          console.log(`image_gen: ${this.model} живёт на /images/generations, переключаюсь`);
          return await this.callImagesEndpoint(prompt, controller);
        }
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
      // A refusal that does not name itself: the model answers with words
      // instead of a picture and calls it `stop`. Counted as a block, because for
      // the caller it is one — otherwise it reads as "the model did not return an
      // image", which points at the API rather than at the prompt.
      return { error: "Модель вернула текст вместо картинки", filter: true };
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

    // Appearance words are allowed here, unlike in the selfie: this is not a
    // scene under an existing canon, it is the whole picture, and a person in it
    // is described from scratch. Only the contradictions are still refused — two
    // framings, two poses, two lights in one frame come back as a mess.
    const objection = checkImagePrompt(prompt, false);
    if (objection) {
      if (this.rejectedOnce === prompt) {
        console.log("image_gen: тот же промпт отклонён во второй раз — рисую как есть");
        this.rejectedOnce = "";
      } else {
        this.rejectedOnce = prompt;
        console.log(`image_gen: промпт отклонён — ${objection.slice(0, 70)}`);
        return { success: false, output: objection };
      }
    }

    const { width, height } = sizeFor(String(params.format ?? ""));
    const local = await this.tryComfy(prompt, width, height);
    if (local) {
      return { success: true, output: "Image generated successfully", mediaUrl: local };
    }

    const cloud = await this.callModel(prompt);
    if (cloud.image) {
      console.log(`image_gen OK (${this.model})`);
      return { success: true, output: "Image generated successfully", mediaUrl: cloud.image };
    }
    if (cloud.filter) {
      return {
        success: false,
        output: `Провайдер отклонил сцену (${cloud.error ?? "unknown"}). Попробуй другую сцену или сформулируй иначе.`,
      };
    }
    return { success: false, output: `Не удалось сгенерировать (${cloud.error ?? "unknown"}). Попробуй другую сцену.` };
  }
}
