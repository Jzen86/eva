/**
 * The chain, checked the way the router would actually ask for it.
 *
 * My first pass built `.../models/{provider}/{model}/endpoints` and read the 404s
 * as "these links are dead". They are not evidence of anything: three of these
 * ids already carry a vendor in their name, so the URL had three path segments
 * where the endpoint wants two, and every one of them 404'd on a malformed path
 * rather than on a missing model. The fix is to ask with the same composed id the
 * client uses, so a 404 means the model is gone and not that I built the address
 * wrong — which is the difference between "your rescue chain is a fiction" and
 * "your rescue chain is fine", a very expensive thing to get backwards.
 */
import { loadConfig, toRegistryConfig } from "./src/core/config.js";
import { ProviderRegistry } from "./src/core/llm/registry.js";

process.env.EVA_CONFIG_PATH = "/root/.eva/config.yaml";
const config = loadConfig("/root/.eva/config.yaml")!;
const registry = new ProviderRegistry(toRegistryConfig(config));
const orKey = registry.toConfig().providers.openrouter?.api_key ?? "";

console.log(`первичная роль fast: ${registry.label(registry.role("fast")!)}\n`);
console.log("цепочка запасных — как её спросит роутер:");

for (const ref of registry.fallbackList()) {
  // The id the client puts on the wire: `${provider}/${model}`.
  const wireId = `${ref.provider}/${ref.model}`;
  const res = await fetch(`https://openrouter.ai/api/v1/models/${wireId}/endpoints`, {
    headers: { Authorization: `Bearer ${orKey}` },
  }).catch(() => null);
  let verdict = "НЕ ПРОВЕРЕНО";
  if (res?.ok) {
    const j = (await res.json()) as {
      data?: { endpoints?: Array<{ pricing?: Record<string, string> }> };
    };
    const eps = j.data?.endpoints ?? [];
    const p = eps[0]?.pricing ?? {};
    const inTok = Number(p.prompt);
    const outTok = Number(p.completion);
    verdict = `ЖИВАЯ  эндпоинтов ${eps.length}  вход $${(inTok * 1e6).toFixed(3)}/1M  выход $${(outTok * 1e6).toFixed(3)}/1M`;
  } else {
    verdict = `НЕТ (${res?.status ?? "ошибка"})`;
  }
  console.log(`  ${wireId.padEnd(48)} ${verdict}`);
}

// And the primary, for comparison.
const fast = registry.role("fast")!;
const fastRes = await fetch(`https://openrouter.ai/api/v1/models/${fast.provider}/${fast.model}/endpoints`, {
  headers: { Authorization: `Bearer ${orKey}` },
}).catch(() => null);
console.log(`\nдля сравнения, первичная: ${fast.provider}/${fast.model} -> ${fastRes?.status === 200 ? "по этому адресу не проверяется, она не openrouter" : "не openrouter, адрес неприменим"}`);
