import { getLogger } from './logger';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors?: string[];
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export async function withRetry<T>(fn: () => Promise<T>, label: string, opts?: Partial<RetryOptions>): Promise<T> {
  const logger = getLogger();
  const options = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === options.maxRetries) break;

      const delay = Math.min(options.baseDelayMs * Math.pow(2, attempt), options.maxDelayMs);
      const jitter = delay * 0.1 * Math.random();

      logger.warn({ attempt: attempt + 1, maxRetries: options.maxRetries, delay: Math.round(delay + jitter), error: lastError.message }, `${label}: retrying after error`);

      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
