import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PRIVATE_KEY: z.string().startsWith('0x').min(66),
  ETHEREUM_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_URL: z.string().url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  DISCORD_WEBHOOK_URL: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MAX_TOTAL_LOSS_PERCENT: z.coerce.number().min(1).max(100).default(10),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedEnv: EnvConfig | undefined;

export function loadEnvConfig(): EnvConfig {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${formatted}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export function getRpcUrl(chainName: string): string {
  const env = loadEnvConfig();
  const key = `${chainName.toUpperCase()}_RPC_URL` as keyof EnvConfig;
  const url = env[key];
  if (!url || typeof url !== 'string') {
    throw new Error(`No RPC URL configured for chain: ${chainName} (expected env var ${key})`);
  }
  return url;
}
