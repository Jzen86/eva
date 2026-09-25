import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RegistryConfig, ModelRef } from "./llm/registry.js";

// Flexible schema that accepts both old and new config formats
/**
 * Personality is one object, never a union with a bare string.
 *
 * It used to be `string | object`, and that was a trap: a single bad type
 * (say `tone: 42`) made the whole union fail, the repair path in loadConfig
 * saw the issue at `agent.personality` rather than at the offending leaf, and
 * deleted the entire personality block. Eva came back with no tone, no
 * custom_instructions and no sliders, silently. String configs are converted
 * to the object form by normalizeConfig instead.
 */
/**
 * The 0-4 dials, in one place.
 *
 * They were spelled out twice: once in the schema, once — once there was a
 * string-coercion pass — as "every key under personality". The second version
 * turned `tone: "3"` into the number 3, because tone is free text and nobody
 * told the coercion which keys were dials. One list, used by the schema and by
 * the coercion, so the two cannot drift.
 */
const PERSONALITY_SLIDERS = [
  "formality",
  "emotionality",
  "humor",
  "confidence",
  "response_length",
  "structure",
  "emoji",
  "examples",
  "friendliness",
  "initiative",
  "curiosity",
  "empathy",
  "criticism",
] as const;

const personalitySchema = z.object({
    // Free-text fields
    tone: z.string().optional(),
    style: z.string().optional(),
    /**
     * Who she is, in her own words. Character, not rules.
     *
     * `custom_instructions` below used to hold both, and the mix was the
     * problem: rewriting her tone meant rewriting the server rules too, and
     * rules buried in a paragraph of character description are followed far
     * less reliably than a list. `persona` is the character half;
     * `ops` is the rules half, and the prompt renders them apart.
     */
    persona: z.string().optional(),
    /**
     * Standing rules for how she operates — a list, so each line is one rule
     * the model can hold on to. "Always reply in Russian", "never use bullet
     * points in chat", "call him Женя".
     */
    ops: z.array(z.string()).optional(),
    /**
     * The original single blob, still read and still rendered. Installs that
     * never split their config keep working untouched; anything new goes to
     * `persona` and `ops`.
     */
    custom_instructions: z.string().optional(),
    // Sliders (0-4)
    ...Object.fromEntries(
      PERSONALITY_SLIDERS.map((key) => [key, z.number().min(0).max(4).optional()]),
    ),
  }).optional();

const llmProviderSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  api_key: z.string(),
});

const llmSchema = z.union([
  // New flat format
  z.object({
    provider: z.string(),
    api_key: z.string(),
    fast_model: z.string().optional(),
    strong_model: z.string().optional(),
    fallback_models: z.array(z.string()).optional(),
  }),
  // Old nested format (fast/strong)
  z.object({
    fast: llmProviderSchema.optional(),
    strong: llmProviderSchema.optional(),
    fallback_models: z.array(z.string()).optional(),
  }),
]);

const modelRefSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

const providerSchema = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  stream_usage: z.boolean().optional(),
});

const configSchema = z.object({
  agent: z.object({
    name: z.string().default("Eva"),
    gender: z.enum(["female", "male"]).default("female"),
    personality: personalitySchema,
  }).default({ name: "Eva" }),

  owner: z.object({
    name: z.string().optional(),
    address_as: z.string().optional(),
    facts: z.array(z.string()).default([]),
  }).optional(),

  security: z.object({
    password_hash: z.string().optional(),
    tools: z.object({
      shell: z.boolean().default(true),
      ssh: z.boolean().default(false),
      browser: z.boolean().default(true),
      npm_install: z.boolean().default(true),
    }).optional(),
  }).optional(),

  llm: llmSchema.optional(),

  /**
   * The pluggable-provider layer. `providers` is a registry of endpoints,
   * `models` assigns endpoints to roles, `fallbacks` is the rescue chain.
   * Supersedes the flat `llm` block above, which is still read for migration.
   */
  providers: z.record(z.string(), providerSchema).optional(),
  models: z.record(z.string(), modelRefSchema).optional(),
  fallbacks: z.array(modelRefSchema).optional(),

  telegram: z.object({
    token: z.string(),
    streaming: z.boolean().optional(),
    owner_id: z.number().optional(),
  }).optional(),

  channels: z.record(z.string(), z.any()).optional(),

  memory: z.object({
    max_knowledge: z.number().default(200),
    study_interval_min: z.number().default(30),
    study_model: z.string().optional(),
    learning_enabled: z.boolean().default(true),
    context_budget: z.number().default(40000),
  }).default({}),

  plugins: z.array(z.string()).default([]),

  voice: z.record(z.string(), z.any()).optional(),
  video: z.record(z.string(), z.any()).optional(),
  selfies: z.record(z.string(), z.any()).optional(),
  sync_so: z.record(z.string(), z.any()).optional(),
  google: z.object({
    api_key: z.string(),
    cx: z.string(),
  }).optional(),
}).passthrough(); // Allow extra fields

export type EvaConfig = z.infer<typeof configSchema>;

export function getConfigDir(): string {
  // Plain relative segment: on Linux "\.eva" would become a literal filename.
  return path.join(os.homedir(), ".eva");
}

export function getConfigPath(customPath?: string): string {
  return customPath ?? process.env.EVA_CONFIG_PATH ?? path.join(getConfigDir(), "config.yaml");
}

/**
 * Turn `"12345"` into `12345` for the fields whose schema demands a number.
 *
 * Everything that feeds this config is a string at the edges: environment
 * variables, YAML written by hand, a `self_config` call from chat. Zod does not
 * coerce, so `owner_id: "12345"` failed validation, and the repair path in
 * loadConfig deleted the field. A bot with no owner id is a bot that answers
 * nobody, and the only warning in the log was one line naming a field nobody
 * looks at. Coerce instead of dropping.
 *
 * Only for keys the schema types as numbers, and only when the string is
 * actually a plain number — `"12abc"` stays a string and gets reported, since
 * that is a real typo rather than a quoting accident.
 */
function coerceNumericStrings(raw: Record<string, unknown>): void {
  const numeric = (obj: Record<string, unknown> | undefined, keys: string[]): void => {
    if (!obj) return;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed === "" || !/^-?\d+(\.\d+)?$/.test(trimmed)) continue;
      obj[key] = Number(trimmed);
    }
  };

  numeric(raw.telegram as Record<string, unknown> | undefined, ["owner_id"]);
  numeric(raw.memory as Record<string, unknown> | undefined, [
    "max_knowledge",
    "study_interval_min",
    "context_budget",
  ]);
  // Dials only. `tone` and `style` sit in the same object and are free text,
  // so a numeric-looking value there is a string and stays one.
  const agent = raw.agent as Record<string, unknown> | undefined;
  const personality = agent?.personality as Record<string, unknown> | undefined;
  if (personality && typeof personality === "object") {
    numeric(personality, [...PERSONALITY_SLIDERS]);
  }
}

/**
 * Convert a flat config (written by self_config tool) to the nested format
 * expected by the zod schema. Handles both flat and already-nested configs.
 */
function normalizeConfig(raw: Record<string, unknown>): Record<string, unknown> {
  // Older installs stored personality as a bare string of free-form
  // instructions. Fold it into the object shape so one schema covers both.
  if (raw.agent && typeof raw.agent === "object") {
    const agent = raw.agent as Record<string, unknown>;
    if (typeof agent.personality === "string") {
      agent.personality = { custom_instructions: agent.personality };
    }
    coerceNumericStrings(raw);
    return raw;
  }

  // Flat format → nested
  const out: Record<string, unknown> = {};

  // agent
  out.agent = {
    name: raw.name ?? "Eva",
    gender: raw.gender ?? "female",
    personality: {
      tone: raw.tone,
      style: raw.style,
      custom_instructions: raw.custom_instructions,
      response_style: raw.response_style,
    },
  };

  // telegram
  if (raw.token) {
    out.telegram = {
      token: raw.token,
      streaming: raw.streaming,
      owner_id: raw.owner_id,
    };
  }

  // llm — detect nested (fast/strong providers) vs flat
  if (raw.api_key || raw.provider) {
    out.llm = {
      fast: {
        provider: raw.provider ?? "openrouter",
        model: raw.model ?? raw.fast_model,
        api_key: raw.api_key,
      },
      strong: {
        provider: raw.provider ?? "openrouter",
        model: raw.strong_model ?? raw.model,
        api_key: raw.api_key,
      },
      fallback_models: raw.fallback_models,
    };
  }

  // memory
  out.memory = {
    max_knowledge: raw.max_knowledge ?? 200,
    study_interval_min: raw.study_interval_min ?? 30,
    study_model: raw.study_model,
    learning_enabled: raw.learning_enabled ?? true,
    context_budget: raw.context_budget ?? 40000,
  };

  // voice
  if (raw.tts_provider || raw.voice_id) {
    out.voice = {
      tts_provider: raw.tts_provider,
      voice_id: raw.voice_id,
      speed: raw.speed,
      pitch: raw.pitch,
      emotion: raw.emotion,
      openai_key: raw.openai_key,
    };
  }

  // selfies (fal.ai)
  if (raw.fal_api_key || raw.reference_photo_url) {
    out.selfies = {
      fal_api_key: raw.fal_api_key,
      reference_photo_url: raw.reference_photo_url,
    };
  }

  // plugins
  if (typeof raw.plugins === "string") {
    try { out.plugins = JSON.parse(raw.plugins); } catch { out.plugins = []; }
  } else if (Array.isArray(raw.plugins)) {
    out.plugins = raw.plugins;
  }

  return out;
}

export function loadConfig(customPath?: string): EvaConfig | null {
  const filePath = getConfigPath(customPath);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const normalized = normalizeConfig(parsed as Record<string, unknown>);

  const result = configSchema.safeParse(normalized);
  if (!result.success) {
    console.error("Config validation warnings:", result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", "));
    // Best-effort: strip invalid fields and retry
    for (const issue of result.error.issues) {
      let obj: Record<string, unknown> = normalized;
      const path = issue.path.slice(0, -1);
      const key = issue.path[issue.path.length - 1];
      for (const p of path) obj = obj[p] as Record<string, unknown>;
      if (obj && key !== undefined) delete obj[key as string];
    }
    return configSchema.parse(normalized);
  }
  return result.data;
}

/**
 * How many previous versions of the config to keep.
 *
 * A fixed count, not one file per save. Timestamped backups were unbounded:
 * the live install has 19 of them sitting next to the original, and the oldest
 * is the most useless one. Rotating slots keep the same safety with a known
 * ceiling.
 */
const CONFIG_BACKUPS = 5;

/**
 * Write the config without ever leaving it half-written.
 *
 * The order matters. Validate first, so a rejected config leaves the working
 * one in place instead of costing a boot. Then write to a temp file in the
 * same directory, flush it to disk, and rename over the target — rename is
 * atomic within a filesystem, so a crash or a full disk mid-write leaves the
 * previous config intact. Writing straight to the path did neither: a
 * truncated YAML file is an agent that will not start, with nothing to
 * indicate why.
 */
export function saveConfig(config: EvaConfig, customPath?: string): void {
  const filePath = getConfigPath(customPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const yaml = stringifyYaml(config);

  // Refuse to save something that will not load. Reading is tolerant on
  // purpose — foreign files get repaired field by field — but what we write
  // back is our own state and by construction has to be valid. If it is not,
  // that is a bug worth hearing about rather than a config to discover broken.
  const check = configSchema.safeParse(
    normalizeConfig(parseYaml(yaml) as Record<string, unknown>),
  );
  if (!check.success) {
    const issues = check.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join(", ");
    throw new Error(`Config not saved — it would not load back: ${issues}`);
  }

  // Snapshot what is on disk now, before it is replaced — that is the state a
  // bad write needs to be undone to. Doing this after the write would put a
  // copy of the fresh file in bak.1 and leave nothing to roll back to.
  rotateConfigBackups(filePath);

  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, yaml, "utf-8");
      // Without the flush the rename can land before the bytes do.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file is in the way of nothing important.
    }
    throw err;
  }
}

/** Shift `bak.1..bak.N` up, drop the oldest, and snapshot the live file into `bak.1`. */
function rotateConfigBackups(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const oldest = `${filePath}.bak.${CONFIG_BACKUPS}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = CONFIG_BACKUPS - 1; i >= 1; i--) {
      const from = `${filePath}.bak.${i}`;
      if (fs.existsSync(from)) fs.copyFileSync(from, `${filePath}.bak.${i + 1}`);
    }
    fs.copyFileSync(filePath, `${filePath}.bak.1`);
  } catch (err) {
    // Backups are insurance, not the write itself. Losing them must not fail
    // a config save that already succeeded.
    console.warn(
      `⚠️ не удалось обновить бэкапы конфига (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * Read-modify-write the config file in one step. Throws if the write fails.
 *
 * The process holds a config object it loaded at startup, and several places
 * (the provider registry, the owner-claim handler, the self_config tool) write
 * to the file later. Saving the startup object would silently roll back
 * anything the others changed in the meantime, so every write goes through
 * here instead: fresh copy from disk, patch, save.
 */
export function patchConfigOrThrow(
  mutate: (config: Record<string, unknown>) => void,
  customPath?: string,
): void {
  const current = (loadConfig(customPath) ?? { agent: { name: "Eva" } }) as unknown as Record<
    string,
    unknown
  >;
  mutate(current);
  saveConfig(current as unknown as EvaConfig, customPath);
}

/**
 * Same as patchConfigOrThrow, but a failed write is a log line and a false.
 *
 * For background callers (the registry's onChange, the owner-claim handler)
 * that have nobody to report to: a rejected setting should not take the
 * process down with it. Callers that can talk to a human — the self_config
 * tool — want the real error, so they use patchConfigOrThrow directly.
 */
export function patchConfig(
  mutate: (config: Record<string, unknown>) => void,
  customPath?: string,
): boolean {
  try {
    patchConfigOrThrow(mutate, customPath);
    return true;
  } catch (err) {
    console.error(`Config not patched: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Check if a config file exists and has LLM credentials */
export function isConfigured(customPath?: string): boolean {
  const config = loadConfig(customPath);
  if (!config) return false;
  if (config.models && Object.keys(config.models).length) return true;
  return Boolean(config.llm);
}

/** Get LLM API key from either config format */
export function getLLMApiKey(config: EvaConfig): string | null {
  // New format: any provider in the registry that has a key.
  const fromProviders = Object.values(config.providers ?? {}).find((p) => p.api_key)?.api_key;
  if (fromProviders) return fromProviders;
  if (!config.llm) return null;
  if ("api_key" in config.llm) return config.llm.api_key;
  if ("fast" in config.llm && config.llm.fast) return config.llm.fast.api_key;
  if ("strong" in config.llm && config.llm.strong) return config.llm.strong.api_key;
  return null;
}

/**
 * Build the provider registry config, accepting both the new providers/models
 * shape and the legacy flat `llm` block, so an existing install can be read
 * before it is migrated.
 */
export function toRegistryConfig(config: EvaConfig): RegistryConfig {
  const providers: RegistryConfig["providers"] = {};
  const models: RegistryConfig["models"] = {};
  let fallbacks: ModelRef[] = [];

  // New shape wins.
  for (const [id, spec] of Object.entries(config.providers ?? {})) {
    providers[id] = {
      ...(spec.base_url === undefined ? {} : { base_url: spec.base_url }),
      ...(spec.api_key === undefined ? {} : { api_key: spec.api_key }),
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      ...(spec.stream_usage === undefined ? {} : { stream_usage: spec.stream_usage }),
    };
  }
  for (const [role, ref] of Object.entries(config.models ?? {})) {
    models[role] = { provider: ref.provider, model: ref.model };
  }
  fallbacks = (config.fallbacks ?? []).map((f) => ({ provider: f.provider, model: f.model }));

  // Legacy shape fills in whatever the new one did not say.
  if (config.llm) {
    const legacy = "api_key" in config.llm ? config.llm : null;
    const nested = "fast" in config.llm ? config.llm : null;

    const legacyProvider = legacy?.provider ?? "openrouter";
    const legacyKey = legacy?.api_key;
    if (legacyKey && !providers[legacyProvider]?.api_key) {
      providers[legacyProvider] = { ...providers[legacyProvider], api_key: legacyKey };
    }

    if (legacy?.fast_model && !models.fast) {
      models.fast = { provider: legacyProvider, model: legacy.fast_model };
    }
    if (legacy?.strong_model && !models.strong) {
      models.strong = { provider: legacyProvider, model: legacy.strong_model };
    }
    if (legacy?.fallback_models?.length && !fallbacks.length) {
      fallbacks = legacy.fallback_models.map((m) => ({ provider: legacyProvider, model: m }));
    }

    // Old nested format: fast/strong each with their own provider and key.
    for (const role of ["fast", "strong"] as const) {
      const entry = nested?.[role];
      if (!entry) continue;
      if (entry.api_key && !providers[entry.provider]?.api_key) {
        providers[entry.provider] = { ...providers[entry.provider], api_key: entry.api_key };
      }
      const model = entry.model ?? (role === "fast" ? undefined : undefined);
      if (entry.model && !models[role]) {
        models[role] = { provider: entry.provider, model: entry.model };
      }
      void model;
    }
    if (nested?.fallback_models?.length && !fallbacks.length) {
      fallbacks = nested.fallback_models.map((m) => ({ provider: legacyProvider, model: m }));
    }
  }

  return { providers, models, fallbacks };
}

/** Get agent name */
export function getAgentName(config: EvaConfig): string {
  return config.agent?.name ?? "Eva";
}

/** Get personality as structured object */
export function getPersonality(config: EvaConfig): {
  tone?: string;
  style?: string;
  persona?: string;
  ops?: string[];
  customInstructions?: string;
} {
  const p = config.agent?.personality;
  if (!p) return {};
  return {
    tone: p.tone,
    style: p.style,
    persona: p.persona,
    ops: p.ops,
    customInstructions: p.custom_instructions,
  };
}

export function getPersonalitySliders(config: EvaConfig): Record<string, number> {
  const p = config.agent?.personality;
  if (!p) return {};
  const result: Record<string, number> = {};
  for (const k of PERSONALITY_SLIDERS) {
    const v = (p as Record<string, unknown>)[k];
    if (typeof v === "number") result[k] = v;
  }
  return result;
}

export { configSchema };
