import { describe, it, expect } from "vitest";
import {
  start,
  answerText,
  answerPhoto,
  expired,
  questionFor,
  describeExisting,
  applyAnswers,
  summary,
  isSkip,
  QUEST_STEPS,
  QUEST_TIMEOUT_MS,
  type Quest,
  type QuestAnswers,
} from "../../src/core/persona-quest.js";
import type { EvaConfig } from "../../src/core/config.js";

/**
 * The constructor, tested as the thing it is: a state machine.
 *
 * Every test below is a way the owner gets a worse outcome than he asked for —
 * a mistyped gender that becomes her character, an abandoned quest that eats a
 * real message tomorrow, a skipped step that deletes something he wrote last
 * week. Those are the failures worth writing down, and none of them show up as
 * a crash.
 */

const NOW = 1_700_000_000_000;

/** Walk a quest to the end with one answer per step. */
function run(answers: Array<string | "photo">): { quest: Quest; turns: string[] } {
  let quest = start(NOW);
  const turns: string[] = [];
  for (const a of answers) {
    const turn = a === "photo" ? answerPhoto(quest, NOW) : answerText(quest, a, NOW);
    turns.push(turn.reply);
    if (turn.finished) return { quest: { ...quest, answers: turn.answers }, turns };
    quest = turn.next!;
  }
  return { quest, turns };
}

describe("the four questions", () => {
  it("asks for a photo, a gender, a character and one rule, in that order", () => {
    expect(QUEST_STEPS).toEqual(["photo", "gender", "persona", "behavior"]);
  });

  it("says out loud that every question can be skipped", () => {
    // An owner who cannot answer a question must be able to move on without
    // feeling like he failed an exam.
    for (const step of QUEST_STEPS) {
      expect(questionFor(step)).toMatch(/пропустить/i);
    }
  });

  it("has four questions, and no fifth that only exists to be a fifth", () => {
    expect(Object.keys(questionFor("photo") ? {} : {})).toEqual([]);
    expect(start(NOW).step).toBe("photo");
  });
});

describe("answerText", () => {
  it("walks all four steps and finishes with the answers collected", () => {
    const { quest, turns } = run([
      "photo",
      "female",
      "молчаливая, наблюдательная, из тех, кто сначала смотрит",
      "на «ты», коротко, без списков",
    ]);
    expect(quest.answers).toEqual({
      photo: true,
      gender: "female",
      persona: "молчаливая, наблюдательная, из тех, кто сначала смотрит",
      behavior: "на «ты», коротко, без списков",
    });
    // The photo question is answered by a photo, so the first text turn asked
    // is the gender one.
    expect(turns[0]).toContain("пол");
  });

  it("carries the answers on the final turn, where there is no next quest", () => {
    // The write happens from `turn.answers`; losing them on the last step
    // would lose the whole constructor, silently, after four questions.
    let quest = start(NOW);
    quest = answerPhoto(quest, NOW).next!;
    quest = answerText(quest, "female", NOW).next!;
    quest = answerText(quest, "она своя, но тёплая", NOW).next!;
    const last = answerText(quest, "коротко, на «ты»", NOW);
    expect(last.finished).toBe(true);
    expect(last.next).toBeNull();
    expect(last.answers.persona).toBe("она своя, но тёплая");
    expect(last.answers.behavior).toBe("коротко, на «ты»");
  });

  it("understands a gender written the way a person would write it", () => {
    for (const [word, expected] of [
      ["она", "female"],
      ["ж", "female"],
      ["мужчина", "male"],
      ["он", "male"],
      ["neutral", "neutral"],
      ["не важно", "neutral"],
      ["нейтрал", "neutral"],
    ] as const) {
      let quest = start(NOW);
      quest = answerPhoto(quest, NOW).next!;
      const turn = answerText(quest, word, NOW);
      expect(turn.answers.gender, word).toBe(expected);
    }
  });

  it("ignores a stray dot after the gender", () => {
    let quest = start(NOW);
    quest = answerPhoto(quest, NOW).next!;
    expect(answerText(quest, "female.", NOW).answers.gender).toBe("female");
  });

  it("re-asks the gender instead of filing a typo as her character", () => {
    // The dangerous failure is a mistyped gender becoming the persona: the owner
    // says "она", the bot does not understand, and the next question's answer
    // lands in the wrong field.
    let quest = start(NOW);
    quest = answerPhoto(quest, NOW).next!;
    const turn = answerText(quest, "непонятно", NOW);
    expect(turn.finished).toBe(false);
    expect(turn.next?.step).toBe("gender");
    expect(turn.answers.gender).toBeUndefined();
    expect(turn.reply).toContain("Не поняла");
  });

  it("re-asks a description that is too short to describe anybody", () => {
    let quest = start(NOW);
    quest = answerPhoto(quest, NOW).next!;
    quest = answerText(quest, "female", NOW).next!;
    const turn = answerText(quest, "ок", NOW);
    expect(turn.next?.step).toBe("persona");
    expect(turn.answers.persona).toBeUndefined();
    expect(turn.reply).toContain("коротко");
  });

  it("moves on when the owner says skip, at any step", () => {
    for (const word of ["пропустить", "Пропусти", "skip", "-", "не хочу"]) {
      expect(isSkip(word), word).toBe(true);
    }
    const { quest } = run(["photo", "пропустить", "она своя, тёплая", "не хочу"]);
    expect(quest.answers.gender).toBeUndefined();
    expect(quest.answers.persona).toBe("она своя, тёплая");
    expect(quest.answers.behavior).toBeUndefined();
  });

  it("finishes a quest where every answer was skipped", () => {
    // All-blank is a legitimate outcome: the owner wanted a working bot and
    // will fill her in later. It must not be treated as a failure.
    let quest = start(NOW);
    for (const _ of QUEST_STEPS) {
      const turn = answerText(quest, "пропустить", NOW);
      if (turn.finished) {
        expect(turn.answers).toEqual({ photo: false });
        return;
      }
      quest = turn.next!;
    }
    throw new Error("quest never finished");
  });
});

describe("answerPhoto", () => {
  it("takes the photo at the photo step and moves on", () => {
    const turn = answerPhoto(start(NOW), NOW);
    expect(turn.answers.photo).toBe(true);
    expect(turn.next?.step).toBe("gender");
  });

  it("refuses a photo at the wrong step without losing the quest", () => {
    // A photo sent while she asks about the character is a misfire. Throwing
    // the quest away would lose three answers the owner already gave.
    let quest = start(NOW);
    quest = answerPhoto(quest, NOW).next!;
    quest = answerText(quest, "female", NOW).next!;
    const turn = answerPhoto(quest, NOW);
    expect(turn.finished).toBe(false);
    expect(turn.next?.step).toBe("persona");
    expect(turn.answers.gender).toBe("female");
    expect(turn.reply).toMatch(/не про фото|текстом/i);
  });
});

describe("expired", () => {
  it("survives long enough to write a character description", () => {
    expect(expired(start(NOW), NOW + QUEST_TIMEOUT_MS - 1000)).toBe(false);
  });

  it("lets go of a forgotten quest", () => {
    // The failure this prevents: a quest left open on Tuesday swallowing
    // "привет" on Wednesday as an answer to a question about her childhood.
    expect(expired(start(NOW), NOW + QUEST_TIMEOUT_MS + 1)).toBe(true);
  });

  it("does not expire the instant it starts", () => {
    expect(expired(start(NOW), NOW)).toBe(false);
  });
});

describe("describeExisting", () => {
  const withPersona = { agent: { personality: { persona: "своя" } } } as unknown as EvaConfig;
  const bare = { agent: { personality: {} } } as unknown as EvaConfig;

  it("says nothing when there is nobody there yet", () => {
    expect(describeExisting(bare)).toBe("");
    expect(describeExisting(null)).toBe("");
  });

  it("warns before a rebuild overwrites something that exists", () => {
    expect(describeExisting(withPersona)).toContain("уже есть характер");
  });
});

describe("summary", () => {
  it("lists what she ended up with, and nothing else", () => {
    // A closing line, not a report. What is still missing is visible in the
    // questions that were skipped and in doctor; listing three negatives on top
    // of a confirmation is noise.
    const text = summary({ photo: true, gender: "female", persona: "тёплая" });
    expect(text).toContain("фото есть");
    expect(text).toContain("female");
    expect(text).toContain("характер описан");
    expect(text).not.toContain("правило");
  });

  it("says plainly that there is no photo when there is none", () => {
    const answers: QuestAnswers = { photo: false };
    expect(summary(answers)).toContain("фото нет");
  });
});

describe("applyAnswers", () => {
  const base = () => ({ agent: { name: "Ева", personality: {} } }) as Record<string, unknown>;
  const personality = (c: Record<string, unknown>) =>
    (c.agent as Record<string, unknown>).personality as Record<string, unknown>;

  it("writes only what the owner actually said", () => {
    const c = base();
    applyAnswers({ photo: true }, c);
    expect(personality(c).persona).toBeUndefined();
    expect((c.agent as Record<string, unknown>).gender).toBeUndefined();
  });

  it("sets the gender and the character", () => {
    const c = base();
    applyAnswers({ photo: true, gender: "neutral", persona: "своя" }, c);
    expect((c.agent as Record<string, unknown>).gender).toBe("neutral");
    expect(personality(c).persona).toBe("своя");
  });

  it("leaves an existing character alone when the step was skipped", () => {
    // «Пропустить» means «не знаю», and «не знаю» is not a reason to delete
    // something the owner wrote last week.
    const c = base();
    applyAnswers({ photo: true, persona: "старая, своя" }, c);
    applyAnswers({ photo: false, behavior: "коротко" }, c);
    expect(personality(c).persona).toBe("старая, своя");
  });

  it("appends a rule rather than replacing the list of them", () => {
    // ops is a list of standing rules; one more rule is not a statement that
    // the previous ones were wrong.
    const c = base();
    applyAnswers({ photo: true, behavior: "коротко" }, c);
    applyAnswers({ photo: false, behavior: "на «ты»" }, c);
    expect(personality(c).ops).toEqual(["коротко", "на «ты»"]);
  });

  it("does not add the same rule twice", () => {
    const c = base();
    applyAnswers({ photo: true, behavior: "коротко" }, c);
    applyAnswers({ photo: false, behavior: "коротко" }, c);
    expect(personality(c).ops).toEqual(["коротко"]);
  });

  it("drops a legacy blob that would fight the new character", () => {
    // The prompt renders persona and custom_instructions both, and the older
    // one wins by being longer.
    const c = {
      agent: { personality: { custom_instructions: "была строгая, но теперь нет" } },
    } as Record<string, unknown>;
    applyAnswers({ photo: true, persona: "тёплая и своя" }, c);
    expect(personality(c).custom_instructions).toBeUndefined();
    expect(personality(c).persona).toBe("тёплая и своя");
  });

  it("works on a config with no agent block at all", () => {
    const c = {} as Record<string, unknown>;
    applyAnswers({ photo: true, persona: "своя" }, c);
    expect((c.agent as Record<string, unknown>).name).toBeUndefined();
    expect(personality(c).persona).toBe("своя");
  });
});
