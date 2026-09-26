/**
 * `eva init` — the step that used to be "copy config.example.yaml and edit it
 * by hand, hopefully without leaving a key in your shell history".
 *
 * The questions are four because the rest can be defaults: a bot token, a
 * provider, a key for it, and a model. Everything else in the config is a
 * setting rather than a decision, and a person setting up a bot for the first
 * time should not have to answer questions about study intervals to get it
 * running.
 *
 * Three things it deliberately does not do:
 *
 * - **Never print a secret.** Hidden input when there is a terminal, refused
 *   rather than echoed when there is not, and the written file is chmod 600 — a
 *   key in a config that other users on the box can read is a key in the wild.
 * - **Never overwrite.** An existing config is a working bot, and init is the
 *   command someone runs again while confused. `--force` is required, it backs
 *   the old file up first, and it says so.
 * - **Never leave it unverified.** A config written and never started is a
 *   config nobody knows is broken. The last thing init does is run the same
 *   checks as `eva doctor`, so the answer to "did it work" is on screen before
 *   the prompt comes back.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  toRegistryConfig,
  getLLMApiKey,
  type EvaConfig,
} from "./config.js";
import { PROVIDER_PRESETS, ProviderRegistry } from "./llm/registry.js";
import { runDoctor, formatReport, type DoctorReport } from "./doctor.js";

export interface InitAnswers {
  telegramToken: string;
  providerId: string;
  providerKey: string;
  /** Explicit endpoint, required for anything not in the preset list. */
  baseUrl?: string;
  model: string;
  agentName: string;
  /** Random per install; encrypts what the http tool stores. */
  securityKey?: string;
  /** Non-interactive: take everything from flags and ask nothing. */
  silent: boolean;
}

export class InitCancelled extends Error {
  constructor() {
    super("отменено");
    this.name = "InitCancelled";
  }
}

/**
 * Presets a person can pick without also having to know an endpoint.
 *
 * `openai_compatible` is deliberately absent: it exists to mean "some other
 * host", and offering it in a list where the next question is "which model"
 * produces a config that cannot work.
 */
export const PRESET_IDS = Object.entries(PROVIDER_PRESETS)
  .filter(([id, spec]) => id !== "openai_compatible" && spec.base_url)
  .map(([id]) => id);

export const DEFAULT_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_AGENT_NAME = "Ева";

/**
 * Ask without echoing.
 *
 * Not via readline: readline echoes typed characters through a function bound
 * to the real stdout at construction time, so pointing `rl.output` at a muted
 * stream silences the prompts too and, before that, does not silence the echo
 * at all. Reading the key bytes in raw mode is the only version here that is
 * actually true, and the claim "ввод скрыт" is worth the twenty lines.
 */
export async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error(
      "Нет терминала — ввод нельзя скрыть. Передай значения флагами: " +
        "--token, --provider, --key, --model",
    );
  }
  stdout.write(question);
  const setRaw = (on: boolean): void => {
    stdin.setRawMode?.(on);
    stdin.pause();
  };
  return new Promise<string>((resolve) => {
    let out = "";
    const finish = (): void => {
      stdin.off("data", onData);
      setRaw(false);
      stdout.write("\n");
      resolve(out.trim());
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C — the universal "never mind", and worth honouring
          // mid-secret rather than after the whole form.
          finish();
          throw new InitCancelled();
        }
        // Backspace arrives as DEL on a Unix tty and as BS on Windows. Both
        // do, depending on the terminal, and a key that only half-deletes is
        // a key typed wrong.
        if (ch === "\u007f" || ch === "\b") {
          out = out.slice(0, -1);
          continue;
        }
        if (ch >= " ") out += ch;
      }
    };
    setRaw(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

/**
 * The config a fresh install gets.
 *
 * Small on purpose. Every block that is not needed to start is left out, and
 * `config.example.yaml` stays the place that shows what else exists — a file
 * full of commented-out keys is a file nobody edits.
 */
export function minimalConfig(a: InitAnswers): EvaConfig {
  const preset = PROVIDER_PRESETS[a.providerId];
  const baseUrl = a.baseUrl || preset?.base_url || "";

  return {
    agent: {
      name: a.agentName,
      gender: "female",
      /**
       * No character, on purpose.
       *
       * This used to write a persona — «Дерзкая и своя…» — and three standing
       * rules, into every fresh install. That was wrong twice over. The person
       * setting up a bot has not asked for anybody's character, and this
       * repository is meant to be the plain base that anybody can take and
       * install: a personality baked into `init` is a personality somebody else
       * chose, shipped inside a default. So she starts as nobody, and `doctor`
       * says so out loud, and the owner tells her who she is — in the chat, in
       * one sentence, as the person he wants rather than the person I picked.
       */
      personality: {},
    },
    telegram: {
      token: a.telegramToken,
      owner_id: 0,
    },
    providers: {
      [a.providerId]: { base_url: baseUrl, api_key: a.providerKey },
    },
    models: {
      fast: { provider: a.providerId, model: a.model },
      strong: { provider: a.providerId, model: a.model },
    },
    fallbacks: [],
    memory: {
      max_knowledge: 200,
      study_interval_min: 60,
      learning_enabled: true,
    },
    security: {
      // Random rather than derived from the token: the token is a credential
      // the owner may rotate, and rotating it must not invalidate everything
      // the http tool encrypted.
      password_hash: a.securityKey || crypto.randomBytes(16).toString("hex"),
    },
  } as unknown as EvaConfig;
}

/** Write the config owner-only, without printing any of it. */
export function writeInitialConfig(configPath: string, config: EvaConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  saveConfig(config, configPath);
  // saveConfig writes through a temp file and renames it, so the mode has to be
  // set after the fact. A 0644 config on a shared box is a published key.
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Windows and some network filesystems have no POSIX modes. Not fatal: an
    // install there is single-user anyway.
  }
}

export interface InitOptions {
  configPath?: string;
  answers?: Partial<InitAnswers>;
  /** Skip the closing doctor run. Tests and scripted installs run their own. */
  verify?: boolean;
  /** Injected in tests so the prompts can be driven without a terminal. */
  askImpl?: (question: string, fallback?: string) => Promise<string>;
  askHiddenImpl?: (question: string) => Promise<string>;
}

export interface InitResult {
  configPath: string;
  config: EvaConfig | null;
  /** True when a config was already there and nothing was written. */
  alreadyDone: boolean;
  report?: DoctorReport;
}

interface ParsedArgs extends Partial<InitAnswers> {
  force?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = (): string => {
      i += 1;
      return argv[i] ?? "";
    };
    switch (argv[i]) {
      case "--token": out.telegramToken = value(); break;
      case "--provider": out.providerId = value(); break;
      case "--key": out.providerKey = value(); break;
      case "--model": out.model = value(); break;
      case "--base-url": out.baseUrl = value(); break;
      case "--name": out.agentName = value(); break;
      case "--force": out.force = true; break;
      default: break;
    }
  }
  return out;
}

function pick<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined && v !== "") return v;
  return undefined;
}

export async function runInit(argv: string[], opts: InitOptions = {}): Promise<InitResult> {
  const args = parseArgs(argv);
  const configPath = opts.configPath ?? getConfigPath();
  const askPrompt = opts.askImpl ?? ask;
  const askSecret = opts.askHiddenImpl ?? askHidden;

  // Re-running init is what someone does while confused. Overwriting a working
  // bot to answer that question is the worst available response, so the answer
  // is to show what is there instead.
  if (fs.existsSync(configPath) && !args.force) {
    const existing = loadConfig(configPath);
    console.log(`ℹ️  Конфиг уже есть: ${configPath}. Менять его — с --force.`);
    const report = opts.verify === false
      ? undefined
      : await runDoctor({
          configPath,
          ...(existing && getLLMApiKey(existing) ? { registry: new ProviderRegistry(toRegistryConfig(existing)) } : {}),
        });
    return { configPath, config: existing, alreadyDone: true, report };
  }

  if (fs.existsSync(configPath)) {
    const backup = `${configPath}.init-backup`;
    fs.copyFileSync(configPath, backup);
    console.log(`⚠️  Старый конфиг сохранён: ${backup}`);
  }

  // Flags for both halves of the secret pair mean nobody has to be sitting
  // there. Anything less and questions get asked, so the default for the name
  // is applied only on the silent path — setting it here unconditionally made
  // the "Как её зовут" prompt unreachable.
  const silent = args.telegramToken !== undefined && args.providerKey !== undefined;

  const answers: InitAnswers = {
    telegramToken: pick(args.telegramToken, opts.answers?.telegramToken) ?? "",
    providerId: pick(args.providerId, opts.answers?.providerId) ?? "",
    providerKey: pick(args.providerKey, opts.answers?.providerKey) ?? "",
    baseUrl: pick(args.baseUrl, opts.answers?.baseUrl),
    model: pick(args.model, opts.answers?.model) ?? "",
    agentName: pick(args.agentName, opts.answers?.agentName) ?? (silent ? DEFAULT_AGENT_NAME : ""),
    securityKey: opts.answers?.securityKey,
    silent,
  };

  if (!answers.silent) {
    console.log("Настройка Евы. Токен и ключ вводятся скрыто и не печатаются.\n");
    answers.agentName ||= await askPrompt("Как её зовут", DEFAULT_AGENT_NAME);
    answers.telegramToken ||= await askSecret("Токен бота от BotFather:");
    answers.providerId ||= await askPrompt(`Провайдер (${PRESET_IDS.join(", ")})`, "openrouter");
    answers.providerKey ||= await askSecret("Ключ провайдера:");
    answers.model ||= await askPrompt("Модель для fast и strong", DEFAULT_MODEL);
  }

  if (!answers.telegramToken) throw new InitCancelled();
  if (!answers.providerKey) throw new Error("Нужен ключ провайдера: без него бот не сможет отвечать.");
  if (!answers.model) throw new Error("Нужно имя модели, например " + DEFAULT_MODEL);
  answers.agentName ||= DEFAULT_AGENT_NAME;

  const preset = PROVIDER_PRESETS[answers.providerId];
  if (!preset && !answers.baseUrl) {
    throw new Error(
      `Провайдер «${answers.providerId}» не знаю. Либо выбери из списка ` +
        `(${PRESET_IDS.join(", ")}), либо укажи свой адрес через --base-url.`,
    );
  }

  const config = minimalConfig(answers);
  writeInitialConfig(configPath, config);
  console.log(`\n✅ Конфиг записан: ${configPath}`);

  let report: DoctorReport | undefined;
  if (opts.verify !== false) {
    report = await runDoctor({
      configPath,
      registry: new ProviderRegistry(toRegistryConfig(config)),
    });
    console.log("");
    console.log(formatReport(report, configPath));
  }

  return { configPath, config, alreadyDone: false, report };
}

/** What to print after a successful init. Kept here so init and README agree. */
export function nextSteps(): string[] {
  return [
    "Проверить:  eva doctor",
    "Запустить:  eva            (или systemd-юнит, см. README)",
    "В чате:    напиши боту — он спросит твой chat id и запомнит его.",
    "Кто она:    скажи ей в чате, кто она и как с ним разговаривать. Не описана —",
    "            будет отвечать ровно, как любая: умно и ничьи.",
  ];
}

export { getConfigPath };
