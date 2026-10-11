import { randomUUID } from "node:crypto";

/**
 * Local image generation through ComfyUI.
 *
 * The graph is ours and only ours: its own node ids, its own output folder
 * (`eva/`), its own uploaded reference names (`eva_ref_*`). The owner's
 * workflows live in the same ComfyUI and use custom nodes and prefixes of their
 * own; nothing here reads or writes them.
 */

export const COMFY_UNET = "qwen-image-2.1-turbo-int8-convrot.safetensors";
export const COMFY_CLIP = "qwen3vl_8b_int8_convrot.safetensors";
export const COMFY_VAE = "qwen_image_2.1_vae_bf16.safetensors";

export interface ComfyGraphOptions {
  prompt: string;
  seed?: number;
  /** Uploaded reference image name, as returned by /upload/image. */
  referenceName?: string;
  filenamePrefix?: string;
  /** Output size. Defaults to 1024×1024 (1:1). */
  width?: number;
  height?: number;
  /** How the reference is scaled for the encoder. Defaults to 1024, to match output. */
  resolution?: number;
}

/**
 * Output formats on a 1024 base: the short side is 1024, the long side grows to
 * the ratio, every side a multiple of 32. Qwen-Image 2.1's own default is one
 * megapixel (1024x1024) and its native 2K is four; what carries the detail is the
 * short side, and 768 sat under it — the skin went soft and mottled there.
 * 2:3 is the tallest frame, for a full body that should fill the shot; 9:16 fills
 * a phone screen; 3:4 the usual portrait; 4:5 the feed-shaped one that keeps a
 * little more in frame; 1:1 the close-up square; 4:3 when the scene needs width.
 */
export const FORMATS = {
  "1:1": { width: 1024, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
  "3:4": { width: 1024, height: 1376 },
  "4:5": { width: 1024, height: 1280 },
  "9:16": { width: 1024, height: 1824 },
  "4:3": { width: 1376, height: 1024 },
} as const;

export type AspectFormat = keyof typeof FORMATS;

/** Size for a named format; anything unknown falls back to 1:1. */
export function sizeFor(format: string | undefined): { width: number; height: number } {
  return FORMATS[(format ?? "") as AspectFormat] ?? FORMATS["1:1"];
}

/**
 * The frame as an images API wants it.
 *
 * The local graph takes any size we ask for, but the cloud endpoints accept a
 * short list — 1024x1024, 1024x1536, 1536x1024 — and anything else comes back
 * rejected or silently coerced. So the frame travels as its shape rather than
 * its numbers: portrait, landscape, square.
 */
export function cloudSizeFor(size: { width: number; height: number }): string {
  if (size.height > size.width) return "1024x1536";
  if (size.width > size.height) return "1536x1024";
  return "1024x1024";
}

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** The picture graph: text-to-image alone, or reference-editing when a photo is given. */
export function buildWorkflow(opts: ComfyGraphOptions): ComfyGraph {
  const hasRef = Boolean(opts.referenceName);
  const graph: ComfyGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: COMFY_UNET, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: COMFY_CLIP, type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: COMFY_VAE } },
    "4": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto", dtype: "default" } },
    // The encoder is the whole ballgame for the face.
    //
    // With a reference the graph uses TextEncodeQwenImageEditPlus: it feeds the
    // reference's vision tokens *and* its VAE latents into the model, so the text
    // prompt edits that woman rather than describing a new one. The plain
    // TextEncodeQwenImage21 drops the vision tokens the moment a reference latent
    // is present, and then a long figure description simply overrides the face.
    // Measured on the live reference, one seed per row: EditPlus kept her face on
    // 4 of 4 seeds; the 21-encoder drew a different woman on 2 of them, both times
    // with the long body text in the prompt and never without it.
    //
    // Without a reference (image_gen) there is nothing to edit, so the 21-encoder
    // is the plain text-to-image path, negative prompt and all.
    "5": hasRef
      ? {
          class_type: "TextEncodeQwenImageEditPlus",
          inputs: { clip: ["2", 0], prompt: opts.prompt, vae: ["3", 0], image1: ["6", 0] },
        }
      : {
          class_type: "TextEncodeQwenImage21",
          inputs: {
            clip: ["2", 0],
            prompt: opts.prompt,
            negative_prompt: "",
            resolution: opts.resolution ?? 1024,
            vae: ["3", 0],
          },
        },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        seed: opts.seed ?? Math.floor(Math.random() * 2 ** 31),
        steps: 8,
        cfg: 1,
        sampler_name: "euler",
        // Two schedules, because the reference changes what the sampler is for.
        // With a reference the photo carries the structure, and `simple`'s fine
        // low-frequency tail only adds life — that is what the selfie has always
        // looked like. Without one the model builds the anatomy itself, and the
        // same tail invents a crease across the belly and veins on the forearms:
        // measured at 768x1152, `simple` grew both, `linear_quadratic` on the same
        // seed and prompt had neither.
        scheduler: hasRef ? "simple" : "linear_quadratic",
        positive: ["5", 0],
        // EditPlus has a single output; the 21-encoder has positive and negative.
        // cfg is 1, so the negative has no effect either way.
        negative: hasRef ? ["5", 0] : ["5", 1],
        latent_image: ["9", 0],
        denoise: 1,
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    // The empty latent sets the output size — the node's own latent output is
    // sized to the reference (square), which would pin every frame to 1:1 and
    // ignore 3:4 / 4:3. Measured: a 768×1024 empty latent renders 3:4 with the
    // face intact, so the size is what decides the frame, not the reference.
    "9": {
      class_type: "EmptyLatentImage",
      inputs: { width: opts.width ?? 1024, height: opts.height ?? 1024, batch_size: 1 },
    },
    "10": {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: opts.filenamePrefix ?? "eva/img" },
    },
  };

  if (opts.referenceName) {
    // Node 6 is the reference photo; node 5 (built above) points its image1 here.
    graph["6"] = { class_type: "LoadImage", inputs: { image: opts.referenceName } };
  }

  return graph;
}

export interface ComfyClientOptions {
  baseUrl: string;
  /** Whole-job budget. A cold model load on 12 GB VRAM is slow, not stuck. */
  timeoutMs?: number;
  pollMs?: number;
}

export class ComfyClient {
  private baseUrl: string;
  private timeoutMs: number;
  private pollMs: number;
  private clientId = randomUUID();

  constructor(opts: ComfyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.pollMs = opts.pollMs ?? 1_500;
  }

  /** Uploads a reference picture to ComfyUI's input folder and returns its name. */
  async upload(bytes: Buffer, filename: string, mime: string): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.append("overwrite", "true");
    const res = await fetch(`${this.baseUrl}/upload/image`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`comfy upload ${res.status}`);
    const json = (await res.json()) as { name?: string };
    if (!json.name) throw new Error("comfy upload: no name in response");
    return json.name;
  }

  /** Runs a graph and returns the first picture as a data URL. */
  async generate(graph: ComfyGraph): Promise<string> {
    const queued = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    if (!queued.ok) throw new Error(`comfy prompt ${queued.status}`);
    const { prompt_id } = (await queued.json()) as { prompt_id: string };

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      const hist = await fetch(`${this.baseUrl}/history/${prompt_id}`);
      if (!hist.ok) continue;
      const entry = ((await hist.json()) as Record<string, ComfyHistory>)[prompt_id];
      if (!entry) continue;
      if (entry.status?.status_str === "error") throw new Error("comfy job failed");
      const image = firstImage(entry.outputs);
      if (!image) throw new Error("comfy: no image in outputs");
      const view = await fetch(
        `${this.baseUrl}/view?${new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })}`,
      );
      if (!view.ok) throw new Error(`comfy view ${view.status}`);
      const b64 = Buffer.from(await view.arrayBuffer()).toString("base64");
      return `data:image/png;base64,${b64}`;
    }
    throw new Error("comfy timeout");
  }
}

interface ComfyImage {
  filename: string;
  subfolder: string;
  type: string;
}

interface ComfyHistory {
  status?: { status_str?: string };
  outputs?: Record<string, { images?: ComfyImage[] }>;
}

function firstImage(outputs: ComfyHistory["outputs"]): ComfyImage | undefined {
  if (!outputs) return undefined;
  for (const node of Object.values(outputs)) {
    const img = node.images?.[0];
    if (img) return img;
  }
  return undefined;
}
