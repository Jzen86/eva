import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliver } from "../../src/channels/telegram/handlers.js";

describe("deliver", () => {
  it("puts the written reply under a voice note instead of dropping it", async () => {
    // A voice note and the written reply are two halves of one turn: she speaks
    // a line, then writes the scene. The .ogg branch sent the file and returned,
    // caption and all — so the written half, the one with the actual scene in it,
    // never left the server. The voice tool reports "готово и отправлено", so she
    // had no way to notice: half of every intimate turn was silently discarded,
    // and the owner concluded she was stalling rather than being cut off.
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
