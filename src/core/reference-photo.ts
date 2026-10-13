/**
 * The reference photo: one path, one writer, one reader.
 *
 * Five places used to build `~/.eva/reference.jpg` by hand — `index.ts` twice,
 * `handlers.ts` twice for the same command in two forms, `image-gen.ts` — and a
 * sixth turned up the moment the install started asking for a photo. A path
 * that six pieces of code agree on by coincidence is a path that will one day
 * be one `.jpg` in one file and a `.png` somewhere else, and the symptom is
 * "фото не находится" with nothing in the log to explain it.
 *
 * So: this file owns the location, the copy, and the question of whether there
 * is one. A plain segment everywhere — `"\\.eva"` in a path.join is a literal
 * filename on Linux, not a directory, and that bug was in the tree twice.
 *
 * The photo is a property of the person, not of the software. It lives in
 * `~/.eva/` beside the config, never in the repository, and it is optional: no
 * photo means no selfies until one arrives, which is a missing feature rather
 * than a broken install.
 *
 * There are two of them now. `self` is the face the bot wears — the woman the
 * selfie draws. `owner` is the person on the other side of the chat, kept for
 * the one thing a photo of him is for: a frame with both of them in it. They
 * are separate files with separate lifetimes, and replacing one must never
 * touch the other — which is why the kind is a parameter of the functions here
 * rather than a second copy of this module.
 */

import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "./config.js";

/** Whose face a file holds: `self` is the bot's, `owner` is the human's. */
export type ReferenceKind = "self" | "owner";

/**
 * The filename for each kind.
 *
 * Deliberately flat, beside the config rather than in a directory of their own:
 * `EVA_CONFIG_PATH` can point the whole install elsewhere, and every path here
 * derives from the config's own directory. One rule for both ends: the config's
 * directory, or nothing.
 */
const REFERENCE_FILES: Record<ReferenceKind, string> = {
  self: "reference.jpg",
  owner: "owner.jpg",
};

/**
 * Where a photo lives: beside the config.
 *
 * Beside, not in a directory of its own. `EVA_CONFIG_PATH` can point the whole
 * install elsewhere, and a photo that init wrote to `~/.eva` while the running
 * bot looked in `/etc/eva` is a photo that exists and is never seen. One rule
 * for both ends: the config's directory, or nothing.
 */
export function referencePhotoPathFor(kind: ReferenceKind, configPath?: string): string {
  return path.join(path.dirname(configPath ?? getConfigPath()), REFERENCE_FILES[kind]);
}

/** The bot's own face: the woman the selfie draws. */
export function referencePhotoPath(configPath?: string): string {
  return referencePhotoPathFor("self", configPath);
}

/** The owner's face, for the frame that has both of them in it. */
export function ownerReferencePhotoPath(configPath?: string): string {
  return referencePhotoPathFor("owner", configPath);
}

/** Whether there is a photo to use. */
export function hasReferencePhotoFor(kind: ReferenceKind, configPath?: string): boolean {
  try {
    return fs.statSync(referencePhotoPathFor(kind, configPath)).size > 0;
  } catch {
    return false;
  }
}

/** Whether the bot's own photo is in place. */
export function hasReferencePhoto(configPath?: string): boolean {
  return hasReferencePhotoFor("self", configPath);
}

/** Whether the owner's photo is in place. */
export function hasOwnerReferencePhoto(configPath?: string): boolean {
  return hasReferencePhotoFor("owner", configPath);
}

/**
 * Human-readable size and age, for the doctor report. Never the photo itself.
 *
 * The age is not decoration. A reference that was never replaced looks exactly
 * like one that was, from the outside: the report said "фото есть", the owner
 * sent a new one, the send went into the conversation, and the file stayed as it
 * was. Two of those in a row looked like the tool ignoring him. Showing when it
 * was last written makes a stale one obvious on sight.
 */
export function describeReferencePhotoFor(kind: ReferenceKind, configPath?: string): string {
  try {
    const st = fs.statSync(referencePhotoPathFor(kind, configPath));
    const when = st.mtime.toISOString().slice(0, 16).replace("T", " ");
    return `${referencePhotoPathFor(kind, configPath)} (${Math.round(st.size / 1024)} КБ, заменено ${when} UTC)`;
  } catch {
    return "нет";
  }
}

export function describeReferencePhoto(configPath?: string): string {
  return describeReferencePhotoFor("self", configPath);
}

export function describeOwnerReferencePhoto(configPath?: string): string {
  return describeReferencePhotoFor("owner", configPath);
}

/** Extensions we accept, judged by what the image actually is. */
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic"]);

export class ReferencePhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferencePhotoError";
  }
}

/** Where the previous photo is kept, so a swap is not a one-way door. */
export function previousReferencePhotoPathFor(kind: ReferenceKind, configPath?: string): string {
  const current = referencePhotoPathFor(kind, configPath);
  return path.join(path.dirname(current), `${path.basename(current, path.extname(current))}.prev${path.extname(current)}`);
}

export function previousReferencePhotoPath(configPath?: string): string {
  return previousReferencePhotoPathFor("self", configPath);
}

/**
 * Put a photo in place — the one place that writes it.
 *
 * Two writers used to exist: `saveReferencePhoto` for a file on disk, and the
 * Telegram handler writing `fs.writeFileSync` straight to the path. Same
 * destination, different rules — the downloader skipped the checks and neither
 * kept the old one, so `/setphoto` was a one-way door: a worse photo replaced a
 * good one and there was nothing to go back to. Trying reference photos against
 * each other is how this actually gets decided, so the previous one is kept.
 *
 * Returns where the photo went.
 */
export function writeReferencePhotoFor(kind: ReferenceKind, buffer: Buffer, configPath?: string): string {
  if (buffer.length === 0) {
    throw new ReferencePhotoError("Файл пустой");
  }
  const dest = referencePhotoPathFor(kind, configPath);
  try {
    if (fs.statSync(dest).size > 0) {
      const previous = previousReferencePhotoPathFor(kind, configPath);
      fs.copyFileSync(dest, previous);
      try {
        fs.chmodSync(previous, 0o600);
      } catch {
        // No POSIX modes on some filesystems; see the note below.
      }
    }
  } catch {
    // No photo there yet, so there is nothing to roll back to. Fine.
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, buffer);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // Windows and some network filesystems have no POSIX modes. A photo is not
    // a credential; failing to chmod is not a reason to refuse the install.
  }
  return dest;
}

export function writeReferencePhoto(buffer: Buffer, configPath?: string): string {
  return writeReferencePhotoFor("self", buffer, configPath);
}

/** Save the owner's photo. Same rules as hers — separate file, separate backup. */
export function writeOwnerReferencePhoto(buffer: Buffer, configPath?: string): string {
  return writeReferencePhotoFor("owner", buffer, configPath);
}

/**
 * Copy a photo into place.
 *
 * Returns where it went. Refuses something that is not a file, and refuses an
 * extension that is not an image — a wrong path is a typo the owner can fix,
 * and copying `~/.ssh/id_rsa` into `reference.jpg` on his word is not one.
 */
export function saveReferencePhotoFor(kind: ReferenceKind, source: string, configPath?: string): string {
  const src = path.resolve(source);
  let st: fs.Stats;
  try {
    st = fs.statSync(src);
  } catch {
    throw new ReferencePhotoError(`Файла нет: ${src}`);
  }
  if (!st.isFile()) {
    throw new ReferencePhotoError(`Это не файл: ${src}`);
  }
  if (st.size === 0) {
    throw new ReferencePhotoError(`Файл пустой: ${src}`);
  }
  if (!IMAGE_EXT.has(path.extname(src).toLowerCase())) {
    throw new ReferencePhotoError(
      `Похоже, это не картинка (${path.extname(src) || "без расширения"}). Нужна фотография: jpg, png, webp.`,
    );
  }

  return writeReferencePhotoFor(kind, fs.readFileSync(src), configPath);
}

export function saveReferencePhoto(source: string, configPath?: string): string {
  return saveReferencePhotoFor("self", source, configPath);
}

export function saveOwnerReferencePhoto(source: string, configPath?: string): string {
  return saveReferencePhotoFor("owner", source, configPath);
}
