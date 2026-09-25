import { ProviderRegistry, type ModelRef } from "./registry.js";
import { isRetryableError, isBillingError } from "./errors.js";
import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, StreamCallback } from "./types.js";

class ModelTimeoutError extends Error {
  constructor() {
    super("Model timed out");
    this.name = "ModelTimeoutError";
  }
}

export class LLMUnavailableError extends Error {
  constructor(message = "All LLM models unavailable") {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

export interface RouterOptions {
  /** Max wait for a first token, reset on every streamed chunk. */
  perModelTimeoutMs?: number;
  /**
   * Wall-clock budget for one request across the whole fallback chain.
   * Without it, 6 models x 60s = six minutes of silence before the user sees
   * anything at all.
   */
  chainBudgetMs?: number;
  /** How often to probe the primary model while degraded. */
  restoreProbeMs?: number;
}

const DEFAULTS = {
  perModelTimeoutMs: 45_000,
  chainBudgetMs: 150_000,
  restoreProbeMs: 5 * 60_000,
};

/** Wraps a promise in a timeout that also respects a shared deadline. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelTimeoutError()), Math.max(1, ms));
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Like withTimeout, but the timer resets on every chunk so a slow-but-alive
 *  stream is never cut off. */
function withStreamingTimeout<T>(run: (reset: () => void) => Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new ModelTimeoutError()), Math.max(1, ms));
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new ModelTimeoutError()), Math.max(1, ms));
    };
    run(reset).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class LLMRouter {
  private readonly registry: ProviderRegistry;
  private readonly opts: Required<RouterOptions>;

  /** Set while we are running on a fallback instead of the configured models. */
  private degradedRef: ModelRef | null = null;
  private degradedIndex = 0;
  private pendingNotification: string | null = null;

  private restoreTimer: ReturnType<typeof setInterval> | null = null;

  private readonly proxies = new Map<string, LLMClient>();

  constructor(registry: ProviderRegistry, options: RouterOptions = {}) {
    this.registry = registry;
    this.opts = { ...DEFAULTS, ...options };
  }

  get mode(): "normal" | "degraded" {
    return this.degradedRef ? "degraded" : "normal";
  }

  get registryRef(): ProviderRegistry {
    return this.registry;
  }

  /** "fast: openrouter/google/gemini-2.5-flash" — for logs and the /models command. */
  describe(role: string): string {
    const ref = this.targetFor(role);
    return ref ? `${role}: ${this.registry.label(ref)}` : `${role}: (не задан)`;
  }

  // --- role accessors --------------------------------------------------------

  fast(): LLMClient {
    return this.roleProxy("fast");
  }

  strong(): LLMClient {
    return this.roleProxy("strong");
  }

  /**
   * A client for any named role. Non-fallback: the caller gets exactly the
   * configured model and sees its errors. Used by study and embeddings, where
   * silently switching to a different model would be wrong.
   */
  role(name: string): LLMClient {
    const ref = this.registry.role(name);
    if (!ref) throw new LLMUnavailableError(`Роль "${name}" не настроена в config.yaml (models.${name})`);
    return this.registry.client(ref);
  }

  hasRole(name: string): boolean {
    return Boolean(this.registry.role(name));
  }

  destroy(): void {
    this.stopRestoreProbe();
  }

  // --- internals -------------------------------------------------------------

  /** Which model a role should actually use right now. */
  private targetFor(role: string): ModelRef | undefined {
    if (this.degradedRef) return this.degradedRef;
    return this.registry.role(role);
  }

  /** Everything we are willing to try, in order, without repeats. */
  private chainFor(role: string): ModelRef[] {
    const chain: ModelRef[] = [];
    const seen = new Set<string>();
    const push = (ref: ModelRef | undefined) => {
      if (!ref) return;
      if (!this.registry.isUsable(ref.provider)) return;
      const key = `${ref.provider} ${ref.model}`;
      if (seen.has(key)) return;
      seen.add(key);
      chain.push(ref);
    };
    push(this.targetFor(role));
    for (const f of this.registry.usableFallbacks()) push(f);
    return chain;
  }

  private roleProxy(role: string): LLMClient {
    const hit = this.proxies.get(role);
    if (hit) return hit;
    const proxy = this.createProxy(role);
    this.proxies.set(role, proxy);
    return proxy;
  }

  private createProxy(role: string): LLMClient {
    const self = this;

    return {
      chat: async (messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> => {
        const deadline = Date.now() + self.opts.chainBudgetMs;
        const chain = self.chainFor(role);
        if (chain.length === 0) {
          throw new LLMUnavailableError(`Нет настроенной модели для роли "${role}"`);
        }

        let lastErr: unknown;
        for (let i = 0; i < chain.length; i++) {
          const ref = chain[i];
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw self.failMessage(role, chain, lastErr, "время вышло");
          }
          try {
            const response = await withTimeout(
              self.registry.client(ref).chat(messages, tools),
              Math.min(self.opts.perModelTimeoutMs, remaining),
            );
            // Only the primary model counts as a recovery. Succeeding on a
            // fallback is the expected outcome of degrading, not a return.
            const primary = self.registry.role(role);
            if (primary && sameRef(ref, primary)) self.recovered(role, ref);
            return self.attachNotification(response);
          } catch (err) {
            lastErr = err;
            if (!isRetryableError(err)) throw err;
            console.warn(
              `⚠️ LLM [${role}] ${self.registry.label(ref)} не ответил: ${errText(err)} — пробую дальше`,
            );
            self.noteFailure(role, ref, i, chain, err);
          }
        }
        throw self.failMessage(role, chain, lastErr, "все модели не ответили");
      },

      chatStream: async (
        messages: LLMMessage[],
        onChunk: StreamCallback,
        tools?: ToolDefinition[],
      ): Promise<LLMResponse> => {
        const deadline = Date.now() + self.opts.chainBudgetMs;
        const chain = self.chainFor(role);
        if (chain.length === 0) {
          throw new LLMUnavailableError(`Нет настроенной модели для роли "${role}"`);
        }

        let lastErr: unknown;
        for (let i = 0; i < chain.length; i++) {
          const ref = chain[i];
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw self.failMessage(role, chain, lastErr, "время вышло");
          }
          let delivered = false;
          try {
            const response = await withStreamingTimeout(
              (reset) =>
                self.registry.client(ref).chatStream(
                  messages,
                  (chunk) => { delivered = true; reset(); onChunk(chunk); },
                  tools,
                ),
              Math.min(self.opts.perModelTimeoutMs, remaining),
            );
            const primary = self.registry.role(role);
            if (primary && sameRef(ref, primary)) self.recovered(role, ref);
            return self.attachNotification(response);
          } catch (err) {
            lastErr = err;
            if (!isRetryableError(err) || delivered) throw err;
            console.warn(
              `⚠️ LLM [${role}] ${self.registry.label(ref)} оборвался на стриме: ${errText(err)} — пробую дальше`,
            );
            self.noteFailure(role, ref, i, chain, err);
          }
        }
        throw self.failMessage(role, chain, lastErr, "все модели не ответили");
      },
    };
  }

  /**
   * Record a failure. On the primary model this means "go degraded" and arms the
   * restore probe; on a fallback it means "advance one step".
   *
   * State changes are synchronous. Deferring them into a promise chain meant a
   * fallback that succeeded on its first attempt cleared the degraded flag
   * before the caller could read it, so the user was never told about the
   * switch. JS is single-threaded, so a plain read-modify-write is already
   * atomic with respect to other requests.
   */
  private noteFailure(role: string, ref: ModelRef, index: number, chain: ModelRef[], err: unknown): void {
    const primary = this.registry.role(role);
    const isPrimary = Boolean(primary && sameRef(ref, primary));

    if (isPrimary && !this.degradedRef) {
      const next = chain.find((m) => !sameRef(m, ref));
      if (!next) return;
      this.degradedRef = next;
      this.degradedIndex = 0;
      this.pendingNotification =
        `⚠️ Модель ${this.registry.label(ref)} недоступна (${errText(err)}). ` +
        `Временно работаю на ${this.registry.label(next)}.`;
      console.warn(`⚠️ LLM [${role}]: переключаюсь на ${this.registry.label(next)}`);
      this.startRestoreProbe(role);
      return;
    }

    if (this.degradedRef) {
      this.degradedIndex = index + 1;
      const next = chain[this.degradedIndex];
      if (next && !sameRef(next, this.degradedRef)) {
        this.degradedRef = next;
        console.warn(`⚠️ LLM [${role}]: следующий fallback — ${this.registry.label(next)}`);
      }
    }
  }

  private failMessage(role: string, chain: ModelRef[], lastErr: unknown, why: string): LLMUnavailableError {
    const tried = chain.map((r) => this.registry.label(r)).join(", ");
    const err = new LLMUnavailableError(
      `Роль "${role}": ${why}. Перепробовано: ${tried}. Последняя ошибка: ${errText(lastErr)}`,
    );
    console.error(`❌ LLM [${role}]: ${err.message}`);
    return err;
  }

  private recovered(role: string, ref: ModelRef): void {
    if (!this.degradedRef) return;
    this.degradedRef = null;
    this.degradedIndex = 0;
    this.pendingNotification = `✅ Модель ${this.registry.label(ref)} снова отвечает — вернулась на неё.`;
    this.stopRestoreProbe();
    console.log(`✅ LLM [${role}]: вернулась на ${this.registry.label(ref)}`);
  }

  /**
   * While degraded, occasionally send the cheapest possible request to the
   * primary model. The old code only polled OpenRouter's balance endpoint, so
   * every other provider stayed on a fallback forever.
   */
  private startRestoreProbe(role: string): void {
    if (this.restoreTimer) return;
    this.restoreTimer = setInterval(() => {
      const primary = this.registry.role(role);
      if (!primary || !this.registry.isUsable(primary.provider)) return;
      void this.registry
        .client(primary)
        .chat([{ role: "user", content: "ping" }])
        .then(() => {
          console.log(`✅ LLM [${role}]: ${this.registry.label(primary)} снова работает`);
          this.recovered(role, primary);
        })
        .catch(() => {
          /* still down — try again next tick */
        });
    }, this.opts.restoreProbeMs);
    this.restoreTimer.unref?.();
  }

  private stopRestoreProbe(): void {
    if (!this.restoreTimer) return;
    clearInterval(this.restoreTimer);
    this.restoreTimer = null;
  }

  private attachNotification(response: LLMResponse): LLMResponse {
    if (this.pendingNotification && response.text) {
      const text = this.pendingNotification + "\n\n" + response.text;
      this.pendingNotification = null;
      return { ...response, text };
    }
    return response;
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sameRef(a: ModelRef, b: ModelRef | null): boolean {
  return Boolean(b) && a.provider === b!.provider && a.model === b!.model;
}

export { isBillingError };
