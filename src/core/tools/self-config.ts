import type { Tool, ToolResult } from "./types.js";
import { loadConfig, saveConfig, configSchema, type BetsyConfig } from "../config.js";

// ---------------------------------------------------------------------------
// What Eva is allowed to change about herself.
//
// This tool writes straight to ~/.eva/config.yaml, so a bad write takes the
// bot down until someone edits a file by hand. The split is deliberate:
//
//   writable — personality, who she is, owner facts, memory tuning. Cheap to
//              get wrong and worth letting her adjust on her own.
//   read-only — everything holding infrastructure or secrets. Visible so she
//              can answer questions about it, never writable.
//   forbidden — provider plumbing. Lives in the ProviderRegistry, and
//              switch_model is the only path that verifies a model before
//              committing it.
// ---------------------------------------------------------------------------

/** Top-level sections she may write to. */
const WRITABLE_ROOTS = new Set(["agent", "owner", "personality"]);

/** Sections that are safe to read but never to write. */
const READ_ONLY_ROOTS = new Set(["telegram", "selfies", "voice", "video", "skillsmp", "google", "skills", "image_gen"]);

/** Handled by the provider registry, not by direct file writes. */
const REGISTRY_ROOTS = new Set(["providers", "models", "fallbacks"]);

/**
 * Anything whose key looks like a credential. Values are never printed — only
 * the fact that something is set and how long it is. Without this, action=list
 * handed the model its own Telegram token and every API key, and from there
 * they went to the LLM provider on the next turn.
 */
const SECRET_PATTERN = /(token|api[_-]?key|secret|password|passwd|credential|private[_-]?key)/i;

function isSecretPath(keyPath: string): boolean {
  return SECRET_PATTERN.test(keyPath);
}

/** Never echo a value that might be a credential. */
function redact(keyPath: string, value: unknown): string {
  if (value === undefined) return "(не задано)";
  if (isSecretPath(keyPath)) {
    const len = typeof value === "string" ? value.length : 0;
    return len > 0 ? `*** (задано, ${len} символов)` : "*** (пусто)";
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function rootOf(keyPath: string): string {
  return keyPath.split(".")[0] ?? "";
}

/**
 * Check a write. Returns a reason string when it must be refused, or null when
 * it is allowed. The message tells the model what to do instead, because a bare
 * "denied" just makes it try a different spelling.
 */
function refuseWrite(keyPath: string): string | null {
  const root = rootOf(keyPath);

  if (REGISTRY_ROOTS.has(root)) {
    return (
      `Ключ "${keyPath}" управляется провайдер-реестром, прямой доступ запрещён. ` +
      `Чтобы сменить модель, вызови switch_model (action=switch) — он проверит новую модель ` +
      `и откатит правку, если она не отвечает. Прямая запись в YAML обошла бы проверку.`
    );
  }
  if (READ_ONLY_ROOTS.has(root)) {
    return (
      `Ключ "${keyPath}" — служебная настройка (ключи, идентификаторы), менять её нельзя. ` +
      `Настройки личности лежат в agent.*, owner.*.`
    );
  }
  if (!WRITABLE_ROOTS.has(root)) {
    return (
      `Ключ "${keyPath}" нельзя менять через self_config: секция "${root}" не относится к личности. ` +
      `Разрешено: ${[...WRITABLE_ROOTS].join(", ")}.*`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers for nested key access (e.g. "agent.gender", "memory.max_knowledge")
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Strings that name a boolean or a number, used for the free-text fields too.
 *
 * A personality like `tone: "3"` is a legitimate instruction to a model, so
 * free-text keys are never coerced. The old version turned it into the number
 * 3, which then failed the schema and — because the repair path in loadConfig
 * works on whole subtrees — took the entire personality block with it.
 */
function coerceValue(raw: string, keyPath: string): unknown {
  const leaf = keyPath.split(".").pop() ?? keyPath;
  if (TEXT_LEAVES.has(leaf)) return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

/** Leaves that must stay strings whatever they look like. */
const TEXT_LEAVES = new Set([
  "name",
  "tone",
  "style",
  "custom_instructions",
  "address_as",
  "response_style",
]);

/** Flatten a nested object into dot-separated key paths for listing */
function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool actions
// ---------------------------------------------------------------------------

function handleGet(params: Record<string, unknown>): ToolResult {
  const key = params.key;
  if (typeof key !== "string" || !key.trim()) {
    return { success: false, output: "Missing required parameter: key", error: "missing_param" };
  }
  const keyPath = key.trim();
  const config = loadConfig();
  if (!config) {
    return { success: false, output: "Config file not found.", error: "no_config" };
  }
  const value = getNestedValue(config as unknown as Record<string, unknown>, keyPath);
  if (value === undefined) {
    return { success: true, output: `${keyPath} — не задано.` };
  }
  return { success: true, output: `${keyPath} = ${redact(keyPath, value)}` };
}

function handleSet(params: Record<string, unknown>): ToolResult {
  const key = params.key;
  if (typeof key !== "string" || !key.trim()) {
    return { success: false, output: "Missing required parameter: key", error: "missing_param" };
  }
  const keyPath = key.trim();
  const refusal = refuseWrite(keyPath);
  if (refusal) return { success: false, output: "", error: refusal };

  const value = params.value;
  if (value === undefined || value === null) {
    return { success: false, output: "Missing required parameter: value", error: "missing_param" };
  }
  if (isSecretPath(keyPath)) {
    return {
      success: false,
      output: "",
      error: `Ключ "${keyPath}" похож на секрет. Ключи задаются только вручную в config.yaml, не через self_config.`,
    };
  }

  const config = loadConfig() ?? ({ agent: { name: "Eva" } } as BetsyConfig);
  const coerced = typeof value === "string" ? coerceValue(value, keyPath) : value;
  setNestedValue(config as unknown as Record<string, unknown>, keyPath, coerced);

  // Refuse a write that the schema would reject. loadConfig repairs invalid
  // configs by dropping fields, and a dropped subtree is invisible to the
  // caller: the write "succeeded" and the setting quietly stopped existing.
  const check = configSchema.safeParse(config);
  if (!check.success) {
    const detail = check.error.issues
      .map((i) => `${i.path.join(".") || "(корень)"}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      output: "",
      error: `Значение не подходит для "${keyPath}". Проверка схемы: ${detail}. Изменение не сохранено.`,
    };
  }

  saveConfig(config);
  return { success: true, output: `${keyPath} = ${redact(keyPath, coerced)} — сохранено.` };
}

function handleAppend(params: Record<string, unknown>): ToolResult {
  const key = params.key;
  if (typeof key !== "string" || !key.trim()) {
    return { success: false, output: "Missing required parameter: key", error: "missing_param" };
  }
  const keyPath = key.trim();
  const refusal = refuseWrite(keyPath);
  if (refusal) return { success: false, output: "", error: refusal };

  const value = params.value;
  if (value === undefined || value === null) {
    return { success: false, output: "Missing required parameter: value", error: "missing_param" };
  }

  const config = loadConfig() ?? ({ agent: { name: "Eva" } } as BetsyConfig);
  const existing = getNestedValue(config as unknown as Record<string, unknown>, keyPath);
  const arr = Array.isArray(existing) ? existing : [];
  arr.push(typeof value === "string" ? value : String(value));
  setNestedValue(config as unknown as Record<string, unknown>, keyPath, arr);
  saveConfig(config);
  return { success: true, output: `Добавлено в ${keyPath} (теперь ${arr.length}).` };
}

function handleList(): ToolResult {
  const config = loadConfig();
  if (!config) {
    return { success: true, output: "Конфиг пуст (файла нет)." };
  }
  const flat = flattenObject(config as unknown as Record<string, unknown>);
  const keys = Object.keys(flat);
  if (keys.length === 0) {
    return { success: true, output: "Конфиг пуст." };
  }
  const lines = keys.map((k) => `- ${k} = ${redact(k, flat[k])}`);
  return { success: true, output: `${keys.length} ключ(ей):\n${lines.join("\n")}` };
}

export const selfConfigTool: Tool = {
  name: "self_config",
  description:
    "Read or write Eva's own configuration in ~/.eva/config.yaml. Dot-notation for nested keys. " +
    "action=get — one key, action=set — write a value, action=append — add to an array, " +
    "action=list — everything (secrets are shown as *** and never as values). " +
    "Writable: agent.name, agent.gender (female/male/neutral), agent.personality.tone, " +
    "agent.personality.style, agent.personality.custom_instructions, " +
    "agent.personality.{formality,emotionality,humor,confidence,response_length,structure," +
    "emoji,examples,friendliness,initiative,curiosity,empathy,criticism} (whole numbers 0-4), " +
    "owner.name, owner.address_as, owner.facts (array). " +
    "Changing which LLM models are used is NOT done here — use switch_model, which verifies " +
    "the new model before committing it. Infrastructure settings (tokens, API keys) are read-only.",
  parameters: [
    { name: "action", type: "string", description: "One of: get, set, append, list", required: true },
    { name: "key", type: "string", description: "Config key in dot-notation, e.g. agent.gender (required for get/set/append)" },
    { name: "value", type: "string", description: "Config value (required for set/append)" },
  ],

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action;
    if (typeof action !== "string" || !action.trim()) {
      return { success: false, output: "Missing required parameter: action", error: "missing_param" };
    }

    switch (action.trim()) {
      case "get":
        return handleGet(params);
      case "set":
        return handleSet(params);
      case "append":
        return handleAppend(params);
      case "list":
        return handleList();
      default:
        return {
          success: false,
          output: `Неизвестное действие: ${action}. Доступно: get, set, append, list.`,
          error: "invalid_action",
        };
    }
  },
};
