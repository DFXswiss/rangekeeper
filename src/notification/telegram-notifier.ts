import https from 'https';
import { Notifier } from './notifier';
import { getLogger } from '../util/logger';

export class TelegramNotifier implements Notifier {
  private readonly logger = getLogger();

  constructor(
    private readonly botToken: string,
    private readonly chatIds: string[],
  ) {
    this.validate();
  }

  private validate(): void {
    if (!this.botToken || !/^\d+:[A-Za-z0-9_-]{35,}$/.test(this.botToken)) {
      throw new Error(`Invalid Telegram botToken format: expected "<number>:<alphanumeric>"`);
    }
    if (this.chatIds.length === 0) {
      throw new Error(`No Telegram chatIds configured`);
    }
    for (const id of this.chatIds) {
      if (!/^-?\d+$/.test(id)) {
        throw new Error(`Invalid Telegram chatId format: expected numeric ID, got "${id}"`);
      }
    }
  }

  async notify(message: string): Promise<void> {
    if (!this.botToken || this.chatIds.length === 0) return;

    // Send sequentially so a slow / failing recipient does not bury the others; each
    // sendOne() resolves regardless of HTTP outcome (errors are logged), matching the
    // previous fire-and-log-on-error behaviour.
    for (const chatId of this.chatIds) {
      await this.sendOne(chatId, message);
    }
  }

  private sendOne(chatId: string, message: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text: `🤖 RangeKeeper\n\n${message}`,
      parse_mode: 'Markdown',
    });

    return new Promise((resolve) => {
      const req = https.request(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 10_000 },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              this.logger.warn({ chatId, statusCode: res.statusCode, response: data }, 'Telegram notification failed');
              resolve();
            }
          });
        },
      );

      req.on('timeout', () => {
        this.logger.warn({ chatId }, 'Telegram notification timed out after 10s');
        req.destroy();
        resolve();
      });

      req.on('error', (err) => {
        this.logger.warn({ chatId, err }, 'Telegram notification error');
        resolve();
      });

      req.write(body);
      req.end();
    });
  }
}
