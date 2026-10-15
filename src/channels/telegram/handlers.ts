import type { Api, Bot, Context } from "grammy";
import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "../../core/types.js";
import type { MessageHandler } from "../types.js";
import { sendVoiceResponse } from "./voice.js";
import { transcribeVoice } from "./transcribe.js";
import { sendVideoNote } from "./video.js";
import { applyPending, discard, peek, describe } from "../../core/pending.js";
import { noteVoiceSent } from "../../core/voice-budget.js";
import { loadConfig, patchConfig } from "../../core/config.js";
import { profileKnowledge, knowledgeOfKind } from "../../core/memory/knowledge.js";
import { renderProfileDossier, renderFlatBlock, writeProfileDoc } from "../../core/profile-dossier.js";
import {
  start as startQuest,
  answerText as answerQuestText,
  answerPhoto as answerQuestPhoto,
  expired as questExpired,
  questionFor,
  describeExisting,
  applyAnswers,
  summary as summaryAnswers,
  type Quest,
  type Turn,
} from "../../core/persona-quest.js";
import fs from "node:fs";
import path from "node:path";
import {
  writeReferencePhoto,
  writeOwnerReferencePhoto,
  referencePhotoPath,
  ownerReferencePhotoPath,
  type ReferenceKind,
} from "../../core/reference-photo.js";

/** Max Telegram message length. */
const MAX_MSG_LEN = 4096;

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML (like OpenClaw's format.ts approach)
// ---------------------------------------------------------------------------

/** Escape HTML special chars. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert LLM markdown to Telegram HTML.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, [links](url)
 * Uses HTML parse_mode (more reliable than MarkdownV2).
 */
function markdownToTelegramHtml(text: string): string {
  const parts: string[] = [];
  // Split by code blocks and inline code (preserve them separately)
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

  for (const segment of segments) {
    if (segment.startsWith("```") && segment.endsWith("```")) {
      const inner = segment.slice(3, -3);
      const newlineIdx = inner.indexOf("\n");
      if (newlineIdx !== -1) {
        const lang = inner.slice(0, newlineIdx).trim();
        const code = inner.slice(newlineIdx + 1);
        parts.push(
          lang
            ? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`
            : `<pre>${escapeHtml(code)}</pre>`,
        );
      } else {
        parts.push(`<pre>${escapeHtml(inner)}</pre>`);
      }
    } else if (segment.startsWith("`") && segment.endsWith("`")) {
      parts.push(`<code>${escapeHtml(segment.slice(1, -1))}</code>`);
    } else {
      // Regular text — convert formatting
      // Extract markdown links before escaping HTML (urls contain & etc.)
      const linkPlaceholders: string[] = [];
      let withPlaceholders = segment.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_match, label, url) => {
          const idx = linkPlaceholders.length;
          linkPlaceholders.push(
            `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
          );
          return `\x00LINK${idx}\x00`;
        },
      );
      let html = escapeHtml(withPlaceholders);
      // Restore link placeholders
      html = html.replace(/\x00LINK(\d+)\x00/g, (_m, i) => linkPlaceholders[Number(i)]);
      // ### heading → <b>heading</b> (strip markdown headers)
      html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
      // **bold** → <b>bold</b>
      html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      // *italic* → <i>italic</i> (but not inside bold tags)
      html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
      // ~~strikethrough~~ → <s>strikethrough</s>
      html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
      // > blockquote → <blockquote>
      html = html.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
      // Merge adjacent blockquotes into one
      html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");
      parts.push(html);
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Typing indicator with circuit breaker (like OpenClaw)
// ---------------------------------------------------------------------------

/** Consecutive 401 failures before suspending chat actions. */
const MAX_401_FAILURES = 10;
/** Max backoff between typing pings (ms). */
const MAX_BACKOFF_MS = 300_000; // 5 min

let consecutive401 = 0;
let backoffMs = 4000;
let suspended = false;

/** Start sending "typing" action with circuit breaker. Returns stop function. */
function startTyping(ctx: Context): () => void {
  let running = true;

  const tick = async () => {
    while (running) {
      if (suspended) {
        await sleep(backoffMs);
        continue;
      }
      try {
        await ctx.replyWithChatAction("typing");
        // Success — reset backoff
        if (consecutive401 > 0) {
          consecutive401 = 0;
          backoffMs = 4000;
          suspended = false;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("401") || msg.includes("Unauthorized")) {
          consecutive401++;
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          if (consecutive401 >= MAX_401_FAILURES) {
            suspended = true;
          }
        }
        // Other errors — just skip this tick
      }
      await sleep(backoffMs);
    }
  };

  tick();
  return () => { running = false; };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Message delivery with chunking
// ---------------------------------------------------------------------------

/**
 * What delivery needs from the channel: the Telegram API and the chat.
 *
 * There are two delivery paths — a live turn (`deliver`, which has a grammY
 * `Context`) and a turn the bot made on its own (`TelegramChannel.send`, which has
 * an api and a chat id) — and they used to be two separate implementations. The
 * one without a Context was the poor relation, and every difference was a loss the
 * owner could see: it sent only the last attachment of a turn, it never converted
 * markdown to HTML, it never chunked (a report over 4096 characters threw, so a
 * long check arrived as nothing at all), it cut her words at 1024 characters
 * *after* converting them — a cut inside a tag makes Telegram reject the whole
 * message, media included — and it dropped the approval buttons, so a check that
 * parked a command left him with no button to press.
 */
export interface Delivery {
  api: Api;
  chatId: number;
  /** The message to hang the answer off, when there is one: a live turn replies. */
  replyTo?: number;
}

/** The delivery of a live turn, which is a grammY context. */
export function deliveryOf(ctx: Context): Delivery {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId === undefined) throw new Error("Telegram: у сообщения нет чата — доставлять некуда");
  return {
    api: ctx.api,
    chatId,
    ...(ctx.msg?.message_id ? { replyTo: ctx.msg.message_id } : {}),
  };
}

/** Options for one send, with the reply link a live turn wants and a bot turn does not. */
function sendOpts(d: Delivery, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return d.replyTo ? { ...extra, reply_parameters: { message_id: d.replyTo } } : extra;
}

/**
 * Send text as HTML, chunking if needed, and never losing the rest of it.
 *
 * The source is cut first and each piece converted on its own, on purpose:
 * converting the whole text and splitting the HTML afterwards cut tags in half,
 * Telegram answered 400, and the fallback then re-sent *every* earlier chunk — the
 * beginning of her answer arrived twice. Here a piece that will not parse costs
 * exactly that piece, sent as plain text.
 */
async function sendText(d: Delivery, text: string): Promise<void> {
  for (const chunk of chunkText(text, MAX_MSG_LEN)) {
    const html = markdownToTelegramHtml(chunk);
    // Escaping grows the text, so a converted chunk can come out over the limit.
    // Cutting the HTML is what broke it in the first place; the plain chunk is
    // already short enough, so it goes as is.
    if (html.length > MAX_MSG_LEN) {
      await d.api.sendMessage(d.chatId, chunk, sendOpts(d));
      continue;
    }
    try {
      await d.api.sendMessage(d.chatId, html, sendOpts(d, { parse_mode: "HTML" }));
    } catch {
      await d.api.sendMessage(d.chatId, chunk, sendOpts(d));
    }
  }
}

/** Split text into chunks respecting max length, trying to break at newlines. */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at last newline within limit
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) {
      // No good newline — break at last space
      breakAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakAt <= 0) {
      // No space either — hard break
      breakAt = maxLen;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}

/** File extension to Telegram send method mapping. */
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".avi", ".mov"]);
const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".flac", ".m4a", ".aac", ".opus"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Runtime options for audio/video delivery (voice config, keys, avatar path). */
export interface AudioOptions {
  voiceConfig: Record<string, unknown>;
  falApiKey?: string;
  avatarPath?: string;
}

/** What this turn produced, oldest first. Falls back to the single slot. */
function turnMedia(response: OutgoingMessage): Array<{ url?: string; path?: string; text?: string }> {
  if (response.media?.length) return response.media;
  if (response.mediaPath || response.mediaUrl) {
    return [{
      ...(response.mediaPath ? { path: response.mediaPath } : {}),
      ...(response.mediaUrl ? { url: response.mediaUrl } : {}),
    }];
  }
  return [];
}

function normalise(s?: string): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Her reply, unless it only repeats what the media already says.
 *
 * She wrote the same line twice: once into the voice tool, once as her answer.
 * The caption then read as a transcript of the note — the words coming out of
 * the speaker and the same words underneath it. A caption has to add something
 * ("проверяй, как звучит" does); a copy of the note is not an addition, and a
 * retelling wrapped around it ("Отправила голосовое: «…»") is worse.
 */
function captionFor(text: string, mediaText?: string): string | undefined {
  if (!text) return undefined;
  // "…", a bare emoji, spaces: she has no way to end a turn with no reply at all,
  // so when she has nothing to add she writes dots — and dots are not a caption.
  if (!/[a-zа-яё0-9]/i.test(text)) return undefined;
  const said = normalise(mediaText);
  const wrote = normalise(text);
  if (said.length >= 20 && (wrote === said || wrote.includes(said))) return undefined;
  // The *source* is cut and then converted, never the other way round: a slice
  // taken from converted HTML can land inside `<b>` or `<a href="…">`, and Telegram
  // then rejects the message whole — the picture and the words with it.
  //
  // And the result is measured, because conversion *grows* the text (each
  // `**bold**` becomes `<b>bold</b>`): a 1024-character source can convert to more
  // than the caption limit, and an over-long caption is rejected along with the
  // picture. So the source is shrunk until its HTML fits.
  let source = text;
  let html = markdownToTelegramHtml(source);
  while (html.length > 1024 && source.length > 1) {
    source = source.slice(0, Math.max(1, Math.floor(source.length * 0.8)));
    html = markdownToTelegramHtml(source);
  }
  return html.length > 1024 ? undefined : html;
}

/** Send one piece of media. False when it could not go out. */
async function sendMedia(
  d: Delivery,
  item: { url?: string; path?: string; text?: string },
  text: string,
): Promise<boolean> {
  if (item.path && fs.existsSync(item.path)) {
    try {
      const { InputFile } = await import("grammy");
      const ext = path.extname(item.path).toLowerCase();
      const caption = captionFor(text, item.text);
      const opts = sendOpts(d, caption ? { caption, parse_mode: "HTML" } : {});
      const file = new InputFile(item.path);

      if (VIDEO_EXTS.has(ext)) {
        await d.api.sendVideo(d.chatId, file, opts);
      } else if (ext === ".ogg" || ext === ".opus") {
        // The caption is her written half, not a transcript of the voice note.
        // A turn with the voice tool makes two things: the line she speaks, and
        // the reply she writes after the tool returns. Dropping the caption threw
        // the second one away silently — the tool answers "готово и отправлено",
        // so she had no way to know, and the owner, seeing only the teasing half,
        // concluded she was stalling when she was being cut off.
        await d.api.sendVoice(d.chatId, file, opts);
        // Spent where the voice leaves, not where it was made: see voice-budget.ts.
        noteVoiceSent();
      } else if (AUDIO_EXTS.has(ext)) {
        await d.api.sendAudio(d.chatId, file, opts);
      } else if (IMAGE_EXTS.has(ext)) {
        // A picture that happens to be a file on disk is a picture, not a document.
        await d.api.sendPhoto(d.chatId, file, opts);
      } else {
        await d.api.sendDocument(d.chatId, file, opts);
      }
      return true;
    } catch (err) {
      console.error("Failed to send file:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  // A media URL (selfie/image_gen) arrives as bytes, not as a file on disk.
  if (item.url) {
    try {
      let buffer: Buffer;
      if (item.url.startsWith("data:")) {
        const base64 = item.url.replace(/^data:image\/[^;]+;base64,/, "");
        buffer = Buffer.from(base64, "base64");
      } else {
        const imgRes = await fetch(item.url);
        buffer = Buffer.from(await imgRes.arrayBuffer());
      }
      const { InputFile } = await import("grammy");
      const caption = captionFor(text, item.text);
      await d.api.sendPhoto(
        d.chatId,
        new InputFile(buffer, "selfie.jpg"),
        sendOpts(d, caption ? { caption, parse_mode: "HTML" } : {}),
      );
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/** Deliver an OutgoingMessage, and the approval buttons when the turn parked one. */
export async function deliver(ctx: Context, response: OutgoingMessage, audio?: AudioOptions): Promise<void> {
  await deliverTo(deliveryOf(ctx), response, audio);
}

/**
 * Deliver a turn the bot made on its own — no context, so nothing to reply to.
 *
 * This is the entry point `TelegramChannel.send` uses (a scheduled report, the
 * initiative, a study note). It is the *same* code a live turn goes through, which
 * is the point: the two paths used to be separate implementations, and the one
 * behind this name was the poor relation — only the last attachment, no markdown,
 * no chunking, a blind 1024-character cut, no approval buttons.
 */
export async function deliverTo(d: Delivery, response: OutgoingMessage, audio?: AudioOptions): Promise<void> {
  await deliverBody(d, response, audio);
  // A parked action goes out as two buttons — one tap instead of typing `/yes`.
  // The commands still work for anyone who prefers them.
  if (response.confirm) await sendConfirm(d, response.confirm);
}

/** Deliver an OutgoingMessage through the appropriate Telegram media type. */
async function deliverBody(d: Delivery, response: OutgoingMessage, audio?: AudioOptions): Promise<void> {
  const mode = response.mode ?? "text";

  // Everything the turn made, in order. A turn can make two — two voice notes
  // when she is asked for two, or a voice and a picture together — and one slot
  // used to keep only the last of them, dropping the rest without a word.
  const items = turnMedia(response);
  if (items.length > 0) {
    // Her words ride the last piece: she writes the reply after the tools, so
    // the scene lands with the voice it belongs to and not before it.
    let sent = 0;
    let wordsOut = false;
    for (let i = 0; i < items.length; i++) {
      const isLast = i === items.length - 1;
      const ok = await sendMedia(d, items[i], isLast ? response.text : "");
      if (ok) {
        sent += 1;
        if (isLast) wordsOut = true;
      }
    }
    if (sent === items.length) return;
    if (sent > 0) {
      // Half delivered. Her words rode the last piece, so if *that* one is what
      // failed they never arrived at all: naming the loss without repeating her
      // answer left the owner with a note about a missing picture and no answer.
      const missing = items.length - sent;
      await sendText(d, missing === 1 ? "(одно вложение не доехало)" : `(${missing} вложения не доехали)`).catch(() => {});
      if (!wordsOut && response.text?.trim()) await sendText(d, response.text).catch(() => {});
      return;
    }
    // Nothing went out — fall through and at least say it as text.
  }

  if (mode === "voice") {
    const sent = audio
      ? await sendVoiceResponse(mediaCtx(d), response.text, audio.voiceConfig, audio.falApiKey)
      : false;
    if (!sent) await sendText(d, response.text);
    return;
  }

  if (mode === "video") {
    const sent = audio
      ? await sendVideoNote(mediaCtx(d), response.text, audio.voiceConfig, audio.falApiKey ?? "", audio.avatarPath ?? "")
      : false;
    if (!sent) await sendText(d, response.text);
    return;
  }

  await sendText(d, response.text);
}

/** The `reply*` methods the voice and video senders ask for, pointed at this delivery. */
function mediaCtx(d: Delivery) {
  return {
    replyWithVoice: (file: unknown) => d.api.sendVoice(d.chatId, file as never, sendOpts(d)),
    replyWithVideo: (file: unknown) => d.api.sendVideo(d.chatId, file as never, sendOpts(d)),
    replyWithVideoNote: (file: unknown) => d.api.sendVideoNote(d.chatId, file as never, sendOpts(d)),
  };
}

/**
 * The approval prompt as two buttons.
 *
 * The owner asked for this instead of typing `/yes`: the decision is one tap,
 * and the command is invisible. `/yes` and `/no` stay as they were — a button
 * that fails to arrive must not leave the owner with no way to answer.
 */
async function sendConfirm(d: Delivery, confirm: { summary: string; reason?: string }): Promise<void> {
  const text =
    `❔ Подтверди: ${confirm.summary}` +
    (confirm.reason ? `\nПричина: ${confirm.reason}` : "");
  await d.api
    .sendMessage(
      d.chatId,
      text,
      sendOpts(d, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Принять", callback_data: "pending:yes" },
              { text: "❌ Отклонить", callback_data: "pending:no" },
            ],
          ],
        },
      }),
    )
    .catch(() => {});
  console.log(`🔘 Кнопки подтверждения отправлены: ${confirm.summary.slice(0, 100)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the text body after a slash-command prefix. */
function commandBody(ctx: Context, command: string): string {
  const raw = ctx.message?.text ?? "";
  return raw.replace(new RegExp(`^/${command}\\s*`), "");
}

/** Download a Telegram photo (largest size) as base64. */
async function downloadPhotoBase64(ctx: Context, photo: { file_id: string }[], botToken: string): Promise<string | null> {
  try {
    const fileId = photo[photo.length - 1].file_id;
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(fileUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

/** Download a Telegram file (voice note, audio) as bytes. */
async function downloadFile(ctx: Context, fileId: string, botToken: string): Promise<Buffer | null> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Convert a grammY Context into a channel-neutral IncomingMessage. */
async function toIncoming(
  ctx: Context,
  text: string,
  botToken: string,
  /**
   * He sent a voice note rather than typing.
   *
   * Carried into the turn because it is the one request for a spoken answer that
   * cannot be read off any words — a transcript says what he said, not that he
   * said it with his voice. The voice budget exempts these (see voice-budget.ts):
   * asked for is asked for, whichever way he asked.
   */
  voiceNote = false,
): Promise<IncomingMessage> {
  const reply = ctx.message?.reply_to_message;
  const replyToText = reply?.text ?? reply?.caption;

  // Collect images: from the message itself and from the replied-to message
  const images: string[] = [];
  const msgPhoto = ctx.message?.photo;
  if (msgPhoto?.length) {
    const b64 = await downloadPhotoBase64(ctx, msgPhoto, botToken);
    if (b64) images.push(b64);
  }
  const replyPhoto = reply?.photo;
  if (replyPhoto?.length) {
    const b64 = await downloadPhotoBase64(ctx, replyPhoto, botToken);
    if (b64) images.push(b64);
  }

  return {
    channelName: "telegram",
    userId: String(ctx.chat?.id ?? ctx.from?.id ?? "unknown"),
    text,
    timestamp: Date.now(),
    metadata: {
      messageId: ctx.message?.message_id,
      fromUsername: ctx.from?.username,
      firstName: ctx.from?.first_name,
      ...(replyToText && { replyToText }),
      ...(voiceNote && { voiceNote: true }),
    },
    ...(images.length && { images }),
  };
}

/** Human-readable tool names for status messages. */
const TOOL_LABELS: Record<string, string> = {
  shell: "выполняю команду",
  files: "работаю с файлами",
  http: "делаю HTTP-запрос",
  browser: "открываю браузер",
  memory: "ищу в памяти",
  npm_install: "устанавливаю пакет",
  self_config: "меняю настройки",
  scheduler: "настраиваю расписание",
  ssh: "подключаюсь по SSH",
};

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Callback to record a reference photo that was just saved.
 *
 * `who` is not decoration: her face and the owner's are separate files, and a
 * callback that could not tell them apart would quietly turn his photo into
 * hers the moment he sent one.
 */
export type SetReferencePhotoFn = (url: string, who: ReferenceKind) => void;

/** Callback when first user claims ownership. */
export type OnOwnerClaimedFn = (chatId: number) => void;

/**
 * Download a photo out of a Telegram message and store it as her face.
 *
 * `/setphoto` exists in two forms — a command, and a caption on a photo sent as
 * a message — and they were two copies of the same twenty lines. The copy that
 * survived edits and the copy that did not were, of course, different, and the
 * difference was found by reading rather than by a failure. Returns where the
 * photo went, or null if Telegram would not give it up.
 */
async function savePhotoFromTelegram(
  ctx: Context,
  token: string,
  who: ReferenceKind = "self",
  photo?: { file_id: string }[],
): Promise<string | null> {
  // The photo is a parameter because `/setphoto` accepts one sent as a *reply*,
  // and reading it from `ctx.message` alone meant the documented form — reply to
  // the command with the picture — was answered with "не удалось обработать фото"
  // while `/setphoto`'s own prompt said to do exactly that.
  const files = photo ?? ctx.message?.photo;
  if (!files?.length) return null;
  try {
    const file = await ctx.api.getFile(files[files.length - 1].file_id);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    // The write belongs to reference-photo.ts: the destination, the empty check
    // and the rollback of the previous photo all live there. Writing the file
    // from here is what left `/setphoto` with no way back from a bad photo.
    const bytes = Buffer.from(await res.arrayBuffer());
    return who === "owner" ? writeOwnerReferencePhoto(bytes) : writeReferencePhoto(bytes);
  } catch {
    return null;
  }
}

/** Send the reference photo that is actually installed, with its age. */
async function sendCurrentReference(ctx: Context, who: ReferenceKind = "self"): Promise<void> {
  const file = who === "owner" ? ownerReferencePhotoPath() : referencePhotoPath();
  const whose = who === "owner" ? "Твоё фото" : "Её фото";
  let size = 0;
  let when = "неизвестно";
  try {
    const st = fs.statSync(file);
    size = st.size;
    when = st.mtime.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    await ctx.reply(`${whose} не задано. Скинь его с подписью ${who === "owner" ? "/setphoto me" : "/setphoto"}.`);
    return;
  }
  const { InputFile } = await import("grammy");
  await ctx.replyWithPhoto(new InputFile(fs.readFileSync(file), who === "owner" ? "owner.jpg" : "reference.jpg"), {
    caption: `Текущее фото (${whose.toLowerCase()}): ${Math.round(size / 1024)} КБ, заменено ${when} UTC`,
  });
}

export function registerHandlers(
  bot: Bot,
  handler: MessageHandler,
  ownerChatId: number | null,
  onSetReferencePhoto?: SetReferencePhotoFn,
  onOwnerClaimed?: OnOwnerClaimedFn,
  audio?: AudioOptions,
  streaming = true,
): void {
  // --- Owner-only filter ---
  // Mutable so the first user can claim ownership at runtime.
  let currentOwner = ownerChatId;

  // The personality constructor, mid-flight. Local to this process and to the
  // owner: one bot, one owner, one half-built person at a time.
  let quest: Quest | null = null;

  /**
   * Set a face — hers or his — from a command or a photo caption.
   *
   * One handler for both, because two copies of this drifted apart once already
   * (that is why `savePhotoFromTelegram` exists). Called with no photo it shows
   * what is installed instead, which is what the owner meant when he ran the
   * command with nothing attached.
   */
  const setReference = async (ctx: Context, who: ReferenceKind): Promise<void> => {
    const photo = ctx.message?.reply_to_message?.photo ?? ctx.message?.photo;
    if (!photo?.length) {
      await ctx.reply("Фото не прикреплено, поэтому ничего не изменилось. Вот что сейчас стоит:");
      await sendCurrentReference(ctx, who);
      return;
    }
    const saved = await savePhotoFromTelegram(ctx, bot.token, who, photo);
    if (saved) {
      onSetReferencePhoto?.(saved, who);
      await ctx.reply(
        who === "owner"
          ? "✅ Твоё фото сохранено — теперь я смогу снять нас вдвоём."
          : "✅ Фото сохранено — теперь это её лицо.",
      );
    } else {
      await ctx.reply("Не удалось обработать фото");
    }
  };

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    // First user claims ownership when no owner is configured.
    if (currentOwner === null) {
      currentOwner = chatId;
      onOwnerClaimed?.(chatId);
      console.log(`🔒 Владелец бота установлен: ${chatId}`);
    }

    if (chatId !== currentOwner) {
      await ctx.reply("Этот бот приватный.");
      return;
    }
    await next();
  });

  // -----------------------------------------------------------------------
  // Native Telegram sendMessageDraft streaming (Bot API Dec 2025)
  // -----------------------------------------------------------------------

  /** Unique draft ID counter — each streaming response gets its own. */
  let nextDraftId = 0;

  /** Call the native sendMessageDraft Bot API method. */
  async function sendDraft(apiObj: Bot["api"], chatId: number, draftId: number, text: string): Promise<void> {
    const raw = apiObj as Bot["api"] & {
      sendMessageDraft?: (chatId: number, draftId: number, text: string, params?: { parse_mode?: string }) => Promise<unknown>;
    };
    if (typeof raw.sendMessageDraft === "function") {
      await raw.sendMessageDraft(chatId, draftId, text);
      return;
    }
    // Fallback: call raw API via grammy's raw method
    await (apiObj as unknown as { raw: { sendMessageDraft: (body: Record<string, unknown>) => Promise<unknown> } })
      .raw.sendMessageDraft({ chat_id: chatId, draft_id: draftId, text });
  }

  /**
   * One turn of the constructor: either the next question, or the write.
   *
   * The write happens here rather than after the last answer so that a failed
   * config save is reported to the one person who can fix it, instead of
   * swallowed into a log nobody reads. The quest is dropped either way — a
   * constructor that cannot save is not worth resuming.
   */
  async function finishOrContinue(ctx: Context, turn: Turn): Promise<void> {
    if (!turn.finished) {
      quest = turn.next;
      await ctx.reply(turn.reply);
      return;
    }
    const answers = turn.answers;
    quest = null;
    let saved: boolean;
    try {
      patchConfig((config) => applyAnswers(answers, config));
      saved = true;
    } catch (err) {
      saved = false;
      console.error(`Persona not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!saved) {
      await ctx.reply("Собрала, но записать не смогла — конфиг не пишется. Смотри `eva doctor`.");
      return;
    }
    // The engine reads her identity from disk per request, so the change is live
    // from this message on — no restart, which is the whole point of building
    // her here rather than in the config.
    await ctx.reply(`Готово: ${summaryAnswers(answers)}.\n\nДальше я такая. Меняется в любой момент — скажи «запомни, ты…» или /persona заново.`);
  }

  /** Handle message with native draft streaming and tool progress. */
  async function handleWithTyping(
    ctx: Context,
    text: string,
    modeOverride?: OutgoingMessage["mode"],
    /** He spoke rather than typed — see toIncoming. */
    voiceNote = false,
  ): Promise<void> {
    const stopTyping = startTyping(ctx);
    const chatId = ctx.chat!.id;

    // Streaming state
    let streamText = "";
    let draftId = 0;
    let lastDraftTime = 0;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let draftSupported = streaming;
    let statusMsgId: number | null = null;

    /** Flush current accumulated text to draft. */
    const flushDraft = async () => {
      if (!streamText || !draftId || !draftSupported) return;
      try {
        await sendDraft(ctx.api, chatId, draftId, streamText + " ▌");
        lastDraftTime = Date.now();
      } catch {
        // sendMessageDraft not supported — stop trying
        draftSupported = false;
      }
    };

    const onProgress: ProgressCallback = (event) => {
      if (event.type === "text_chunk") {
        streamText += event.chunk;

        // Allocate draft ID on first chunk
        if (!draftId) {
          nextDraftId = nextDraftId >= 2_147_483_647 ? 1 : nextDraftId + 1;
          draftId = nextDraftId;

          // Delete status message if exists
          if (statusMsgId) {
            ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
            statusMsgId = null;
          }
        }

        // Throttle drafts to ~every 500ms
        if (Date.now() - lastDraftTime > 500) {
          flushDraft();
        } else if (!draftTimer) {
          draftTimer = setTimeout(() => {
            draftTimer = null;
            flushDraft();
          }, 500);
        }
        return;
      }

      if (event.type === "tool_start") {
        const label = TOOL_LABELS[event.tool];
        if (!label) return; // skip status for unlisted tools (e.g. selfie)
        const statusText = `⏳ ${label}...`;
        if (statusMsgId) {
          ctx.api.editMessageText(chatId, statusMsgId, statusText).catch(() => {});
        } else {
          ctx.reply(statusText).then((msg) => { statusMsgId = msg.message_id; }).catch(() => {});
        }
        return;
      }

      if (event.type === "turn_complete" && event.turn > 1 && statusMsgId) {
        ctx.api.editMessageText(chatId, statusMsgId, `🔄 Думаю... (шаг ${event.turn})`).catch(() => {});
      }
    };

    try {
      const response = await handler(await toIncoming(ctx, text, bot.token, voiceNote), onProgress);
      stopTyping();
      if (draftTimer) clearTimeout(draftTimer);

      // Clean up status message
      if (statusMsgId) {
        ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
      }

      // Clear the draft — but not when the answer rides a caption: with media the
      // text goes out attached to it, and the draft would paint it twice (once as a
      // preview, once as the caption). Only `mediaUrl` was checked, while a voice
      // note or a file arrive as `mediaPath` (or in the `media` list) and carry the
      // caption just the same.
      const carriesText = Boolean(response.mediaUrl || response.mediaPath || response.media?.length);
      if (draftId && draftSupported && !carriesText) {
        try {
          await sendDraft(ctx.api, chatId, draftId, response.text);
          await sleep(300);
        } catch { /* ignore */ }
      }

      // Send the final message
      await deliver(ctx, modeOverride ? { ...response, mode: modeOverride } : response, audio);
    } catch (err) {
      stopTyping();
      if (draftTimer) clearTimeout(draftTimer);
      if (statusMsgId) {
        ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
      }
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Ошибка: ${msg}`);
    }
  }

  // /start
  bot.command("start", (ctx) => handleWithTyping(ctx, "/start"));
  // /status
  bot.command("status", (ctx) => handleWithTyping(ctx, "/status"));
  // /help
  bot.command("help", (ctx) => handleWithTyping(ctx, "/help"));

  // /voice <text>
  bot.command("voice", async (ctx) => {
    const body = commandBody(ctx, "voice");
    if (!body) { await ctx.reply("Usage: /voice <text to speak>"); return; }
    await handleWithTyping(ctx, body, "voice");
  });

  // /video <text>
  bot.command("video", async (ctx) => {
    const body = commandBody(ctx, "video");
    if (!body) { await ctx.reply("Usage: /video <text for lip-sync>"); return; }
    await handleWithTyping(ctx, body, "video");
  });

  // /selfie <prompt>
  bot.command("selfie", async (ctx) => {
    const body = commandBody(ctx, "selfie");
    if (!body) { await ctx.reply("Usage: /selfie <description>"); return; }
    await handleWithTyping(ctx, `Сделай селфи: ${body}`);
  });

  // /photo — show the reference that is actually installed.
  //
  // Because for a while nobody could tell: the owner changed his mind about a
  // photo, and the only way to find out which one was in use was for me to read
  // the file and compare hashes. "Is it the new one?" was unanswerable from the
  // phone, which is the only place he is. A question about state has to be
  // answerable where it is asked.
  bot.command("photo", async (ctx) => {
    // `/photo` is her face; `/photo me` is the owner's — the one used only for a
    // frame with both of them in it.
    const who: ReferenceKind = (ctx.match ?? "").trim().toLowerCase() === "me" ? "owner" : "self";
    await sendCurrentReference(ctx, who);
  });

  // /setphoto — set reference photo for selfie generation (saved locally)
  bot.command("setphoto", async (ctx) => {
    // `/setphoto me` stores the owner's face, which is used for one thing only:
    // a frame with both of them in it. Bare `/setphoto` is her face, as before.
    const who: ReferenceKind = (ctx.match ?? "").trim().toLowerCase() === "me" ? "owner" : "self";
    await setReference(ctx, who);
  });

  // `/myphoto` — the owner's face, by the same rules, as a command with no
  // argument on purpose. Telegram's command menu cannot carry one, so
  // `/setphoto me` works but is invisible there, and "нет команды" is exactly
  // how a working instruction reads from a phone. This one appears in the menu.
  bot.command("myphoto", async (ctx) => {
    await setReference(ctx, "owner");
  });

  // /profile — the dossier she keeps about the owner, holes included.
  //
  // Exists because a memory only one of them can read cannot be checked: the
  // owner's description was "она должна составить анкету, автобиографию обо
  // мне", and the point of a questionnaire is that its subject can read it and
  // see what is missing. The empty sections are the to-do list — "работа — пока
  // не знаю" is the honest state of the base, and hiding it would make a
  // half-empty dossier look complete.
  bot.command("profile", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    try {
      const rows = profileKnowledge(200);
      const rules = knowledgeOfKind("rules", 200);
      const lessons = knowledgeOfKind("lesson", 200);
      const parts = [
        renderProfileDossier(rows, {
          offsetHours: loadConfig()?.agent?.timezone_offset_hours ?? 4,
          includeHoles: true,
        }),
      ];
      if (rules.length) parts.push(`## Как с ним работать\n\n${renderFlatBlock(rules)}`);
      if (lessons.length) parts.push(`## Чему он меня научил\n\n${renderFlatBlock(lessons)}`);
      const text = parts.join("\n\n");
      const where = writeProfileDoc(
        `# Что я о нём знаю\n\n${text}\n\n_(обновлено ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`,
      );
      console.log(`📋 Анкета: ${rows.length} записей, правил ${rules.length}, уроков ${lessons.length} → ${where}`);
      await ctx.reply(`Что я о нём знаю:\n\n${text}`);
    } catch (err) {
      console.error("⚠️ анкета не собралась:", err instanceof Error ? err.message : err);
      await ctx.reply("Не получилось собрать анкету — посмотри журнал.");
    }
  });

  // /study
  bot.command("study", (ctx) => handleWithTyping(ctx, "/study"));
  // /settings
  bot.command("settings", (ctx) => handleWithTyping(ctx, "/settings"));

  // /yes and /no — the other end of a self_config proposal.
  //
  // The model parks identity changes instead of applying them (see
  // core/pending.ts). These are the only ways to settle one, which is the
  // point: the decision comes from the owner, in a channel of their own
  // choosing, not from the same conversation that wanted the change.
  /**
   * Run an approved action, then let her read what came back.
   *
   * Approving used to just execute the command and answer "Готово: <что>" — the
   * output went nowhere and she never saw it, so a confirmation asked for a
   * *check* ended in a receipt: the owner approved expecting her to go and look,
   * and nothing looked back. Now the result is handed to her, and she says what
   * it means.
   */
  const confirmAndReport = async (ctx: Context, chatId: number): Promise<void> => {
    const result = await applyPending(String(chatId));
    console.log(`🔘 ✅ подтверждение: ${result.ok ? "выполнено" : "не вышло"} — ${result.message.slice(0, 140)}`);
    await ctx.reply(result.message);
    if (!result.ok) return;
    // Even an empty output deserves an answer: "git diff" with nothing to show is
    // a result, and silence after a tap is what "the confirmation broke" looks
    // like from the outside.
    const body = result.output?.trim() ? result.output.slice(0, 3000) : "(вывод пустой)";

    // The owner's name is not written here: the repo is a base, not an install, and
    // his name already reaches her through the prompt ("Его зовут: …"). The sentence
    // is about him, so it says "he" the way the rest of the prompt's prose does.
    const prompt =
      `[Подтверждено] Он подтвердил отложенное действие, и оно выполнено. Его вывод:\n\n` +
      `${body}\n\n` +
      `Коротко скажи ему, что из этого следует — что нашла, всё ли в порядке. Не пересказывай команду.`;
    try {
      const reply = await handler(await toIncoming(ctx, prompt, bot.token));
      await deliver(ctx, reply, audio);
    } catch (err) {
      console.error("Продолжение после подтверждения не удалось:", err instanceof Error ? err.message : err);
    }
  };

  bot.command("yes", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    await confirmAndReport(ctx, chatId);
  });
  bot.command("no", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const dropped = discard(String(chatId));
    await ctx.reply(
      dropped
        ? `Отклонила: ${describe(dropped)}.`
        : "Нечего отклонять — я ничего не предлагала.",
    );
  });
  // /pending — what a /yes would do, without doing it.
  bot.command("pending", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const waiting = peek(String(chatId));
    await ctx.reply(
      waiting
        ? `Жду подтверждения: ${describe(waiting)}\n${waiting.reason ? `Причина: ${waiting.reason}` : "Причина не указана."}\n/yes — принять, /no — отклонить.`
        : "Ничего не ждёт подтверждения.",
    );
  });

  // The two buttons under an approval prompt. Same decision as /yes and /no, one
  // tap; both commands still work, so a lost button never traps the owner.
  bot.on("callback_query:data", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    await ctx.answerCallbackQuery().catch(() => {});
    if (currentOwner && chatId !== currentOwner) return;

    const data = ctx.callbackQuery.data;
    if (data !== "pending:yes" && data !== "pending:no") return;

    const accepted = data === "pending:yes";
    const waiting = peek(String(chatId));
    // Take the keyboard away, and rewrite the prompt into the verdict. A tap that
    // leaves no visible mark is a tap the owner cannot tell from a dead button —
    // which is exactly what he asked about.
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ctx
      .editMessageText(`${accepted ? "✅ Принято" : "❌ Отклонено"}: ${waiting?.summary ?? "—"}`)
      .catch(() => {});

    if (accepted) {
      await confirmAndReport(ctx, chatId);
    } else {
      const dropped = discard(String(chatId));
      console.log(`🔘 Кнопка ❌: отклонено — ${dropped?.summary ?? "нечего"}`);
      await ctx.reply(
        dropped ? `Отклонила: ${describe(dropped)}.` : "Нечего отклонять — я ничего не предлагала.",
      );
    }
  });

  // /persona — the personality constructor. Four questions, asked here in the
  // chat rather than in `init`, because this is where the owner and the photo
  // are. `/cancel` throws the half-built quest away, and an abandoned one
  // expires, so a forgotten constructor never eats a real message later.
  bot.command("persona", async (ctx) => {
    if (quest) {
      await ctx.reply(`Мы уже собираем её. Сейчас спрашиваю:\n\n${questionFor(quest.step)}\n\n/cancel — забить.`);
      return;
    }
    const config = loadConfig();
    quest = startQuest();
    await ctx.reply(
      "Соберём её заново. Четыре вопроса, каждый можно пропустить — тогда она останется частично собой.\n\n" +
        describeExisting(config) +
        questionFor(quest.step) +
        "\n\n/cancel — забить.",
    );
  });

  bot.command("cancel", async (ctx) => {
    if (!quest) {
      await ctx.reply("Нечего отменять.");
      return;
    }
    quest = null;
    await ctx.reply("Ладно, забросили. Начать заново: /persona");
  });

  // Photos: /setphoto saves reference, everything else is sent to the LLM
  bot.on("message:photo", async (ctx) => {
    const caption = ctx.message.caption?.trim();

    // A caption that sets a face. Hers: `/setphoto` or `/photo`. His:
    // `/setphoto me`, `/photo me` or `/myphoto` — `/setphoto me` is invisible in
    // the command menu, so the plain `/myphoto` is what a phone will show.
    const ownerCaptions = ["/setphoto me", "/photo me", "/myphoto"];
    const selfCaptions = ["/setphoto", "/photo"];
    if (caption && (ownerCaptions.includes(caption) || selfCaptions.includes(caption))) {
      const who: ReferenceKind = ownerCaptions.includes(caption) ? "owner" : "self";
      const saved = await savePhotoFromTelegram(ctx, bot.token, who);
      if (saved) {
        onSetReferencePhoto?.(saved, who);
        await ctx.reply(
          who === "owner"
            ? "✅ Твоё фото сохранено — теперь я смогу снять нас вдвоём."
            : "✅ Фото сохранено — теперь это её лицо.",
        );
      } else {
        await ctx.reply("Не удалось обработать фото");
      }
      return;
    }

    // A photo without the caption is a photo in the conversation, not a new face.
    // Say so in the log: the owner sent two "new" references this way, believed
    // both had been applied, and the file on disk never changed. Nothing looked
    // broken — which is exactly why it went unnoticed twice.
    console.log("📷 Фото в чат (референс не менялся — для этого /setphoto на фото)");

    // A photo while the constructor is asking for something else is a wrong
    // answer, not a new topic: say which question is open and keep the quest
    // where it is, so it cannot be quietly thrown away by a misfire.
    if (quest && questExpired(quest)) {
      quest = null;
      await ctx.reply("Забыла, что собиралась. Начать заново: /persona");
      return;
    }
    if (quest) {
      if (quest.step !== "photo") {
        // The photo is refused *before* anything is written. The file on disk used
        // to be replaced first and only then did `answerPhoto` answer "сейчас я
        // спрашиваю не про фото" — so a picture sent while she was asking about his
        // character quietly became her face, and the question stayed where it was.
        // The wording is the state machine's, not a copy of it.
        await ctx.reply(answerQuestPhoto(quest).reply);
        return;
      }
      const saved = await savePhotoFromTelegram(ctx, bot.token, "self");
      if (!saved) {
        await ctx.reply("Не получилось забрать фото — Telegram не отдал его. Попробуй ещё раз.");
        return;
      }
      onSetReferencePhoto?.(saved, "self");
      const turn = answerQuestPhoto(quest);
      await finishOrContinue(ctx, turn);
      return;
    }

    // Regular photo — send to LLM with caption as text
    await handleWithTyping(ctx, caption || "Что на этом фото?");
  });

  // Plain text messages (including unregistered /commands — let LLM handle them)
  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text;

    // A live constructor owns the next message. This is the one place where a
    // sentence can be eaten by the wrong listener, which is why an abandoned
    // constructor expires instead of lingering: an hour-old quest that swallows
    // "привет" is worse than a lost question.
    if (quest) {
      if (questExpired(quest)) {
        quest = null;
        await ctx.reply("Забыла, что собиралась. Начать заново: /persona");
        return;
      }
      await finishOrContinue(ctx, answerQuestText(quest, userText));
      return;
    }

    await handleWithTyping(ctx, userText);
  });

  // Voice notes from the owner: transcribe, then treat as an ordinary message.
  //
  // There was no handler here at all, so a voice note arrived and went nowhere —
  // no transcription, no answer, not even a "did not catch that". The owner had
  // no way to tell a deaf bot from a busy one, and the only clue was the silence.
  bot.on("message:voice", async (ctx) => {
    const stopTyping = startTyping(ctx);
    const ogg = await downloadFile(ctx, ctx.message.voice.file_id, bot.token);
    if (!ogg) {
      stopTyping();
      await ctx.reply("Не смогла скачать голосовое — попробуй ещё раз или напиши текстом.");
      return;
    }

    const transcript = await transcribeVoice(ogg, audio?.voiceConfig);
    stopTyping();

    if (!transcript) {
      await ctx.reply("Не разобрала голосовое — напиши текстом или переговори, я послушаю.");
      return;
    }

    // A voice note is an answer like any other. The constructor has a branch in the
    // text and photo handlers but had none here, so a voice note during `/persona`
    // went into the chat as an ordinary turn while the open question kept eating the
    // *next* text message: the question and its answer landed in different rooms.
    if (quest) {
      if (questExpired(quest)) {
        quest = null;
        await ctx.reply("Забыла, что собиралась. Начать заново: /persona");
        return;
      }
      await finishOrContinue(ctx, answerQuestText(quest, transcript));
      return;
    }

    await handleWithTyping(ctx, transcript, undefined, true);
  });

  // Everything else he can send: a document, a video, a round video note, an audio
  // file, a sticker. There was no listener for any of them and the bot answered
  // with silence — the same defect that got `message:voice` its own handler, and the
  // worst shape of it: he sent something and *nothing* happened, which reads as a
  // bot that is down or ignoring him.
  bot.on(
    ["message:document", "message:video", "message:video_note", "message:audio", "message:sticker"],
    async (ctx) => {
      const kind = ctx.message.document
        ? "документ"
        : ctx.message.video
          ? "видео"
          : ctx.message.video_note
            ? "видео-кружок"
            : ctx.message.audio
              ? "аудио"
              : "стикер";
      console.log(`📎 Пришло вложение (${kind}) — читать такое я не умею.`);
      await ctx.reply(`Вижу ${kind}, но открыть его не могу — пришли текстом или картинкой.`);
    },
  );
}

