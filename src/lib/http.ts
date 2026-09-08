export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface JsonRequestOptions extends Omit<RequestInit, 'signal'> {
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** Retry idempotent failures (network errors, 5xx, 429) this many times. */
  retries?: number;
  signal?: AbortSignal | null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // Network failures reject with a TypeError; a caller-driven abort must not retry.
  return error instanceof TypeError;
}

/**
 * `fetch` with a timeout, bounded retries and JSON parsing. Retries use
 * exponential backoff so a struggling upstream is not hammered.
 */
export async function fetchJson<T>(
  url: string,
  options: JsonRequestOptions = {},
): Promise<T> {
  const { timeoutMs = 12_000, retries = 1, signal, ...init } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const composite = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await fetch(url, { ...init, signal: composite });
      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text().catch(() => undefined);
        }
        throw new HttpError(
          response.status,
          `${response.status} ${response.statusText} für ${url}`,
          body,
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt === retries || !isRetryable(error)) throw error;
      await sleep(2 ** attempt * 400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function postJson<T>(
  url: string,
  body: unknown,
  options: JsonRequestOptions = {},
): Promise<T> {
  return fetchJson<T>(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(body),
  });
}
