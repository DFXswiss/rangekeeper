import { promises as fs } from 'fs';
import TelegramBot from 'node-telegram-bot-api';
import { Notifier } from './notifier';
import { getLogger } from '../util/logger';

interface TelegramGroupState {
  apiVersion: string;
  createdAt: number;
  updatedAt: number;
  groups: string[];
}

const COMMAND_HANDLES = ['/start', '/subscribe', '/unsubscribe', '/help'];

export class TelegramNotifier implements Notifier {
  private readonly logger = getLogger();
  private readonly bot: TelegramBot;
  private groupState: TelegramGroupState = { apiVersion: '1.0.0', createdAt: 0, updatedAt: 0, groups: [] };
  private loaded = false;

  constructor(
    private readonly botToken: string,
    private readonly groupsJsonPath: string,
  ) {
    this.validate();
    this.bot = new TelegramBot(this.botToken, { polling: true });
    this.applyListener();
    void this.loadGroupState();
  }

  private validate(): void {
    if (!this.botToken || !/^\d+:[A-Za-z0-9_-]{35,}$/.test(this.botToken)) {
      throw new Error(`Invalid Telegram botToken format: expected "<number>:<alphanumeric>"`);
    }
    if (!this.groupsJsonPath) {
      throw new Error(`TELEGRAM_GROUPS_JSON path is required`);
    }
  }

  /**
   * Deliver to every subscribed chat. Per-chat send failures (user blocked the bot,
   * chat deleted, transient API error) are logged and skipped so a single bad chat
   * does not suppress the entire alert. Resolves regardless of HTTP outcome to keep
   * the previous fire-and-log behaviour.
   */
  async notify(message: string): Promise<void> {
    if (!this.loaded) await this.loadGroupState();
    if (this.groupState.groups.length === 0) return;

    const text = `🤖 RangeKeeper\n\n${message}`;
    for (const chatId of this.groupState.groups) {
      try {
        await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        this.logger.warn({ chatId, err }, 'Telegram delivery failed');
      }
    }
  }

  // --- Subscriber management ---------------------------------------------------------

  private applyListener(): void {
    this.bot.on('message', async (msg) => {
      const text = msg.text;
      if (!text || !COMMAND_HANDLES.includes(text)) return;
      const chatId = msg.chat.id.toString();
      try {
        switch (text) {
          case '/start':
          case '/subscribe':
            await this.handleSubscribe(chatId);
            break;
          case '/unsubscribe':
            await this.handleUnsubscribe(chatId);
            break;
          case '/help':
            await this.handleHelp(chatId);
            break;
        }
      } catch (err) {
        this.logger.warn({ chatId, command: text, err }, 'Command handler failed');
      }
    });
    this.bot.on('polling_error', (err) => {
      this.logger.warn({ err }, 'Polling error');
    });
  }

  private async handleSubscribe(chatId: string): Promise<void> {
    if (!this.loaded) await this.loadGroupState();
    if (this.groupState.groups.includes(chatId)) {
      await this.bot.sendMessage(chatId, 'You are already subscribed.');
      return;
    }
    this.groupState.groups.push(chatId);
    await this.writeGroupState();
    await this.bot.sendMessage(chatId, 'You are now subscribed. Use /unsubscribe to stop.');
    this.logger.info({ chatId, total: this.groupState.groups.length }, 'Subscribed');
  }

  private async handleUnsubscribe(chatId: string): Promise<void> {
    if (!this.loaded) await this.loadGroupState();
    if (!this.groupState.groups.includes(chatId)) {
      await this.bot.sendMessage(chatId, 'You are not subscribed.');
      return;
    }
    this.groupState.groups = this.groupState.groups.filter((g) => g !== chatId);
    await this.writeGroupState();
    await this.bot.sendMessage(chatId, 'You are not subscribed anymore.');
    this.logger.info({ chatId, total: this.groupState.groups.length }, 'Unsubscribed');
  }

  private async handleHelp(chatId: string): Promise<void> {
    const lines = [
      '*Available commands:*',
      '/start or /subscribe — receive RangeKeeper alerts in this chat',
      '/unsubscribe — stop receiving alerts',
      '/help — show this message',
    ];
    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  private async loadGroupState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.groupsJsonPath, 'utf-8');
      const parsed: TelegramGroupState = JSON.parse(raw);
      this.groupState = {
        apiVersion: parsed.apiVersion ?? '1.0.0',
        createdAt: parsed.createdAt ?? 0,
        updatedAt: parsed.updatedAt ?? 0,
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn({ path: this.groupsJsonPath, err }, 'Could not read groups file');
      }
      this.groupState = { apiVersion: '1.0.0', createdAt: Date.now(), updatedAt: Date.now(), groups: [] };
    }
    this.loaded = true;
  }

  private async writeGroupState(): Promise<void> {
    this.groupState.updatedAt = Date.now();
    if (!this.groupState.createdAt) this.groupState.createdAt = Date.now();
    try {
      await fs.writeFile(this.groupsJsonPath, JSON.stringify(this.groupState), 'utf-8');
    } catch (err) {
      this.logger.error({ path: this.groupsJsonPath, err }, 'Failed to persist groups file');
    }
  }
}
