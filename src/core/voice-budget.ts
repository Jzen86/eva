/**
 * The voice budget: how often she may speak on her own.
 *
 * Not about money. The Gemini TTS ladder gives roughly twenty requests a day on
 * the *first* model and twenty on each rung below it, so the supply is real — but
 * the owner's complaint was not scarcity either. He asked her to speak less, she
 * promised, and the next message spoke again: "она обещает, но не делает этого".
 * A promise has nowhere to live — it is not in the prompt on the next turn — so
 * the shape that holds is the one the initiative already uses: a **gap** between
 * events, enforced by code, plus a ceiling for the day.
 *
 * Measured before this: 27 voice messages in four hours, about seven an hour, at
 * 173 of his messages. A daily ceiling alone would not have stopped that — twenty
 * can be spent in an hour — which is why the gap is the load-bearing part: it does
 * not forbid a voice, it makes her decide *now*, once per half hour, whether this
 * moment is worth hearing.
 *
 * Two rules the owner set himself:
 *   - the clock runs from the **last voice**, not from the last message of any
 *     kind: "отправив голос в 19:39, следующее не раньше 20:00, независимо от
 *     кол-ва других сообщений, текст или картинка";
 *   - **asked for is asked for**: his voice note or his words ("скажи голосом")
 *     pass the gap and the ceiling untouched. A budget that made her refuse him
 *     would be worse than a hundred voice messages.
 */

import { getDB, readMeta, writeMeta } from "./memory/db.js";

/** How long after one voice the next one of her own may go. */
export const VOICE_GAP_MIN = 30;
/** How many voices she may start in a rolling day. */
export const VOICE_PER_DAY = 20;
const DAY_SEC = 24 * 60 * 60;

const META_KEY = "voice_sent_at";

/**
 * Timestamps of the voices sent in the last day, oldest first.
 *
 * A list rather than a counter, because the gap and the day's total must both be
 * answered from it and a counter cannot answer the first. Trimmed on write, so
 * it stays small without a separate cleanup job.
 */
function sentAt(now = Math.floor(Date.now() / 1000)): number[] {
  try {
    const raw = readMeta(META_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > now - DAY_SEC)
      .sort((a, b) => a - b);
  } catch {
    // A memory that cannot be read is not a reason to gag her, or to let her
    // speak without limit: starting empty grants the gap from zero, which is the
    // mildest failure of the three.
    return [];
  }
}

export interface VoiceBudget {
  allow: boolean;
  /** Why not, in words she can act on. Empty when allowed. */
  reason: string;
  /** How many of the day's voices are left. */
  remaining: number;
  /** Minutes still to wait, when the gap is what blocks. */
  waitMin: number;
}

/**
 * May she start a voice right now?
 *
 * `requested` means the owner asked — by speaking, or in words. It bypasses both
 * rules and is checked first, so no state of the budget can make her refuse him.
 */
export function checkVoiceBudget(requested: boolean): VoiceBudget {
  const now = Math.floor(Date.now() / 1000);
  const recent = sentAt(now);
  const remaining = Math.max(0, VOICE_PER_DAY - recent.length);

  if (requested) {
    return { allow: true, reason: "", remaining, waitMin: 0 };
  }

  const last = recent[recent.length - 1];
  if (last !== undefined) {
    const sinceMin = Math.floor((now - last) / 60);
    if (sinceMin < VOICE_GAP_MIN) {
      return {
        allow: false,
        reason:
          `Голосовое было ${sinceMin} мин назад. Голос — событие, а не способ ответить: ` +
          `следующее своими словами не раньше ${VOICE_GAP_MIN} минут от прошлого (это ещё ` +
          `${VOICE_GAP_MIN - sinceMin} мин). Ответь текстом — или подожди.`,
        remaining,
        waitMin: VOICE_GAP_MIN - sinceMin,
      };
    }
  }

  if (remaining <= 0) {
    return {
      allow: false,
      reason:
        `Своих голосовых на сегодня уже ${VOICE_PER_DAY} — лимит выбран. Ответь текстом: ` +
        `если он попросит голосом или пришлёт голосовое, это пройдёт мимо лимита.`,
      remaining: 0,
      waitMin: 0,
    };
  }

  return { allow: true, reason: "", remaining, waitMin: 0 };
}

/** Record that a voice went out. Called only after it actually did. */
export function noteVoiceSent(at = Math.floor(Date.now() / 1000)): void {
  try {
    const list = sentAt(at);
    list.push(at);
    const db = getDB();
    void db;
    writeMeta(META_KEY, JSON.stringify(list.slice(-VOICE_PER_DAY * 2)));
  } catch (err) {
    // Failing to record costs the budget its memory, not the turn its voice.
    console.warn(
      `⚠️ голос не записан в бюджет (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * What the tool tells her about the budget, so the decision is hers to make.
 *
 * The owner's ask was not a mute button: "я бы хотел чтоб она их использовала в
 * случаях, когда это необходимо, сама решала". A number in front of her — the
 * gap and what is left of the day — is what turns "почему бы и нет" into a choice.
 */
export function voiceBudgetNote(): string {
  const { remaining, waitMin } = checkVoiceBudget(false);
  const parts = [`Голосовых своими словами осталось сегодня: ${remaining} из ${VOICE_PER_DAY}.`];
  if (waitMin > 0) {
    parts.push(`Следующее — не раньше чем через ${waitMin} мин от прошлого.`);
  }
  parts.push("Трать на то, что он должен услышать.");
  return parts.join(" ");
}
