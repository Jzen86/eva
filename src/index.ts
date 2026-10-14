import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { isConfigured, loadConfig, patchConfig, getConfigPath, getAgentName, getPersonality, getPersonalitySliders, getLLMApiKey, toRegistryConfig, type EvaConfig } from "./core/config.js";
import { TelegramChannel } from "./channels/telegram/index.js";
import { synthesizeVoiceOgg } from "./channels/telegram/voice.js";
import { LLMRouter } from "./core/llm/router.js";
import { ProviderRegistry } from "./core/llm/registry.js";
import { Engine } from "./core/engine.js";
import { SchedulerService } from "./core/tools/scheduler.js";
import { SchedulerStore } from "./core/tools/scheduler-store.js";
import { getDB } from "./core/memory/db.js";
import { SCHEDULED_TURN_PREFIX, lastOwnerMessageAt } from "./core/memory/conversations.js";
import { parseInitiative, dueNow, loadState, saveState, markSent, localClock } from "./core/initiative.js";
import { runStudyIfDue } from "./core/memory/study-runner.js";
import type { LLMClient } from "./core/llm/types.js";
import type { Channel } from "./channels/types.js";
import { buildTools, describeToolset } from "./core/toolsets.js";
import { userFilesPath } from "./core/user-files.js";
import { describeBrowserInstall } from "./core/tools/browser.js";
import { runDoctor, formatReport } from "./core/doctor.js";
import { runInit, nextSteps, InitCancelled } from "./core/init.js";
import { referencePhotoPath, ownerReferencePhotoPath, hasReferencePhoto, hasOwnerReferencePhoto } from "./core/reference-photo.js";
import { archiveThenDeliver, isReportTask } from "./core/watch-reports.js";
import { SILENCE_REPLY, saidNothing } from "./core/silence.js";
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
    // Outside services get a real call too, for the same reason and with the
    // same bill: a key in a config file is not a working key. On this machine the
    // fal key is valid and the account is locked, which no presence check can
    // see and which the startup line used to imply was fine.
    probeMedia: probe
      ? async (which) => {
          const started = Date.now();
          try {
            if (which === "voice") {
              const voice = (config?.voice ?? {}) as Record<string, unknown>;
              const falKey = String((config?.selfies as Record<string, unknown> | undefined)?.fal_api_key ?? "") || undefined;
              const bytes = await synthesizeVoiceOgg("Проверка связи.", voice, falKey);
              const ms = Date.now() - started;
              return bytes && bytes.length > 0
                ? { ok: true, ms }
                : { ok: false, ms, reason: "синтезатор вернул пусто" };
            }
            const falKey = String((config?.selfies as Record<string, unknown> | undefined)?.fal_api_key ?? "")
              || String((config?.video as Record<string, unknown> | undefined)?.fal_api_key ?? "");
            const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
              method: "POST",
              headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
              // 64x64, one image: the cheapest thing that still exercises the
              // account rather than the model's manners.
              body: JSON.stringify({ prompt: "a red dot on white", image_size: { width: 64, height: 64 }, num_images: 1 }),
            });
            const body = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
            const ms = Date.now() - started;
            return res.ok ? { ok: true, ms } : { ok: false, ms, reason: `${res.status} ${body}` };
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
    // Taken from the registry, not typed out here. A hand-written list was one
    // role behind the moment `models.checks` appeared: the log showed the check
    // running on its own role while this line still named four, and the first
    // thing anyone reads at boot is this line — so "did my new role apply?"
    // looked unanswered when it was answered. The familiar names come first for
    // readability; anything a config adds later is appended rather than dropped.
    const roleOrder = ["fast", "strong", "study", "checks", "embed", "image"];
    const configured = Object.keys(registry.rolesList()).sort(
      (a, b) => {
        const ia = roleOrder.indexOf(a);
        const ib = roleOrder.indexOf(b);
        return (ia < 0 ? roleOrder.length : ia) - (ib < 0 ? roleOrder.length : ib);
      },
    );
    console.log("✅ LLM подключён:", configured
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
  console.log(await describeBrowserInstall(Boolean(toolset.tools.get("browser"))));

  // Setup Engine with personality and tools
  const personality = getPersonality(config);
  const engine = llm ? new Engine({
    llm,
    config: {
      name,
      gender: config.agent?.gender ?? "neutral",
      personality: {
        tone: personality.tone,
        responseStyle: personality.style,
        persona: personality.persona,
        ops: personality.ops,
        turnNote: personality.turnNote,
        customInstructions: personality.customInstructions,
      },
      personalitySliders: getPersonalitySliders(config),
      owner: config.owner,
      filesVaultPath: userFilesPath(),
    },
    tools,
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
      telegram.onSetReferencePhoto = (photoPath, who) => {
        // Her face and the owner's are different files. Routing his photo into
        // `setReferencePhoto` would make her own selfie start drawing him — the
        // kind is the whole reason this callback takes two arguments.
        if (who === "owner") {
          console.log(`📸 Фото владельца обновлено: ${photoPath.slice(0, 60)}`);
          return;
        }
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
      if (hasOwnerReferencePhoto()) {
        console.log(`📸 Фото владельца: ${ownerReferencePhotoPath()}`);
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
          console.log("🧠 study: есть записи");
          await channels.get("telegram")?.send(ownerId, { text: result.report });
          return;
        }
        // An empty session is the day's business and gets one line — except the
        // one worth reading. When the checks refused what the model returned, the
        // session did find something and our own guesses about vocabulary threw it
        // away: that is a finding about the checks, not about the day. The report
        // already names the refused string and the reason for it, and until now it
        // was built in this very branch and then dropped on the floor — the
        // journal said "отброшено фильтром" with nothing behind it, so the only
        // way to see a rejected memory was to make the session happen again.
        if (result.dropped?.length) {
          console.log(`🧠 study:\n${result.report}`);
          return;
        }
        console.log("🧠 study: записей нет —", result.reason ?? "без причины");
      } catch (err) {
        console.error("❌ study:", err instanceof Error ? err.message : err);
      }
    };

    // No priming on boot. The cooldown is recorded in the database, so a restart
    // inherits it instead of pushing the next session back by a full interval —
    // see lastRunMs for what that cost the live install.
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
        `${SCHEDULED_TURN_PREFIX} "${task.name}".`,
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
          metadata: { scheduledTask: true, reportTask: isReportTask(task.schedule) },
        });

        // A clean round says nothing, in the same shape the initiative uses:
        // the answer is exactly `[тишина]`. Until this branch existed the
        // instruction "если всё чисто — НИЧЕГО не пиши" was unfulfillable — a
        // scheduled turn has no other way to produce no message, and an empty
        // answer is read as a failed turn. The five reports in
        // reports/server_watch.md are all text, every all-clear among them: the
        // round could only ever answer, so it answered every time.
        //
        // Silence still leaves a line here. "Said nothing" and "never ran" must
        // not look alike — the empty-answer bug was exactly that confusion, and
        // without the line, shorter intervals would quietly become checks that
        // never happened.
        if (saidNothing(result.text)) {
          console.log(`🕊 Плановая проверка "${task.name}": чисто — промолчала (ни сообщения, ни записи)`);
          return;
        }

        // The archive is a separate destination on purpose: the owner reads her
        // reports there, in order, without the ordinary conversation around
        // them — and it is written before the send, so a bad night for Telegram
        // cannot take the record with it. See watch-reports.ts.
        //
        // A one-shot scheduled message is not one of those reports: the wake-up
        // call landed in reports/14_10.md next to the server checks, and noise
        // in the reading place is what makes a finding get skimmed past. It is
        // still sent, still in `conversations`, still in Telegram — only the
        // third copy is skipped.
        if (!isReportTask(task.schedule)) {
          try {
            await channel.send(task.chatId, result);
            console.log(`✅ Scheduler: delivered "${task.name}" (сообщение, без архива)`);
          } catch (err) {
            console.error(`⚠️ Scheduler "${task.name}": ${err instanceof Error ? err.message : err}`);
          }
          return;
        }

        const outcome = await archiveThenDeliver(task.name, result.text, () =>
          channel.send(task.chatId, result),
        );
        if (outcome.saved) console.log(`🗂 Отчёт "${task.name}" → ${outcome.saved}`);
        if (outcome.delivered) console.log(`✅ Scheduler: delivered "${task.name}" to ${task.channel}:${task.chatId}`);
        if (outcome.error) console.error(`⚠️ Scheduler "${task.name}": ${outcome.error}`);
      } catch (err) {
        console.error(`❌ Scheduler: failed to deliver "${task.name}":`, err);
      }
    });

    await scheduler.recoverMissed();
    scheduler.start();
    console.log("✅ Планировщик запущен");

    // --- Initiative: she writes first ----------------------------------------
    // The clock and the caps live in core/initiative.ts; what she sends is hers.
    // Config is re-read every tick, so the owner can change the periods or switch
    // it off without a restart. The first tick is five minutes after boot, never
    // at once, so a restart cannot set her off mid-morning.
    if (config.telegram?.owner_id) {
      const initiativeOwnerId = String(config.telegram.owner_id);
      const runInitiative = async (): Promise<void> => {
        try {
          const live = loadConfig() ?? config;
          const cfg = parseInitiative(live.initiative);
          if (!cfg || !cfg.enabled) return;

          const offset = live.agent?.timezone_offset_hours ?? 0;
          const now = Date.now();
          const state = loadState();
          const due = dueNow(cfg, state, now, offset, lastOwnerMessageAt(initiativeOwnerId));
          if (!due) return;

          const { minutes } = localClock(now, offset);
          const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
          const prompt = [
            `${SCHEDULED_TURN_PREFIX} «инициатива».`,
            `Сейчас ${clock} — период «${due.instance.period.name}». Ты пишешь Жене сама, первой, без его запроса.`,
            `Реши сама: написать текстом, прислать селфи или голосовое (с подписью или без) — или не писать ничего, если момент не тот. Что и как — на твоё усмотрение; пусть будет по времени суток к месту.`,
            `Одно короткое сообщение. Если решишь промолчать — ответь ровно ${SILENCE_REPLY}.`,
          ].join("\n");

          const result = await engine.process({
            channelName: "telegram",
            userId: initiativeOwnerId,
            text: prompt,
            timestamp: now,
            metadata: { scheduledTask: true },
          });

          // The moment is spent either way; only a real message resets the gap.
          const fired = (state.instanceId === due.instance.id ? state.fired : 0) + 1;
          if (saidNothing(result.text)) {
            saveState({ instanceId: due.instance.id, fired, lastSentAt: state.lastSentAt });
            console.log(`🕊 Инициатива: ${due.instance.period.name} — промолчала`);
            return;
          }
          saveState(markSent(state, due.instance.id, now));
          await channels.get("telegram")?.send(initiativeOwnerId, result);
          console.log(`💌 Инициатива: ${due.instance.period.name} — отправлено`);
        } catch (err) {
          console.error("❌ Инициатива:", err instanceof Error ? err.message : err);
        }
      };
      const initiativeTimer = setInterval(() => { void runInitiative(); }, 5 * 60_000);
      initiativeTimer.unref?.();
      console.log("💌 Инициатива: таймер запущен (раз в 5 мин)");
    }
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
      "  eva init      развернуть конфиг: токен бота + ключ провайдера + имя",
      "  eva           запустить бота (то же, что systemctl start eva)",
      "  eva doctor    проверить, что не сломано [--probe — живые запросы к моделям]",
      "",
      "eva init без флагов спрашивает всё нужное и прячет ввод ключей.",
      "eva init --token T --provider openai --key K --model gpt-4o-mini — без вопросов.",
      "Личность в init не спрашивается: она собирается в чате, командой /persona",
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
