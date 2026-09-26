import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { Channel, MessageHandler } from "../types.js";
import type { OutgoingMessage } from "../../core/types.js";
import { registerHandlers, type SetReferencePhotoFn, type OnOwnerClaimedFn, type AudioOptions } from "./handlers.js";

/**
 * Telegram channel adapter.
 *
 * Wraps a grammY Bot and exposes the unified Channel interface
 * so the core agent can drive it without knowing Telegram specifics.
 */
export class TelegramChannel implements Channel {
  name = "telegram";
  requiredConfig = ["token"];

  private bot: Bot | null = null;
  private handler: MessageHandler | null = null;
  private ownerChatId: number | null = null;
  private _onSetReferencePhoto: SetReferencePhotoFn | undefined;
  private _onOwnerClaimed: OnOwnerClaimedFn | undefined;

  /** Audio delivery options (voice config/keys), set by the host before start(). */
  voiceOptions?: AudioOptions;

  /** Native draft streaming (sendMessageDraft). Set false to avoid the vanishing preview message. */
  streaming?: boolean;

  /** Set callback for /setphoto command. */
  set onSetReferencePhoto(fn: SetReferencePhotoFn) { this._onSetReferencePhoto = fn; }

  /** Set callback for first-user ownership claim. */
  set onOwnerClaimed(fn: OnOwnerClaimedFn) { this._onOwnerClaimed = fn; }

  async start(config: Record<string, string>): Promise<void> {
    this.bot = new Bot(config.token);
    this.bot.api.config.use(autoRetry());
    this.ownerChatId = config.owner_chat_id ? parseInt(config.owner_chat_id, 10) : null;

    if (!this.handler) {
      throw new Error("TelegramChannel: call onMessage() before start()");
    }

    // The bot's own Telegram avatar used to be fetched here "for the selfie
    // reference" and then read by nobody: a dead field, and a wrong idea besides
    // — a bot account's profile picture is not a woman's face. The reference is
    // the owner's photo in `~/.eva/reference.jpg`, and the selfie tool reads
    // that file. Three API calls at every start, in exchange for nothing.

    registerHandlers(this.bot, this.handler, this.ownerChatId, this._onSetReferencePhoto, this._onOwnerClaimed, this.voiceOptions, this.streaming ?? true);
    await this.publishCommands();
    this.bot.start();
  }

  /**
   * Tell Telegram which commands exist, so the client's menu lists them.
   *
   * Handlers are not a menu. A phone shows a slash list that the server fills in
   * through `setMyCommands`, and nothing here had ever called it — so `/photo`
   * and `/setphoto` worked, and the owner had no way to learn they existed. That
   * is the worst shape of a working feature: invisible. It is also how two
   * replacement references went unused, since a command he cannot see is a
   * command he does not send.
   *
   * Best-effort: a bot that refuses to start because it could not publish a menu
   * is worse than one with a stale menu.
   */
  private async publishCommands(): Promise<void> {
    const commands = [
      { command: "help", description: "Что она умеет" },
      { command: "status", description: "Состояние: модель, память, задачи" },
      { command: "photo", description: "Показать фото, которое сейчас её лицо" },
      { command: "setphoto", description: "Сменить фото: скинь его с этой подписью" },
      { command: "selfie", description: "Селфи (или спроси её словами)" },
      { command: "persona", description: "Собрать её личность заново" },
      { command: "voice", description: "Голосовое сообщение" },
      { command: "settings", description: "Настройки" },
      { command: "pending", description: "Что awaits подтверждения" },
      { command: "yes", description: "Подтвердить последнее" },
      { command: "no", description: "Отклонить последнее" },
      { command: "cancel", description: "Отменить текущий вопрос" },
      { command: "study", description: "Режим «study»: отвечает подробнее" },
    ];
    try {
      await this.bot?.api.setMyCommands(commands);
    } catch (err) {
      console.error(
        `⚠️ Не удалось опубликовать список команд: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
  }

  async send(userId: string, message: OutgoingMessage): Promise<void> {
    await this.bot?.api.sendMessage(parseInt(userId, 10), message.text);
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
