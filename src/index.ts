import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { isConfigured, loadConfig, patchConfig, getConfigPath, getAgentName, getPersonality, getPersonalitySliders, getLLMApiKey, toRegistryConfig, type EvaConfig } from "./core/config.js";
import { TelegramChannel } from "./channels/telegram/index.js";
import { LLMRouter } from "./core/llm/router.js";
import { ProviderRegistry } from "./core/llm/registry.js";
import { Engine } from "./core/engine.js";
import { SchedulerService } from "./core/tools/scheduler.js";
import { SchedulerStore } from "./core/tools/scheduler-store.js";
import { getDB } from "./core/memory/db.js";
import { primeStudyTimer, runStudyIfDue } from "./core/memory/study-runner.js";
import type { LLMClient } from "./core/llm/types.js";
import type { Channel } from "./channels/types.js";
import { buildTools, describeToolset } from "./core/toolsets.js";
import { runDoctor, formatReport } from "./core/doctor.js";
import { runInit, nextSteps, InitCancelled } from "./core/init.js";
import { referencePhotoPath, hasReferencePhoto } from "./core/reference-photo.js";
import type { EmbeddingEndpoint } from "./core/memory/dedup.js";

/**
 * The embedding endpoint, if the `embed` role is configured.
 *
 * A missing endpoint is a supported mode, not a broken one: memory dedup simply
 * stays lexical. Everything that needs vectors goes through this so there is
 * one place that knows how an endpoint is resolved.
 */
function embeddingEndpointFor(reg: ProviderRegistry | null): EmbeddingEndpoint | null {
  const ref = reg?.role("embed");
  if (!ref) return null;
  const provider = reg?.toConfig().providers[ref.provider];
  if (!provider?.base_url || !provider.api_key) return null;
  return { baseUrl: provider.base_url, apiKey: provider.api_key, model: ref.model };
}

/**
 * `eva doctor` — the same checks the `doctor` tool runs, without starting the
 * bot.
 *
 * The tool is the useful half; this is the half that works when the bot will
 * not start, or over ssh as the user the service runs as. Exit code is 1 when
 * something is broken, so a check can gate a restart.
 */
async function doctorCli(argv: string[]): Promise<number> {
  const probe = argv.includes("--probe");
  const configPath = getConfigPath();
  const config = isConfigured() ? loadConfig(configPath) : null;
  const registry = registryFor(config);

  const report = await runDoctor({
    configPath,
    registry,
    probe: probe
      ? async (ref) => {
          if (!registry) return { ok: false, ms: 0, reason: "реестр недоступен" };
          const started = Date.now();
          try {
            const res = await registry.client(ref).chat([
              { role: "user", content: "Скажи одно слово: ок" },
            ]);
            const ms = Date.now() - started;
            const empty = !res.text.trim() && !res.toolCalls?.length;
            return empty ? { ok: false, ms, reason: "пустой ответ" } : { ok: true, ms };
          } catch (err) {
            return {
              ok: false,
              ms: Date.now() - started,
              reason: err instanceof Error ? err.message.slice(0, 300) : String(err),
            };
          }
        }
      : undefined,
  });

  console.log(formatReport(report, configPath));
  return report.bad > 0 ? 1 : 0;
}

async function main() {
  const config = isConfigured() ? loadConfig() : null;

  if (!config) {
    console.error("❌ Конфиг не найден.");
    console.error("   Скопируй config.example.yaml в config.yaml и заполни ключи.");
    console.error("   Ожидается в ~/.eva/config.yaml (переопределяется EVA_CONFIG_PATH).");
    process.exit(1);
  }

  const name = getAgentName(config);

  console.log(`🦀 ${name} запускается...`);
  console.log(`✅ Конфиг загружен: ${name}`);

  // Setup LLM
  const apiKey = getLLMApiKey(config);
  let llm: LLMRouter | null = null;
  let registry: ProviderRegistry | null = null;

  if (apiKey) {
    registry = new ProviderRegistry(toRegistryConfig(config));
    // Write-through so a model switch made at runtime survives a restart.
    const cfgPath = getConfigPath();
    registry.onChange(() => {
      try {
        const snapshot = registry!.toConfig();
        // Patch only the provider sections on top of what is on disk, so a
        // personality change made through self_config at the same moment
        // survives instead of being rolled back by this write.
        patchConfig((fresh) => {
          fresh.providers = snapshot.providers;
          fresh.models = snapshot.models;
          fresh.fallbacks = snapshot.fallbacks;
        }, cfgPath);
        // Keep the in-memory copy in step so a later save is not the stale one.
        config.providers = snapshot.providers;
        config.models = snapshot.models;
        config.fallbacks = snapshot.fallbacks;
      } catch (err) {
        console.error("⚠️ не удалось сохранить конфиг:", err instanceof Error ? err.message : err);
      }
    });
    llm = new LLMRouter(registry);
    console.log("✅ LLM подключён:", ["fast", "strong", "study", "embed"]
      .filter((r) => llm!.hasRole(r))
      .map((r) => llm!.describe(r))
      .join("  |  "));
  }

  // Register tools
  const schedulerDb = getDB();
  const schedulerStore = new SchedulerStore(schedulerDb);
  schedulerStore.init();
  const scheduler = new SchedulerService(schedulerStore);
  const passwordHash = config.security?.password_hash ?? "default-key-change-me";
  // channels map is populated later — closure captures the reference
  const channels = new Map<string, Channel>();
  // Which tools exist is a function of the config and nothing else, so it can be
  // asked without starting a bot. See core/toolsets.ts.
  const toolset = buildTools({
    config,
    registry,
    router: llm,
    scheduler,
    passwordHash,
    embedding: embeddingEndpointFor(registry),
  });
  const tools = toolset.tools;
  console.log(describeToolset(toolset));

  // Setup Engine with personality and tools
  const personality = getPersonality(config);
  const engine = llm ? new Engine({
    llm,
    config: {
      name,
      gender: config.agent?.gender ?? "female",
      personality: {
        tone: personality.tone,
        responseStyle: personality.style,
        persona: personality.persona,
        ops: personality.ops,
        customInstructions: personality.customInstructions,
      },
      personalitySliders: getPersonalitySliders(config),
      owner: config.owner,
    },
    tools,
    contextBudget: config.memory?.context_budget ?? 40000,
    encryptionKey: passwordHash,
  }) : null;

  // Start Telegram channel
  let telegram: TelegramChannel | null = null;
  if (config.telegram?.token) {
    try {
      telegram = new TelegramChannel();
      telegram.onOwnerClaimed = (chatId) => {
        config.telegram!.owner_id = chatId;
        // Surgical write: this fires when someone claims the bot, which is
        // exactly when a model switch or a self_config edit may already be on
        // disk. Saving the startup object here would undo both.
        patchConfig((fresh) => {
          const tg = (fresh.telegram ?? {}) as Record<string, unknown>;
          tg.owner_id = chatId;
          fresh.telegram = tg;
        });
        console.log(`🔒 Owner ID ${chatId} сохранён в конфиг`);
      };
      telegram.onSetReferencePhoto = (photoPath) => {
        toolset.instances.selfie?.setReferencePhoto(photoPath);
        console.log(`📸 Референсное фото обновлено: ${photoPath.slice(0, 60)}`);
      };
      telegram.onMessage(async (msg, onProgress) => {
        if (engine) {
          scheduler.setMessageContext(
            msg.channelName,
            msg.userId,
            engine.getHistory(msg.userId) ?? [],
          );
          return engine.process(msg, onProgress);
        }
        return { text: "LLM не настроен. Открой дашборд для настройки." };
      });
      // Voice delivery options (Gemini TTS etc.) — must be set before start()
      telegram.streaming = config.telegram.streaming ?? true;
      const selfiesCfg = (config.selfies as Record<string, unknown> | undefined) ?? {};
      const videoCfg = (config.video as Record<string, unknown> | undefined) ?? {};
      const ttsKey = (typeof selfiesCfg.fal_api_key === "string" && selfiesCfg.fal_api_key)
        || (typeof videoCfg.fal_api_key === "string" && videoCfg.fal_api_key)
        || undefined;
      telegram.voiceOptions = {
        voiceConfig: (config.voice as Record<string, unknown>) ?? {},
        falApiKey: ttsKey,
        avatarPath: referencePhotoPath(),
      };
      await telegram.start({
        token: config.telegram.token,
        owner_chat_id: config.telegram.owner_id?.toString() ?? "",
      });
      // Load the saved reference photo unless the config names a URL. The path
      // belongs to reference-photo.ts; this is the only place that decides
      // whether to use it.
      const savedRef = referencePhotoPath();
      if (!toolset.instances.selfie?.config.referencePhotoUrl && hasReferencePhoto()) {
        toolset.instances.selfie?.setReferencePhoto(savedRef);
        console.log("📸 Референсное фото: ~/.eva/reference.jpg");
      }
      console.log("✅ Telegram бот запущен");
    } catch (err) {
      console.error("❌ Telegram ошибка:", err instanceof Error ? err.message : err);
    }
  }

  if (telegram) {
    channels.set("telegram", telegram);
  }

  // --- Background study sessions (self-learning) -----------------------------
  // Every STUDY_TICK_MS we ask the study model for ONE new insight, built from
  // the knowledge base + the recent conversation. The model often answers
  // "nothing new" and then nothing is written at all.
  if (llm && config.telegram?.owner_id) {
    const ownerId = String(config.telegram.owner_id);
    const studyIntervalMs = (config.memory?.study_interval_min ?? 30) * 60_000;
    // Built once, but resolved lazily so a model switch mid-run is picked up.
    const studyClients: LLMClient[] = [
      {
        chat: (m, t) => (llm!.hasRole("study") ? llm!.role("study").chat(m, t) : llm!.fast().chat(m, t)),
        chatStream: (m, cb, t) =>
          llm!.hasRole("study") ? llm!.role("study").chatStream(m, cb, t) : llm!.fast().chatStream(m, cb, t),
      },
    ];
    const studyLabel = llm.hasRole("study")
      ? llm.describe("study")
      : `${llm.describe("fast")} (study-роль не задана)`;

    const runOneStudy = async () => {
      // Don't burn free fallback quota on junk insights when the balance is out.
      if (llm.mode === "degraded") return;
      try {
        const result = await runStudyIfDue({
          clients: studyClients,
          agentName: name,
          ownerName: config.owner?.name,
          userId: ownerId,
          learning: {
            learningEnabled: config.memory?.learning_enabled ?? true,
            studyIntervalMs,
            specialties: [],
          },
          maxKnowledge: config.memory?.max_knowledge ?? 200,
          // Present only when an embedding provider is configured; the run
          // falls back to lexical dedup without it.
          embedding: embeddingEndpointFor(registry),
        });
        if (result.error) {
          console.error("❌ study:", result.error);
          return;
        }
        if (!result.ran || !result.report) return;
        if (result.wrote) {
          console.log("🧠 study:", result.topic);
          await channels.get("telegram")?.send(ownerId, { text: result.report });
        } else {
          console.log("🧠 study: новых выводов нет —", result.reason ?? "без причины");
        }
      } catch (err) {
        console.error("❌ study:", err instanceof Error ? err.message : err);
      }
    };

    primeStudyTimer();
    const studyTimer = setInterval(runOneStudy, 5 * 60_000);
    studyTimer.unref?.();
    console.log(
      `🧠 Самообучение: каждые ${studyIntervalMs / 60_000} мин, ${studyLabel}`,
    );
  }

  if (engine) {
    scheduler.onTaskFire(async (task) => {
      const channel = channels.get(task.channel);
      if (!channel) {
        console.error(`Scheduler: channel "${task.channel}" not available for task "${task.name}"`);
        return;
      }

      const prompt = [
        `Сработало запланированное задание "${task.name}".`,
        `Задача: ${task.command}`,
        task.context ? `\nКонтекст разговора при создании задачи:\n${task.context}` : "",
        `\nНапиши владельцу сообщение в связи с этой задачей.`,
      ].join("\n");

      try {
        const result = await engine.process({
          channelName: task.channel,
          userId: task.chatId,
          text: prompt,
          timestamp: Date.now(),
          metadata: { scheduledTask: true },
        });
        await channel.send(task.chatId, result);
        console.log(`✅ Scheduler: delivered "${task.name}" to ${task.channel}:${task.chatId}`);
      } catch (err) {
        console.error(`❌ Scheduler: failed to deliver "${task.name}":`, err);
      }
    });

    await scheduler.recoverMissed();
    scheduler.start();
    console.log("✅ Планировщик запущен");
  }

  setupShutdown(scheduler, llm ?? undefined);
}

function setupShutdown(scheduler?: SchedulerService, router?: LLMRouter) {
  const shutdown = () => {
    console.log("\nЗавершение работы...");
    scheduler?.stop();
    router?.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * The registry a config describes, or undefined when the config cannot make
 * one — a diagnosis is still worth running without it, and that case is exactly
 * the one where a diagnosis is needed.
 */
function registryFor(config: EvaConfig | null): ProviderRegistry | undefined {
  return config && getLLMApiKey(config) ? new ProviderRegistry(toRegistryConfig(config)) : undefined;
}

async function initCli(argv: string[]): Promise<number> {
  try {
    const result = await runInit(argv);
    if (result.alreadyDone) return 0;
    console.log("");
    for (const step of nextSteps()) console.log(`  ${step}`);
    // A bad check right after init means the config just written is wrong, and
    // saying so here is cheaper than finding out from a silent bot.
    return result.report && result.report.bad > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof InitCancelled) {
      // Not a failure: nobody asked for anything to be destroyed by it.
      console.log("Отменено. Ничего не изменено.");
      return 0;
    }
    throw err;
  }
}

function usage(): void {
  console.log(
    [
      "Ева — телеграм-бот с памятью и любым провайдером LLM.",
      "",
      "  eva init      развернуть конфиг: токен бота + ключ провайдера + кто она",
      "  eva           запустить бота (то же, что systemctl start eva)",
      "  eva doctor    проверить, что не сломано [--probe — живые запросы к моделям]",
      "",
      "eva init без флагов спрашивает всё нужное и прячет ввод ключей.",
      "eva init --token T --provider openai --key K --model gpt-4o-mini — без вопросов.",
      "Флаги личности: --name --gender --persona --ops --photo. Всё это меняется в чате.",
    ].join("\n"),
  );
}

// The CLI path is checked before main() so a diagnosis works on a box where
// the bot itself will not come up - which is exactly when it is needed.
const argv = process.argv.slice(2);
if (argv[0] === "doctor") {
  doctorCli(argv.slice(1))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (argv[0] === "init") {
  initCli(argv.slice(1))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  usage();
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
