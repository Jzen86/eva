import type { LLMMessage } from "./types.js";

/**
 * Cut a history back to something a provider will accept.
 *
 * A tool result is not a message, it is an answer to a specific call. Every
 * OpenAI-compatible endpoint enforces the pairing, and most of them answer a
 * broken history with a bare `400` and no body — Gemini included. So the rule
 * is not "keep the last N" but "keep the last N that still parse as a
 * conversation":
 *
 *   - it starts at a `user` message (an orphaned `tool` result, or an
 *     `assistant(tool_calls)` whose earlier half was cut away, is not a
 *     conversation);
 *   - every `assistant(tool_calls)` is followed by a `tool` result for each
 *     call it made, contiguously.
 *
 * A dangling call is cut from there to the end. Dropping only the offending
 * message is not enough — the results after it are answers to a call nobody
 * can see — and keeping them is not an option either: the whole request is
 * rejected, so the tail is what we lose.
 *
 * This is the shared border sanitizer. It used to exist only inside
 * `loadHistory`, which is why a live in-memory history that outgrew its buffer
 * had nothing to call: `hard_truncate` sliced raw, `slice(-40)` landed inside a
 * tool block, and every following request 400'd — including the recovery call
 * that apologises to the user, which is why the bot went quiet instead of
 * merely wrong. Same rules, applied after every cut, is the whole repair.
 *
 * Returns the same array instance when nothing had to be dropped, so a caller
 * that holds the history it also stores cannot lose the messages it appends
 * next. Anything else returns a new array, and the difference in length is how
 * a caller knows a cut happened.
 */
export function alignHistory(messages: LLMMessage[]): LLMMessage[] {
  // Start at the first `user` message: anything before it is the remains of a
  // turn that began before the window, and no provider wants to open a
  // conversation with a model's turn.
  let start = 0;
  while (start < messages.length && messages[start].role !== "user") start++;
  if (start === messages.length) return [];

  const out: LLMMessage[] = [];
  let i = start;
  let dropped = start;

  while (i < messages.length) {
    const msg = messages[i];

    // A tool result with no call in front of it can never be satisfied.
    if (msg.role === "tool") {
      dropped += messages.length - i;
      break;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const results: LLMMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        results.push(messages[j]);
        j++;
      }
      const answered = new Set(results.map((r) => r.toolCallId));
      const complete =
        results.length === msg.toolCalls.length &&
        msg.toolCalls.every((tc) => answered.has(tc.id));
      // Half an answer is worse than none: cut the turn off at the call.
      if (!complete) {
        dropped += messages.length - i;
        break;
      }
      out.push(msg, ...results);
      i = j;
      continue;
    }

    out.push(msg);
    i++;
  }

  return dropped === 0 ? messages : out;
}
