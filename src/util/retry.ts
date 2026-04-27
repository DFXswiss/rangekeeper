import { getLogger } from './logger';

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

// Nonce-related errors indicate a TX was already submitted/mined — retrying would be dangerous
export const NON_RETRYABLE_TX_PATTERNS = [
  'nonce too low',
  'nonce has already been used',
  'replacement transaction underpriced',
  'already known',
  'transaction already imported',
];

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

      if (lastError instanceof NonRetryableError) {
        throw lastError;
      }

      // Check for nonce-related errors that should never be retried
      const msgLower = lastError.message.toLowerCase();
      if (NON_RETRYABLE_TX_PATTERNS.some((p) => msgLower.includes(p))) {
        logger.warn({ error: lastError.message }, `${label}: non-retryable TX error detected, aborting retries`);
        throw lastError;
      }

      if (options.retryableErrors && options.retryableErrors.length > 0) {
        const msg = lastError.message.toLowerCase();
        const isRetryable = options.retryableErrors.some((re) => msg.includes(re.toLowerCase()));
        if (!isRetryable) {
          throw lastError;
        }
      }

      if (attempt === options.maxRetries) break;

      const delay = Math.min(options.baseDelayMs * Math.pow(2, attempt), options.maxDelayMs);
      const jitter = delay * 0.1 * Math.random();

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: options.maxRetries,
          delay: Math.round(delay + jitter),
          error: lastError.message,
        },
        `${label}: retrying after error`,
      );

      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
