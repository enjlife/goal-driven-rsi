import { ProviderError } from './errors.js';
import { sleep } from './util.js';

export interface RetryOptions {
  maxRetries: number;
  baseMs: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

function isRetryable(e: unknown): boolean {
  return e instanceof ProviderError && e.retryable;
}

function backoffDelay(attempt: number, baseMs: number, e: unknown): number {
  const retryAfter = e instanceof ProviderError ? e.retryAfterMs : undefined;
  if (retryAfter != null) return retryAfter;
  const exp = baseMs * Math.pow(2, attempt); // 1x, 2x, 4x, ...
  return Math.round(exp * (1 + Math.random() * 0.3)); // jitter
}

/** Run `fn`, retrying on retryable ProviderErrors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt === opts.maxRetries) throw e;
      const delay = backoffDelay(attempt, opts.baseMs, e);
      opts.onRetry?.(attempt + 1, e as Error, delay);
      await sleep(delay);
    }
  }
  // unreachable: the loop either returns or throws
  throw new Error('withRetry: unreachable');
}
