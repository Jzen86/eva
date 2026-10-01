import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliver } from "../../src/channels/telegram/handlers.js";

describe("deliver", () => {
  it("gives a voice note the written half as its caption", async () => {
    // A turn with the voice tool makes two things: the line she speaks, and the
    // reply she writes after the tool returns. The .ogg branch sent the file and
    // returned, caption and all, so the written half never left the server. The
    // tool answers "готово и отправлено", which means she had no way to notice —
    // and the owner, seeing only the teasing half that arrived, concluded she was
    // stalling when she was being cut off mid-turn.
    //
    // The caption is her written half, not a transcript: what goes under the note
    // is the reply she composed, and that is where a scene lands when she speaks
    // instead of writing.
    const file = path.join(os.tmpdir(), `eva-voice-${Date.now()}.ogg`);
    fs.writeFileSync(file, Buffer.from([0x4f, 0x67, 0x67, 0x53]));

    const ctx = {
      replyWithVoice: vi.fn().mockResolvedValue({ message_id: 1 }),
      reply: vi.fn().mockResolvedValue({ message_id: 2 }),
    };

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
});
