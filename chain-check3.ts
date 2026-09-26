/**
 * Third pass, and this time the id is taken from the code rather than composed
 * by hand.
 *
 * The first pass prefixed the provider, the second did it again, and both times
 * the 404s came from an address the client would never send. What goes on the
 * wire is `ref.model` and nothing else — `createOpenAICompatClient({ model:
 * ref.model })` — so `qwen/qwen3.8-27b:free` is asked for as exactly that, and
 * `openrouter/free` as exactly that. Two wrong probes in a row is the reason this
 * file reads the registry instead of building strings.
 */
import { loadConfig, toRegistryConfig } from "./src/core/config.js";
import { ProviderRegistry } from "./src/core/llm/registry.js";

process.env.EVA_CONFIG_PATH = "/root/.eva/config.yaml";
const config = loadConfig("/root/.eva/config.yaml")!;
const registry = new ProviderRegistry(toRegistryConfig(config));
const orKey = registry.toConfig().providers.openrouter?.api_key ?? "";

const ask = async (id: string): Promise<string> => {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, {
    headers: { Authorization: `Bearer ${orKey}` },
  }).catch(() => null);
  if (!res) return "ошибка сети";
  if (!res.ok) return `нет (${res.status})`;
  const j = (await res.json()) as { data?: { endpoints?: Array<{ pricing?: Record<string, string> }> } };
  const eps = j.data?.endpoints ?? [];
  if (eps.length === 0) return "страница есть, эндпоинтов 0";
  const p = eps[0].pricing ?? {};
  return `ЖИВАЯ  эндп. ${eps.length}  вход $${(Number(p.prompt) * 1e6).toFixed(3)}/1M  выход $${(Number(p.completion) * 1e6).toFixed(3)}/1M`;
};

console.log("цепочка — модель ровно та, что уходит в теле запроса:\n");
for (const ref of registry.fallbackList()) {
  console.log(`  ${ref.model.padEnd(42)} ${await ask(ref.model)}`);
}

const fast = registry.role("fast")!;
console.log(`\nпервичная fast: ${fast.provider}/${fast.model} (не openrouter, через свой адрес)`);

// What the client really sends, straight from the registry's own state.
console.log("\nдля сверки: что вернёт роутер при отказе основной модели");
for (const ref of registry.fallbackList()) {
  const spec = registry.toConfig().providers[ref.provider];
  const isOpenRouter = spec?.base_url?.includes("openrouter");
  console.log(`  ${spec?.base_url?.replace(/^https?:\/\//, "").slice(0, 28) ?? "?"}…  модель ${ref.model}`);
  if (!isOpenRouter) break;
}
