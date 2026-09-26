/**
 * Find an image model that is actually free, and prove it by drawing with it.
 *
 * The price list says what a model should cost; only a generation says whether
 * it can be reached at all. My earlier attempt at the three cheap candidates
 * reported 404 — on a URL I had built wrong, so that told us nothing either way.
 * Redone with the id the client actually sends, and then a real picture at 64px
 * to keep the cost in the fractions of a cent.
 *
 * Also measured here, because it decides what "free" means: a picture is about
 * 1120 output tokens, so a rate of 0.000002 per token is $0.0022 a picture, and
 * 0.0000000 is genuinely free.
 */

import { loadConfig } from "./src/core/config.js";

process.env.EVA_CONFIG_PATH = "/root/.eva/config.yaml";
const cfg = loadConfig() as unknown as {
  providers: Record<string, { base_url: string; api_key: string }>;
  selfies: { openrouter_model: string };
};
const or = cfg.providers.openrouter;

const candidates = [
  "inclusionai/ming-image-0.1-design",
  "meta/muse-image",
  "qwen/qwen-image-3",
  "x-ai/grok-imagine-image-2.0",
  "qwen/qwen-image-3-pro",
  "x-ai/grok-imagine-image-quality",
  "google/gemini-3.1-flash-lite-image",
  cfg.selfies.openrouter_model,
];

interface Live {
  id: string;
  rate: number;
  endpoints: number;
  takesPhoto: boolean;
}

const live: Live[] = [];

for (const id of candidates) {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, {
    headers: { Authorization: `Bearer ${or.api_key}` },
  }).catch(() => null);
  if (!res?.ok) {
    console.log(`${id.padEnd(40)} нет эндпоинтов (${res?.status ?? "ошибка"})`);
    continue;
  }
  const j = (await res.json()) as {
    data?: {
      endpoints?: Array<{ pricing?: Record<string, string> }>;
      architecture?: { input_modalities?: string[] };
    };
  };
  const eps = j.data?.endpoints ?? [];
  const rate = Number(eps[0]?.pricing?.image_output ?? NaN);
  const takesPhoto = (j.data?.architecture?.input_modalities ?? []).includes("image");
  const perImage = Number.isFinite(rate) ? rate * 1120 : NaN;
  console.log(
    `${id.padEnd(40)} живая  эндп. ${eps.length}  $${Number.isFinite(rate) ? rate.toFixed(7) : "?"}/токен  → $${Number.isFinite(perImage) ? perImage.toFixed(5) : "?"}/картинка  фото:${takesPhoto ? "да" : "нет"}`,
  );
  if (eps.length > 0 && Number.isFinite(rate)) live.push({ id, rate, endpoints: eps.length, takesPhoto });
}

// Draw with the cheapest one that can take a reference photo, and with the free
// one even though it cannot — to see what it returns when asked.
const tryDraw = async (id: string, withReference: boolean) => {
  const t0 = Date.now();
  const messages: unknown[] = [{ role: "user", content: "Нарисуй: красная точка на белом фоне." }];
  if (withReference) {
    const img = await fetch("https://placehold.co/64x64/ff0000/ff0000.png");
    const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");
    messages[0] = {
      role: "user",
      content: [
        { type: "text", text: "Сделай так же, но синюю точку." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    };
  }
  const res = await fetch(`${or.base_url}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${or.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: id, messages, modalities: ["image", "text"] }),
  });
  const body = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(`  ${id} -> ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 150)}`);
    return;
  }
  let outTokens = NaN;
  let hasImage = false;
  try {
    const j = JSON.parse(body) as {
      choices?: Array<{ message?: { images?: unknown[] } }>;
      usage?: { completion_tokens?: number };
    };
    outTokens = j.usage?.completion_tokens ?? NaN;
    hasImage = Boolean(j.choices?.[0]?.message?.images?.length);
  } catch {
    /* reported below by the raw check */
  }
  hasImage = hasImage || /image_url|data:image/.test(body);
  const cost = Number.isFinite(outTokens) ? outTokens * (live.find((l) => l.id === id)?.rate ?? NaN) : NaN;
  console.log(
    `  ${id} -> 200 за ${ms}мс  картинка: ${hasImage ? "ЕСТЬ" : "нет"}  вых. токенов ${outTokens}  цена $${Number.isFinite(cost) ? cost.toFixed(5) : "?"}`,
  );
};

console.log("\n=== рисуем по-настоящему ===");
const withPhoto = live.filter((l) => l.takesPhoto).sort((a, b) => a.rate - b.rate);
const withoutPhoto = live.filter((l) => !l.takesPhoto).sort((a, b) => a.rate - b.rate);

for (const c of withPhoto.slice(0, 3)) await tryDraw(c.id, true);
for (const c of withoutPhoto.slice(0, 1)) await tryDraw(c.id, false);
