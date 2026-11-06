// The SPA's calls to its own backend (same origin only: the CSP's `connect-src 'self'`). Every write carries the
// console's CSRF header and a JSON content type (docs/batch-c-spec.md "Sessions": the browser adds `Sec-Fetch-Site` and
// `Origin`). Cookies are HttpOnly: the page never sees a session, a flow cookie or a token.
//
// A session that ends while the page is open (2 h idle, 12 h absolute, or revoked) answers 401 `unauthenticated`. Once
// this page has had a session, such a request isn't failed: it waits (the page, its typed values and the write's busy
// button untouched) while the banner (SessionBanner) offers "Sign in again" in a new tab, and "Try again" sends exactly
// the same request again. A move to another page drops what was waiting on the old one (never sent later). Nothing is
// kept anywhere but this tab's memory.

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

// ---- the session's end ----

/** What the banner shows. `ended`: a request found the session gone; `back`: a check found a new one, requests wait. */
export interface SessionState {
  ended: boolean;
  back: boolean;
  /** A Try again (or a check) still found no session. */
  stillOut: boolean;
  /** Requests waiting for a new sign-in. */
  waiting: number;
  /** The session's absolute end (ms, GET /api/me `sessionExpiresAt`), when known. */
  expiresAt: number | null;
}

interface Waiting {
  page: string;
  resume: () => void;
  drop: (e: ApiError) => void;
}

const listeners = new Set<() => void>();
let state: SessionState = { ended: false, back: false, stillOut: false, waiting: 0, expiresAt: null };
let waiting: Waiting[] = [];
/** This page has had a session: a 401 after that is a session that ended, not a visitor who never signed in. */
let hadSession = false;
let retried = false;
let checking = false;

function set(next: Partial<SessionState>): void {
  state = { ...state, ...next, waiting: waiting.length };
  for (const l of listeners) l();
}

/** The session's end as the banner reads it (`useSyncExternalStore`). */
export const sessionStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: (): SessionState => state,
};

function ended(): void {
  const stillOut = state.stillOut || retried;
  retried = false;
  set({ ended: true, back: false, stillOut });
}

function answered(): void {
  hadSession = true;
  if (!state.ended) return;
  retried = false;
  if (waiting.length) set({ back: true, stillOut: false });
  else set({ ended: false, back: false, stillOut: false });
}

function waitForSignIn(): Promise<void> {
  return new Promise((resume, drop) => {
    waiting.push({ page: window.location.pathname, resume, drop });
    ended();
  });
}

/** Reads GET /api/me's `sessionExpiresAt` (ms). */
function noteExpiry(body: unknown): void {
  const at = (body as { sessionExpiresAt?: unknown } | null)?.sessionExpiresAt;
  set({ expiresAt: typeof at === 'number' && Number.isFinite(at) ? at : null });
}

/** Whether `path` is answered with this browser's session (sign-in's own routes aren't: they make one). */
const withSession = (path: string): boolean => !path.startsWith('/api/auth/');

/** One request, sent again unchanged after a new sign-in when the session ended under it. */
async function request(path: string, init: RequestInit): Promise<Response> {
  for (;;) {
    const res = await fetch(path, init);
    if (res.status === 401 && hadSession && withSession(path)) {
      await waitForSignIn();
      continue;
    }
    if (res.ok && withSession(path)) answered();
    return res;
  }
}

export const session = {
  /** "Try again": every waiting request is sent again, exactly as it was; with none waiting, the session is checked. */
  retry(): void {
    const all = waiting;
    waiting = [];
    retried = true;
    if (!all.length) return void session.check();
    set({});
    for (const w of all) w.resume();
  },

  /** A move to another page: what was waiting on the old one is never sent later (its form is gone). */
  dropOtherPages(page: string): void {
    if (!waiting.some((w) => w.page !== page)) return;
    const keep: Waiting[] = [];
    for (const w of waiting) {
      if (w.page === page) keep.push(w);
      else w.drop(new ApiError(0, 'session_ended', 'Not sent: the session had ended'));
    }
    waiting = keep;
    if (state.back && !keep.length) set({ ended: false, back: false, stillOut: false });
    else set({});
  },

  /**
   * Asks the server (GET /api/me) whether this browser has a session, and when it ends: after a sign-in in another
   * tab, at the absolute end on this clock, or on Try again with nothing waiting. Never waits for a sign-in. Only
   * when the session has ended or its absolute end is near, so a check never stands in for activity (the 2 h idle).
   */
  async check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const path = '/api/me';
      const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (res.status === 401) return void ended();
      if (!res.ok) return;
      noteExpiry(await res.json());
      answered();
    } catch {
      // Offline: the next look at this tab checks again.
    } finally {
      checking = false;
    }
  },
};

/** Test hook: a fresh page (no session seen yet, nothing waiting). */
export function resetSession(): void {
  for (const w of waiting) w.drop(new ApiError(0, 'session_ended', 'reset'));
  waiting = [];
  hadSession = false;
  retried = false;
  checking = false;
  state = { ended: false, back: false, stillOut: false, waiting: 0, expiresAt: null };
}

// ---- requests ----

export async function getJson<T>(path: string): Promise<T> {
  const res = await request(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) throw await errorOf(res);
  const body = (await res.json()) as T;
  if (path === '/api/me') noteExpiry(body);
  return body;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  // Serialised once: a retry after a new sign-in sends these same bytes.
  const res = await request(path, {
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
  const res = await request(path, {
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
