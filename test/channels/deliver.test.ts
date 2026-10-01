import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliver } from "../../src/channels/telegram/handlers.js";

function tempOgg(tag: string): string {
  const file = path.join(os.tmpdir(), `eva-voice-${tag}-${Date.now()}.ogg`);
  fs.writeFileSync(file, Buffer.from([0x4f, 0x67, 0x67, 0x53]));
  return file;
}

function fakeCtx() {
  return {
    replyWithVoice: vi.fn().mockResolvedValue({ message_id: 1 }),
    replyWithPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
    reply: vi.fn().mockResolvedValue({ message_id: 3 }),
  };
}

describe("deliver", () => {
  it("gives a voice note the written half as its caption", async () => {
    // A turn with the voice tool makes two things: the line she speaks, and the
    // reply she writes after the tool returns. The .ogg branch sent the file and
    // returned, caption and all, so the written half never left the server. The
    // tool answers "готово и отправлено", which means she had no way to notice —
    // and the owner, seeing only the teasing half that arrived, concluded she was
    // stalling when she was being cut off mid-turn.
    const file = tempOgg("one");
    const ctx = fakeCtx();

    await deliver(ctx as never, {
      text: "Подхожу ближе, кладу ладони тебе на плечи и медленно веду пальцами вниз",
      mediaPath: file,
    });

    expect(ctx.replyWithVoice).toHaveBeenCalledTimes(1);
    const options = ctx.replyWithVoice.mock.calls[0][1] as { caption?: string } | undefined;
    expect(options?.caption).toContain("кладу ладони");
    expect(ctx.reply).not.toHaveBeenCalled();

    fs.unlinkSync(file);
  });

  it("sends every piece a turn produced, not only the last one", async () => {
    // Two voice notes are a legitimate ask, and she answers it with two calls.
    // `lastMediaPath` is one slot, so the second overwrote the first and only one
    // note ever arrived — while both tools reported success, so she believed the
    // turn landed whole and never repeated the missing half.
    const first = tempOgg("a");
    const second = tempOgg("b");
    const ctx = fakeCtx();

    await deliver(ctx as never, {
      text: "Отправила два голосовых подряд 😘",
      media: [{ path: first }, { path: second }],
    });

    expect(ctx.replyWithVoice).toHaveBeenCalledTimes(2);
    const firstOptions = ctx.replyWithVoice.mock.calls[0][1] as { caption?: string } | undefined;
    const secondOptions = ctx.replyWithVoice.mock.calls[1][1] as { caption?: string } | undefined;
    // Her words ride the last piece; the earlier one goes out clean.
    expect(firstOptions?.caption).toBeUndefined();
    expect(secondOptions?.caption).toContain("два голосовых");

    fs.unlinkSync(first);
    fs.unlinkSync(second);
  });
});
