import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliver, deliverTo } from "../../src/channels/telegram/handlers.js";

function tempOgg(tag: string): string {
  const file = path.join(os.tmpdir(), `eva-voice-${tag}-${Date.now()}.ogg`);
  fs.writeFileSync(file, Buffer.from([0x4f, 0x67, 0x67, 0x53]));
  return file;
}

/**
 * The Telegram API, as the delivery sees it.
 *
 * Delivery is written against `api` + chat id rather than against a grammY
 * `Context`, because a turn the bot made on its own (a report, the initiative) has
 * no context. That second path used to be its own implementation and had drifted:
 * one attachment, no markdown, no chunking, a blind 1024-character cut, no buttons.
 */
function fakeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendVoice: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    sendVideo: vi.fn().mockResolvedValue({ message_id: 4 }),
    sendAudio: vi.fn().mockResolvedValue({ message_id: 5 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 6 }),
    sendVideoNote: vi.fn().mockResolvedValue({ message_id: 7 }),
  };
}

/** A live turn: a context with an api, a chat and a message to answer. */
function fakeCtx() {
  const api = fakeApi();
  const chatId = 42;
  return {
    api,
    chatId,
    ctx: { api, chat: { id: chatId }, msg: { message_id: 100 } },
  };
}

/** Options of one call: `(chatId, file|text, options)`. */
function optsOf(call: unknown[] | undefined): { caption?: string; parse_mode?: string; reply_parameters?: { message_id: number } } {
  return (call?.[2] ?? {}) as never;
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
    const { ctx, api } = fakeCtx();

    await deliver(ctx as never, {
      text: "Подхожу ближе, кладу ладони тебе на плечи и медленно веду пальцами вниз",
      mediaPath: file,
    });

    expect(api.sendVoice).toHaveBeenCalledTimes(1);
    expect(optsOf(api.sendVoice.mock.calls[0]).caption).toContain("кладу ладони");
    expect(api.sendMessage).not.toHaveBeenCalled();

    fs.unlinkSync(file);
  });

  it("sends every piece a turn produced, not only the last one", async () => {
    // Two voice notes are a legitimate ask, and she answers it with two calls.
    // `lastMediaPath` is one slot, so the second overwrote the first and only one
    // note ever arrived — while both tools reported success, so she believed the
    // turn landed whole and never repeated the missing half.
    const first = tempOgg("a");
    const second = tempOgg("b");
    const { ctx, api } = fakeCtx();

    await deliver(ctx as never, {
      text: "Отправила два голосовых подряд 😘",
      media: [{ path: first }, { path: second }],
    });

    expect(api.sendVoice).toHaveBeenCalledTimes(2);
    // Her words ride the last piece; the earlier one goes out clean.
    expect(optsOf(api.sendVoice.mock.calls[0]).caption).toBeUndefined();
    expect(optsOf(api.sendVoice.mock.calls[1]).caption).toContain("два голосовых");
    // A live turn keeps the reply link its answer used to hang off.
    expect(optsOf(api.sendVoice.mock.calls[1]).reply_parameters).toEqual({ message_id: 100 });

    fs.unlinkSync(first);
    fs.unlinkSync(second);
  });

  it("does not caption a voice note with the words it is already saying", async () => {
    // She wrote the same line twice: once into the voice tool, once as her
    // answer. The caption then read as a transcript of the note — the words out
    // of the speaker, and the same words underneath it.
    const file = tempOgg("dup");
    const { ctx, api } = fakeCtx();
    const line =
      "Ого, хакер наш объявился 😈 Давай, чини, а я пока тут посижу и посмотрю, что у тебя получится";

    await deliver(ctx as never, { text: line, media: [{ path: file, text: line }] });

    expect(api.sendVoice).toHaveBeenCalledTimes(1);
    expect(optsOf(api.sendVoice.mock.calls[0]).caption).toBeUndefined();

    fs.unlinkSync(file);
  });

  it("keeps a caption that adds something the voice does not say", async () => {
    const file = tempOgg("add");
    const { ctx, api } = fakeCtx();

    await deliver(ctx as never, {
      text: "Проверяй, как звучит, и скажи, дошло ли нормально",
      media: [{ path: file, text: "Слушаю тебя, любимый 🖤😘" }],
    });

    expect(api.sendVoice).toHaveBeenCalledTimes(1);
    expect(optsOf(api.sendVoice.mock.calls[0]).caption).toContain("Проверяй, как звучит");

    fs.unlinkSync(file);
  });

  it("treats dots as no caption at all", async () => {
    // She has no way to end a turn without a reply, so when there is nothing to
    // add she writes "…" — and three dots under a voice note are not a caption.
    const file = tempOgg("dots");
    const { ctx, api } = fakeCtx();

    await deliver(ctx as never, {
      text: "...",
      media: [{ path: file, text: "Слушаю тебя, любимый 🖤😘" }],
    });

    expect(api.sendVoice).toHaveBeenCalledTimes(1);
    expect(optsOf(api.sendVoice.mock.calls[0]).caption).toBeUndefined();

    fs.unlinkSync(file);
  });

  it("puts a parked action on two buttons instead of a /yes to remember", async () => {
    const { ctx, api } = fakeCtx();

    await deliver(ctx as never, {
      text: "Нужно твоё добро.",
      confirm: { summary: "выполнить команду: npm install foo", reason: "просил поставить пакет" },
    });

    const withKeyboard = api.sendMessage.mock.calls.find(
      (c) => (c[2] as { reply_markup?: unknown } | undefined)?.reply_markup !== undefined,
    );
    expect(withKeyboard).toBeDefined();
    const markup = (withKeyboard![2] as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    }).reply_markup;
    expect(markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      "pending:yes",
      "pending:no",
    ]);
    expect(String(withKeyboard![1])).toContain("npm install foo");
    expect(String(withKeyboard![1])).toContain("просил поставить пакет");
  });

  it("still says what she said when the piece carrying her words fails", async () => {
    // Her words ride the *last* attachment. When that is the one that fails, the
    // notice about a missing attachment used to be the whole message: the owner
    // was told a picture got lost and never learned what she answered.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = tempOgg("ok");
      const second = tempOgg("fail");
      const { ctx, api } = fakeCtx();
      api.sendVoice
        .mockResolvedValueOnce({ message_id: 1 })
        .mockRejectedValueOnce(new Error("400: bad request"));

      await deliver(ctx as never, {
        text: "Второе не записалось, зато первое слушай как надо",
        media: [{ path: first }, { path: second }],
      });

      const texts = api.sendMessage.mock.calls.map((c) => String(c[1]));
      expect(texts.some((t) => t.includes("не доехало"))).toBe(true);
      expect(texts.some((t) => t.includes("Второе не записалось"))).toBe(true);

      fs.unlinkSync(first);
      fs.unlinkSync(second);
    } finally {
      spy.mockRestore();
    }
  });

  it("never cuts a caption inside an HTML tag", async () => {
    // The cut used to happen *after* markdown conversion, so a long answer could
    // end inside `<b>` — and Telegram rejects the whole message, picture and words
    // together. The source is cut and then converted now.
    const file = tempOgg("cut");
    const { ctx, api } = fakeCtx();
    const long = "**жирный текст** ".repeat(120);

    await deliver(ctx as never, { text: long, media: [{ path: file, text: "чужие слова" }] });

    const caption = optsOf(api.sendVoice.mock.calls[0]).caption ?? "";
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect((caption.match(/<b>/g) ?? []).length).toBe((caption.match(/<\/b>/g) ?? []).length);

    fs.unlinkSync(file);
  });
});

describe("deliverTo (a turn the bot made on its own)", () => {
  it("chunks a long report instead of throwing it away", async () => {
    // `TelegramChannel.send` used to be its own path: `sendMessage(chatId, text)`
    // with no chunking. Telegram answers 400 above 4096 characters, the send
    // throws, the scheduler logs "доставка не удалась" — and the owner sees nothing
    // at all. It also had no reply link, which is correct here: there is no message
    // to answer.
    const api = fakeApi();
    const long = "длинный отчёт про сервер. ".repeat(400);
    expect(long.length).toBeGreaterThan(4096);

    await deliverTo({ api, chatId: 7 } as never, { text: long });

    expect(api.sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of api.sendMessage.mock.calls) {
      expect(call[0]).toBe(7);
      expect(String(call[1]).length).toBeLessThanOrEqual(4096);
      expect(optsOf(call).reply_parameters).toBeUndefined();
    }
    const joined = api.sendMessage.mock.calls.map((c) => String(c[1])).join(" ");
    expect(joined.split("про сервер").length - 1).toBe(400);
  });

  it("converts markdown, sends every attachment and offers the buttons", async () => {
    const api = fakeApi();
    const file = tempOgg("bot");
    const photo = path.join(os.tmpdir(), `eva-photo-${Date.now()}.png`);
    fs.writeFileSync(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    api.sendDocument.mockResolvedValueOnce({ message_id: 1 });

    await deliverTo({ api, chatId: 7 } as never, {
      text: "**Отчёт** готов: `report.md`",
      media: [{ path: file }, { path: photo }],
      confirm: { summary: "выполнить команду: uptime" },
    });

    expect(api.sendVoice).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    // Markdown reached Telegram as HTML: the owner used to get the asterisks.
    const captions = [optsOf(api.sendVoice.mock.calls[0]).caption, optsOf(api.sendPhoto.mock.calls[0]).caption];
    expect(captions.some((c) => c?.includes("<b>Отчёт</b>"))).toBe(true);
    expect(captions.every((c) => !c?.includes("**"))).toBe(true);
    // A parked command from a check gets the same two buttons a live turn does.
    const withKeyboard = api.sendMessage.mock.calls.find(
      (c) => (c[2] as { reply_markup?: unknown } | undefined)?.reply_markup !== undefined,
    );
    expect(withKeyboard).toBeDefined();

    fs.unlinkSync(file);
    fs.unlinkSync(photo);
  });
});
