import type { Tool, ToolParam, ToolResult } from "./types.js";
import { runDoctor, formatReport, type DoctorOptions } from "../doctor.js";
import { getConfigPath } from "../config.js";
import type { ProviderRegistry, ModelRef } from "../llm/registry.js";

/**
 * The self-diagnosis, as something she can be asked for.
 *
 * Being able to run the checks is not the point on its own. The point is that
 * "something is wrong and I do not know what" has an answer, and that the
 * answer names the fix rather than the symptom. When the owner says "ты
 * что-то забыла", the first thing worth doing is running this and reading the
 * memory section, not guessing at the prompt.
 *
 * The probe is opt-in on purpose. A live model request costs money and can
 * fail for reasons that have nothing to do with the setup, so mixing it into
 * the default run would turn a configuration report into a flaky test.
 */
export class DoctorTool implements Tool {
  name = "doctor";
  description =
    "Diagnose myself: check the config, the providers, the model roles, the memory " +
    "database and the search index, and say what is broken together with the fix. " +
    "Use it when something misbehaves and the cause is not obvious — before guessing. " +
    "action=summary — the report from what is already known (default, no requests, " +
    "costs nothing). " +
    "action=probe — the same plus one live request per model role; costs a few tokens " +
    "and the only way to tell 'the key is wrong' from 'the model is down'. " +
    "action=json — the same as summary in machine-readable form. " +
    "Report secrets by presence and length only; the values are never printed.";
  parameters: ToolParam[] = [
    {
      name: "action",
      type: "string",
      description: "One of: summary, probe, json",
      required: false,
    },
  ];

  private readonly registry?: ProviderRegistry;
  private readonly base: DoctorOptions;

  constructor(opts: { registry?: ProviderRegistry } & Omit<DoctorOptions, "registry" | "probe"> = {}) {
    const { registry, ...base } = opts;
    this.registry = registry;
    this.base = base;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = typeof params.action === "string" ? params.action.trim() : "summary";

    if (action !== "summary" && action !== "probe" && action !== "json") {
      return {
        success: false,
        output: "",
        error: `Неизвестное action "${action}". Доступно: summary, probe, json.`,
      };
    }

    const configPath = this.base.configPath ?? getConfigPath();
    const report = await runDoctor({
      ...this.base,
      configPath,
      registry: this.registry,
      probe: action === "probe" ? this.probe : undefined,
    });

    if (action === "json") {
      return { success: true, output: JSON.stringify(report, null, 2) };
    }
    return { success: true, output: formatReport(report, configPath) };
  }

  /**
   * One short request per role, timed. The question is only "does this role
   * answer at all", so the cheapest possible prompt will do.
   */
  private probe = async (ref: ModelRef): Promise<{ ok: boolean; ms: number; reason?: string }> => {
    if (!this.registry) return { ok: false, ms: 0, reason: "реестр недоступен" };
    const started = Date.now();
    try {
      const res = await this.registry.client(ref).chat([
        { role: "user", content: "Скажи одно слово: ок" },
      ]);
      const ms = Date.now() - started;
      if (!res.text.trim() && !res.toolCalls?.length) {
        return { ok: false, ms, reason: "пустой ответ" };
      }
      return { ok: true, ms };
    } catch (err) {
      return {
        ok: false,
        ms: Date.now() - started,
        reason: err instanceof Error ? err.message.slice(0, 300) : String(err),
      };
    }
  };
}
