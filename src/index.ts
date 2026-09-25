import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { isConfigured, loadConfig, patchConfig, getConfigPath, getAgentName, getPersonality, getPersonalitySliders, getLLMApiKey, toRegistryConfig } from "./core/config.js";
import { TelegramChannel } from "./channels/telegram/index.js";
import { LLMRouter } from "./core/llm/router.js";
import { ProviderRegistry } from "./core/llm/registry.js";
import { Engine } from "./core/engine.js";
import { ToolRegistry } from "./core/tools/registry.js";
import { ShellTool } from "./core/tools/shell.js";
import { FilesTool } from "./core/tools/files.js";
import { HttpTool } from "./core/tools/http.js";
import { BrowserTool } from "./core/tools/browser.js";
import { WebTool } from "./core/tools/web.js";
import { memoryTool } from "./core/tools/memory.js";
import { selfConfigTool } from "./core/tools/self-config.js";
import { SchedulerService } from "./core/tools/scheduler.js";
import { SchedulerStore } from "./core/tools/scheduler-store.js";
import { getDB } from "./core/memory/db.js";
import { primeStudyTimer, runStudyIfDue } from "./core/memory/study-runner.js";
import type { LLMClient } from "./core/llm/types.js";
import type { Channel } from "./channels/types.js";
import { sshTool } from "./core/tools/ssh.js";
import { npmInstallTool } from "./core/tools/npm-install.js";
import { SelfieTool } from "./core/tools/selfie.js";
import { VoiceTool } from "./core/tools/voice.js";
import { ImageGenTool } from "./core/tools/image-gen.js";
import { SkillSearchTool } from "./core/tools/skill-search.js";
import { SkillInstallTool } from "./core/tools/skill-install.js";
import { SendFileTool } from "./core/tools/send-file.js";
import { SwitchModelTool } from "./core/tools/switch-model.js";

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
  const tools = new ToolRegistry();
  const schedulerDb = getDB();
  const schedulerStore = new SchedulerStore(schedulerDb);
  schedulerStore.init();
  const scheduler = new SchedulerService(schedulerStore);
  tools.register(new ShellTool());
  tools.register(new SendFileTool());
  tools.register(new FilesTool());
  const passwordHash = config.security?.password_hash ?? "default-key-change-me";
  tools.register(new HttpTool({ encryptionKey: passwordHash }));
  tools.register(new BrowserTool());
  tools.register(memoryTool);
  tools.register(selfConfigTool);
  tools.register(scheduler.tool);
  tools.register(sshTool);
  tools.register(npmInstallTool);
  // channels map is populated later — closure captures the reference
  const channels = new Map<string, Channel>();
  if (registry && llm) {
    // Let Eva answer "давай поговорим на другой модели" herself. Verified
    // before it sticks: a model that fails the smoke test is rolled back.
    tools.register(new SwitchModelTool({ registry, router: llm, selfSwitchable: true }));
  }

  // Selfie tool — uses fal.ai key from selfies config, falls back to video config
  const selfiesConfig = config.selfies as Record<string, string> | undefined;
  const videoConfig = config.video as Record<string, string> | undefined;
  // Image generation goes through the `image` role when it is set, so it is not
  // tied to OpenRouter by construction.
  const imageCfg = (config.image_gen as Record<string, string> | undefined) ?? {};
  const imageRef = registry?.role("image") ?? registry?.role("fast");
  const imageProvider = imageRef ? registry?.toConfig().providers[imageRef.provider] : undefined;
  const imageKey =
    imageCfg.api_key ??
    (imageRef && imageProvider?.api_key ? imageProvider.api_key : getLLMApiKey(config)) ??
    "";
  const imageBaseUrl = imageCfg.base_url ?? imageProvider?.base_url;
  const selfieTool = new SelfieTool({
    falApiKey: selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "",
    referencePhotoUrl: selfiesConfig?.reference_photo_url,
    provider: (selfiesConfig?.provider as "fal" | "openrouter" | undefined) ?? "fal",
    openrouterApiKey: imageKey,
    openrouterModel: imageCfg.model ?? (imageRef ? imageRef.model : undefined),
    imageBaseUrl: imageCfg.base_url,
  });
  tools.register(selfieTool);
  // Voice tool — lets Eva send voice messages on her own initiative
  tools.register(new VoiceTool({
    voiceConfig: (config.voice as Record<string, unknown>) ?? {},
    falApiKey: (selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "") || undefined,
  }));
  const llmApiKey = getLLMApiKey(config);
  if (imageKey) {
    tools.register(new ImageGenTool({ apiKey: imageKey, baseUrl: imageBaseUrl }));
  }
  // SkillsMP tools — search and install agent skills
  const skillsmpKey = (config as any).skillsmp?.api_key as string | undefined;
  if (skillsmpKey) {
    tools.register(new SkillSearchTool({ apiKey: skillsmpKey }));
    // Embeddings come from the `embed` role, same as everything else.
    const embedRef = registry?.role("embed");
    const embedProvider = embedRef ? registry?.toConfig().providers[embedRef.provider] : undefined;
    tools.register(new SkillInstallTool({
      apiKey: llmApiKey ?? undefined,
      ...(embedRef && embedProvider?.base_url && embedProvider.api_key
        ? {
            embeddingEndpoint: {
              baseUrl: embedProvider.base_url,
              apiKey: embedProvider.api_key,
              model: embedRef.model,
            },
          }
        : {}),
    }));
  }
  // Web tool — conditional on google config
  const googleConfig = (config as any).google as { api_key: string; cx: string } | undefined;
  if (googleConfig?.api_key && googleConfig?.cx) {
    tools.register(new WebTool({ apiKey: googleConfig.api_key, cx: googleConfig.cx }));
  }
  console.log(`🔧 Зарегистрировано инструментов: ${tools.list().length}`);

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
        selfieTool.setReferencePhoto(photoPath);
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
      telegram.voiceOptions = {
        voiceConfig: (config.voice as Record<string, unknown>) ?? {},
        falApiKey: (selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "") || undefined,
        avatarPath: path.join(os.homedir(), "\.eva", "reference.jpg"),
      };
      await telegram.start({
        token: config.telegram.token,
        owner_chat_id: config.telegram.owner_id?.toString() ?? "",
      });
      // Load saved reference photo if exists and no URL in config
      const savedRef = path.join(os.homedir(), "\.eva", "reference.jpg");
      if (!selfieTool.config.referencePhotoUrl && fs.existsSync(savedRef)) {
        selfieTool.setReferencePhoto(savedRef);
        console.log("📸 Референсное фото загружено из ~/.eva/reference.jpg");
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
