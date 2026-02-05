import https from 'https';
import { Notifier } from './notifier';
import { getLogger } from '../util/logger';

export class TelegramNotifier implements Notifier {
  private readonly logger = getLogger();

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async notify(message: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: `🤖 RangeKeeper\n\n${message}`,
      parse_mode: 'Markdown',
    });

    return new Promise((resolve, _reject) => {
      const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            this.logger.warn({ statusCode: res.statusCode, response: data }, 'Telegram notification failed');
            resolve(); // Don't fail the bot on notification errors
          }
        });
      });

      req.on('error', (err) => {
        this.logger.warn({ err }, 'Telegram notification error');
        resolve(); // Don't fail the bot
      });

      req.write(body);
      req.end();
    });
  }
}
