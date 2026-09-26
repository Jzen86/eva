/**
 * Which tools the bot actually gets.
 *
 * This used to be a run of `tools.register(...)` calls in the middle of
 * `main()`, with no way to ask what the list would be without starting a bot.
 * That is why the toolset drifted: tools stayed registered when the service
 * behind them was not configured, so a fresh install advertised a selfie
 * generator it could not run, a browser it had not installed, and a voice
 * tool with no voice in it. The model was told those tools existed, reached for
 * one, and got an error back — which is worse than not having it, because it
 * reads as "she is broken" rather than "that is not installed here".
 *
 * So the list is a pure function of the config now, and every tool says what it
 * needs. A tool is registered when its requirement is met, and when it is not,
 * the reason is recorded and printed at startup. Nothing disappears silently.
 *
 * Three tiers, and the difference is not fussiness:
 *
 * - **core** — works with nothing but the LLM config. Always on.
 * - **keyed** — needs one key from an external service (web search, skills, an
 *   image backend). On when the key is there, absent from the prompt when not.
 * - **opt-in** — powerful enough to be worth a deliberate decision: a real
 *   browser, remote shell over ssh, installing npm packages. Off by default,
 *   turned on in `tools:`. They can run arbitrary code or cost hundreds of
 *   megabytes, so making them the default would mean every install carries the
 *   risk and none of the use.
 */

import type { Tool } from "./tools/types.js";
import { ToolRegistry } from "./tools/registry.js";
import { ShellTool } from "./tools/shell.js";
import { SendFileTool } from "./tools/send-file.js";
import { FilesTool } from "./tools/files.js";
import { HttpTool } from "./tools/http.js";
import { BrowserTool } from "./tools/browser.js";
import { SelfieTool } from "./tools/selfie.js";
import { VoiceTool } from "./tools/voice.js";
import { ImageGenTool } from "./tools/image-gen.js";
import { WebTool } from "./tools/web.js";
import { SkillSearchTool } from "./tools/skill-search.js";
import { SkillInstallTool } from "./tools/skill-install.js";
import { selfConfigTool } from "./tools/self-config.js";
import { SshTool } from "./tools/ssh.js";
import { npmInstallTool } from "./tools/npm-install.js";
import { SwitchModelTool } from "./tools/switch-model.js";
import { DoctorTool } from "./tools/doctor.js";
import { createMemoryTool } from "./tools/memory.js";
import type { EmbeddingEndpoint } from "./memory/dedup.js";
import type { ProviderRegistry } from "./llm/registry.js";
import type { LLMRouter } from "./llm/router.js";
import { getLLMApiKey, type EvaConfig } from "./config.js";
import { SchedulerService } from "./tools/scheduler.js";

export type ToolTier = "core" | "keyed" | "opt-in";

/** One tool's fate, kept for the startup log and for tests. */
export interface ToolDecision {
  name: string;
  tier: ToolTier;
  registered: boolean;
  /** Present exactly when `registered` is false. Human-readable. */
  reason?: string;
}

export interface ToolsetContext {
  config: EvaConfig;
  registry: ProviderRegistry | null;
  router: LLMRouter | null;
  scheduler: SchedulerService;
  passwordHash: string;
  embedding: EmbeddingEndpoint | null;
}

export interface ToolsetResult {
  tools: ToolRegistry;
  decisions: ToolDecision[];
  registered: string[];
  /** Names of what stayed out, for one line of startup output. */
  disabled: Array<{ name: string; reason: string }>;
  /**
   * The optional tools that exist as objects, for the channel layer to attach
   * to later. The reference-photo command has to reach the selfie tool, and it
   * runs after the toolset is built — so the instance has to come back out
   * rather than be rebuilt or looked up by name.
   */
  instances: {
    selfie?: SelfieTool;
    voice?: VoiceTool;
    browser?: BrowserTool;
  };
}

/** Read the `tools:` block, tolerating both a missing one and a wrong-typed one. */
function optIn(config: EvaConfig, name: string): boolean {
  const block = config.tools as Record<string, unknown> | undefined;
  return block?.[name] === true;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function buildTools(ctx: ToolsetContext): ToolsetResult {
  const { config, registry, router } = ctx;
  const decisions: ToolDecision[] = [];
  const tools = new ToolRegistry();

  /**
   * Widenings of the read-only allowlist, from `tools.shell_trust`.
   *
   * The default list covers the diagnostics, not git or docker: those have too
   * many write modes for a table to be honest, so they wait for /yes. An owner
   * who wants one unattended can name it here rather than us guessing.
   */
  const shellTrust = Array.isArray(config.tools?.shell_trust)
    ? (config.tools?.shell_trust as string[]).filter((b): b is string => typeof b === "string")
    : [];

  const add = (tool: Tool, tier: ToolTier, reason?: string): void => {
    if (reason) {
      decisions.push({ name: tool.name, tier, registered: false, reason });
      return;
    }
    tools.register(tool);
    decisions.push({ name: tool.name, tier, registered: true });
  };

  // --- core: nothing but an LLM config ------------------------------------

  add(new ShellTool({ shellTrust }), "core");
  add(new SendFileTool(), "core");
  add(new FilesTool(), "core");
  add(selfConfigTool, "core");
  add(ctx.scheduler.tool, "core");
  add(new HttpTool({ encryptionKey: ctx.passwordHash }), "core");
  add(createMemoryTool({ embedding: ctx.embedding }), "core");
  add(new DoctorTool({ registry: registry ?? undefined }), "core");

  // Switching models needs a live router. Not a reason to hide the other tools —
  // a bot with no LLM still needs a diagnosis — but this one has nothing to
  // work with, so it stays out rather than being offered and failing.
  if (registry && router) {
    add(new SwitchModelTool({ registry, router }), "core");
  } else {
    decisions.push({ name: "switch_model", tier: "core", registered: false, reason: "нет подключённой модели" });
  }

  // --- keyed: one key away, then they work --------------------------------

  const googleConfig = config.google as { api_key?: string; cx?: string } | undefined;
  if (googleConfig?.api_key && googleConfig.cx) {
    add(new WebTool({ apiKey: googleConfig.api_key, cx: googleConfig.cx }), "keyed");
  } else {
    decisions.push({ name: "web", tier: "keyed", registered: false, reason: "нет google.api_key + google.cx" });
  }

  const skillsKey = str((config.skillsmp as { api_key?: string } | undefined)?.api_key);
  // Decisions are recorded under the tools' real names, not under a group
  // label. A group label is unreadable when someone greps for `skill_search`
  // and finds no explanation of why it is missing.
  if (skillsKey) {
    add(new SkillSearchTool({ apiKey: skillsKey }), "keyed");
    add(
      new SkillInstallTool({
        apiKey: getLLMApiKey(config) ?? undefined,
        ...(ctx.embedding ? { embeddingEndpoint: ctx.embedding } : {}),
      }),
      "keyed",
    );
  } else {
    const why = "нет skillsmp.api_key";
    decisions.push({ name: "skill_search", tier: "keyed", registered: false, reason: why });
    decisions.push({ name: "skill_install", tier: "keyed", registered: false, reason: why });
  }

  // Where pictures come from, decided once and used by both picture tools.
  //
  // In order: an explicit `image_gen` block, the registry's `image` role, the
  // legacy `selfies.openrouter_model`, and only then the chat model.
  //
  // The last step is the one that used to be the only one, and it is a trap: it
  // works by accident, for as long as the chat model happens to sit on the
  // provider that can draw. This install has `selfies.provider: openrouter` and
  // `selfies.openrouter_model: google/gemini-3.1-flash-image` written down, and
  // the old code used neither — it borrowed `fast`, which was a chat model on
  // openrouter. Move the chat model to another provider, as any normal evening
  // of switching models does, and the picture tools silently follow it to an
  // endpoint that cannot draw, holding a text model and the wrong provider's key,
  // with nothing in any log. Found on the live install the day `fast` moved to
  // google, which is the only reason it was ever noticed.
  const imageCfg = (config.image_gen as Record<string, unknown> | undefined) ?? {};
  const selfies = (config.selfies as Record<string, unknown> | undefined) ?? {};
  const video = (config.video as Record<string, unknown> | undefined) ?? {};

  const providerSpecs = registry?.toConfig().providers ?? {};
  const imageRoleRef = registry?.role("image");
  const chatRef = registry?.role("fast");

  const explicitModel = str(imageCfg.model);
  const legacyModel = str(selfies.openrouter_model);
  // The provider always follows the model, so a key and an endpoint can never be
  // taken from one place and a model from another.
  const source = explicitModel
    ? { model: explicitModel, provider: str(selfies.provider) ?? "" }
    : imageRoleRef
      ? { model: imageRoleRef.model, provider: imageRoleRef.provider }
      : legacyModel
        ? { model: legacyModel, provider: str(selfies.provider) ?? "" }
        : chatRef
          ? { model: chatRef.model, provider: chatRef.provider }
          : null;

  const imageModel = source?.model;
  const imageSpec = source ? providerSpecs[source.provider] : undefined;
  const imageKey = str(imageCfg.api_key) || imageSpec?.api_key || getLLMApiKey(config) || "";
  const imageBaseUrl = str(imageCfg.base_url) || imageSpec?.base_url;

  if (imageKey) {
    add(new ImageGenTool({ apiKey: imageKey, baseUrl: imageBaseUrl, ...(imageModel ? { model: imageModel } : {}) }), "keyed");
  } else {
    decisions.push({ name: "image_gen", tier: "keyed", registered: false, reason: "нет ключа провайдера изображений" });
  }

  // Selfies: either an external image backend, or a reference photo uploaded by
  // the owner. The second case matters — with a reference photo and an
  // image-capable provider she can still make pictures, and requiring a fal key
  // for that would be exactly the kind of mandatory vendor to get rid of.
  const falKey = str(selfies.fal_api_key) || str(video.fal_api_key);
  const referencePhoto = str(selfies.reference_photo_url);
  if (falKey || (referencePhoto && imageKey)) {
    add(
      new SelfieTool({
        falApiKey: falKey,
        referencePhotoUrl: referencePhoto || undefined,
        provider: (selfies.provider as "fal" | "openrouter" | undefined) ?? "fal",
        openrouterApiKey: imageKey,
        openrouterModel: imageModel,
        imageBaseUrl: imageBaseUrl || undefined,
      }),
      "keyed",
    );
  } else {
    decisions.push({ name: "selfie", tier: "keyed", registered: false, reason: "нет selfies.fal_api_key и референс-фото" });
  }

  // Voice: sending herself a voice note needs a TTS backend, and the only one
  // wired up is fal. No key, no tool — rather than a tool that always fails.
  if (falKey) {
    add(
      new VoiceTool({ voiceConfig: (config.voice as Record<string, unknown>) ?? {}, falApiKey: falKey }),
      "keyed",
    );
  } else {
    decisions.push({ name: "voice", tier: "keyed", registered: false, reason: "нет TTS-бэкенда (selfies.fal_api_key)" });
  }

  // --- opt-in: a deliberate decision --------------------------------------

  if (optIn(config, "browser")) {
    // No auto-install. Installing ~150 MB of Chromium at request time, as the
    // service user, because a tool call failed, is not something a bot should
    // do on its own. `tools.browser: true` plus the owner's own install
    // command is the whole contract.
    add(new BrowserTool(), "opt-in");
  } else {
    decisions.push({ name: "browser", tier: "opt-in", registered: false, reason: "не включён: tools.browser: true" });
  }

  if (optIn(config, "ssh")) {
    add(new SshTool({ shellTrust }), "opt-in");
  } else {
    decisions.push({ name: "ssh", tier: "opt-in", registered: false, reason: "не включён: tools.ssh: true" });
  }

  if (optIn(config, "npm_install")) {
    add(npmInstallTool, "opt-in");
  } else {
    decisions.push({ name: "npm_install", tier: "opt-in", registered: false, reason: "не включён: tools.npm_install: true" });
  }

  const disabled = decisions
    .filter((d) => !d.registered && d.reason)
    .map((d) => ({ name: d.name, reason: d.reason as string }));

  const instances: ToolsetResult["instances"] = {};
  for (const tool of tools.list()) {
    if (tool instanceof SelfieTool) instances.selfie = tool;
    else if (tool instanceof VoiceTool) instances.voice = tool;
    else if (tool instanceof BrowserTool) instances.browser = tool;
  }

  return { tools, decisions, registered: tools.list().map((t) => t.name), disabled, instances };
}

/** One line for the startup log: what is on, and why the rest is not. */
export function describeToolset(result: ToolsetResult): string {
  const on = result.registered.length;
  if (result.disabled.length === 0) return `🔧 Инструментов: ${on}`;
  const why = result.disabled.map((d) => `${d.name} (${d.reason})`).join(", ");
  return `🔧 Инструментов: ${on} · отключено: ${why}`;
}
