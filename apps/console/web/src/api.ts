// The SPA's calls to its own backend (same origin only: the CSP's `connect-src 'self'`). Every write carries the
// console's CSRF header and a JSON content type (docs/batch-c-spec.md "Sessions": the browser adds `Sec-Fetch-Site` and
// `Origin`). Cookies are HttpOnly: the page never sees a session, a flow cookie or a token.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The policy validator's problems (`policy_invalid`), one per line. */
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown }; problems?: unknown };
    const code = typeof body.error?.code === 'string' ? body.error.code : 'internal';
    const message = typeof body.error?.message === 'string' ? body.error.message : 'Something went wrong';
    const problems = Array.isArray(body.problems) ? body.problems.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
    return new ApiError(res.status, code, message, problems);
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

/** A raw-body POST (the logo upload: `application/octet-stream`, the one non-JSON write the console takes). */
export async function postBytes<T>(path: string, bytes: Uint8Array<ArrayBuffer>, contentType = 'application/octet-stream'): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': contentType, 'x-hana-console': '1', accept: 'application/json' },
    body: bytes,
  });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

/** A created fresh-sign-in action (`POST /api/orgs/:org/actions`). */
export interface CreatedAction {
  id: string;
  kind: string;
  decoded: Record<string, unknown>;
  expiresAt: number;
}

/** Builds an action on the server; the caller sends the member to `/actions/:id` to review and confirm it. */
export const createAction = (org: string, kind: string, params: unknown): Promise<CreatedAction> => postJson<CreatedAction>(`/api/orgs/${org}/actions`, { kind, params });

/** Starts the action's fresh sign-in: the whole window goes to the auth origin, then Google. */
export async function confirmWithGoogle(actionId: string): Promise<void> {
  const { startUrl } = await postJson<{ startUrl: string }>(`/api/actions/${actionId}/google`, {});
  nav.assign(startUrl);
}
