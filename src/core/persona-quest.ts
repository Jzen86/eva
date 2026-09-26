/**
 * The personality constructor: the four questions that turn a machine into
 * somebody.
 *
 * Why this is in the chat and not in `init`: a persona is not a setting, it is
 * the act of handing over a person. Asking for it on a server console, where
 * the owner is ssh'd into a box and the photo is still on his phone, produces
 * the same four blank answers every time. In the chat the owner already is, the
 * photo is two taps away, and the answers arrive where they were written.
 *
 * `init` therefore installs a bot with no character, on purpose, and the
 * doctor's «личность не описана» is not a defect to be tidied away — it is the
 * honest description of a fresh install and the reason `/persona` exists.
 *
 * This module is pure: no Telegram, no filesystem, no clock of its own. The
 * clock is a parameter, which is why a walk-away can be tested instead of
 * guessed at. Telegram wiring lives in the channel; the config write goes
 * through `applyAnswers`, the one function in here that touches anything.
 */

import type { EvaConfig } from "./config.js";

export type QuestStep = "photo" | "gender" | "persona" | "behavior";
export type Gender = "female" | "male" | "neutral";

export interface QuestAnswers {
  /** True once a photo is on disk, or once the owner said to skip it. */
  photo: boolean;
  gender?: Gender;
  persona?: string;
  behavior?: string;
}

export interface Quest {
  step: QuestStep;
  answers: QuestAnswers;
  startedAt: number;
}

export const QUEST_STEPS: readonly QuestStep[] = ["photo", "gender", "persona", "behavior"];

/**
 * How long a half-built constructor survives.
 *
 * Generous, because writing a character description is not a two-word job and
 * an owner who leaves to look at something must not come back to a bot that
 * swallowed their next message as an answer. Short enough that a forgotten
 * quest is gone by the time he has forgotten about it.
 */
export const QUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** Answers shorter than this are a misfire, not a description. */
const MIN_TEXT = 4;

const SKIP_WORDS = new Set([
  "пропустить",
  "пропусти",
  "пропущ",
  "skip",
  "-",
  "--",
  "нет",
  "не хочу",
  "не буду",
  "позже",
]);

const GENDER_WORDS: Record<string, Gender> = {
  female: "female",
  f: "female",
  ж: "female",
  жен: "female",
  "женщина": "female",
  "она": "female",
  male: "male",
  m: "male",
  м: "male",
  муж: "male",
  "мужчина": "male",
  "он": "male",
  neutral: "neutral",
  n: "neutral",
  нейтрал: "neutral",
  "неважно": "neutral",
  "не важно": "neutral",
  "неважный": "neutral",
};

const QUESTIONS: Record<QuestStep, string> = {
  photo: "Первое — лицо. Пришли фотографию, это будет она.\nМожно «пропустить».",
  gender: "Второе — пол. female, male или neutral? Можно «пропустить».",
  persona: "Третье — кто она. Своими словами, как есть: характер, манера, откуда, зачем.\nЧем больше, тем живее. Можно «пропустить».",
  behavior: "И последнее — как она разговаривает. Одно главное правило: как обращается, как отвечает, чего не делает.\nМожно «пропустить».",
};

export function start(now: number = Date.now()): Quest {
  return { step: QUEST_STEPS[0], answers: { photo: false }, startedAt: now };
}

export function questionFor(step: QuestStep): string {
  return QUESTIONS[step];
}

export function isSkip(text: string): boolean {
  return SKIP_WORDS.has(text.trim().toLowerCase());
}

/** Whether a half-built quest has been left alone long enough to forget. */
export function expired(quest: Quest, now: number = Date.now()): boolean {
  return now - quest.startedAt > QUEST_TIMEOUT_MS;
}

export interface Turn {
  /** What to say back. Empty when `finished`. */
  reply: string;
  /** The next quest, or null when the constructor is done. */
  next: Quest | null;
  /** True when this turn finished the constructor. */
  finished: boolean;
  /**
   * Everything collected so far, including on the final turn — where `next` is
   * null and there is nothing left to carry the answers. The caller writes
   * these, so losing them on the last step would lose the whole constructor.
   */
  answers: QuestAnswers;
}

function advance(quest: Quest): Turn {
  const i = QUEST_STEPS.indexOf(quest.step);
  const nextStep = QUEST_STEPS[i + 1];
  if (!nextStep) return { reply: "", next: null, finished: true, answers: quest.answers };
  return {
    reply: QUESTIONS[nextStep],
    next: { ...quest, step: nextStep },
    finished: false,
    answers: quest.answers,
  };
}

/**
 * One text answer to the current question.
 *
 * Every rejection re-asks the same question with the reason attached, so a
 * mistyped gender does not silently become her character: the owner is told
 * what was not understood and where the answer went instead.
 */
export function answerText(quest: Quest, raw: string, now: number = Date.now()): Turn {
  const text = raw.trim();
  const step = quest.step;

  if (step === "gender") {
    if (isSkip(text)) {
      const { photo, persona, behavior } = quest.answers;
      return advance({ ...quest, answers: { photo, persona, behavior } });
    }
    const gender = GENDER_WORDS[text.toLowerCase().replace(/[.!?]+$/, "")];
    if (!gender) {
      return {
        reply: `Не поняла, кто она: «${text}». Напиши female, male или neutral — или «пропустить».`,
        next: quest,
        finished: false,
        answers: quest.answers,
      };
    }
    const { photo, persona, behavior } = quest.answers;
    return advance({ ...quest, answers: { photo, gender, persona, behavior } });
  }

  // persona / behavior
  if (isSkip(text)) {
    const { photo, gender } = quest.answers;
    const answers: QuestAnswers =
      step === "persona"
        ? { photo, gender, persona: quest.answers.persona }
        : { photo, gender, persona: quest.answers.persona, behavior: quest.answers.behavior };
    return advance({ ...quest, answers });
  }

  if (text.length < MIN_TEXT) {
    return {
      reply: `«${text}» — это слишком коротко, чтобы понять, о ком речь. Расскажи подробнее или скажи «пропустить».`,
      next: quest,
      finished: false,
      answers: quest.answers,
    };
  }

  const answers: QuestAnswers =
    step === "persona" ? { ...quest.answers, persona: text } : { ...quest.answers, behavior: text };
  return advance({ ...quest, answers });
}

/** A photo, once the channel has put it on disk. */
export function answerPhoto(quest: Quest, now: number = Date.now()): Turn {
  if (quest.step !== "photo") {
    return {
      reply: `Сейчас я спрашиваю не про фото. ${
        quest.step === "gender" ? "Ответь про пол — female, male или neutral." : "Ответь текстом, и я пойду дальше."
      }`,
      next: quest,
      finished: false,
      answers: quest.answers,
    };
  }
  const answers: QuestAnswers = { ...quest.answers, photo: true };
  const turn = advance({ ...quest, answers });
  return { ...turn, answers };
}

/** One line about what is already there, for the opening of a rebuild. */
export function describeExisting(config: EvaConfig | null): string {
  if (!config) return "";
  const p = config.agent?.personality;
  const has = Boolean(p?.persona || p?.custom_instructions || p?.tone || p?.style);
  if (!has) return "";
  return "У неё уже есть характер. Если начнём заново — новый ответ заменит старый.\n";
}

/**
 * What the constructor collected, in words. Shown before anything is written,
 * because the last thing anyone wants from a bot that just learned who it is
 * is a personality it did not mean to give.
 */
export function summary(answers: QuestAnswers): string {
  const bits: string[] = [];
  bits.push(answers.photo ? "фото есть" : "фото нет");
  if (answers.gender) bits.push(`пол: ${answers.gender}`);
  if (answers.persona) bits.push("характер описан");
  if (answers.behavior) bits.push("правило общения есть");  return bits.join(", ");
}

/**
 * Write the answers into a config object.
 *
 * Only what was actually said. A skipped step leaves whatever was there alone —
 * "пропустить" means «не знаю», and «не знаю» is not a reason to delete a
 * character that already exists.
 *
 * `behavior` appends to `ops` rather than replacing it: `ops` is a list of
 * standing rules, and one more rule is what the owner just added, not a
 * statement that the previous ones were wrong.
 */
export function applyAnswers(
  answers: QuestAnswers,
  config: Record<string, unknown>,
): void {
  const agent = (config.agent ?? {}) as Record<string, unknown>;
  if (answers.gender) agent.gender = answers.gender;

  if (answers.persona) {
    const personality = (agent.personality ?? {}) as Record<string, unknown>;
    personality.persona = answers.persona;
    // A persona given as a fresh description must not fight a legacy blob: the
    // prompt renders both, and the old one wins by being longer.
    delete personality.custom_instructions;
    agent.personality = personality;
  }

  if (answers.behavior) {
    const personality = (agent.personality ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(personality.ops) ? (personality.ops as string[]) : [];
    if (!existing.includes(answers.behavior)) personality.ops = [...existing, answers.behavior];
    agent.personality = personality;
  }

  config.agent = agent;
}
