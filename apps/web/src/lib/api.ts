import type { ApiErrorBody, ApiErrorCode } from '@workeasy/shared';

/** Error thrown for every non-2xx API response, carrying the server's stable code and field errors. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network_error',
    message: string,
    readonly fields: Record<string, string[]> = {},
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api';
const CSRF_COOKIES = ['__Host-wk_csrf', 'wk_csrf'];

function readCookie(names: string[]): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (names.includes(part.slice(0, eq))) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

let csrfPromise: Promise<string> | null = null;
/** Fetches a CSRF token (the server also sets it as a cookie). Deduplicated across concurrent callers. */
export function refreshCsrf(): Promise<string> {
  csrfPromise ??= fetch(`${BASE}/v1/auth/csrf`, { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => r.json() as Promise<{ csrfToken: string }>)
    .then((b) => b.csrfToken)
    .finally(() => {
      csrfPromise = null;
    });
  return csrfPromise;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Same-origin JSON client. Sends the CSRF token on state-changing requests and, if the server reports the token
 * as stale (e.g. after signing in or out in another tab), refreshes it and retries exactly once.
 * The UI treats responses as hints: authorization is always enforced by the API.
 */
export async function api<T = unknown>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const unsafe = !['GET', 'HEAD'].includes(method);
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (unsafe) headers['x-csrf-token'] = readCookie(CSRF_COOKIES) ?? (await refreshCsrf());

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (res.ok) return data as T;

  const err = (data as ApiErrorBody | undefined)?.error;
  if (err?.code === 'csrf_failed' && !retried) {
    await refreshCsrf();
    return api<T>(method, path, opts, true);
  }
  throw new ApiError(res.status, err?.code ?? 'internal_error', err?.message ?? 'Something went wrong', err?.fields, err?.requestId);
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) => api<T>('GET', path, { signal }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', path, { body: body ?? {}, headers }),
  put: <T>(path: string, body: unknown) => api<T>('PUT', path, { body }),
  patch: <T>(path: string, body: unknown) => api<T>('PATCH', path, { body }),
  delete: <T>(path: string, body?: unknown) => api<T>('DELETE', path, { body }),
};

/** New idempotency key per user action (retries of the same action reuse it). */
export const idempotencyKey = () => `web-${crypto.randomUUID()}`;
