/**
 * Is the rescue chain still real?
 *
 * Google is the primary and the Google quota is reported badly by Google, and the
 * key's origin is unknown — so the thing that must not be assumed is the fallback
 * chain. Four of the five links are `:free` builds, and a free build is a
 * catalogue entry today and a 404 next month. A chain that names a model the
 * provider has dropped is worse than no chain, because it looks like coverage.
 *
 * Catalogue reads only: `GET /api/v1/models` costs nothing and does not appear
 * in the activity log, so this does not pollute the window the owner is watching.
 */
import { loadConfig, toRegistryConfig } from "./src/core/config.js";
import { ProviderRegistry } from "./src/core/llm/registry.js";

process.env.EVA_CONFIG_PATH = "/root/.eva/config.yaml";
const config = loadConfig("/root/.eva/config.yaml")!;
const registry = new ProviderRegistry(toRegistryConfig(config));

const refs = registry.fallbackList();
console.log(`запасных в конфиге: ${refs.length}\n`);

const catalogue = new Map<string, Record<string, unknown>>();
for (const p of ["openrouter", "google"]) {
  const spec = registry.toConfig().providers[p];
  if (!spec?.base_url) continue;
  const res = await fetch(`${spec.base_url.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${spec.api_key}` },
  }).catch(() => null);
  if (!res?.ok) {
    console.log(`${p}: /models -> ${res?.status ?? "ошибка"}`);
    continue;
  }
  const j = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> };
  for (const m of j.data ?? j.models ?? []) {
    const id = m.id ?? m.name;
    if (id) catalogue.set(id, m);
  }
  console.log(`${p}: моделей в меню ${catalogue.size}`);
}

console.log("\nкаждая ссылка цепочки:");
for (const ref of refs) {
  // Google lists ids as `models/x`, OpenRouter as `vendor/x`; accept either.
  const inCatalogue =
    catalogue.has(ref.model) || catalogue.has(`models/${ref.model}`) || catalogue.has(`google/${ref.model}`);
  const res = await fetch(`https://openrouter.ai/api/v1/models/${ref.provider}/${ref.model}/endpoints`, {
    headers: { Authorization: `Bearer ${registry.toConfig().providers.openrouter?.api_key ?? ""}` },
  }).catch(() => null);
  const callable = res?.ok ?? false;
  console.log(
    `  ${ref.provider}/${ref.model.padEnd(40)} в меню: ${inCatalogue ? "да" : "НЕТ "}   вызывается: ${callable ? "да" : "НЕТ "}`,
  );
}
