import type { Tool, ToolResult } from "./types.js";
import {
  loadConfig,
  patchConfigOrThrow,
  configSchema,
  getNestedValue,
  setNestedValue,
  type EvaConfig,
} from "../config.js";
import { propose } from "../pending.js";
import { PERSONALITY_SLIDERS } from "../config.js";

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

/**
 * Writes that are safe to apply on the spot.
 *
 * Not "harmless" in the abstract — the config file is her own, and she is
 * writing to it. The line drawn is between *flavour* and *identity*. Tone and
 * the dials change how a message reads; the cost of a wrong value is one
 * conversation that felt off. Her name, her gender, her character, and what
 * she knows about the owner are who she is: a wrong value there outlives the
 * message that caused it, and nobody notices it changed.
 *
 * So the safe list is an allowlist of leaves, not a denylist of badness. A new
 * writable key lands in the sensitive class until someone decides otherwise,
 * which is the right way round for a class whose whole point is a second look.
 */
const SAFE_LEAVES = new Set<string>([
  "tone",
  "style",
  ...PERSONALITY_SLIDERS,
]);

/** True when a write may be applied without asking the owner first. */
export function isSafeWrite(keyPath: string): boolean {
  const leaf = keyPath.split(".").pop() ?? keyPath;
  return SAFE_LEAVES.has(leaf);
}

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
// Nested key access lives in core/config.ts — the approval flow needs it too.
// ---------------------------------------------------------------------------

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
  "persona",
  "custom_instructions",
  "address_as",
  "response_style",
  // An array of rules, appended one line at a time via action=append. Never a
  // scalar, and a numeric rule ("всегда отвечай 2 предложениями") must not
  // become the number 2.
  "ops",
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

  const coerced = typeof value === "string" ? coerceValue(value, keyPath) : value;

  // Validate the result of the write before it is written, and report the
  // schema's own words when it is not. loadConfig repairs invalid configs by
  // dropping fields, and a dropped subtree is invisible to the caller: the
  // write "succeeded" and the setting quietly stopped existing. Checked
  // before the proposal too — parking something that cannot be written only
  // moves the failure to the /yes.
  const probe = loadConfig() ?? ({ agent: { name: "Eva" } } as EvaConfig);
  setNestedValue(probe as unknown as Record<string, unknown>, keyPath, coerced);
  const check = configSchema.safeParse(probe);
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

  if (!isSafeWrite(keyPath)) {
    return parkChange(params, keyPath, coerced, "set");
  }

  // patchConfigOrThrow, not patchConfig: the owner asked for this value, so
  // they get told why it did not stick instead of a log line nobody reads.
  try {
    patchConfigOrThrow((config) => setNestedValue(config, keyPath, coerced));
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `Не сохранено: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { success: true, output: `${keyPath} = ${redact(keyPath, coerced)} — сохранено.` };
}

/**
 * Hold a sensitive change for the owner instead of applying it.
 *
 * Returned as a success: the tool did its job, which was to prepare the
 * change. The output says plainly that nothing was written, because the whole
 * point is that the model must not tell the owner it already happened. A
 * failure here would have the model retry with another spelling of the same
 * key, which lands in the same place.
 */
function parkChange(
  params: Record<string, unknown>,
  keyPath: string,
  value: unknown,
  kind: "set" | "append",
): ToolResult {
  const ownerId = typeof params._userId === "string" ? params._userId : null;
  if (!ownerId) {
    return {
      success: false,
      output: "",
      error:
        `Ключ "${keyPath}" требует подтверждения владельца, а подтвердить нечем: вызов без чата. ` +
        `Изменение не применено.`,
    };
  }
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : "";
  const summary = kind === "append" ? `добавлено в ${keyPath}` : `${keyPath} = ${String(value)}`;
  const parked = propose(ownerId, {
    kind: kind === "append" ? "config_append" : "config_set",
    key: keyPath,
    value,
    summary,
    reason,
  });
  const because = reason ? ` Причина: ${reason}.` : "";
  return {
    success: true,
    output:
      `⏸ Жду подтверждения. Предложено: ${summary}.${because} ` +
      `НЕ ПРИМЕНЕНО. Скажи владельцу, что нужно подтвердить это изменение (/yes — принять, /no — отклонить).`,
  };
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

  const added = typeof value === "string" ? value : String(value);

  // An append to a sensitive list is still a change to who she is: one more
  // standing rule is one more thing she follows everywhere from now on.
  if (!isSafeWrite(keyPath)) {
    const probe = loadConfig() ?? ({ agent: { name: "Eva" } } as EvaConfig);
    const existing = getNestedValue(probe as unknown as Record<string, unknown>, keyPath);
    const arr = Array.isArray(existing) ? [...existing, added] : [added];
    setNestedValue(probe as unknown as Record<string, unknown>, keyPath, arr);
    const check = configSchema.safeParse(probe);
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
    return parkChange(params, keyPath, added, "append");
  }

  try {
    patchConfigOrThrow((config) => {
      const existing = getNestedValue(config, keyPath);
      const arr = Array.isArray(existing) ? [...existing] : [];
      arr.push(added);
      setNestedValue(config, keyPath, arr);
    });
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `Не сохранено: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const count = getNestedValue(loadConfig() as unknown as Record<string, unknown>, keyPath);
  const total = Array.isArray(count) ? count.length : 1;
  return { success: true, output: `Добавлено в ${keyPath} (теперь ${total}).` };
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
    "Flavour changes (tone, style, the 0-4 dials) apply at once. " +
    "Identity changes (name, gender, persona, ops, anything about the owner) are " +
    "NOT applied: the tool parks the change and the owner confirms it with /yes. " +
    "If you get 'Жду подтверждения', the change has not happened — tell the owner " +
    "what you want to change and that it needs their yes. Do not retry it. " +
    "Writable: agent.name, agent.gender (female/male/neutral), " +
    "agent.personality.tone, agent.personality.style, " +
    "agent.personality.persona (WHO SHE IS — character, manner, backstory; free text), " +
    "agent.personality.ops (STANDING RULES — a list, add one rule per call with action=append), " +
    "agent.personality.{formality,emotionality,humor,confidence,response_length,structure," +
    "emoji,examples,friendliness,initiative,curiosity,empathy,criticism} (whole numbers 0-4), " +
    "owner.name, owner.address_as, owner.facts (array). " +
    "Character and rules are separate on purpose: rewrite her tone without touching her rules, " +
    "and put a new standing rule in ops rather than burying it in a paragraph of character. " +
    "Changing which LLM models are used is NOT done here — use switch_model, which verifies " +
    "the new model before committing it. Infrastructure settings (tokens, API keys) are read-only.",
  parameters: [
    { name: "action", type: "string", description: "One of: get, set, append, list", required: true },
    { name: "key", type: "string", description: "Config key in dot-notation, e.g. agent.gender (required for get/set/append)" },
    { name: "value", type: "string", description: "Config value (required for set/append)" },
    { name: "reason", type: "string", description: "One line on why this change, shown to the owner when the change needs their confirmation. Be specific — it is the only thing they see besides the key and the value." },
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
