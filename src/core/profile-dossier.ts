/**
 * The dossier: what she knows about him, as a questionnaire rather than a heap.
 *
 * The profile rows were a list, newest first, and a list answers no question
 * about a person — you cannot see that work is known and where he lives is not,
 * or that his word for something was explained and then forgotten. The owner's
 * description of what he wanted is exact: "она должна составить анкету,
 * автобиографию обо мне". So the rows are grouped into sections, the sections
 * have a fixed order, and the gaps are shown as gaps.
 *
 * One place owns the section names, because three parts have to agree on them:
 * the study prompt asks the writer to choose one, the always-on prompt block
 * renders what is known, and `/profile` shows the same thing plus the holes. A
 * section list copied into three files is a list that disagrees with itself in
 * a month.
 *
 * The path lives here for the same reason `reference-photo.ts` owns the photo's:
 * it is derived from the config's directory, so `EVA_CONFIG_PATH` moves the
 * dossier with the install instead of leaving a document nobody reads.
 */

import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "./config.js";
import type { KnowledgeRow } from "./memory/knowledge.js";

/**
 * The sections, in the order a person would ask about them.
 *
 * Asked for by name in the study prompt, so the writer chooses from this list
 * instead of inventing a topic each time. Rows whose topic is not one of these
 * still render — under their own heading, after the canonical ones — because a
 * row that exists must never become invisible to the person reading the dossier.
 *
 * Rewritten on the owner's reading of the whole dossier (18.10): "тело и привычки
 * — бред" (an energy drink is a taste, not physiology), "люди" was too vague for
 * what he actually wanted there (animals, friends, relatives), and money and plans
 * never made it into a conversation he could point at. The five that remain are the
 * ones he named as needed, and the closing line of his list is the test for each:
 * "это по сути в каждом сообщении может использоваться".
 */
export const PROFILE_SECTIONS = [
  "работа",
  "где живёт",
  "досуг",
  "окружение",
  "вкусы",
] as const;

/** What a section with nothing known in it says. */
const HOLE = "— пока не знаю";

/** Where the dossier is written: beside the config, like every other artifact. */
export function profileDocPath(configPath?: string): string {
  return path.join(path.dirname(configPath ?? getConfigPath()), "profile.md");
}

export interface DossierOptions {
  /** Local-time offset for the dates on each fact. See renderKnowledge. */
  offsetHours?: number;
  /**
   * Print the empty sections too.
   *
   * For `/profile` and for the owner, yes: the holes are the to-do list, and
   * seeing them is how he knows what to tell her. For the prompt, no — a block
   * of "не знаю" on every turn is noise she cannot act on, and the question she
   * is allowed to ask has its own instruction.
   */
  includeHoles?: boolean;
}

function sectionOf(topic: string): { section: string; known: boolean } {
  const key = topic.trim().toLowerCase();
  const match = PROFILE_SECTIONS.find((s) => s === key);
  return match ? { section: match, known: true } : { section: topic.trim() || "прочее", known: false };
}

/**
 * The dossier as text.
 *
 * The facts are printed verbatim, not summarised: these lines are the only
 * evidence of what she actually knows, and a rendering that rewrites them
 * would hide exactly the mistakes the owner needs to see — "работает" without
 * "где" is how the missing-fact defect looks from the outside.
 */
export function renderProfileDossier(rows: KnowledgeRow[], opts: DossierOptions = {}): string {
  const grouped = new Map<string, KnowledgeRow[]>();
  const extraOrder: string[] = [];
  for (const row of rows) {
    const { section, known } = sectionOf(row.topic);
    if (!grouped.has(section)) {
      grouped.set(section, []);
      if (!known) extraOrder.push(section);
    }
    grouped.get(section)!.push(row);
  }

  const lines: string[] = [];
  const sections = [
    ...PROFILE_SECTIONS.filter((s) => grouped.has(s) || opts.includeHoles),
    ...extraOrder,
  ];
  for (const section of sections) {
    const facts = grouped.get(section);
    lines.push(`### ${section}`);
    if (!facts || facts.length === 0) {
      lines.push(HOLE);
    } else {
      for (const f of facts) {
        // The fact only. `conclusion` and the case fields belong to the searched
        // side: they say how one conversation ended, and a dossier line that
        // carries "он уточнил, что…" is the water the owner read first and
        // longest — a questionnaire is read for the fact, not for the story.
        lines.push(`- ${f.insight.trim()}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Write the dossier beside the config. Returns where it went. */
export function writeProfileDoc(text: string, configPath?: string): string {
  const dest = profileDocPath(configPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, `${text}\n`);
  return dest;
}

/**
 * One name per block, in his language, in the one place.
 *
 * Three readers depend on this vocabulary: the session report says where each
 * record went (`💾профиль`), the prompt says which block it is putting in front
 * of her, and `/profile` names them for the owner. A second copy of these words
 * is how "события" starts being called "эпизоды" in one place and not the other.
 */
export const BLOCK_LABELS: Record<string, string> = {
  profile: "профиль",
  rules: "правила",
  lesson: "чему он меня научил",
  episode: "события",
};

/**
 * A block without sections: rules and lessons.
 *
 * They have no questionnaire shape — a requirement and an explanation are each
 * their own line — but they are always in front of her for the same reason a
 * preference is: a rule about how to work applies to every kind of work, and a
 * word of his means the same thing in every conversation.
 */
export function renderFlatBlock(rows: KnowledgeRow[]): string {
  return rows.map((r) => `- ${r.insight.trim()}`).join("\n");
}

/**
 * The two always-on blocks that are not about who he is.
 *
 * `rules` is how to work with him, `lesson` is what his words mean. Both are
 * instructions rather than facts, and they get their own framing in the prompt —
 * see RULES_RULE and LESSON_RULE. Kept here so the dossier and the prompt read
 * the same text about the same block.
 */
export const RULES_RULE =
  "Это его требования к твоей работе. Выполняй их без напоминаний; если он просит " +
  "сделать наоборот — скажи, что у тебя записано иначе, и спроси, поменялось ли правило.";

export const LESSON_RULE =
  "Это то, чему он тебя научил: что значит его слово, как понимать то, что он говорит. " +
  "Опирайся на это, а не на своё понимание, и пиши так, как он объяснил, — даже если " +
  "привычное значение другое.";

/**
 * The instruction she is given with the block, and the only place the two
 * responsibilities are stated: follow the entry rather than her own taste, and
 * fill a hole with a question when the conversation is at that hole.
 */
export const PROFILE_RULE =
  "Это знания о нём, а не твои. Если он говорит о том, о чём здесь сказано, " +
  "опирайся на запись, а не на свой вкус: он любит не то же, что нравится тебе. " +
  "Если он предлагает то, что в записи ему не нравится, — скажи прямо, что он этого " +
  "не любит, и предложи то, что любит. " +
  "А если он говорит о том, чего в списке нет вовсе (о работе, о жилье, о чём-то," +
  " чего ты о нём не знаешь), — спроси, и один раз: тебе это интересно, и без ответа" +
  " пустая строка так и останется пустой. " +
  "И третье, про время: если в записи есть его уклад — график работы, смены, когда он " +
  "дома, — сверься с ним и с текущим временем, прежде чем что-то предлагать или звать " +
  "его куда-то. Позвать на диван в его смену — это предложение в пустоту, и он ответит " +
  "«я на работе». Предлагай то, что возможно сейчас, или то, что будет возможно к концу " +
  "смены, и называй когда. Один раз посчитанный по графику день лучше, чем тёплое " +
  "«заходи, когда сможешь».";
