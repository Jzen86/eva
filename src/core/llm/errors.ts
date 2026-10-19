import OpenAI from "openai";

/**
 * Which failures are worth trying the next model for.
 *
 * The old code only recognised billing errors, 429 and timeouts, so a 500 from
 * an upstream provider or a dropped connection killed the request outright even
 * though the next model in the chain would have answered fine.
 */

/** 5xx that means "the server broke", not "your request was wrong". */
const SERVER_ERRORS = new Set([500, 502, 503, 504, 520, 522, 524, 529]);

/**
 * The provider answered 200 and said nothing at all.
 *
 * Not an HTTP error, which is exactly why it needs a name of its own. It looks
 * like a successful answer to every layer below, so nothing retried, nothing
 * fell back, and the engine's two empty attempts turned into her saying
 * "повтори" — twelve minutes of that on the live install while the provider
 * flapped (503s in between, and 200s whose choice carried neither text nor a
 * tool call). `doctor`'s own probe has always called an empty reply a failure;
 * this makes the transport agree, and isTransientError says what to do next.
 */
export class EmptyResponseError extends Error {
  constructor(model: string, finishReason: string | null = null) {
    super(
      `Модель ${model} вернула пустой ответ` +
        (finishReason ? ` (finish_reason: ${finishReason})` : ""),
    );
    this.name = "EmptyResponseError";
  }
}

const BILLING_KEYWORDS = [
  "insufficient_quota",
  "insufficient credits",
  "credits",
  "billing",
  "payment",
  "exceeded your current quota",
  "quota exceeded",
  "account balance",
];

/** Transient network-level failures: connection refused, reset, DNS, timeout. */
const NETWORK_PATTERNS = [
  "fetch failed",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  "epipe",
  "socket hang up",
  "network",
  "timeout",
  "aborted",
];

function statusOf(err: unknown): number | null {
  if (err instanceof OpenAI.APIError) return err.status ?? null;
  if (typeof err === "object" && err !== null) {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return `${err.message} ${causeMsg}`.toLowerCase();
  }
  return String(err).toLowerCase();
}

function isApiError(err: unknown): boolean {
  return err instanceof OpenAI.APIError || statusOf(err) !== null;
}

/** The account cannot pay — retrying the same provider is pointless. */
export function isBillingError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 402) return true;
  if (status === 429 || status === 400 || status === 403) {
    const msg = messageOf(err);
    return BILLING_KEYWORDS.some((kw) => msg.includes(kw));
  }
  return false;
}

/** Model is gone, rate limited, or the provider is having a bad day. */
export function isTransientError(err: unknown): boolean {
  // The provider failing while looking healthy. Checked first, because
  // by every other measure here it is not an error at all.
  if (err instanceof EmptyResponseError) return true;
  const status = statusOf(err);
  if (status === 404) return true; // dead model id
  if (status === 408) return true; // request timeout
  if (status !== null && SERVER_ERRORS.has(status)) return true;
  if (status === 429) return !isBillingError(err);
  if (status === 400) {
    // OpenRouter wraps upstream provider failures in a 400.
    const msg = messageOf(err);
    return /provider returned error|upstream|model.*not found|does not exist|overloaded/i.test(msg);
  }
  if (isApiError(err)) return false;
  // Not an HTTP error at all — most likely a network failure.
  const msg = messageOf(err);
  return NETWORK_PATTERNS.some((p) => msg.includes(p));
}

/** Anything we might get through by switching to a different model. */
export function isRetryableError(err: unknown): boolean {
  return isBillingError(err) || isTransientError(err) || err instanceof Error && err.name === "ModelTimeoutError";
}

/**
 * What actually went wrong, in words a person can act on.
 *
 * The engine used to hand the recovery call one vague phrase ("что-то у меня
 * зависло") and then tell the model not to use technical terms, so the owner got
 * "повтори, пожалуйста" with no idea whether it was a hiccup, a spent quota or a
 * dead key — and asked for the reason to be in the sentence (19.10). A 503, a
 * 429, a timeout and an empty 200 need different actions: wait a minute, wait for
 * the key, correct the model id, or just retry.
 *
 * The provider name comes from the model ids the router puts into its own failure
 * message ("Перепробовано: google/gemini-…"), because that is the one string every
 * layer above keeps.
 */
export type FailureKind =
  | "timeout"
  | "overloaded"
  | "limit"
  | "quota"
  | "empty"
  | "gone"
  | "auth"
  | "network"
  | "unknown";

const PROVIDER_NAMES: Record<string, string> = {
  google: "Гугл",
  openrouter: "Опенроутер",
  deepseek: "Дипсик",
  openai: "ОпенАИ",
  anthropic: "Антропик",
};

export function failureReason(err: unknown): {
  kind: FailureKind;
  where: string | null;
  code: number | null;
} {
  const msg = messageOf(err);
  const provider = msg.match(/(google|openrouter|deepseek|openai|anthropic|opencode-go)\//);
  const where = provider ? (PROVIDER_NAMES[provider[1]] ?? provider[1]) : null;
  const codeMatch = msg.match(/\b(4\d{2}|5\d{2})\b/);
  // The status lives on the error when the provider SDK threw it; the message is
  // the only place it survives when the router wrapped it ("…Последняя ошибка:
  // 503 status code"). Both are real paths, so both are read.
  const code = statusOf(err) ?? (codeMatch ? Number(codeMatch[1]) : null);

  const kind = ((): FailureKind => {
    if (err instanceof EmptyResponseError || msg.includes("пустой ответ")) return "empty";
    if (msg.includes("model timed out") || msg.includes("время вышло") || code === 408) return "timeout";
    if (isBillingError(err)) return "quota";
    if (code === 401 || code === 403) return "auth";
    if (code === 404 || /model.*not found|does not exist/.test(msg)) return "gone";
    if (code === 429) return "limit";
    if (code !== null && SERVER_ERRORS.has(code)) return "overloaded";
    if (statusOf(err) === null && NETWORK_PATTERNS.some((p) => msg.includes(p))) return "network";
    if (/overloaded|high demand|unavailable/.test(msg)) return "overloaded";
    return "unknown";
  })();

  return { kind, where, code };
}

/** One short sentence with the reason and what to do about it. */
export function failureSentence(err: unknown): string {
  const { kind, where, code } = failureReason(err);
  const at = where ? `${where} ` : "";
  const num = code ? ` (${code})` : "";
  switch (kind) {
    case "timeout":
      return `${at}молчит — не ответила вовремя. Подожди немного и повтори, пожалуйста!`;
    case "overloaded":
      return `${at}моросит — перегрузка${num}. Подожди немного и повтори, пожалуйста!`;
    case "limit":
      return `${at}упёрлась в лимит запросов${num}. Подожди пару минут и повтори, пожалуйста!`;
    case "quota":
      return `${at}кончился лимит ключа${num} — мне надо это поправить, дай минуту.`;
    case "empty":
      return `${at}вернула пустой ответ. Повтори, пожалуйста!`;
    case "gone":
      return `${at}не отдаёт модель${num} — мне надо это поправить.`;
    case "auth":
      return `${at}не пускает по ключу${num} — мне надо это поправить.`;
    case "network":
      return "нет связи с моделью. Подожди немного и повтори, пожалуйста!";
    default:
      return "что-то сломалось на стороне модели. Повтори, пожалуйста!";
  }
}
