import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { referencePhotoPath, ownerReferencePhotoPath } from "../reference-photo.js";
import { checkSelfieContext } from "./prompt-check.js";
import { buildWorkflow, sizeFor, cloudSizeFor, formatList, FORMATS, type ComfyClient } from "../comfy.js";
import { frameNote } from "../image-preview.js";

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

/**
 * The five things she chooses for every selfie.
 *
 * The face and the hair colour are not here: they come from the reference photo
 * and never change. Everything else is hers to write, in English, and it has to
 * be concrete — the live engine proved on 26.10 that "a warm smile" leaves the
 * neutral reference face untouched, while "laughing hard, mouth open, teeth
 * showing" changes it. See the tool description.
 */
export interface SceneFields {
  hair: string;
  face: string;
  outfit: string;
  scene: string;
  light: string;
}

/**
 * What the reference is allowed to decide, and what it is not.
 *
 * The old sentence said "same hairstyle" and "only change pose, clothes,
 * background, lighting and expression" — so a scene asking for a ponytail was
 * fighting a direct order to keep the reference's hair. The live test on 26.10
 * drew the same woman with loose waves, a red dress and a laughing face only
 * after this line stopped locking them.
 */
const FACE_FROM_REFERENCE =
  "Keep the exact face and hair color from the reference image (image 1): same facial features, eyes, nose, lips and face shape. The hairstyle, facial expression, outfit, scene and light come from the text below, not from the reference.";

/** The five fields as one block, in the order they are read. */
function sceneBlock(fields: SceneFields): string {
  return `Hairstyle: ${fields.hair}. Face: ${fields.face}. Outfit: ${fields.outfit}. Scene: ${fields.scene}. Light: ${fields.light}.`;
}

function buildPrompt(
  fields: SceneFields,
  mode: "mirror" | "direct",
  appearance = "",
  body = "",
): string {
  // No face claim here: the caller prepends FACE_FROM_REFERENCE only when a
  // reference is actually attached. An install with a written canon has no photo
  // to point at, and a prompt that claims one is a lie the model tries to keep.
  const opener = appearance ? `${appearance}. Photorealistic.` : "A photorealistic photo of a woman.";
  // The figure standard, in words, so the body does not drift frame to frame.
  // It describes proportions only — clothing still comes from the scene and wins
  // over it, so an innocent scene stays dressed.
  const figure = body ? ` ${body}` : "";
  if (mode === "mirror") {
    return `${opener}${figure} A photorealistic photo of her in front of a mirror. ${sceneBlock(fields)} Full figure visible in the mirror, realistic photo.`;
  }
  // No "selfie" phrasing and no outstretched arm: the owner's complaint was exact
  // — he asks for a photo of her and gets the arm's-length pose, because the code
  // said so, not because he wanted it. The pose and the framing come from the
  // scene she wrote (lying, sitting, standing, portrait or full length).
  return `${opener}${figure} A photorealistic photo of her. ${sceneBlock(fields)} Natural pose, realistic photo.`;
}

/**
 * The prompt for a frame with both of them in it.
 *
 * Same reason as FACE_FROM_REFERENCE: the local graph is handed two photos and
 * has to be told which part of the picture comes from which. It names both faces
 * first — hers is image 1, his is image 2 — and the scene (`context`) comes last,
 * so the words say what they are doing rather than who they are.
 *
 * The figure standard (`selfies.body`) rides here too, exactly as on a lone
 * selfie: the owner wants her proportions the same in every frame. It was pulled
 * once (`e5544ea`) because a canon that spelled out areolas and nipples made the
 * model inflate the chest and, on one seed, drop the man — but the fault was in
 * those words, not in describing the figure at all. The owner's canon without
 * them renders both people clean on 8 of 8 (4 lingerie, 4 nude, 4 seeds).
 */
const PAIR_FACES =
  "Two people in one photo. The woman is the person from image 1: keep her exact face and hair color. The man is the person from image 2: keep his exact face. Do not swap, blend or merge the faces. Her hairstyle, facial expression, outfit, scene and light come from the text below, not from the reference photos.";

/**
 * The prompt for a frame with both of them in it.
 *
 * The faces come from the two reference photos, and so does the man's *clothing*
 * — the prompt says nothing about it, so the edit model keeps whatever he wears
 * in his photo and he came out in the same shirt every time (the owner, 16.10:
 * "почему я вечно в рубашке"). The fix is the same one her own selfie uses:
 * clothing rides in on the scene, so `context` must name what each of them has on.
 * His figure stays words-only (`ownerBody`) because the photo already carries the
 * body; only the outfit was missing a place to be said.
 *
 * The scene alone was not enough, and a sentence telling the model not to copy the
 * photo did not help either. Measured on the live ComfyUI (16.10): a frame whose
 * scene named his outfit drew exactly that ("a bright red short-sleeve t-shirt"),
 * and the same frame with his outfit left out copied the reference again. So the
 * text works — it just has to *carry a garment*, and she never supplied one, twice.
 * The outfit is therefore its own parameter (`his_outfit`), and `generatePair`
 * refuses an empty one; here it only has to be spent, with the reference's
 * clothing named as not the source.
 */
function buildPairPrompt(
  fields: SceneFields,
  body = "",
  ownerBody = "",
  hisOutfit = "",
): string {
  const herFigure = body ? ` The woman's figure: ${body}.` : "";
  const hisFigure = ownerBody ? ` The man's figure: ${ownerBody}.` : "";
  const hisClothes = hisOutfit ? ` The man is wearing ${hisOutfit}.` : "";
  const clothing =
    " Take the clothing for both of them from this description, not from the reference photos.";
  return `${PAIR_FACES}${herFigure}${hisFigure}${hisClothes} ${sceneBlock(fields)}.${clothing} Photorealistic photo of the two of them together, both fully in frame, natural.`;
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
   * The owner's photo on disk, for a frame that has both of them in it.
   *
   * A separate file from `referencePath` on purpose: replacing his photo must
   * not change hers, and vice versa. Missing means a pair frame cannot be drawn
   * — and, unlike her selfie, it does not fall back to the cloud at all, because
   * a provider will not take a photo of a real person: that refusal is colour,
   * not shape, and every pair frame is built on his face. `with_owner` on the
   * tool reads this path; nothing else does.
   */
  ownerReferencePath?: string;
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
  /**
   * The man's figure, in words — used only on a pair frame, so his build holds
   * the same way hers does. Meant to be short: the reference photo already
   * carries his body, and the words are a nudge, not a specification.
   */
  ownerBody?: string;
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
    "Заполни пять полей ПО-АНГЛИЙСКИ, каждое конкретно и физически. hair — только укладка, без цвета: neat ponytail, messy bun, loose waves. face — выражение и детали лица: laughing hard, mouth open, teeth showing, eyes crinkled; furious, brows drawn together, jaw clenched; dark circles under the eyes, tears. outfit — что на тебе: nude, black panties, red silk dress, niqab, torn shirt. scene — где ты и что делаешь: sitting on a windowsill in a café, walking down a rainy street, lying on a bed. light — какой свет: soft morning light from the window, cold streetlamp, neon signs. " +
    "Не пиши «лёгкая улыбка», «soft smile», «warm smile» или «красиво»: Qwen оставит нейтральное лицо с референса и дорисует сам. Называй действие и мышцы: «смеётся, рот открыт, зубы видны», «губы приоткрыты, уголки вверх, глаза прищурены», «брови сведены, губы сжаты». Это проверено на живом движке 26.10: «warm smile» не меняет лицо, «laughing hard, mouth open, teeth showing» меняет. Чем конкретнее поле, тем точнее кадр; литературу не пиши — пяти коротких фраз достаточно. " +
    "Тело и цвет волос не описывай — они заданы референсом; меняются только причёска, лицо, одежда, сцена и свет. " +
    "Если в кадре поцелуй или объятие — назови контакт прямо и телесно: «губы плотно прижаты к губам, рты соприкасаются, глаза закрыты». Общее «страстно целуемся» движок рисует как «почти»: лица рядом, а касания нет. " +
    "Если в кадре вы вдвоём — with_owner=true и his_outfit: назови, что НА НЁМ, одной фразой. Это твоё решение, как и твой собственный вид; связи между вами нет — оба голые, оба одетые, кто-то один. Без his_outfit движок возьмёт его одежду с его фото, и он выйдет в одном и том же. " +
    "Кадр и ориентацию выбирай под сцену, не по шаблону: крупный план (mode=direct) или полный рост (mode=mirror), ориентация — " + formatList() + ". Зеркало — только если сцена про зеркало, примерку или полный рост. " +
    "Готовый кадр приходит к тебе в этом же ходу — смотри на него и говори по кадру, а не по своему промпту. " +
    "Не анонсируй съёмку: «сейчас отправлю селфи» без вызова тулза — это кадр, которого нет. Позвала — он придёт в этом же ходу.";
  parameters = [
    { name: "hair", type: "string", description: "Причёска по-английски, без цвета: neat ponytail, messy bun, loose waves.", required: true },
    { name: "face", type: "string", description: "Лицо по-английски: выражение и детали, конкретно. Не «soft smile» и не «warm smile» — Qwen их игнорирует; пиши, что делает лицо: lips parted, teeth showing, eyes crinkled; brows drawn together, jaw clenched; dark circles under the eyes.", required: true },
    { name: "outfit", type: "string", description: "Одежда по-английски: nude, black panties, red silk dress, niqab, torn shirt.", required: true },
    { name: "scene", type: "string", description: "Сцена по-английски: где ты и что делаешь. Sitting on a windowsill in a café, walking down a rainy street, lying on a bed.", required: true },
    { name: "light", type: "string", description: "Свет по-английски: soft morning light from the window, cold streetlamp, neon signs.", required: true },
    { name: "mode", type: "string", description: "mirror (полный рост, зеркало) или direct (крупный план). Бери под сцену; без него определится по контексту.", required: false },
    { name: "format", type: "string", description: `Ориентация: ${formatList()}. Выбери под сцену; без него — 3:4 для зеркала и 1:1 для крупного плана.`, required: false },
    { name: "with_owner", type: "boolean", description: "true — на кадре вы вдвоём (она и владелец). По умолчанию false — только она.", required: false },
    { name: "his_outfit", type: "string", description: "Для кадра вдвоём (with_owner=true) — что НА НЁМ, коротко: «чёрная футболка», «рубашка нараспашку», «голый торс», «полотенце на бёдрах». Обязательно для пары: без неё движок берёт его одежду прямо с его фото, и он выходит в том же, что на снимке.", required: false },
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

  /**
   * The last pair scene refused for a missing `his_outfit`, as `outfit|context`.
   *
   * The same one-shot escape as above, for the same reason. Unlike the prompt
   * check this one guards something the owner asked for directly ("почему я вечно
   * в рубашке"): the outfit has to be said, because the model copies his photo
   * otherwise. But a missing slot is still her mistake to fix, not a wall.
   */
  private rejectedOutfitOnce = "";

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
    const fields: SceneFields = {
      hair: String(params.hair ?? "").trim(),
      face: String(params.face ?? "").trim(),
      outfit: String(params.outfit ?? "").trim(),
      scene: String(params.scene ?? "").trim(),
      light: String(params.light ?? "").trim(),
    };
    const missing = (Object.keys(fields) as Array<keyof SceneFields>).filter((k) => !fields[k]);
    if (missing.length > 0) {
      return {
        success: false,
        output: `Заполни все пять полей: ${missing.join(", ")}. Без них Qwen нарисует нейтральный референс, а не сцену.`,
      };
    }
    const sceneText = [fields.hair, fields.face, fields.outfit, fields.scene, fields.light].join(". ");

    // A frame with both of them is a different job: two references in, one
    // picture out, and no cloud path at all. The image providers refuse a photo
    // of a real person, and every pair frame is built on one — so it is the
    // local ComfyUI or an honest refusal, never a stranger's face. Checked
    // before the key, because a pair frame needs no key.
    if (params.with_owner === true || params.with_owner === "true") {
      return this.generatePair(fields, String(params.format ?? ""), String(params.his_outfit ?? "").trim());
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

    const mode = this.resolveMode(params, sceneText);
    const { width, height } = sizeFor(this.resolveFormat(params, mode));

    // The finished prompt opens with the canon and closes with the framing the mode
    // demands, so the check runs on the scene she wrote — see prompt-check.ts.
    const objection = checkSelfieContext(sceneText, mode);
    if (objection) {
      const key = `${mode}|${sceneText}`;
      if (this.rejectedOnce === key) {
        console.log("📸 Selfie: тот же контекст отклонён во второй раз — рисую как есть");
        this.rejectedOnce = "";
      } else {
        this.rejectedOnce = key;
        console.log(`📸 Selfie: контекст отклонён — ${objection.slice(0, 70)}`);
        return { success: false, output: objection };
      }
    }

    const prompt = buildPrompt(fields, mode, appearance, this.config.body ?? "");

    const local = await this.tryComfy(prompt, width, height);
    if (local) {
      return { success: true, output: "Селфи отправлено в чат (файла нет — отдельно слать нечего)" + frameNote(local), mediaUrl: local };
    }

    return this.generateOpenRouter(prompt, mode, cloudSizeFor({ width, height }));
  }

  /** MIME by extension, the way the selfie path has always guessed it. */
  private mimeOf(file: string): string {
    const ext = path.extname(file).toLowerCase();
    return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  }

  /**
   * The two of them in one frame.
   *
   * Local ComfyUI only. Two references go in — hers as image 1, his as image 2 —
   * and the prompt names which face is which. The cloud is not an option here,
   * not even as a last resort: the providers refuse a photo of a real person,
   * and a pair frame is exactly that, twice over. A missing ComfyUI or a missing
   * owner photo is an honest refusal ("not now", "no his photo yet"), which is
   * better than a picture of two strangers with her name on it.
   */
  private async generatePair(fields: SceneFields, format: string, hisOutfit = ""): Promise<ToolResult> {
    const sceneText = [fields.hair, fields.face, fields.outfit, fields.scene, fields.light].join(". ");
    const comfy = this.config.comfy;
    if (!comfy) {
      return {
        success: false,
        output: "Парный кадр рисуется только локально, а ComfyUI сейчас недоступен. Попробуй позже.",
      };
    }
    const ownerFile = this.config.ownerReferencePath ?? ownerReferencePhotoPath();
    if (!fs.existsSync(ownerFile)) {
      return {
        success: false,
        output: "Нет фото владельца — пришли его с подписью /setphoto me, и я смогу снять нас двоих.",
      };
    }
    const herFile = this.config.referencePath ?? defaultReferenceFile();
    if (!fs.existsSync(herFile)) {
      return { success: false, output: "Нет моего референс-фото — сначала /setphoto с моим лицом." };
    }

    // His outfit cannot be left to chance. With nothing named, the edit model
    // keeps what his reference photo shows, and every frame reproduced the same
    // shirt (owner, 16.10: "почему я вечно в рубашке"). Asking her to name it in
    // the description was skipped twice, so the empty slot is an error instead.
    // Once: a second identical attempt is drawn anyway, so a check she cannot
    // satisfy never traps her (same shape as the prompt check above).
    if (!hisOutfit) {
      const key = `outfit|${sceneText}`;
      if (this.rejectedOutfitOnce === key) {
        console.log("📸 Парный кадр: одежда его не названа повторно — рисую как есть");
        this.rejectedOutfitOnce = "";
      } else {
        this.rejectedOutfitOnce = key;
        return {
          success: false,
          output:
            "Для кадра вдвоём назови, что НА НЁМ, в параметре his_outfit — одна короткая фраза: " +
            "«чёрная футболка», «рубашка нараспашку», «голый торс», «полотенце на бёдрах». " +
            "Без неё движок берёт его одежду прямо с его фото, и он выходит одинаковым в каждом кадре.",
        };
      }
    }

    const prompt = buildPairPrompt(fields, this.config.body ?? "", this.config.ownerBody ?? "", hisOutfit);
    // A pair frame is square or landscape. Two people side by side want the
    // width, and a requested portrait leaves one of them cropped or floating —
    // so in a pair the square stands in for the vertical, and the scene picks
    // between square and landscape. Solo keeps the full set; only this path
    // narrows it. The owner ruled this: horizontal pair shots come out well, and
    // the tall frames do not.
    const asked = sizeFor(format);
    const { width, height } = asked.height > asked.width ? sizeFor("1:1") : asked;
    try {
      const herName = await comfy.upload(fs.readFileSync(herFile), `eva_ref${path.extname(herFile) || ".jpg"}`, this.mimeOf(herFile));
      const ownerName = await comfy.upload(fs.readFileSync(ownerFile), `eva_owner${path.extname(ownerFile) || ".jpg"}`, this.mimeOf(ownerFile));
      const image = await comfy.generate(
        buildWorkflow({
          prompt,
          referenceName: herName,
          referenceName2: ownerName,
          filenamePrefix: "eva/couple",
          width,
          height,
        }),
      );
      console.log("📸 Парный кадр OK (comfy, qwen-image-2.1-turbo, +2 референса)");
      return { success: true, output: "Парный кадр отправлен в чат (файла нет — отдельно слать нечего)" + frameNote(image), mediaUrl: image };
    } catch (err) {
      console.error(`📸 Парный кадр: comfy failed: ${err instanceof Error ? err.message : err}`);
      return {
        success: false,
        output: `Не вышло сгенерировать парный кадр: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
      // The face line belongs only where a reference actually travels. The
      // dedicated /images/generations endpoint takes no photo, so it gets the
      // base prompt (see the wrong-door branch below).
      const text = refUrl ? `${FACE_FROM_REFERENCE} ${prompt}` : prompt;
      const content: unknown = refUrl
        ? [
            { type: "text", text },
            { type: "image_url", image_url: { url: refUrl } },
          ]
        : text;
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
      return { success: true, output: `Селфи сгенерировано${noFace}` + frameNote(first.image), mediaUrl: first.image };
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
      return { success: true, output: "Селфи сгенерировано" + frameNote(second.image), mediaUrl: second.image };
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

