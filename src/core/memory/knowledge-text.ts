/**
 * Which columns of a knowledge row are searchable, in one place.
 *
 * This lives outside knowledge.ts because db.ts needs it too, and knowledge.ts
 * already imports db.ts — a function shared by both would mean a cycle or a
 * copy of the field list. A copy is the worse of the two: the reindex at open
 * time would quietly build a different index from the one a live write builds,
 * and the same row would then be findable by one of them and not the other,
 * with nothing in the log to say why.
 *
 * It only needs the stemmer, so it stays a leaf module either way.
 */
import { indexText } from "./stem-ru.js";

/** The parts of a row that carry meaning, in the order they read. */
export interface SearchableKnowledge {
  topic: string;
  insight: string;
  her_move?: string | null;
  context?: string | null;
  his_reaction?: string | null;
  conclusion?: string | null;
}

/**
 * The indexed form of a knowledge row.
 *
 * The case fields are here for the same reason the text is: a note about how he
 * took a joke has to be found by the joke. Without them, "он ответил холодно,
 * хотя был весёлый разговор" is reachable only through the sentence written
 * around it, and every new phrasing becomes a fact nothing can find.
 */
export function searchableText(row: SearchableKnowledge): string {
  return indexText(
    [
      row.topic,
      row.insight,
      row.her_move ?? "",
      row.context ?? "",
      row.his_reaction ?? "",
      row.conclusion ?? "",
    ].join(" "),
  );
}
