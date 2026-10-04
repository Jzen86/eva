import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "./types.js";
import type { LLMClient, LLMMessage, ContentPart, ToolDefinition } from "./llm/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import { buildSystemPrompt, buildTimeSeams, buildTurnContext, type PromptConfig } from "./prompt.js";
import {
  getConfigPath,
  getAgentName,
  getPersonality,
  getPersonalitySliders,
  loadConfig,
  type EvaConfig,
} from "./config.js";
import { searchKnowledge, renderKnowledge, KNOWLEDGE_PROMPT_LIMIT } from "./memory/knowledge.js";
import { saveMessage, loadHistory, extractText, previousLiveExchange, recentSeams } from "./memory/conversations.js";
import { gapFacts, GAP_THRESHOLD_MIN, type GapFacts } from "./memory/time-words.js";
import { compactHistory } from "./memory/compaction.js";
import { alignHistory } from "./llm/history.js";
import { LLMUnavailableError } from "./llm/router.js";
import { isHeavyToolCall } from "./tool-tiers.js";
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
export const MAX_SAME_TOOL = 5;
const PROCESS_TIMEOUT = 300_000; // 5 minutes — soft budget, triggers graceful wrap-up
const MAX_TOOL_OUTPUT_CHARS = 8_000; // Truncate tool outputs to prevent history bloat

/**
 * Said when the model ends a turn with an empty answer, twice.
 *
 * The old fallback here was a bare `...`, and it was wrong twice over: it
 * dressed a dropped completion as a deliberate message — a silent glitch read
 * as "ну и?", which is exactly how a person reads three dots — and it hid the
 * failure, so nobody could tell a dead turn from a meaningful pause. The retry
 * above usually recovers a real answer; when it does not, this says so instead
 * of inventing a message the model never sent.
 */
export const EMPTY_REPLY = "Не получилось ответить — повтори, пожалуйста.";

export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient; hasRole?(name: string): boolean };
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
        gender: config.agent?.gender ?? "female",
        personality: {
          tone: personality.tone,
          responseStyle: personality.style,
          persona: personality.persona,
          ops: personality.ops,
          customInstructions: personality.customInstructions,
        },
        personalitySliders: getPersonalitySliders(config),
        timezoneOffsetHours: config.agent?.timezone_offset_hours,
        gapThresholdMinutes: config.agent?.gap_threshold_min,
        owner: config.owner,
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
    return this.runExclusive(msg.userId, () => this.processLocked(msg, onProgress));
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
    let llm = this.deps.llm.fast();
    /**
     * Which role answers right now, for the turn log.
     *
     * The log used to record only that tools were involved, never the model, so
     * "did this turn lift to strong?" could not be answered from a live journal —
     * only guessed at. The tier is what the routing decision actually is, so it
     * is written down where the decision is made.
     */
    let tier: "fast" | "strong" = "fast";
    // Only upgrade to the strong role when it is configured. A tool turn would
    // otherwise ask a role that resolves to nothing and fail.
    const strongAvailable = this.deps.llm.hasRole?.("strong") ?? false;
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
      history.push({ role: "user", content: parts });
    } else {
      history.push({ role: "user", content: textContent });
    }

    saveMessage(userId, msg.channelName, "user", textContent);

    // Build tool definitions for the LLM
    const tools = this.buildToolDefinitions();

    try {
      let lastMediaUrl: string | undefined;
      let lastMediaPath: string | undefined;
      /**
       * Everything this turn made, in the order it was made.
       *
       * `lastMediaUrl` and `lastMediaPath` are one slot each, so the second
       * picture or the second voice note overwrote the first and vanished — while
       * the tool told her "готово и отправлено", which is why she never noticed
       * and never repeated it. A turn can legitimately make two: two voice notes
       * when she is asked for two, or a voice and a picture together.
       */
      const media: Array<{ url?: string; path?: string; text?: string }> = [];
      const toolCallCounts = new Map<string, number>();
      const processStart = Date.now();

      // Agentic loop: LLM → tool calls → execute → repeat
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // Soft time budget — give LLM one final chance to summarize (no tools)
        if (Date.now() - processStart > PROCESS_TIMEOUT) {
          console.log(JSON.stringify({ tag: "engine:limit", reason: "timeout", elapsedMs: Date.now() - processStart }));
          history.push({ role: "user", content: "Времени мало. Ответь на основе того, что уже удалось сделать. Не вызывай инструменты." });
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = finalResponse.text || "Не удалось завершить задачу полностью, но вот что получилось.";
          history.push({ role: "assistant", content: text });
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
          ...history,
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
          history.push({ role: "assistant", content: text });
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
              text = EMPTY_REPLY;
            }
          }
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);

          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
        }

        // Tools are involved from here on, and only some of them are work worth
        // the strong model. A light tool — a search, a memory lookup, a voice
        // note — leaves the rest of the turn on the chat model; a heavy one
        // lifts it. `llm` is never put back down, so once a heavy step has
        // raised the turn it stays raised to its end. See tool-tiers.ts.
        const needsStrong = response.toolCalls.some((tc) =>
          isHeavyToolCall(tc.name, tc.arguments),
        );
        if (needsStrong && strongAvailable) {
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
          const result = await this.executeTool(tc.name, tc.arguments, userId);
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
            media.push({
              ...(result.mediaUrl ? { url: result.mediaUrl } : {}),
              ...(result.mediaPath ? { path: result.mediaPath } : {}),
              ...(result.mediaText ? { text: result.mediaText } : {}),
            });
          }

          history.push({
            role: "tool",
            content: resultText,
            toolCallId: tc.id,
          });
          saveMessage(userId, msg.channelName, "tool", resultText, tc.id);

          onProgress?.({ type: "tool_end", tool: tc.name, turn: turn + 1, success: result.success });
        }

        // Increment tool counts for this cycle
        for (const tc of response.toolCalls) {
          toolCallCounts.set(tc.name, (toolCallCounts.get(tc.name) ?? 0) + 1);
        }

        // Check 2: Per-tool limit (scoped to current process() call only)
        const overused = [...toolCallCounts.entries()].find(([, count]) => count > MAX_SAME_TOOL);
        if (overused) {
          console.log(JSON.stringify({
            tag: "engine:limit",
            reason: "tool_limit",
            tool: overused[0],
            count: overused[1],
          }));
          // Give LLM one final chance to summarize what it found (no tools)
          history.push({ role: "user", content: `Лимит использования инструмента "${overused[0]}" достигнут. Ответь на основе уже полученной информации.` });
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = finalResponse.text || `Инструмент "${overused[0]}" использован ${overused[1]} раз, но не удалось сформировать ответ.`;
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
        }

        onProgress?.({ type: "turn_complete", turn: turn + 1, totalTurns: MAX_TURNS });
      }

      // Max turns exceeded — give LLM final chance to summarize
      console.log(JSON.stringify({ tag: "engine:limit", reason: "max_turns" }));
      history.push({ role: "user", content: "Лимит шагов достигнут. Ответь на основе того, что уже удалось сделать." });
      const wrapMessages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];
      const wrapResponse = await llm.chat(wrapMessages);
      const text = wrapResponse.text || "Вот что удалось сделать.";
      history.push({ role: "assistant", content: text });
      saveMessage(userId, msg.channelName, "assistant", text);
      return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath, ...(media.length ? { media } : {}) };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Engine error:", errorMsg);

      // Try to let LLM explain what happened naturally
      try {
        const errorContext = errorMsg.includes("timed out") ? "запрос к языковой модели завис — слишком долго думала"
          : errorMsg.includes("billing") || errorMsg.includes("402") ? "закончились кредиты на API языковой модели"
          : errorMsg.includes("rate") || errorMsg.includes("429") ? "слишком много запросов, API временно ограничил доступ"
          : errorMsg.includes("503") || errorMsg.includes("502") ? "сервер языковой модели временно недоступен"
          : `техническая проблема: ${errorMsg}`;

        history.push({ role: "user", content: `[Системное сообщение: произошла ошибка — ${errorContext}. Объясни пользователю своими словами что случилось, извинись и предложи попробовать ещё раз. Не используй технические термины. Будь краткой.]` });

        // Last chance to leave the history in a state someone can answer: the
        // apology below is the last thing Eva says this turn, and if it goes
        // out on an unparseable history the user gets silence instead of it.
        history = this.align(userId, history, "recovery");

        const recoveryMessages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...history,
        ];
        const recoveryResponse = await llm.chat(recoveryMessages);
        const text = recoveryResponse.text || "Прости, что-то у меня зависло. Повтори, пожалуйста!";
        history.push({ role: "assistant", content: text });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text };
      } catch {
        // If even the recovery LLM call fails, use a simple message
        const text = "Прости, что-то у меня зависло. Повтори, пожалуйста!";
        history.push({ role: "assistant", content: text });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text };
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

    // What she has seen before, for this exact kind of moment. Rendered by
    // knowledge.ts so a case can never reach the prompt stripped of the state it
    // happened in — and never without the date it happened on — the same shaping
    // is used by the memory tool's own search.
    try {
      const hits = searchKnowledge(userMessage, KNOWLEDGE_PROMPT_LIMIT);
      const rendered = renderKnowledge(hits, {
        offsetHours: live.timezoneOffsetHours ?? 4,
      });
      if (rendered) {
        prompt += `\n\n## Что было раньше\n\n${rendered}`;
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
   * It runs after the cut, off the critical path, on the fast model: a failure
   * here costs the old messages their summary, which is a far smaller loss than
   * refusing to answer. The next message waits for it at the top of
   * `processLocked`, which is what puts the finished digest into that prompt.
   *
   * It writes the digest and nothing else. A fold does not delete rows or touch
   * the history, so reloading the history afterwards would hand back the very
   * array the running turn is already appending to — and a turn halfway through a
   * tool block would lose the rest of itself. That is the same "someone else
   * wrote the history mid-turn" hazard `turnLocks` exists for, and a fold that
   * only appends a summary has no reason to write to the history at all.
   */
  private startCompaction(userId: string): void {
    if (this.compactionInFlight.has(userId)) return;
    const started = Date.now();
    const promise = compactHistory(userId, this.deps.llm.fast(), MAX_HISTORY)
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
  private async executeTool(name: string, args: Record<string, unknown>, userId?: string): Promise<ToolResult> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `unknown tool "${name}"` };
    }

    try {
      const params = userId ? { ...args, _userId: userId } : args;
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
