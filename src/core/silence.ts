/**
 * Saying nothing, on purpose.
 *
 * Two callers start turns nobody asked for — the initiative, which writes when
 * it feels right, and the scheduled checks, which report on the machine and on
 * her own log. Both are allowed to decide that the moment calls for no message
 * at all, and neither has any other way to say so: an empty answer is not a
 * silence, it is a failed turn (the engine substitutes its "осталось без ответа"
 * line for exactly that), and a reply that has to be sent cannot also be
 * absent.
 *
 * Hence one convention, written here once because it now has two callers and a
 * copy of a literal is how two callers drift apart: the answer is exactly
 * `[тишина]`, and the caller sends nothing.
 *
 * The caller still has to leave a line in the journal. "Said nothing" and "never
 * ran" must never look alike — that is the whole lesson of the empty-answer bug,
 * where a dropped completion had the shape of a finished report.
 */

/** The reply that means "no message this time". */
export const SILENCE_REPLY = "[тишина]";

/**
 * Whether the turn decided to say nothing.
 *
 * Trimmed, because the model can put a newline after it, and case-folded, because
 * it is punctuation and brackets rather than prose — a capitalised "[Тишина]"
 * means the same thing and sending it as a message would be the bug.
 */
export function saidNothing(text: string | undefined | null): boolean {
  return (text ?? "").trim().toLowerCase() === SILENCE_REPLY;
}
