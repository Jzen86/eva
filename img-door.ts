/**
 * The cheap models are not chat models, and that is the whole reason Eva pays
 * $0.0672 a picture: her image tool only speaks `chat/completions`, and every
 * model that can return an image through it is a premium one. The cheap ones
 * want a different endpoint, and until something here can call that endpoint
 * they are unreachable no matter what they charge.
 *
 * So: try both doors. `modalities: ["image"]` alone may satisfy the Grok models on
 * the chat endpoint, and `/api/v1/images` is what the error message points at for
 * the dedicated generators. The point is to find out what shape the answer comes
 * back in, so the tool can be taught to ask properly.
 */
import { loadConfig } from "./src/core/config.js";

process.env.EVA_CONFIG_PATH = "/root/.eva/config.yaml";
const cfg = loadConfig() as unknown as {
  providers: Record<string, { base_url: string; api_key: string }>;
};
const or = cfg.providers.openrouter;
const headers = { Authorization: `Bearer ${or.api_key}`, "Content-Type": "application/json" };
const POST = (p: string, body: unknown) =>
  fetch(`${or.base_url}${p}`, { method: "POST", headers, body: JSON.stringify(body) });

// --- door one: chat endpoint, image modality only --------------------------
console.log("=== дверь 1: /chat/completions с modalities: [image] ===");
for (const id of ["x-ai/grok-imagine-image-2.0", "x-ai/grok-imagine-image-quality"]) {
  const res = await POST("/chat/completions", {
    model: id,
    messages: [{ role: "user", content: "Нарисуй: красная точка на белом фоне." }],
    modalities: ["image"],
  });
  const body = await res.text();
  console.log(`  ${id.padEnd(34)} ${res.status}  ${body.replace(/\s+/g, " ").slice(0, 130)}`);
}

// --- door two: the images endpoint ------------------------------------------
console.log("\n=== дверь 2: /images/generations ===");
for (const id of ["meta/muse-image", "qwen/qwen-image-3", "inclusionai/ming-image-0.1-design"]) {
  for (const path of ["/images/generations", "/images"]) {
    const res = await POST(path, {
      model: id,
      prompt: "A red dot on a white background, minimal",
    });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body) as { data?: Array<{ url?: string; b64_json?: string }> };
      const item = j.data?.[0];
      console.log(`  ${id.padEnd(34)} ${path} -> 200`);
      console.log(`     ключи ответа: ${Object.keys(j).join(", ")} | в data: ${item ? Object.keys(item).join(", ") : "нет"}`);
      if (item?.url) {
        const img = await fetch(item.url);
        console.log(`     картинка скачивается: ${img.status}, ${(await img.arrayBuffer()).byteLength} байт`);
      }
      if (item?.b64_json) console.log(`     b64_payload: ${item.b64_json.length} символов`);
      break;
    }
    console.log(`  ${id.padEnd(34)} ${path} -> ${res.status}  ${body.replace(/\s+/g, " ").slice(0, 100)}`);
  }
}

// --- and the reference-photo path, which is what a selfie needs ------------
console.log("\n=== дверь 2b: /images/edits с референсом ===");
const img = await fetch("https://placehold.co/64x64/ff0000/ff0000.png");
const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");
for (const id of ["meta/muse-image"]) {
  const form = new FormData();
  form.append("model", id);
  form.append("prompt", "Same but with a blue dot");
  form.append("image", new Blob([Buffer.from(b64, "base64")], { type: "image/png" }), "ref.png");
  const res = await fetch(`${or.base_url}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${or.api_key}` },
    body: form,
  });
  const body = await res.text();
  console.log(`  ${id} /images/edits -> ${res.status}  ${body.replace(/\s+/g, " ").slice(0, 180)}`);
}
