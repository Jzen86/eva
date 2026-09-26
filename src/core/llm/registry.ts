import { createOpenAICompatClient } from "./providers/openai-compat.js";
import type { LLMClient } from "./types.js";

/** A provider is just an address plus a key. Anything that speaks OpenAI fits. */
export interface ProviderSpec {
  base_url: string;
  api_key: string;
  headers?: Record<string, string>;
  /** Set false if the endpoint rejects stream_options. Default true. */
  stream_usage?: boolean;
}

/** A model is a provider plus a model id. */
export interface ModelRef {
  provider: string;
  model: string;
}

export type Roles = Record<string, ModelRef>;

export interface RegistryConfig {
  providers: Record<string, Partial<ProviderSpec>>;
  models: Roles;
  fallbacks: ModelRef[];
}

/**
 * Ready-made provider definitions. A config that only lists the provider name
 * gets the base URL and headers for free:
 *
 *   providers:
 *     openrouter: {}            # enough
 *     openai: {}
 *     google: {}
 *     my-server:                # self-hosted, everything explicit
 *       base_url: http://127.0.0.1:1234/v1
 *       api_key: whatever
 */
export const PROVIDER_PRESETS: Record<string, ProviderSpec> = {
  openrouter: {
    base_url: "https://openrouter.ai/api/v1",
    api_key: "",
    // OpenRouter ranks by these; harmless elsewhere.
    headers: { "HTTP-Referer": "https://github.com/Jzen86/eva", "X-Title": "Eva" },
  },
  openai: { base_url: "https://api.openai.com/v1", api_key: "" },
  google: {
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    api_key: "",
  },
  groq: { base_url: "https://api.groq.com/openai/v1", api_key: "" },
  deepseek: { base_url: "https://api.deepseek.com/v1", api_key: "" },
  together: { base_url: "https://api.together.xyz/v1", api_key: "" },
  cerebras: { base_url: "https://api.cerebras.ai/v1", api_key: "" },
  openai_compatible: { base_url: "", api_key: "" },
};

export class UnknownProviderError extends Error {
  constructor(id: string, known: string[]) {
    super(`Unknown provider "${id}". Known: ${known.join(", ") || "(none)"}`);
    this.name = "UnknownProviderError";
  }
}

export class IncompleteProviderError extends Error {
  constructor(id: string) {
    super(`Provider "${id}" has no base_url or api_key — fill it in under providers.${id} in config.yaml`);
    this.name = "IncompleteProviderError";
  }
}

const MAX_CACHED_CLIENTS = 32;

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderSpec>();
  private readonly roles = new Map<string, ModelRef>();
  private readonly clientCache = new Map<string, LLMClient>();
  private fallbacks: ModelRef[] = [];
  /** Called after any change so the caller can write the config back to disk. */
  private persist: (() => void) | null = null;

  constructor(cfg: RegistryConfig) {
    for (const [id, partial] of Object.entries(cfg.providers ?? {})) {
      const preset = PROVIDER_PRESETS[id];
      this.providers.set(id, {
        base_url: partial.base_url ?? preset?.base_url ?? "",
        api_key: partial.api_key ?? preset?.api_key ?? "",
        headers: { ...preset?.headers, ...partial.headers },
        ...(partial.stream_usage === undefined ? {} : { stream_usage: partial.stream_usage }),
      });
    }
    for (const [role, ref] of Object.entries(cfg.models ?? {})) {
      this.roles.set(role, { ...ref });
    }
    this.fallbacks = (cfg.fallbacks ?? []).map((f) => ({ ...f }));
  }

  /** Register a change handler. Without it the registry still works, it just
   *  won't write through to config.yaml. */
  onChange(fn: () => void): void {
    this.persist = fn;
  }

  // --- reads -----------------------------------------------------------------

  providerIds(): string[] {
    return [...this.providers.keys()];
  }

  rolesList(): Roles {
    return Object.fromEntries([...this.roles.entries()].map(([k, v]) => [k, { ...v }]));
  }

  fallbackList(): ModelRef[] {
    return this.fallbacks.map((f) => ({ ...f }));
  }

  /** Human-readable "provider/model" label. */
  label(ref: ModelRef): string {
    return `${ref.provider}/${ref.model}`;
  }

  private resolveProvider(id: string): ProviderSpec {
    const spec = this.providers.get(id);
    if (!spec) throw new UnknownProviderError(id, this.providerIds());
    if (!spec.base_url || !spec.api_key) throw new IncompleteProviderError(id);
    return spec;
  }

  /** Is this provider configured enough to be used? */
  isUsable(id: string): boolean {
    const spec = this.providers.get(id);
    return Boolean(spec?.base_url && spec?.api_key);
  }

  role(name: string): ModelRef | undefined {
    const ref = this.roles.get(name);
    return ref ? { ...ref } : undefined;
  }

  /**
   * A client for a model reference. Cached by provider+model, so repeated calls
   * for the same model reuse one HTTP client (and its connection pool).
   */
  client(ref: ModelRef): LLMClient {
    const key = `${ref.provider}\\0${ref.model}`;
    const hit = this.clientCache.get(key);
    if (hit) {
      // Refresh LRU position.
      this.clientCache.delete(key);
      this.clientCache.set(key, hit);
      return hit;
    }

    const spec = this.resolveProvider(ref.provider);
    const client = createOpenAICompatClient({
      baseURL: spec.base_url,
      apiKey: spec.api_key,
      model: ref.model,
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.stream_usage === undefined ? {} : { streamUsage: spec.stream_usage }),
      ...(echoesToolContent(spec.base_url)
        ? { echoProviderToolContent: true }
        : {}),
    });

    this.clientCache.set(key, client);
    while (this.clientCache.size > MAX_CACHED_CLIENTS) {
      const oldest = this.clientCache.keys().next();
      if (oldest.done) break;
      this.clientCache.delete(oldest.value);
    }
    return client;
  }

  /** The fallback chain, skipping anything that is not configured. */
  usableFallbacks(): ModelRef[] {
    return this.fallbacks.filter((f) => this.isUsable(f.provider));
  }

  // --- writes ----------------------------------------------------------------

  setRole(name: string, ref: ModelRef): void {
    this.roles.set(name, { ...ref });
    this.persist?.();
  }

  addProvider(id: string, spec: ProviderSpec): void {
    const preset = PROVIDER_PRESETS[id];
    this.providers.set(id, {
      base_url: spec.base_url,
      api_key: spec.api_key,
      headers: { ...preset?.headers, ...spec.headers },
      ...(spec.stream_usage === undefined ? {} : { stream_usage: spec.stream_usage }),
    });
    this.persist?.();
  }

  setFallbacks(refs: ModelRef[]): void {
    this.fallbacks = refs.map((f) => ({ ...f }));
    this.persist?.();
  }

  /** Serialisable snapshot for config.yaml. */
  toConfig(): RegistryConfig {
    return {
      providers: Object.fromEntries(
        [...this.providers.entries()].map(([id, spec]) => {
          const out: Partial<ProviderSpec> = {};
          if (spec.base_url) out.base_url = spec.base_url;
          if (spec.api_key) out.api_key = spec.api_key;
          if (spec.headers && Object.keys(spec.headers).length) out.headers = spec.headers;
          if (spec.stream_usage !== undefined) out.stream_usage = spec.stream_usage;
          return [id, out];
        }),
      ),
      models: this.rolesList(),
      fallbacks: this.fallbackList(),
    };
  }
}

/**
 * Does this endpoint want the opaque blob it attached to its tool calls?
 *
 * Google Gemini 3 puts `thought_signature` on every function call and answers
 * the follow-up with `400 Function call is missing a thought_signature in
 * functionCall parts` — an error with no body, naming a docs page instead of
 * the field that was dropped. Every other endpoint either sends nothing or
 * rejects an unrecognised field, so the answer has to be per provider.
 *
 * Matched on the host rather than on a config flag because the signature travels
 * in the conversation history, not in the config: a flag that said "echo this"
 * without saying "for whom" would break the moment he switched a role to
 * OpenRouter mid-chat and the old token went out to a provider that 400s on
 * unknown fields. The history stays provider-agnostic and the client decides.
 */
export function echoesToolContent(baseUrl: string): boolean {
  return /(^|\/\/|\.)generativelanguage\.googleapis\.com(\/|$|:)/i.test(baseUrl);
}

/**
 * Which models a provider offers. Handles both `{data:[{id}]}` and `{models:[{name}]}`.
 *
 * Ids come back exactly as the provider spells them, minus one exception:
 * Google's OpenAI-compatible endpoint lists `models/gemini-2.5-flash`, which is
 * a resource path, and sending that to the chat endpoint is a 400. OpenRouter
 * spells the same kind of thing `openai/gpt-4o` and means it, so the prefix
 * cannot be stripped generically — only the literal `models/`, which is Google's
 * path segment and not part of anyone's model name.
 *
 * The reason to normalise here rather than at the call site: the whole point of
 * this list is that its entries go straight back into `action=switch`. A list
 * that reads like a menu and is not a menu is worse than no list, because the
 * model picks from it confidently and the switch then fails on a name the tool
 * itself printed.
 */
export async function listProviderModels(spec: ProviderSpec): Promise<string[]> {
  const url = `${spec.base_url.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${spec.api_key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as {
    data?: Array<{ id?: string; name?: string }>;
    models?: Array<{ id?: string; name?: string }>;
  };
  const rows = data.data ?? data.models ?? [];
  return rows
    .map((r) => r.id ?? r.name)
    .filter((x): x is string => Boolean(x))
    .map((x) => x.replace(/^models\//, ""))
    .sort();
}
