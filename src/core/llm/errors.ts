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
