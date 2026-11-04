// The SPA's calls to its own backend (same origin only: the CSP's `connect-src 'self'`). Every write carries the
// console's CSRF header and a JSON content type (docs/batch-c-spec.md "Sessions": the browser adds `Sec-Fetch-Site` and
// `Origin`). Cookies are HttpOnly: the page never sees a session, a flow cookie or a token.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === 'string' ? body.error.code : 'internal';
    const message = typeof body.error?.message === 'string' ? body.error.message : 'Something went wrong';
    return new ApiError(res.status, code, message);
  } catch {
    return new ApiError(res.status, 'internal', 'Something went wrong');
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-hana-console': '1', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

/** Top-level navigation (a seam for the tests). */
export const nav = { assign: (url: string): void => window.location.assign(url) };

/** Starts a Google sign-in: asks the backend for a flow, then sends the whole window to the auth origin. */
export async function startSignIn(invite?: string): Promise<void> {
  const { startUrl } = await postJson<{ startUrl: string }>('/api/auth/start', { purpose: 'login', ...(invite ? { invite } : {}) });
  nav.assign(startUrl);
}
