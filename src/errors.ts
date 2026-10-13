/** Error thrown by providers, carrying enough info to decide whether to retry. */
export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;

  constructor(message: string, opts: { status?: number; retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Retryable HTTP statuses: rate limit, request timeout, and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Parse a `Retry-After` header into milliseconds, if present and numeric. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}
