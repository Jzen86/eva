import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "./types.js";
import type { LLMClient, LLMMessage, ContentPart, ToolDefinition } from "./llm/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import { buildSystemPrompt, buildTimeSeams, buildTurnContext, stampHistory, type PromptConfig } from "./prompt.js";
import { stripReplyStamp } from "./memory/time-words.js";
import { userFilesPath } from "./user-files.js";
import {
  getConfigPath,
  getAgentName,
  getPersonality,
  getPersonalitySliders,
  loadConfig,
  type EvaConfig,
} from "./config.js";
import { searchKnowledge, renderKnowledge, KNOWLEDGE_PROMPT_LIMIT, profileKnowledge, knowledgeOfKind } from "./memory/knowledge.js";
import { renderProfileDossier, renderFlatBlock, PROFILE_RULE, RULES_RULE, LESSON_RULE } from "./profile-dossier.js";
import { scheduleLine } from "./work-schedule.js";
import { REPORT_SHAPE } from "./watch-reports.js";
import { previewImage, isInlineImage } from "./image-preview.js";
import { saveMessage, loadHistory, extractText, previousLiveExchange, recentSeams } from "./memory/conversations.js";
import { gapFacts, GAP_THRESHOLD_MIN, type GapFacts } from "./memory/time-words.js";
import { compactHistory } from "./memory/compaction.js";
import { alignHistory } from "./llm/history.js";
import { LLMUnavailableError } from "./llm/router.js";
import { failureSentence, isPolicyRefusal } from "./llm/errors.js";
import { isHeavyToolCall } from "./tool-tiers.js";
import { peek } from "./pending.js";
import { TokenStore } from "../services/tokens.js";
import { getService } from "../services/catalog.js";
import { SkillsStore } from "../services/skills-store.js";

function historyChars(history: LLMMessage[]): number {
  let total = 0;
  for (const m of history) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else {
      for (const p of m.content) {
        if (p.type === "text") total += p.text.length;
      }
    }
  }
  return total;
}

const MAX_TURNS = 20;
const MAX_HISTORY = 40;
export const MAX_PROMPT_TOKENS = 128_000;
/**
 * How many calls of one tool a chat turn may make before it is wound up.
 *
 * A loop guard, not a plan: a weak model can call the same tool over and over,
 * and the owner is on the other side, so stopping short costs one sentence and
 * one "повтори".
 */
export const MAX_SAME_TOOL = 5;
/**
 * The same ceiling for a service turn — a scheduled job, not a conversation.
 *
 * Nobody is on the other side of these to ask again, so being cut off mid-way
 * costs the whole report, and the job is longer than a chat turn by its own
 * text: `self_watch` reads sixteen hours of log, then `git log`, then
 * `git diff`, then the sources it names — all through `shell`, one command at a
 * time. Five stopped it at the sixth call on 11.10 and again on 13.10, and the
 * report ended with "про Задрота не успела — на меня свалился лимит на команды".
 *
 * Twelve is evidence, not taste: on 11.10 she was still firing `shell` calls
 * when the old check caught her at the ninth, so the job needs at least nine and
 * twelve is nine plus slack. That is also how to re-judge this later — if a
 * report is once cut at twelve, the ceiling is what to raise, not the task text
 * to cut down; if the reports never come near twelve, it is room nobody uses and
 * five was enough after all. The idle periods of the day are not what bounds
 * this either: `MAX_TURNS` and the five-minute budget do, and those are
 * unchanged.
 */
export const MAX_SAME_TOOL_SERVICE = 12;
const PROCESS_TIMEOUT = 300_000; // 5 minutes — soft budget, triggers graceful wrap-up
const MAX_TOOL_OUTPUT_CHARS = 8_000; // Truncate tool outputs to prevent history bloat

/**
 * What she says when two passes in a row came back empty.
 *
 * The old fallback here was a bare `...`, and it was wrong twice over: it
 * dressed a dropped completion as a deliberate message — a silent glitch read
 * as "ну и?", which is exactly how a person reads three dots — and it hid the
 * failure, so nobody could tell a dead turn from a meaningful pause. A person's
 * missed beat is what it is, so it is worded as one: a distracted "sorry, say
 * that again", not a status code. Picked at random so the same rare failure
 * does not wear the same sentence every time.
 *
 * Gendered because Russian past-tense verbs are, and the gender is taken from
 * the owner's config, never guessed here. The base ships `neutral` with
 * impersonal wording ("меня отвлекло", not "я отвлеклась"): deciding she is a
 * woman inside the repository is the one thing this base must not do.
 */
const EMPTY_REPLIES: Record<"female" | "male" | "neutral", readonly string[]> = {
  female: [
    "Ой, извини, я отвлеклась — повтори, пожалуйста.",
    "Прости, я прослушала — повтори, пожалуйста.",
    "Извини, я задумалась — повтори, пожалуйста.",
    "Прости, я не совсем поняла — повтори, пожалуйста.",
  ],
  male: [
    "Ой, извини, я отвлёкся — повтори, пожалуйста.",
    "Прости, я прослушал — повтори, пожалуйста.",
    "Извини, я задумался — повтори, пожалуйста.",
    "Прости, я не совсем понял — повтори, пожалуйста.",
  ],
  neutral: [
    "Ой, извини, меня что-то отвлекло — повтори, пожалуйста.",
    "Прости, до меня не сразу дошло — повтори, пожалуйста.",
    "Извини, что-то я не догоняю — повтори, пожалуйста.",
    "Прости, мысль куда-то убежала — повтори, пожалуйста.",
  ],
};

/** One empty-answer line, in the gender the config chose. */
export function emptyReply(gender: "female" | "male" | "neutral" | undefined): string {
  const list = EMPTY_REPLIES[gender ?? "neutral"] ?? EMPTY_REPLIES.neutral;
  return list[Math.floor(Math.random() * list.length)] ?? EMPTY_REPLIES.neutral[0]!;
}

/**
 * What a *service* turn says when the model answered nothing at all.
 *
 * A conversation keeps the filler above: somebody is on the other side, and a
 * distracted "sorry, say that again" is the human shape of a missed beat. A
 * service turn has no such reader — its text is the report the scheduler writes
 * into `~/.eva/reports/<task>.md` and sends as the result of a check, and there
 * the personal filler is a lie with a date on it. Verified live: on 13.10 the
 * 10:31 `server_watch` entered the archive as "Прости, я прослушала" while no
 * check had run at all, and the entry read exactly like a finished one.
 *
 * Silence would be the other lie, and the worse one: a check that never happened
 * would look precisely like a check that found nothing. So the failure is said
 * out loud, and named as a failure.
 */
const EMPTY_SERVICE_REPLY =
  "⚠️ Плановое задание осталось без ответа: модель промолчала дважды. Проверки не было — отчёта нет, следующий заход по расписанию.";

/**
 * What a scheduled *message* says when the model answered nothing at all.
 *
 * A check's text becomes the report, so it has to be a fact about a check (the
 * constant above). A reminder or an initiative has no report — and until this
 * existed it was handed the check's sentence verbatim: her own initiative at nine
 * in the morning carried "Проверки не было — отчёта нет, следующий заход по
 * расписанию" about a check nobody had scheduled. That is the same "lie with a
 * date on it" the text above was written to avoid, one step to the side.
 *
 * The flag that tells the two apart is `reportTask` — the same one the report
 * archive uses, not `scheduledTask`, which is true for all three.
 */
export const EMPTY_SCHEDULE_REPLY =
  "⚠️ Плановое сообщение осталось без ответа: модель промолчала дважды.";

/**
 * What she is told when her own picture is put in front of her.
 *
 * Two sentences, on purpose. The first version listed the defects to look for and
 * she recited them; the second listed the ones to ignore and was just as
 * specific — the same mistake twice, both times mine. What has to be said is the
 * task (does the picture show what he asked for) and who decides (he does), and
 * neither needs an inventory of failure modes to be understood.
 *
 * There is no retry here, and that is deliberate: the note used to promise one
 * ("one retry on her own, with a changed prompt"), and the engine has never had
 * such a thing — the only retry in it is for an empty answer. A second frame is
 * the owner's call.
 *
 * The owner added a third thing (16.10): the frame is for her to *know what she
 * sent*, not to narrate. He sees the picture himself, so a description in the
 * reply is noise, and "оставлять или переделывать?" is a question he does not
 * want to answer in chat. The reply must be her own message — the words she
 * wanted to say, e.g. "я тебе кофе сделала, идём пить" — with the picture
 * standing beside it. So the note keeps "you see it" (that clause is what once
 * stopped her from writing "я не вижу картинок" into memory) and adds "don't
 * describe it, don't ask — write your own message".
 *
 * And the decision he did want her to make (16.10, second pass): a *gross*
 * defect — an extra arm, leg or head, the wrong number of parts — is hers to
 * redo, once, and she says nothing about it; small flaws (a bent finger, a
 * crooked hand) are kept. The line is drawn where he drew it, because the
 * difference between "broken picture" and "nobody looks at hands" is his, not
 * hers to guess. This is why the note no longer ends "переделывать или нет —
 * решает он": the retry exists now (she re-calls the generator, and the engine
 * replaces the rejected frame — see the media list in the tool loop, so only the
 * accepted one is delivered), and only the *report* about it stays unwelcome.
 */
export const IMAGE_FEEDBACK_NOTE =
  "Это кадр, который ты только что сделала — ты видишь его сама. Явный брак (лишняя рука, " +
  "нога или голова, не то число частей тела) — переделай один раз; мелкие огрехи вроде " +
  "вывернутых пальцев или кривой кисти — оставь как есть. Ни проверку, ни переделку ему " +
  "не описывай и не переспрашивай: напиши то, что хочешь ему сказать, — своё обычное " +
  "сообщение, кадр он видит и без тебя.";

export interface EngineDeps {
  llm: {
    fast(): LLMClient;
    strong(): LLMClient;
    hasRole?(name: string): boolean;
    /**
     * A role's client with the fallback chain, like `fast()`/`strong()`.
     *
     * Optional so a test can hand in a two-role fake; the engine checks for its
     * presence before using it, exactly as it does with `hasRole`.
     */
    proxied?(name: string): LLMClient;
    /**
     * A role's client with no fallback chain: exactly the configured model, whose
     * failures reach the caller — the router's `role()`.
     *
     * Optional for the same reason as `proxied`, and used by the digest: a chain
     * would walk it onto whatever the router is degraded to, which is the chat's
     * model, not a model chosen for this job.
     */
    role?(name: string): LLMClient;
  };
  config: PromptConfig;
  tools: ToolRegistry;
  encryptionKey?: string;
}

export class Engine {
  private deps: EngineDeps;
  private histories: Map<string, LLMMessage[]> = new Map();
  private summaries: Map<string, string> = new Map();
  private compactionInFlight: Map<string, Promise<void>> = new Map();
  /**
   * The "here is what you made" messages pushed during the current turn, per
   * user, so the next turn can take them back out. See the push in the tool
   * loop: a generated picture should be visible while it is being judged, not
   * on every message afterwards.
   */
  private imageFeedback: Map<string, LLMMessage[]> = new Map();
  /**
   * One turn at a time per user.
   *
   * `process()` mutates the shared history array across awaits: it pushes an
   * assistant message carrying tool_calls and, several calls later, the
   * matching tool results. A scheduler tick — or a reminder recovered at
   * startup — that runs inside that window builds a request from the same array
   * and sends it, so the model sees an unanswered tool_call and every provider
   * answers 400. study-runner already guards against exactly this with an
   * inFlight flag; the path that produces a user-visible answer did not.
   */
  private turnLocks: Map<string, Promise<void>> = new Map();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  /**
   * Who she is, read from disk at request time.
   *
   * This used to be the snapshot taken at startup, and that made a personality
   * written from the chat — `/persona`, or a `self_config` call the owner
   * confirmed with `/yes` — take effect only after someone restarted the bot.
   * The owner's words were «потом командами можно поменять», and the honest
   * reading of the code was «потом, после рестарта, а про рестарт никто не
   * говорил». A change to who she is has to be in her next answer, because the
   * whole point of making the change is to see her be different.
   *
   * Cost: one small YAML parse per message, against a model call that takes
   * seconds. Not a trade-off worth optimising away.
   *
   * On a read that fails — a hand-edited file mid-write, a half-flushed save —
   * the startup snapshot stays. A bot that suddenly forgets her name because
   * the config was unreadable for one message is worse than one that is a
   * message late, and the failure gets logged either way.
   */
  private liveConfig(): PromptConfig {
    let config: EvaConfig | null = null;
    try {
      config = loadConfig(getConfigPath());
    } catch (err) {
      console.error(
        `Identity not reloaded, keeping the startup snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.deps.config;
    }
    if (!config) return this.deps.config;

    try {
      const personality = getPersonality(config);
      return {
        name: getAgentName(config),
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
        timezoneOffsetHours: config.agent?.timezone_offset_hours,
        workSchedule: config.agent?.schedule
          ? {
              workDays: config.agent.schedule.work_days,
              restDays: config.agent.schedule.rest_days,
              anchor: config.agent.schedule.anchor,
              shift: config.agent.schedule.shift,
            }
          : undefined,
        gapThresholdMinutes: config.agent?.gap_threshold_min,
        owner: config.owner,
        filesVaultPath: userFilesPath(),
      };
    } catch (err) {
      console.error(
        `Identity not rebuilt, keeping the startup snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.deps.config;
    }
  }

  private hydrateUser(userId: string): void {
    if (this.histories.has(userId)) return;
    const { messages, summary } = loadHistory(userId, MAX_HISTORY, this.deps.config.timezoneOffsetHours ?? 4);
    this.histories.set(userId, messages);
    if (summary) this.summaries.set(userId, summary);
  }

  /** Get conversation history for a user (for scheduler context). */
  clearHistory(userId: string): void {
    this.histories.delete(userId);
    this.summaries.delete(userId);
  }

  /**
   * Keep only the part of the history a provider will parse, and remember it.
   *
   * The single place this happens, called before every request the engine
   * builds — which covers each way a history can arrive wrong: loaded from the
   * database, cut by `hard_truncate`, replaced wholesale by a compaction, or
   * appended to by a turn that died midway. Checking at the request boundary
   * rather than at each source is the point: a second source added later gets
   * the guarantee for free, and there is no ordering to get wrong between a
   * cut and a check.
   *
   * This is not a nicety. On 27.09 Eva went quiet for the rest of the
   * process's life: `slice(-40)` landed inside an `assistant(tool_calls)` +
   * `tool` pair, every request came back `400` with no body, and the catch that
   * apologises to the user sent the same broken history, so the apology failed
   * too. A request that cannot be parsed is not a provider having a bad day.
   */
  private align(userId: string, history: LLMMessage[], reason: string): LLMMessage[] {
    const aligned = alignHistory(history);
    if (aligned === history) return history;
    console.log(
      JSON.stringify({
        tag: "engine:history_align",
        userId,
        reason,
        dropped: history.length - aligned.length,
        kept: aligned.length,
      }),
    );
    this.histories.set(userId, aligned);
    return aligned;
  }

  getHistory(userId: string): Array<{ role: string; content: string }> {
    this.hydrateUser(userId);
    const history = this.histories.get(userId);
    if (!history) return [];
    return history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
      }));
  }

  async process(msg: IncomingMessage, onProgress?: ProgressCallback): Promise<OutgoingMessage> {
    // A turn can park an action for the owner (pending.ts). Catch the one this
    // turn created so the channel can put buttons under the reply rather than
    // making the owner type /yes: createdAt moves only when a new proposal
    // replaces the old one, so an older, untouched proposal does not re-prompt.
    const parkedBefore = peek(msg.userId)?.createdAt ?? 0;
    const out = await this.runExclusive(msg.userId, () => this.processLocked(msg, onProgress));
    // The clock the window carries does not belong in her reply; see stripReplyStamp.
    // Stripped here as well as in `saveMessage`, so the delivered text and the stored
    // one are the same words.
    out.text = stripReplyStamp(out.text);
    const parked = peek(msg.userId);
    if (parked && parked.createdAt > parkedBefore) {
      return {
        ...out,
        confirm: {
          summary: parked.summary,
          ...(parked.reason ? { reason: parked.reason } : {}),
          ...(parked.policy ? { policy: parked.policy } : {}),
        },
      };
    }
    return out;
  }

  /** Serialise turns per user; see `turnLocks`. */
  private async runExclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.turnLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.turnLocks.set(userId, current);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.turnLocks.get(userId) === current) this.turnLocks.delete(userId);
    }
  }

  private async processLocked(msg: IncomingMessage, onProgress?: ProgressCallback): Promise<OutgoingMessage> {
    /**
     * Which role answers right now, for the turn log.
     *
     * The log used to record only that tools were involved, never the model, so
     * "did this turn lift to strong?" could not be answered from a live journal —
     * only guessed at. The tier is what the routing decision actually is, so it
     * is written down where the decision is made.
     */
    let tier: "fast" | "strong" | "checks" = "fast";
    // Only upgrade to the strong role when it is configured. A tool turn would
    // otherwise ask a role that resolves to nothing and fail.
    const strongAvailable = this.deps.llm.hasRole?.("strong") ?? false;
    /**
     * A report turn — a scheduled check writing what it found — runs on its own
     * role, and stays there.
     *
     * The role is optional: with no `models.checks` in the config the turn runs
     * exactly as it did before, on `fast` and lifting to `strong` like any other
     * tool turn. That keeps the base installable with one provider, and it is
     * why the checks role is a role rather than a new mechanism.
     *
     * The lift is deliberately switched off here. A check's whole job is heavy —
     * it runs `shell` on its first turn and keeps running it — so the ordinary
     * rule would lift every check turn to `strong` and the dedicated role would
     * never be used. Which is also the honest reason the role can exist at all:
     * on this turn the model is doing one narrow kind of work (read a log, read
     * a diff, write a report), not holding a conversation.
     */
    const checksTurn =
      msg.metadata?.reportTask === true &&
      (this.deps.llm.proxied !== undefined && (this.deps.llm.hasRole?.("checks") ?? false));

    /**
     * Did he ask to be answered with a voice?
     *
     * Asked for is asked for, and the voice budget exempts it (voice-budget.ts) —
     * a budget that made her refuse the owner would be worse than any number of
     * voice messages. Two ways to ask: he sent a voice note (the channel marks it,
     * because a transcript says what he said, not that he said it aloud), or he
     * said so in words.
     */
    const voiceRequested =
      msg.metadata?.voiceNote === true ||
      /(голосов|озвуч|голосом|вслух)/i.test(msg.text ?? "");
    let llm = checksTurn ? this.deps.llm.proxied!("checks") : this.deps.llm.fast();
    if (checksTurn) tier = "checks";
    const userId = msg.userId;

    // Wait for any in-flight compaction to finish before proceeding
    const pending = this.compactionInFlight.get(userId);
    if (pending) {
      await pending;
    }

    // Get or create history for this user
    if (!this.histories.has(userId)) {
      this.hydrateUser(userId);
    }
    let history = this.histories.get(userId)!;

    /**
     * The moment of this turn, in seconds — the clock every message it adds carries.
     *
     * So the request built at the end of the turn can say when each line happened
     * (`stampHistory`): messages loaded from the table bring the row's own timestamp,
     * and the ones this turn pushes are all this moment, give or take the seconds it
     * takes to think. Without it, everything from one process's life reads as "just
     * now" — the live failure of 18.10, where a morning of server work was called
     * "ты только что ковырял" eight hours later, and a six-hour figure from 15:36 came
     * back unchanged at 18:00.
     */
    const turnSeconds = Math.floor((msg.timestamp ?? Date.now()) / 1000);
    /** His hours, for the clock in front of the lines of the window (`stampHistory`). */
    const tzOffsetHours = this.liveConfig().timezoneOffsetHours ?? 4;

    // Drop the pictures shown to her during the previous turn. They exist so she
    // can judge what she just generated; keeping them would charge image tokens
    // on every later message of the session. See the feedback push below.
    const previousFeedback = this.imageFeedback.get(userId);
    if (previousFeedback?.length) {
      history = history.filter((m) => !previousFeedback.includes(m));
      this.histories.set(userId, history);
      this.imageFeedback.delete(userId);
    }

    // The window is full: fold what falls out of it into the digest before the
    // cut, so the oldest thing the model can still see does not simply stop
    // existing. The cut itself stays raw — `align` runs at the request boundary,
    // and a second pass over the same array would be the same walk twice.
    if (history.length > MAX_HISTORY * 2) {
      console.log(JSON.stringify({ tag: "engine:hard_truncate", userId, before: history.length, kept: MAX_HISTORY }));
      this.startCompaction(userId);
      history = history.slice(-MAX_HISTORY);
      this.histories.set(userId, history);
    };

    // Build system prompt with memory context. The rotation on the conversation
    // length is what makes the leave-taking block frequent but not constant.
    const systemPrompt = this.buildPromptWithMemory(
      msg.text,
      userId,
      msg.timestamp,
      msg.metadata?.scheduledTask === true,
      history.length % 3 !== 0,
      msg.metadata?.reportTask === true,
    );

    // Add user message (with reply context and/or images if present)
    const replyTo = msg.metadata?.replyToText as string | undefined;
    const textContent = replyTo
      ? `[В ответ на сообщение: "${replyTo}"]\n\n${msg.text}`
      : msg.text;

    if (msg.images?.length) {
      const parts: ContentPart[] = [
        { type: "text", text: textContent },
        ...msg.images.map((b64): ContentPart => ({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${b64}` },
        })),
      ];
      history.push({ role: "user", content: parts, at: turnSeconds });
    } else {
      history.push({ role: "user", content: textContent, at: turnSeconds });
    }

    saveMessage(userId, msg.channelName, "user", textContent);

    // Build tool definitions for the LLM
    const tools = this.buildToolDefinitions();

    // A service turn is doing a job and its job is longer than a chat turn's —
    // see MAX_SAME_TOOL_SERVICE.
    const sameToolLimit =
      msg.metadata?.scheduledTask === true ? MAX_SAME_TOOL_SERVICE : MAX_SAME_TOOL;

    /**
     * Everything this turn made, in the order it was made.
     *
     * `lastMediaUrl` and `lastMediaPath` are one slot each, so the second
     * picture or the second voice note overwrote the first and vanished — while
     * the tool told her "готово и отправлено", which is why she never noticed
     * and never repeated it. A turn can legitimately make two: two voice notes
     * when she is asked for two, or a voice and a picture together.
     *
     * Declared outside the `try` on purpose: the catch below is a *recovery* turn,
     * and it used to return text alone. A picture or a voice note made before the
     * failure — the frame she had just been told she could see — was dropped, and
     * the owner read an apology with no sign that anything had been made at all.
     */
    let lastMediaUrl: string | undefined;
    let lastMediaPath: string | undefined;
    const media: Array<{ url?: string; path?: string; text?: string }> = [];
    /**
     * Where an inline frame from each generator sits in `media`.
     *
     * A frame she can see and judge is the one thing she may ask for again: a
     * gross defect is hers to redo (see IMAGE_FEEDBACK_NOTE). The second frame
     * *replaces* the rejected one instead of joining it, so the owner gets the
     * picture and not the process — he said it plainly (16.10): "для меня это
     * просто картинка в итоге". Keyed by tool and limited to inline images,
     * which is exactly what she can see; two voice notes, or a voice and a
     * picture, still both travel.
     */
    const frameAt = new Map<string, number>();

    try {
      const toolCallCounts = new Map<string, number>();
      const processStart = Date.now();

      // Agentic loop: LLM → tool calls → execute → repeat
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // Soft time budget — give LLM one final chance to summarize (no tools)
        if (Date.now() - processStart > PROCESS_TIMEOUT) {
          console.log(JSON.stringify({ tag: "engine:limit", reason: "timeout", elapsedMs: Date.now() - processStart }));
          // The instruction belongs to this call, not to the session. Pushed into
          // `history` it stayed there for the rest of it, so the *next* turn opened
          // with "не вызывай инструменты" — a stale order outliving the reason for
          // it. (The image feedback is the deliberate opposite: seen once, dropped
          // at the top of the next turn, because it is about something she made.
          // These are instructions to one call.)
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...stampHistory(history, tzOffsetHours),
            { role: "user", content: "Времени мало. Ответь на основе того, что уже удалось сделать. Не вызывай инструменты." },
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = finalResponse.text || "Не удалось завершить задачу полностью, но вот что получилось.";
          history.push({ role: "assistant", content: text, at: turnSeconds });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
        }

        onProgress?.({ type: "thinking" });

        history = this.align(userId, history, "request");

        // Use streaming for text responses, non-streaming for tool calls
        const streamChunk = onProgress
          ? (chunk: string) => onProgress({ type: "text_chunk", chunk })
          : undefined;

        const request: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...stampHistory(history, tzOffsetHours),
        ];

        const histSize = historyChars(history);
        const llmStart = Date.now();
        // No retry on a 400, and that is deliberate. The history is aligned
        // right above, before the request is assembled, so a rejected request
        // was rejected for a reason that survives the same request being sent
        // again — a model that is not allowed, a body nobody here reads. What
        // used to happen instead: the request 400'd, the catch apologised to
        // the user on the very same history, that call 400'd too, and Eva went
        // silent for the rest of the process's life.
        const response = streamChunk
          ? await llm.chatStream(request, streamChunk, tools.length ? tools : undefined)
          : await llm.chat(request, tools.length ? tools : undefined);
        const llmMs = Date.now() - llmStart;

        console.log(JSON.stringify({
          tag: "engine",
          turn: turn + 1,
          tier,
          llmMs,
          promptTokens: response.usage?.promptTokens,
          completionTokens: response.usage?.completionTokens,
          historyMessages: history.length,
          historyChars: histSize,
          reasoning: response.text?.slice(0, 200),
          stopReason: response.stopReason,
          toolCalls: response.toolCalls?.map(t => t.name),
        }));

        // Hard ceiling against the provider's own context limit. Not a compaction
        // trigger: at 128k prompt tokens a 40-message window has long since been
        // summarised, so there is nothing left here to compact — this only runs if
        // a single turn itself goes enormous, and then all it can do is stop.
        if (response.usage && response.usage.promptTokens > MAX_PROMPT_TOKENS) {
          const text = response.text || "Достигнут лимит контекста. Вот что удалось найти.";
          history.push({ role: "assistant", content: text, at: turnSeconds });
          saveMessage(userId, msg.channelName, "assistant", text);
          console.log(JSON.stringify({
            tag: "engine:limit",
            reason: "token_budget",
            promptTokens: response.usage.promptTokens,
          }));
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
        }

        // If LLM didn't request tools, return the text response
        if (response.stopReason !== "tool_use" || !response.toolCalls?.length) {
          let text = response.text ?? "";
          if (!text.trim()) {
            // The model ended the turn with nothing to say. Once is a glitch —
            // a dropped completion, not a decision — so ask again before
            // putting words in her mouth. The retry goes out without tools: the
            // turn is already over, the model was not going to call one, and a
            // tool call here would have no result to answer from.
            console.log(JSON.stringify({ tag: "engine:empty", turn: turn + 1, retry: true }));
            const retry = streamChunk
              ? await llm.chatStream(request, streamChunk)
              : await llm.chat(request);
            text = (retry.text ?? "").trim();
            if (!text) {
              console.log(JSON.stringify({ tag: "engine:empty", turn: turn + 1, retry: false }));
              text =
                msg.metadata?.reportTask === true
                  ? EMPTY_SERVICE_REPLY
                  : msg.metadata?.scheduledTask === true
                    ? EMPTY_SCHEDULE_REPLY
                    : emptyReply(this.liveConfig().gender);
            }
          }
          history.push({ role: "assistant", content: text, at: turnSeconds });
          saveMessage(userId, msg.channelName, "assistant", text);

          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
        }

        // Tools are involved from here on, and only some of them are work worth
        // the strong model. A light tool — a search, a memory lookup, a voice
        // note — leaves the rest of the turn on the chat model; a heavy one
        // lifts it. `llm` is never put back down, so once a heavy step has
        // raised the turn it stays raised to its end. See tool-tiers.ts.
        //
        // A report turn is excluded: it was already started on its own role
        // because everything it does is heavy, and lifting it here would hand
        // the check straight back to `strong` on the first `shell` call.
        const needsStrong = response.toolCalls.some((tc) =>
          isHeavyToolCall(tc.name, tc.arguments),
        );
        if (needsStrong && strongAvailable && !checksTurn) {
          llm = this.deps.llm.strong();
          tier = "strong";
        }

        // Add assistant message with tool calls to history (MOVED from before compaction check)
        history.push({
          role: "assistant",
          content: response.text || "",
          toolCalls: response.toolCalls,
        });
        saveMessage(userId, msg.channelName, "assistant", response.text || "", undefined, response.toolCalls);

        // Execute each tool and add results to history
        for (const tc of response.toolCalls) {
          onProgress?.({ type: "tool_start", tool: tc.name, turn: turn + 1 });

          const toolStart = Date.now();
          const result = await this.executeTool(tc.name, tc.arguments, userId, voiceRequested);
          const toolMs = Date.now() - toolStart;

          let resultText = result.success
            ? result.output
            : `Error: ${result.error || result.output}`;

          if (resultText.length > MAX_TOOL_OUTPUT_CHARS) {
            resultText = resultText.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n[обрезано: ${resultText.length} символов → ${MAX_TOOL_OUTPUT_CHARS}]`;
          }

          console.log(JSON.stringify({
            tag: "engine:tool",
            turn: turn + 1,
            tool: tc.name,
            params: tc.arguments,
            success: result.success,
            outputChars: resultText.length,
            toolMs,
          }));

          if (result.mediaUrl) {
            lastMediaUrl = result.mediaUrl;
          }
          if (result.mediaPath) {
            lastMediaPath = result.mediaPath;
          }
          if (result.mediaUrl || result.mediaPath) {
            const entry = {
              ...(result.mediaUrl ? { url: result.mediaUrl } : {}),
              ...(result.mediaPath ? { path: result.mediaPath } : {}),
              ...(result.mediaText ? { text: result.mediaText } : {}),
            };
            // A second inline frame from the same generator is a redo, and it
            // takes the rejected frame's place rather than piling up beside it.
            const redoAt = isInlineImage(result.mediaUrl) ? frameAt.get(tc.name) : undefined;
            if (redoAt !== undefined) {
              media[redoAt] = entry;
            } else {
              if (isInlineImage(result.mediaUrl)) frameAt.set(tc.name, media.length);
              media.push(entry);
            }
          }

          history.push({
            role: "tool",
            content: resultText,
            toolCallId: tc.id,
          });
          saveMessage(userId, msg.channelName, "tool", resultText, tc.id);

          /**
           * Show her what she just made.
           *
           * The picture goes out to the channel as a data URL, and the model that
           * wrote the prompt never saw it: she generated blind, the owner said
           * "не то", and she rewrote the words with no idea which part was wrong.
           * Measured on the live install: the same request produced a frame with
           * both hands on her chest and, one minute later, a frame with her hand
           * there and his lower — the model follows "touching" loosely, and only
           * whoever looks at the result can tell. So the image travels back to her
           * as an image part she can see.
           *
           * It is a synthetic user message, and deliberately not saved: it is not
           * something the owner said, and it must not enter the archive as a turn
           * of the conversation. It also lives for one turn only — the engine drops
           * these at the start of the next one, so a picture costs image tokens
           * while it is being judged and not on every later message.
           */
          if (isInlineImage(result.mediaUrl)) {
            const preview = await previewImage(result.mediaUrl);
            if (preview) {
              console.log(JSON.stringify({
                tag: "engine:image_feedback",
                tool: tc.name,
                inBytes: result.mediaUrl.length,
                outBytes: preview.dataUrl.length,
                bytes: preview.bytes,
                shrunk: !preview.original,
              }));
              const feedback: LLMMessage = {
                role: "user",
                content: [
                  { type: "text", text: IMAGE_FEEDBACK_NOTE },
                  { type: "image_url", image_url: { url: preview.dataUrl } },
                ],
                // The one push that must keep its identity: the list below is compared
                // by reference at the top of the next turn, so a copy here would leave
                // the picture in the history — and its base64 in every later request.
                at: turnSeconds,
              };
              history.push(feedback);
              const shown = this.imageFeedback.get(userId) ?? [];
              shown.push(feedback);
              this.imageFeedback.set(userId, shown);
            }
          }

          onProgress?.({ type: "tool_end", tool: tc.name, turn: turn + 1, success: result.success });
        }

        // Increment tool counts for this cycle
        for (const tc of response.toolCalls) {
          toolCallCounts.set(tc.name, (toolCallCounts.get(tc.name) ?? 0) + 1);
        }

        // Check 2: Per-tool limit (scoped to current process() call only)
        const overused = [...toolCallCounts.entries()].find(([, count]) => count > sameToolLimit);
        if (overused) {
          console.log(JSON.stringify({
            tag: "engine:limit",
            reason: "tool_limit",
            tool: overused[0],
            count: overused[1],
            // Which ceiling stopped it: a chat turn and a service turn have
            // different ones, and without this the log cannot tell them apart.
            limit: sameToolLimit,
          }));
          // Give LLM one final chance to summarize what it found (no tools). The
          // instruction goes with this call only — see the timeout branch above.
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: `Лимит использования инструмента "${overused[0]}" достигнут. Ответь на основе уже полученной информации.` },
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = finalResponse.text || `Инструмент "${overused[0]}" использован ${overused[1]} раз, но не удалось сформировать ответ.`;
          history.push({ role: "assistant", content: text, at: turnSeconds });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
        }

        onProgress?.({ type: "turn_complete", turn: turn + 1, totalTurns: MAX_TURNS });
      }

      // Max turns exceeded — give LLM final chance to summarize
      console.log(JSON.stringify({ tag: "engine:limit", reason: "max_turns" }));
      const wrapMessages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: "Лимит шагов достигнут. Ответь на основе того, что уже удалось сделать." },
      ];
      const wrapResponse = await llm.chat(wrapMessages);
      const text = wrapResponse.text || "Вот что удалось сделать.";
      history.push({ role: "assistant", content: text, at: turnSeconds });
      saveMessage(userId, msg.channelName, "assistant", text);
      return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Engine error:", errorMsg);

      // The reason has to survive into the sentence. A 503, a 429, a spent key and
      // an empty 200 need different actions, and the old "что-то у меня зависло"
      // told the owner nothing about which one it was (his ask, 19.10).
      const fallback = `Блин, ${failureSentence(err)}`;

      // A refusal gets no second attempt at explaining itself. The recovery
      // call carries the same history, so the provider refuses it the same way
      // it refused the turn — two more calls and two more full prompts spent on
      // an answer that cannot arrive. The reason goes to the owner as it is.
      if (isPolicyRefusal(err)) {
        const text = fallback;
        history.push({ role: "assistant", content: text, at: turnSeconds });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
      }

      // Try to let LLM explain what happened naturally
      try {
        // Last chance to leave the history in a state someone can answer: the
        // apology below is the last thing Eva says this turn, and if it goes
        // out on an unparseable history the user gets silence instead of it.
        history = this.align(userId, history, "recovery");

        // The instruction rides this call only — see the timeout branch above for
        // why it must not be pushed into `history`.
        const recoveryMessages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: `[Системное сообщение: произошла ошибка — ${failureSentence(err)} Передай ему это своими словами, в одном-двух предложениях: назови причину так, как она названа здесь, можно с кодом, и что делать. Коротко извинись. Других причин не выдумывай, ремарок не добавляй.]` },
        ];
        const recoveryResponse = await llm.chat(recoveryMessages);
        const text = recoveryResponse.text || fallback;
        history.push({ role: "assistant", content: text, at: turnSeconds });
        saveMessage(userId, msg.channelName, "assistant", text);
        // Whatever the turn managed to make before it broke goes out with the
        // apology. The apology is a lie if the frame it answers about is thrown away.
        return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
      } catch {
        // If even the recovery LLM call fails, use a simple message
        const text = fallback;
        history.push({ role: "assistant", content: text, at: turnSeconds });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
      }
    }
  }

  /**
   * How long the chat has been silent, in the terms the prompt can use.
   *
   * The window she is handed is a feed with no seams: role and text, forty
   * messages deep. So "лучше поиграю" at eight in the evening and "привет" at
   * five the next afternoon read as two neighbouring sentences, and she answers
   * the second as if it continued the first — asking about the game he finished
   * a night and a sleep ago. Nothing about that is her being careless: the
   * information was never in the request.
   *
   * Two decisions worth keeping when this is tuned. First, the measure is the
   * distance to the previous *sentence*, not to the previous row — tool results
   * and the scheduler's own reports are not things either of them said.
   * Second, it is emitted only when the threshold is crossed, and only on the
   * turn right after the pause, which is what stops a silence from being
   * mentioned twice: on the next message the gap is seconds wide and there is
   * nothing to say about it.
   */
  private gapFor(
    userId: string,
    incomingAt: number,
    live: PromptConfig,
  ): (GapFacts & { prevRole: string; previousExchange: ReturnType<typeof previousLiveExchange> }) | null {
    const thresholdMin = live.gapThresholdMinutes ?? GAP_THRESHOLD_MIN;
    const offsetHours = live.timezoneOffsetHours ?? 4;

    try {
      const previousExchange = previousLiveExchange(userId);
      const previous = previousExchange.at(-1);
      if (!previous) return null;

      const facts = gapFacts(previous.timestamp, Math.floor(incomingAt / 1000), offsetHours);
      const emitted = facts.seconds >= thresholdMin * 60;

      // Logged either way, and this is the point of the line rather than a
      // detail of it: with only the emitted case recorded, "she said something
      // odd about the pause" and "the measure never arrived" look the same in
      // the log, and the difference between them is a threshold and a prompt.
      console.log(JSON.stringify({
        tag: "engine:time_gap",
        userId,
        emitted,
        gapSec: facts.seconds,
        label: facts.label,
        passage: facts.passage,
        prevRole: previous.role,
        crossedDay: facts.crossedDay,
        touchedNight: facts.touchedNight,
        thresholdMin,
      }));

      return emitted ? { ...facts, prevRole: previous.role, previousExchange } : null;
    } catch {
      // Memory not initialized yet — the same quiet failure the knowledge
      // lookup below is allowed to have.
      return null;
    }
  }

  /** Build system prompt and inject relevant memory context. */
  private buildPromptWithMemory(
    userMessage: string,
    chatId: string,
    incomingAt: number,
    scheduledTurn: boolean,
    /**
     * Include the leave-taking block on this turn.
     *
     * Most turns, not all. Always present and it stops reading as advice: she
     * would work a "stay" hook into every reply, trailing one behind an answer
     * about the weather. The rotation comes from the conversation length, so a
     * silence does not reset it to the same value every time.
     */
    engage: boolean,
    /**
     * This turn is a planned *check*, not a message to him.
     *
     * Such a turn reads a log and a diff and writes a report; the memory of what
     * he likes and what they decided is not input to that work. Worse than
     * useless, it is an invitation: twelve lines of personal history in front of
     * a code review is how a report about a regression ends up mentioning how
     * they felt about it. The initiative keeps its memory — it *is* writing to
     * him — so the two service turns are told apart by `reportTask`, the same
     * flag that picks the model for the turn.
     */
    reportTurn = false,
  ): string {
    let connectedServiceNames: string[] = [];
    if (this.deps.encryptionKey) {
      try {
        const tokenStore = new TokenStore(this.deps.encryptionKey);
        const tokens = tokenStore.listConnected(chatId);
        connectedServiceNames = tokens.map(t => {
          const svc = getService(t.serviceId);
          return svc ? `${svc.name} (${t.scopes})` : t.serviceId;
        });
      } catch {}
    }

    const live = this.liveConfig();
    const gap = scheduledTurn ? null : this.gapFor(chatId, incomingAt, live);
    let prompt = buildSystemPrompt(live, undefined, chatId, connectedServiceNames, undefined, engage);

    // What he is like, always in front of her — see profileKnowledge for why
    // this one is not a search. The instruction after the list is the part the
    // measurements asked for: on every live run where the fact contradicted her
    // own taste, she read it and answered from her taste anyway ("я в зелёной
    // футболке" against a row saying he dislikes green drew praise for green,
    // twice). A fact that does not outrank her own preference is not memory, it
    // is decoration.
    try {
      if (!reportTurn) {
        const profile = renderProfileDossier(profileKnowledge());
        if (profile) {
          prompt += `\n\n## Что я о нём знаю\n\n${profile}\n\n${PROFILE_RULE}`;
        }
        // Today, counted from his cycle — the one part of the arrangement that cannot
        // live in the dossier, since it is true for a day and not for months. Without
        // a schedule in the config this is nothing at all.
        const today = scheduleLine(live.workSchedule, incomingAt, live.timezoneOffsetHours ?? 0);
        if (today) prompt += `\n\n${today}`;
        const rules = renderFlatBlock(knowledgeOfKind("rules"));
        if (rules) {
          prompt += `\n\n## Как с ним работать\n\n${rules}\n\n${RULES_RULE}`;
        }
        const lessons = renderFlatBlock(knowledgeOfKind("lesson"));
        if (lessons) {
          prompt += `\n\n## Чему он меня научил\n\n${lessons}\n\n${LESSON_RULE}`;
        }
      }
    } catch {
      // Memory not initialized yet — skip
    }

    // What she has seen before, for this exact kind of moment. Rendered by
    // knowledge.ts so a case can never reach the prompt stripped of the state it
    // happened in — and never without the date it happened on — the same shaping
    // is used by the memory tool's own search.
    //
    // Not on a check turn: see the `reportTurn` note above.
    try {
      if (!reportTurn) {
        const hits = searchKnowledge(userMessage, KNOWLEDGE_PROMPT_LIMIT);
        const rendered = renderKnowledge(hits, {
          offsetHours: live.timezoneOffsetHours ?? 4,
        });
        if (rendered) {
          prompt += `\n\n## Что было раньше\n\n${rendered}`;
        }
      }
    } catch {
      // Memory not initialized yet — skip
    }

    // The seams of the window: where the pauses inside it were, so a subject from
    // three hours ago does not read as this minute's. Nothing new is stored — the
    // times come from the timestamps every row already carries.
    try {
      const offsetHours = live.timezoneOffsetHours ?? 4;
      const seams = buildTimeSeams(
        recentSeams(chatId, 80, live.gapThresholdMinutes ?? GAP_THRESHOLD_MIN, 3),
        offsetHours,
      );
      if (seams) {
        prompt += `\n\n${seams}`;
      }
    } catch {
      // Memory not initialized yet — skip
    }

    // Inject installed skills context
    try {
      const skillsStore = new SkillsStore();
      const allSkills = skillsStore.listAll();
      if (allSkills.length > 0) {
        const skillContext = allSkills
          .slice(0, 3)
          .map((s, i) => `${i + 1}. [${s.name}] ${s.description}`)
          .join("\n");
        prompt += `\n\n## Установленные скиллы\n\n${skillContext}\n\nЧтобы использовать скилл, вспомни его содержимое из памяти.`;
      }
    } catch {}

    const summary = this.summaries.get(chatId);
    if (summary) {
      prompt += `\n\n## Краткое содержание предыдущего разговора\n\n${summary}`;
    }

    // What a report has to make visible. It belongs to the turn rather than to the task
    // text: three checks read one skeleton, and a shape copied into three texts drifts.
    // See REPORT_SHAPE for where it came from and why a clean run answers as well.
    if (reportTurn) {
      prompt += `\n\n## Отчёт\n\n${REPORT_SHAPE}`;
    }

    const turnContext = buildTurnContext(userMessage, gap ?? undefined);
    return turnContext ? `${prompt}\n\n${turnContext}` : prompt;
  }

  /**
   * Fold the conversation that has fallen out of the window into the digest, in
   * the background, at most once per user at a time.
   *
   * Called from the one place where messages actually leave the model's view —
   * the hard truncation. It used to be called when the prompt passed a token
   * budget, which could not happen: the window is 40 messages, and 40 messages
   * of chat with her come to roughly 14k prompt tokens, well under the 40k that
   * budget was set to. A conversation that was not already in trouble never
   * compacted, and every truncation dropped its oldest messages with no trace.
   * The budget was a property of the prompt; what fills a conversation and what
   * is about to be lost is the number of messages in it.
   *
   * It runs after the cut, off the critical path, on the digest's own model when
   * `models.compaction` exists and on the fast model otherwise (`digestClient`): a
   * failure here costs the old messages their summary, which is a far smaller loss
   * than refusing to answer. The next message waits for it at the top of
   * `processLocked`, which is what puts the finished digest into that prompt.
   *
   * It writes the digest and nothing else. A fold does not delete rows or touch
   * the history, so reloading the history afterwards would hand back the very
   * array the running turn is already appending to — and a turn halfway through a
   * tool block would lose the rest of itself. That is the same "someone else
   * wrote the history mid-turn" hazard `turnLocks` exists for, and a fold that
   * only appends a summary has no reason to write to the history at all.
   */
  private digestClient(): LLMClient {
    /*
     * The digest has a model of its own when the config names one, and that is
     * not the same decision as "which model talks to the owner".
     *
     * A conversation and a memory fold are different jobs. Talking is the thing
     * the owner judges her by, and the model that does it is his call. Folding the
     * digest is maintenance that carries whatever fell out of the window —
     * *including what a content filter refuses to look at*: both Google flash-lite
     * models answer this install's merge prompt with
     * `content_filter: PROHIBITED_CONTENT` (reproduced 4/4 on both), because the
     * chunks summarise an intimate conversation. While this ran on `fast()`, every
     * such refusal also pushed the live chat onto the fallback chain and told him
     * "временно работаю на …" — two jobs, one chain, and the wrong one won.
     *
     * The role is taken **without its fallback chain**, and that is deliberate.
     * The chain walks on to the global fallbacks, and it does not matter which
     * role asked: `targetFor` hands out the degraded ref to every role once the
     * router is degraded. So a refused chat reply was enough to put the digest
     * back on Google — which is the model that refuses this very prompt (seen live
     * on the first merge after the role appeared: `Роль "compaction": перепробовано:
     * google/gemini-3.1-flash-lite … PROHIBITED_CONTENT`, i.e. the digest waited a
     * turn for a model chosen exactly so that it would not be Google). No chain
     * means: this model, or the merge does not happen — and a skipped merge is
     * cheap and already handled (`mergeOldestChunks` logs it and stops).
     *
     * Optional on purpose, and it falls back to `fast()`: the repository is a
     * base, not an instance, and a config that says nothing about compaction keeps
     * behaving exactly as it did.
     */
    if (this.deps.llm.role && (this.deps.llm.hasRole?.("compaction") ?? false)) {
      return this.deps.llm.role("compaction");
    }
    return this.deps.llm.fast();
  }

  private startCompaction(userId: string): void {
    if (this.compactionInFlight.has(userId)) return;
    const started = Date.now();
    const promise = compactHistory(userId, this.digestClient(), MAX_HISTORY)
      .then((result) => {
        const summary = loadHistory(userId).summary;
        if (summary) this.summaries.set(userId, summary);
        // A fold that carried nothing forward is the failure worth seeing, not
        // the one that gets a line: `result` is null precisely when there was
        // nothing new to summarise.
        console.log(
          JSON.stringify({
            tag: "engine:compaction",
            userId,
            ms: Date.now() - started,
            folded: result?.folded ?? 0,
            chunks: result?.chunks ?? 0,
            digestChars: result?.digestChars ?? 0,
          }),
        );
      })
      .catch((err) => console.error("Compaction failed:", err))
      .finally(() => this.compactionInFlight.delete(userId));
    this.compactionInFlight.set(userId, promise);
  }

  /** Execute a single tool by name. Returns full ToolResult. */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    userId?: string,
    /** The turn's request was for a spoken answer — see voice-budget.ts. */
    voiceRequested = false,
  ): Promise<ToolResult> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `unknown tool "${name}"` };
    }

    try {
      const params = userId
        ? { ...args, _userId: userId, _voiceRequested: voiceRequested }
        : { ...args, _voiceRequested: voiceRequested };
      return await tool.execute(params);
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Convert our ToolParam[] format to OpenAI function-calling ToolDefinition[]. */
  private buildToolDefinitions(): ToolDefinition[] {
    return this.deps.tools.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: Object.fromEntries(
            tool.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ]),
          ),
          required: tool.parameters
            .filter((p) => p.required)
            .map((p) => p.name),
        },
      },
    }));
  }
}
