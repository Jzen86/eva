/**
 * The frames she has already made, so the next one can be different.
 *
 * Measured on the live install (14 days, 165 selfies): she describes a scene
 * thoroughly, but the *choices* on every axis stay put — one room, morning, a
 * smirk, a bun. Twenty-two per cent of the frames were the bedroom, kitchen and
 * street were zero, the hairstyle was named in eleven per cent of them.
 *
 * The cause was not a thin description: a probe of ten requests in a row showed
 * the same defaults win whether the prompt asks for detail or not (a list of
 * suggested values in the tool description changed almost nothing, and explicit
 * axis labels without anything else changed nothing either). What did move them
 * was *memory* — the same writer, shown the frames it had just made and told not
 * to repeat them, spread across locations, poses, hairstyles and moods (smiles
 * fell from 8 of 10 to 4 of 10). A round trip through the real engine confirmed
 * it on the picture side too: with a reference photo attached, a short general
 * prompt renders the reference as-is, while a scene that names hair, expression,
 * clothing, pose, background and light arrives in the frame unchanged.
 *
 * So the rows are stored here and the engine puts the last few in front of her,
 * with FRAME_VARIETY_RULE. What is stored is the scene as she wrote it — not a
 * parsed summary: parsing would have to guess her wording, and the text is what
 * she needs to see to avoid it.
 */

import { getDB } from "./db.js";

/** How many of the last frames ride in the prompt. Five is where the effect saturated. */
export const SCENE_PROMPT_LIMIT = 5;

/** Rows kept per user. Older ones are dropped as new frames arrive. */
export const SCENE_KEEP = 30;

/** One line's ceiling. The measured scene runs 274 characters at the median, 518 at the 95th. */
export const SCENE_LINE_LIMIT = 400;

export interface SceneRow {
  context: string;
  mode: string;
  /** Milliseconds. */
  at: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Remember a frame she actually made.
 *
 * Called by the selfie tool on a success that carries a picture, never on a
 * refusal: a scene that was not drawn is not a scene she has to avoid.
 *
 * An identical repeat of the newest row is dropped. The tool may legitimately
 * draw the same scene twice in one turn (the prompt check lets a second identical
 * attempt through so a check she cannot satisfy never traps her), and two equal
 * lines in the block would read as two memories where there was one.
 */
export function recordScene(userId: string, context: string, mode = "", at = Date.now()): void {
  const scene = collapse(context);
  if (!scene) return;
  const db = getDB();

  const newest = db
    .prepare("SELECT context FROM scene_log WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(userId) as { context: string } | undefined;
  if (newest && collapse(newest.context) === scene) return;

  db.prepare("INSERT INTO scene_log (user_id, context, mode, timestamp) VALUES (?, ?, ?, ?)").run(
    userId,
    scene,
    mode,
    Math.floor(at / 1000),
  );
  db.prepare(
    `DELETE FROM scene_log WHERE user_id = ? AND id NOT IN (
       SELECT id FROM scene_log WHERE user_id = ? ORDER BY id DESC LIMIT ?
     )`,
  ).run(userId, userId, SCENE_KEEP);
}

/** Her last few frames, newest first. */
export function recentScenes(userId: string, limit = SCENE_PROMPT_LIMIT): SceneRow[] {
  const rows = getDB()
    .prepare("SELECT context, mode, timestamp FROM scene_log WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit) as Array<{ context: string; mode: string; timestamp: number }>;
  return rows.map((r) => ({ context: r.context, mode: r.mode, at: r.timestamp * 1000 }));
}

/** The lines as the prompt shows them: one frame per line, whitespace flattened. */
export function renderRecentFrames(rows: SceneRow[]): string {
  return rows
    .map((row) => {
      const one = collapse(row.context);
      if (!one) return "";
      const shown =
        one.length > SCENE_LINE_LIMIT
          // Cut on a word boundary, so the line does not end mid-word.
          ? `${one.slice(0, SCENE_LINE_LIMIT).replace(/\s\S*$/, "")}…`
          : one;
      return `- ${shown}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * The instruction she is given with the block.
 *
 * Lives beside the rows rather than in the engine, so the rule and the data it
 * is about cannot drift apart. The second sentence is the one that mattered in
 * the probe: told only "each frame unlike the last", the writer went back to the
 * same room; told to invent a new one when he names nothing, it moved.
 */
export const FRAME_VARIETY_RULE =
  "Это кадры, которые ты уже сделала, — последние сверху. Новый кадр не должен повторять их: " +
  "другую обстановку, другую позу, другую причёску, другой взгляд, другой свет. " +
  "Если он сам не назвал сцену — придумай новую, непохожую на эти, а не бери ту же комнату и то же утро.";
