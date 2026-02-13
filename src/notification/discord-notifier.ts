import https from 'https';
import { URL } from 'url';
import { Notifier } from './notifier';
import { getLogger } from '../util/logger';

export class DiscordNotifier implements Notifier {
  private readonly logger = getLogger();

  constructor(private readonly webhookUrl: string) {
    this.validate();
  }

  private validate(): void {
    if (!this.webhookUrl) {
      throw new Error('Discord webhookUrl is required');
    }
    try {
      const parsed = new URL(this.webhookUrl);
      if (parsed.protocol !== 'https:') {
        throw new Error('Discord webhook URL must use HTTPS');
      }
      if (!parsed.hostname.endsWith('discord.com')) {
        throw new Error(`Discord webhook URL has unexpected hostname: ${parsed.hostname}`);
      }
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error(`Invalid Discord webhook URL: ${this.webhookUrl}`);
      }
      throw err;
    }
  }

  async notify(message: string): Promise<void> {
    if (!this.webhookUrl) return;

    const body = JSON.stringify({
      content: `**RangeKeeper**\n\n${message}`,
    });

    const url = new URL(this.webhookUrl);

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              this.logger.warn({ statusCode: res.statusCode }, 'Discord notification failed');
              resolve();
            }
          });
        },
      );

      req.on('timeout', () => {
        this.logger.warn('Discord notification timed out after 10s');
        req.destroy();
        resolve();
      });

      req.on('error', (err) => {
        this.logger.warn({ err }, 'Discord notification error');
        resolve();
      });

      req.write(body);
      req.end();
    });
  }
}
