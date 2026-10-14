/**
 * A small copy of a generated picture, for her to look at.
 *
 * The picture is what she judges her own work by, and the version that leaves the
 * generator is far bigger than judging needs: a 1024-pixel PNG comes to about
 * 1.5 MB, which is ~2 MB of base64 in the body of the request — the owner noticed
 * the delay immediately ("это значительно увеличивает время"). What has to be
 * visible is where a hand is and whose it is, and that survives a large cut.
 *
 * ffmpeg, because it is already the tool this project uses for media conversion
 * (see voice.ts) and it is present on the server; a second encoder would be a
 * second thing to install.
 *
 * Fails towards *looking*: if conversion does not work, the original is returned
 * rather than nothing — a slow look is still a look, and silence here would put
 * her back to guessing with no signal that anything broke.
 */

import { spawn } from "node:child_process";

/** Longest side of the copy. Enough for a pose and a hand, not for a poster. */
const PREVIEW_MAX_SIDE = 640;

/** Below this the original is already cheap — no point converting. */
const ALREADY_SMALL_BYTES = 200 * 1024;

export interface PreviewResult {
  dataUrl: string;
  /** Bytes of the payload, before base64, so the log can say what it cost. */
  bytes: number;
  /** Whether this is the original rather than a converted copy. */
  original: boolean;
}

function runFfmpeg(input: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vf", `scale='min(${PREVIEW_MAX_SIDE},iw)':-2`,
      "-q:v", "5",
      "-f", "image2",
      "-c:v", "mjpeg",
      "pipe:1",
    ];
    let out: Buffer[] = [];
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let ff;
    try {
      ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }
    // Judging a picture is not worth hanging a turn on: without a timeout a
    // stuck ffmpeg would hold the conversation, which is worse than a big image.
    const timer = setTimeout(() => {
      try { ff.kill("SIGKILL"); } catch {}
      finish(null);
    }, 10_000);
    ff.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    ff.on("error", () => { clearTimeout(timer); finish(null); });
    ff.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      finish(code === 0 && buf.length > 0 ? buf : null);
    });
    ff.stdin.on("error", () => {});
    ff.stdin.end(input);
  });
}

/**
 * Shrink a `data:image/...;base64,...` payload for the model to look at.
 * Returns null when the input is not an inline image at all.
 */
export async function previewImage(dataUrl: string): Promise<PreviewResult | null> {
  const match = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length === 0) return null;
  if (bytes.length <= ALREADY_SMALL_BYTES) {
    return { dataUrl, bytes: bytes.length, original: true };
  }
  const shrunk = await runFfmpeg(bytes);
  if (!shrunk) return { dataUrl, bytes: bytes.length, original: true };
  return {
    dataUrl: `data:image/jpeg;base64,${shrunk.toString("base64")}`,
    bytes: shrunk.length,
    original: false,
  };
}
