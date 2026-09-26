import type { Tool, ToolParam, ToolResult } from "./types.js";
import { ProviderRegistry, listProviderModels, type ModelRef } from "../llm/registry.js";
import type { LLMRouter } from "../llm/router.js";

/** Roles that exist out of the box. Anything else must already be in the config. */
const KNOWN_ROLES = ["fast", "strong", "study", "embed"] as const;

export interface SwitchModelDeps {
  registry: ProviderRegistry;
  router: LLMRouter;
}

/**
 * Lets the model be swapped while the bot keeps running.
 *
 * The switch is verified before it is kept: a model that is not in the
 * provider's list, or that fails a one-token smoke test, is rejected and the
 * old assignment stays in place. A wrong model in the config means Eva goes
 * silent on every future message, so a bad guess must not stick.
 *
 * On whose authority she switches: the owner's, by request, and nobody else's.
 * That is the whole point of the tool existing — «работай на любом провайдере»
 * is a promise about a conversation, not about a config file. So there is no
 * /yes gate here, unlike the identity changes self_config parks: the owner
 * asking for a different model is the consent, and a second tap for a second
 * look at the same request is friction in the one place friction was not
 * needed. The verification above is what makes that safe — she cannot park a
 * model that does not answer.
 *
 * There used to be a `selfSwitchable` flag here, described as "roles Eva may
 * move on her own; others need the owner" and passed `true` at the only call
 * site. It gated nothing, and a flag that promises a rule it does not enforce
 * is worse than no flag: the next person to read it believes a boundary exists
 * that nothing checks. Removed rather than wired up, because the policy it was
 * reaching for is the one written above.
 */
export class SwitchModelTool implements Tool {
  name = "switch_model";
  description =
    "Switch which LLM model Eva uses, or inspect what is configured. " +
    "Roles: 'fast' (everyday chatter), 'strong' (hard thinking, tool use), " +
    "'study' (background learning), 'embed' (embeddings). " +
    "action=current — what is in use now. " +
    "action=providers — which endpoints are configured. " +
    "action=available — which models a provider offers (needs provider). " +
    "action=switch — move a role onto another model (needs role, provider, model). " +
    "Prefer action=available over guessing a model id; if the owner names a model you do not recognise, list first.";
  parameters: ToolParam[] = [];
  private readonly registry: ProviderRegistry;
  private readonly router: LLMRouter;

  constructor(deps: SwitchModelDeps) {
    this.registry = deps.registry;
    this.router = deps.router;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = str(params.action) ?? "current";
    try {
      switch (action) {
        case "current":
          return { success: true, output: this.current() };
        case "providers":
          return { success: true, output: this.providers() };
        case "available":
          return { success: true, output: await this.available(req(params.provider)) };
        case "switch":
          return await this.switchRole(
            req(params.role),
            req(params.provider),
            req(params.model),
          );
        default:
          return {
            success: false,
            output: "",
            error: `Неизвестное action "${action}". Доступно: current, providers, available, switch.`,
          };
      }
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private current(): string {
    const roles = this.registry.rolesList();
    if (Object.keys(roles).length === 0) {
      return "Ни одна роль не настроена. В config.yaml заполни секцию models:";
    }
    const lines = Object.entries(roles).map(([role, ref]) => {
      const known = (KNOWN_ROLES as readonly string[]).includes(role) ? "" : " (своя роль)";
      return `  ${role}: ${this.registry.label(ref)}${known}`;
    });
    const fallbacks = this.registry.fallbackList();
    const fb = fallbacks.length
      ? `\n\nЗапасные (если основная не отвечает):\n  ${fallbacks.map((f) => this.registry.label(f)).join("\n  ")}`
      : "\n\nЗапасных моделей не настроено.";
    return `Сейчас работаю на:\n${lines.join("\n")}\n  режим: ${this.router.mode === "degraded" ? "⚠️ аварийный (основная не отвечает)" : "основной"}${fb}`;
  }

  private providers(): string {
    const ids = this.registry.providerIds();
    if (ids.length === 0) return "Провайдеры не настроены (секция providers в config.yaml пустая).";
    return (
      "Настроенные провайдеры:\n" +
      ids
        .map((id) => `  ${id} — ${this.registry.isUsable(id) ? "готов" : "НЕ ЗАПОЛНЕН (нужны base_url и api_key)"}`)
        .join("\n")
    );
  }

  private async available(provider: string): Promise<string> {
    const cfg = this.registry.toConfig().providers[provider];
    if (!cfg) {
      throw new Error(
        `Провайдер "${provider}" не настроен. Настроенные: ${this.registry.providerIds().join(", ") || "(пусто)"}.`,
      );
    }
    if (!cfg.base_url || !cfg.api_key) {
      throw new Error(`У провайдера "${provider}" не хватает base_url или api_key.`);
    }
    const models = await listProviderModels({ base_url: cfg.base_url, api_key: cfg.api_key });
    if (models.length === 0) return `${provider}: провайдер не вернул ни одной модели.`;
    const shown = models.slice(0, 60);
    return `${provider} (${models.length} моделей):\n${shown.map((m) => `  ${m}`).join("\n")}${models.length > shown.length ? `\n  ...и ещё ${models.length - shown.length}` : ""}`;
  }

  private async switchRole(role: string, provider: string, model: string): Promise<ToolResult> {
    if (!this.registry.isUsable(provider)) {
      const known = this.registry.providerIds().filter((p) => this.registry.isUsable(p));
      throw new Error(
        `Провайдер "${provider}" не настроен или не заполнен.` +
          (known.length ? ` Готовые: ${known.join(", ")}.` : ""),
      );
    }

    const ref: ModelRef = { provider, model };
    const previous = this.registry.role(role);

    // Verify BEFORE assigning, not after.
    //
    // setRole is what fires the write-through to config.yaml, so assigning
    // first and rolling back on failure means the model that did not answer
    // was on disk for a moment — and the rollback is a second write that can
    // itself fail. A process killed between them, a full disk, a config file
    // that became read-only in that exact second: the rejected model stays, and
    // Eva goes silent on every message from then on. That is the exact outcome
    // this check exists to prevent, and the ordering was the only thing letting
    // it through.
    //
    // The check does not need the role assigned: verify() is handed the ref and
    // builds a client for it directly, so nothing here depends on the old order.
    const check = await this.verify(ref);
    if (!check.ok) {
      throw new Error(
        `Модель ${provider}/${model} не подошла: ${check.reason}. ` +
          (previous ? `Оставил ${this.registry.label(previous)}.` : "Ничего не меняла."),
      );
    }

    this.registry.setRole(role, ref);

    const roles = this.registry.rolesList();
    const now = Object.entries(roles)
      .map(([r, m]) => `  ${r}: ${this.registry.label(m)}`)
      .join("\n");
    return {
      success: true,
      output: `Переключила ${role} на ${provider}/${model} — проверила, отвечает.\n\nТеперь:\n${now}\n\nИзменение сохранено в config.yaml и переживёт перезапуск.`,
    };
  }

  /** One short request. Confirms the model exists and speaks the API. */
  private async verify(ref: ModelRef): Promise<{ ok: boolean; reason: string }> {
    try {
      const res = await this.registry.client(ref).chat([
        { role: "user", content: "Скажи одно слово: ок" },
      ]);
      if (!res.text.trim() && !res.toolCalls?.length) {
        return { ok: false, reason: "пустой ответ" };
      }
      return { ok: true, reason: "" };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function req(v: unknown): string {
  const s = str(v);
  if (!s) throw new Error("Не хватает обязательного параметра.");
  return s;
}
