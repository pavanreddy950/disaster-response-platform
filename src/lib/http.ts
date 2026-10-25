import { ExternalServiceError } from './errors.js';

export interface FetchJsonOptions {
  service: string;
  timeoutMs: number;
  /** Extra attempts after the first one, only for retryable failures (network, timeout, 429, 5xx). */
  retries: number;
  headers?: Record<string, string>;
  /** Base backoff in ms; attempt n waits baseDelayMs * 2^(n-1). */
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a JSON document with a per-attempt timeout and bounded exponential-backoff retries.
 * 4xx responses (other than 429) are not retried: repeating a bad request will not fix it.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions): Promise<T> {
  const baseDelay = opts.baseDelayMs ?? 200;
  let lastError: ExternalServiceError | undefined;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1));
    try {
      return await fetchOnce<T>(url, opts);
    } catch (err) {
      lastError =
        err instanceof ExternalServiceError
          ? err
          : new ExternalServiceError(opts.service, (err as Error).message, true);
      if (!lastError.retryable) break;
    }
  }
  throw lastError;
}

async function fetchOnce<T>(url: string, opts: FetchJsonOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    throw new ExternalServiceError(
      opts.service,
      timedOut ? `timed out after ${opts.timeoutMs}ms` : `network error: ${(err as Error).message}`,
      true,
    );
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new ExternalServiceError(opts.service, `HTTP ${res.status}`, retryable, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ExternalServiceError(opts.service, 'invalid JSON response', false, res.status);
  }
}
