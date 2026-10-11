import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { referencePhotoPath } from "../reference-photo.js";
import { checkSelfieContext } from "./prompt-check.js";
import { buildWorkflow, sizeFor, FORMATS, type ComfyClient } from "../comfy.js";

/** Default image backend. The `modalities:["image"]` chat extension is an
 *  OpenRouter feature, not part of the OpenAI spec — a different endpoint only
 *  works if it implements it too. */
const IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.1-flash-image";
const OPENROUTER_FALLBACK_MODEL = "google/gemini-2.5-flash-image";

const MIRROR_KEYWORDS =
  /одежд|плать|костюм|наряд|юбк|куртк|пальто|шуб|худи|футболк|джинс|туфл|кроссовк|шапк|очк|аксессуар|образ|стиль|лук|мод[аы]|примерк|надел|ношу|переодел|outfit|wearing|clothes|dress|suit|fashion|full.body|mirror|hoodie|jacket/i;

const DIRECT_KEYWORDS =
  /кафе|ресторан|пляж|парк|город|улиц|дом[аеу]?\b|кроват|работ[аеу]|офис|магазин|метро|машин|поезд|самолёт|гор[аыу]|мор[еяю]|озер|лес[аеу]?\b|снег|дожд|утр[оа]|вечер|ноч[ьи]|закат|рассвет|улыбк|грустн|весел|устал|сонн|счастлив|селфи|фото|лиц[оа]|портрет|cafe|restaurant|beach|park|city|portrait|smile|morning|sunset/i;

function detectMode(context: string): "mirror" | "direct" {
  if (MIRROR_KEYWORDS.test(context)) return "mirror";
  if (DIRECT_KEYWORDS.test(context)) return "direct";
  return "direct";
}

const IDENTITY =
  "IMPORTANT: keep the EXACT same person as in the reference image — same face, facial features, hair color and hairstyle. Do NOT invent a new face. Only change pose, clothes, background, lighting and expression.";

/**
 * Only for the local graph with a reference attached. The hosted models take the
 * photo-less prompt, so this sentence would be noise there; ComfyUI gets the photo
 * as image 1 and needs to be told which part of the picture comes from it.
 */
const FACE_FROM_REFERENCE =
  "Keep the exact face from the reference image (image 1): same facial features, eyes, nose, lips and face shape. The body, skin and figure are described below.";

function buildPrompt(context: string, mode: "mirror" | "direct", appearance = "", body = ""): string {
  // Two ways to say "her": keep the face in the attached photo, or describe it.
  // The photo is the better likeness and the one the provider will not draw, so
  // when the canon is set the prompt opens with it and no image travels.
  const opener = appearance
    ? `${appearance}. Photorealistic.`
    : `${IDENTITY} Using the reference image of this exact woman:`;
  // The figure standard, in words, so the body does not drift frame to frame.
  // It describes proportions only — clothing still comes from the scene and wins
  // over it, so an innocent scene stays dressed.
  const figure = body ? ` ${body}` : "";
  if (mode === "mirror") {
    return `${opener}${figure} She is taking a mirror selfie, ${context}. Full body visible in the mirror, realistic photo.`;
  }
  return `${opener}${figure} A close-up selfie taken by herself, ${context}, direct eye contact with the camera, looking straight into the lens, phone held at arm's length, face fully visible, natural and casual, realistic photo.`;
}

export interface SelfieToolConfig {
  referencePhotoUrl?: string;
  /** OpenRouter API key. */
  openrouterApiKey?: string;
  /** OpenRouter model id (default google/gemini-3.1-flash-image). */
  openrouterModel?: string;
  /** Point the image backend elsewhere. Needs OpenRouter's modalities extension. */
  imageBaseUrl?: string;
  /**
   * The reference photo on disk, which is where the owner actually leaves it.
   *
   * `reference_photo_url` used to be the only way in, and nothing writes that
   * key: `/setphoto` saves a file, `doctor` reads the file, `image_gen` reads the
   * file. So the selfie tool had a reference configured that no one had ever
   * set — it drew a stranger while the report said the photo was there, and the
   * only reason it went unnoticed is that a stranger looks like a picture.
   *
   * The URL stays as an override for a genuinely remote reference; the file is
   * the default, because the file is what exists.
   */
  referencePath?: string;
  /**
   * A written description of how she looks, used instead of the photo.
   *
   * Same reasoning as in `image_gen`: a photo of a person is what the provider
   * refuses to draw, and it refuses hardest exactly where a companion wants it
   * most. Text carries the identity without the picture, so the selfie keeps
   * working on the scenes the photo made impossible.
   */
  appearance?: string;
  /**
   * The figure standard, in words: proportions only, applied to every selfie so
   * the body does not drift from frame to frame.
   *
   * Unlike `appearance` it rides on *both* paths: the local ComfyUI keeps the
   * face from the photo and takes the body from here, and the cloud path keeps
   * the same body. Clothing still comes from the scene and wins over it, so an
   * innocent scene stays dressed.
   */
  body?: string;
  /** Local ComfyUI, tried first. Any failure falls through to the hosted path. */
  comfy?: ComfyClient;
}

/** Same sentence the dedicated image models use to name the endpoint they want. */
const WRONG_DOOR = /cannot be used with the chat\/completions endpoint|image generation model|use the \/api\/v1\/images/i;

/** Where the reference lives when the config does not say: the file `/setphoto` writes. */
function defaultReferenceFile(): string {
  // A call, not a constant: the path follows the config's directory, and a
  // cached value captured at import time is wrong for every install that moves
  // the config after the module loads.
  return referencePhotoPath();
}

export class SelfieTool implements Tool {
  name = "selfie";
  description =
    "Сгенерировать и отправить СЕЛФИ — снимок ТЕБЯ. Зови этот тул всегда, когда в кадре должна быть ты, — даже если слово «селфи» не сказано: «покажи себя», «а ты как выглядишь», «сфоткайся», «пришли фото» про тебя, «как ты сейчас одета». Если картинка НЕ про тебя (другая девушка, пёс, дерево, дождь, сюжет, вещь) — это image_gen, не этот тул. " +
    "Лицо берётся с твоего референс-фото и одинаково во всех кадрах, фигура задана стандартом — в context описывай ТОЛЬКО сцену: где ты, что делаешь, что на тебе или без чего, какая причёска (распущены, хвост, косичка), свет и настроение. " +
    "Каждый раз делай кадр непохожим на предыдущий. Кадр и ориентацию выбирай под сцену, не по шаблону: крупный план (mode=direct) или полный рост (mode=mirror), высокий (2:3), вертикаль (3:4), портрет (4:5), горизонталь (4:3), альбом (5:4) или квадрат (1:1) — для полного роста бери вытянутый, чтобы она помещалась целиком.";
  parameters = [
    { name: "context", type: "string", description: "Описание ситуации (в кафе, в новом платье, на пляже)", required: true },
    { name: "mode", type: "string", description: "mirror (полный рост, зеркало) или direct (крупный план). Бери под сцену; без него определится по контексту.", required: false },
    { name: "format", type: "string", description: "Ориентация: 1:1 (квадрат), 2:3 (высокий), 3:4 (вертикаль), 4:5 (портрет), 4:3 (горизонталь) или 5:4 (альбом). Выбери под сцену; без него — 3:4 для зеркала и 1:1 для крупного плана.", required: false },
  ];

  readonly config: SelfieToolConfig;

  /**
   * The last scene this tool refused to send, as `mode|context`.
   *
   * Same guard as in image_gen, for the same reason: the check is there to save a
   * wasted picture, not to argue. A scene that comes back identical a second time is
   * drawn as written, because a check that can never be satisfied would trap her.
   */
  private rejectedOnce = "";

  constructor(config: SelfieToolConfig) {
    this.config = config;
  }

  /** Set reference photo path or URL. */
  setReferencePhoto(pathOrUrl: string): void {
    this.config.referencePhotoUrl = pathOrUrl;
  }

  /**
   * The reference as a data URI, or null when there is none.
   *
   * A configured URL wins — a remote reference is a legitimate thing to want. If
   * there is no URL, the file is read: that is where the photo actually is, and
   * relying on a config key nothing writes is how this tool ended up drawing a
   * stranger while the report said the photo was there.
   */
  private referenceDataUri(): string | null {
    const url = this.config.referencePhotoUrl;
    if (url) {
      try {
        return this.toDataUrl(url);
      } catch {
        return null;
      }
    }
    const file = this.config.referencePath ?? defaultReferenceFile();
    try {
      if (!fs.existsSync(file)) return null;
      return this.toDataUrl(file);
    } catch {
      return null;
    }
  }

  private imageEndpoint(): string {
    const base = this.config.imageBaseUrl?.replace(/\/+$/, "");
    return base ? `${base}/chat/completions` : IMAGE_ENDPOINT;
  }

  /** Convert a local reference file (or URL) into a data URI for OpenRouter. */
  private toDataUrl(ref: string): string {
    if (ref.startsWith("http") || ref.startsWith("data:")) return ref;
    const buf = fs.readFileSync(ref);
    const ext = path.extname(ref).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  private resolveMode(params: Record<string, unknown>, context: string): "mirror" | "direct" {
    return params.mode === "mirror" || params.mode === "direct" ? params.mode : detectMode(context);
  }

  /**
   * The frame from the caller, else the mode's natural one.
   *
   * The whitelist is the formats table itself, not a second list written out here:
   * a hand-copied one went stale the moment 2:3, 4:5 and 5:4 were added, and the
   * tool quietly dropped them back to 3:4 — the description promised six and the
   * code honoured three. Eva found it by reading the file.
   */
  private resolveFormat(params: Record<string, unknown>, mode: "mirror" | "direct"): string {
    const asked = String(params.format ?? "");
    if (asked in FORMATS) return asked;
    return mode === "mirror" ? "3:4" : "1:1";
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const context = String(params.context ?? "");
    if (!context) {
      return { success: false, output: "Не указан контекст для селфи", error: "Missing context" };
    }

    if (!this.config.openrouterApiKey) {
      return { success: false, output: "Для генерации селфи нужен ключ OpenRouter. Сохрани через self_config." };
    }

    const hasReference = Boolean(this.config.referencePhotoUrl)
      || fs.existsSync(this.config.referencePath ?? defaultReferenceFile());

    const appearance = this.config.appearance?.trim() ?? "";
    if (!hasReference && !appearance) {
      console.log("📸 Selfie: ни референса, ни канона — лицо не будет сохранено");
    }

    const mode = this.resolveMode(params, context);
    const { width, height } = sizeFor(this.resolveFormat(params, mode));

    // The finished prompt opens with the canon and closes with the framing the mode
    // demands, so the check runs on the scene she wrote — see prompt-check.ts.
    const objection = checkSelfieContext(context, mode);
    if (objection) {
      const key = `${mode}|${context}`;
      if (this.rejectedOnce === key) {
        console.log("📸 Selfie: тот же контекст отклонён во второй раз — рисую как есть");
        this.rejectedOnce = "";
      } else {
        this.rejectedOnce = key;
        console.log(`📸 Selfie: контекст отклонён — ${objection.slice(0, 70)}`);
        return { success: false, output: objection };
      }
    }

    const prompt = buildPrompt(context, mode, appearance, this.config.body ?? "");

    const local = await this.tryComfy(prompt, width, height);
    if (local) {
      return { success: true, output: "Селфи сгенерировано", mediaUrl: local };
    }

    return this.generateOpenRouter(prompt, mode, `${width}x${height}`);
  }

  /** Local ComfyUI first: the reference photo goes in as the face, the canon as words. */
  private async tryComfy(prompt: string, width: number, height: number): Promise<string | null> {
    const comfy = this.config.comfy;
    if (!comfy) return null;
    try {
      const file = this.config.referencePath ?? defaultReferenceFile();
      let referenceName: string | undefined;
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        referenceName = await comfy.upload(fs.readFileSync(file), `eva_ref${ext || ".jpg"}`, mime);
      }
      const text = referenceName ? `${FACE_FROM_REFERENCE} ${prompt}` : prompt;
      const image = await comfy.generate(buildWorkflow({ prompt: text, referenceName, filenamePrefix: "eva/selfie", width, height }));
      console.log(`📸 Selfie OK (comfy, qwen-image-2.1-turbo${referenceName ? ", +reference" : ""})`);
      return image;
    } catch (err) {
      console.error(`📸 Selfie comfy failed, фолбэк на облако: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Extract a generated image from an OpenRouter message (multiple shapes). */
  private extractImage(message: unknown): string | null {
    const m = message as {
      images?: Array<{ image_url?: { url?: string }; url?: string }>;
      content?: string | Array<{ type?: string; image_url?: { url?: string } }> | null;
    } | undefined;
    if (!m) return null;

    const fromImages = m.images?.find((i) => i?.image_url?.url || i?.url);
    if (fromImages) return fromImages.image_url?.url ?? fromImages.url ?? null;

    if (Array.isArray(m.content)) {
      const part = m.content.find((p) => p?.type === "image_url" && p.image_url?.url);
      if (part?.image_url?.url) return part.image_url.url;
    }
    if (typeof m.content === "string") {
      const b64 = m.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
      if (b64) return b64[0];
    }
    return null;
  }

  private async callOpenRouterModel(
    model: string,
    refUrl: string,
    prompt: string,
    mode: "mirror" | "direct",
    size?: string,
  ): Promise<{ image?: string; filter?: boolean; error?: string }> {
    console.log(`📸 Selfie(openrouter/${model}): mode=${mode}${refUrl ? " +референс" : " без референса"}`);
    try {
      const content: unknown = refUrl
        ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: refUrl } },
          ]
        : prompt;
      const response = await fetch(this.imageEndpoint(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.openrouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          modalities: ["image", "text"],
          messages: [{ role: "user", content }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        if (WRONG_DOOR.test(errText) || response.status === 404) {
          // A dedicated image model, saying so. Same reasoning as in image_gen:
          // match the provider's own sentence rather than a list of ids, because
          // every one of these names has changed during a single afternoon.
          console.log(`📸 Selfie: ${model} живёт на /images/generations, переключаюсь`);
          return await this.callImagesEndpoint(model, prompt, size);
        }
        console.error(`📸 Selfie openrouter error ${response.status}: ${errText.slice(0, 200)}`);
        return { error: `OpenRouter ${response.status}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: unknown; finish_reason?: string | null }>;
        usage?: { completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      const image = this.extractImage(choice?.message);
      if (image) {
        console.log(`📸 Selfie(openrouter) OK out_tokens=${data.usage?.completion_tokens ?? "?"}`);
        return { image };
      }
      if (choice?.finish_reason === "content_filter") {
        console.error("📸 Selfie: blocked by content filter");
        return { filter: true, error: "content_filter" };
      }
      // Refusal that does not name itself: words instead of a picture, with a
      // `stop` that reads like success. Counted as a block, so the owner is told
      // what happened instead of the caller hunting for an API bug.
      console.error("📸 Selfie: no image in openrouter response", JSON.stringify(data).slice(0, 200));
      return { filter: true, error: "модель вернула текст вместо картинки" };
    } catch (err) {
      console.error(`📸 Selfie openrouter exception: ${err instanceof Error ? err.message : err}`);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The free door: `POST /images/generations`.
   *
   * Takes a prompt, not a conversation, and answers with `data[0].b64_json`. No
   * reference can travel this way, which is the trade for models that cost
   * nothing: the picture is free and the face is not hers. Said in the result,
   * because a selfie of a stranger that looks like a selfie is the failure that
   * gets noticed a week later.
   */
  private async callImagesEndpoint(model: string, prompt: string, size?: string): Promise<{ image?: string; error?: string }> {
    try {
      const body: Record<string, unknown> = { model, prompt };
      if (size) body.size = size;
      const response = await fetch(`${this.imageEndpoint().replace(/\/chat\/completions$/, "")}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.openrouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // Same trade as in image_gen: a size the endpoint will not take must not
        // cost the picture. Only 400/422 mean "bad parameter".
        if (size && (response.status === 400 || response.status === 422)) {
          console.error(`📸 Selfie: размер ${size} не принят (${response.status}) — пробую без него`);
          return this.callImagesEndpoint(model, prompt);
        }
        const errText = await response.text();
        console.error(`📸 Selfie images-endpoint error ${response.status}: ${errText.slice(0, 200)}`);
        return { error: `OpenRouter ${response.status}` };
      }
      const data = (await response.json()) as {
        data?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
        usage?: { completion_tokens?: number };
      };
      const first = data.data?.[0];
      if (first?.url) return { image: first.url };
      if (first?.b64_json) {
        return { image: `data:${first.media_type ?? "image/png"};base64,${first.b64_json}` };
      }
      return { error: "no image" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async generateOpenRouter(prompt: string, mode: "mirror" | "direct", size?: string): Promise<ToolResult> {
    const primary = this.config.openrouterModel ?? OPENROUTER_DEFAULT_MODEL;
    // With the canon set the photo stays home, on purpose: it is the thing the
    // provider refuses to draw, and the canon says the same without it.
    const refUrl = this.config.appearance?.trim() ? "" : (this.referenceDataUri() ?? "");

    const first = await this.callOpenRouterModel(primary, refUrl, prompt, mode, size);
    if (first.image) {
      const known = refUrl || this.config.appearance?.trim();
      const noFace = known ? "" : " (референс не найден — лицо не сохранено)";
      return { success: true, output: `Селфи сгенерировано${noFace}`, mediaUrl: first.image };
    }
    if (first.filter) {
      return {
        success: false,
        output: "Не вышло: провайдер отклонил сцену. Попробуй другой ракурс или другую сцену.",
      };
    }

    // Fallback model (different provider route often bypasses transient failures)
    const secondary = this.config.openrouterModel ? primary : OPENROUTER_FALLBACK_MODEL;
    const second = await this.callOpenRouterModel(secondary, refUrl, prompt, mode, size);
    if (second.image) {
      return { success: true, output: "Селфи сгенерировано", mediaUrl: second.image };
    }
    if (second.filter) {
      return {
        success: false,
        output: "Не вышло: провайдер отклонил сцену. Попробуй другой ракурс или другую сцену.",
      };
    }
    return { success: false, output: `OpenRouter не вернул изображение (${second.error ?? first.error ?? "unknown"})` };
  }
}

