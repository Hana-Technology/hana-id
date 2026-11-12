// Small shared pieces of the SPA: the data hook (a 401 sends the browser to sign-in), the write and fresh-sign-in
// hooks (a write's success is a toast, toast.tsx), the touched-fields hook (validate on blur), the fragment reader,
// formatting, and the messages for sign-in's error codes. The UI components are ui.tsx.
import type { SignInError } from '@hana-id/console-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { ApiError, type ReturnTo, createAction, getJson } from './api.ts';
import { useToast } from './toast.tsx';

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | undefined;
  reload: () => void;
}

const unreachable = () => new ApiError(0, 'network', 'The console could not be reached');

/** GETs `path` (null: nothing yet). A 401 (no session, or it ended) goes to /signin. */
export function useApi<T>(path: string | null): Loaded<T> {
  const navigate = useNavigate();
  const [state, setState] = useState<{ path: string | null; data?: T; error?: ApiError }>({ path: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    getJson<T>(path).then(
      (data) => live && setState({ path, data }),
      (err: unknown) => {
        if (!live) return;
        const e = err instanceof ApiError ? err : unreachable();
        if (e.status === 401) navigate('/signin', { replace: true });
        else setState({ path, error: e });
      },
    );
    return () => {
      live = false;
    };
  }, [path, tick, navigate]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = state.path === path;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, reload };
}

/**
 * The fragment's `key`, read once and then cleared from the address bar (an invite or a cancel token is never kept in
 * history or sent in a URL). The read is kept in a ref, so React's development double effect (StrictMode) can't read
 * the already-cleared fragment a second time and lose the token. `undefined` until read; `null` when absent or not a
 * 43-character token.
 */
export function useFragmentToken(key = 't'): string | null | undefined {
  const read = useRef<string | null | undefined>(undefined);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (read.current === undefined) {
      const t = new URLSearchParams(window.location.hash.replace(/^#/u, '')).get(key);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      read.current = t !== null && /^[A-Za-z0-9_-]{43}$/u.test(t) ? t : null;
    }
    setToken(read.current);
  }, [key]);
  return token;
}

export function when(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A time as the reader's wall clock shows it, `HH:MM`, with the day when it isn't today (`14:05 on 12 Nov`). `nowMs`
 * is the server's clock (`AppCtl.serverNow`), so "today" is judged by it, not by a reader's clock that is off.
 */
export function clockTime(atMs: number, nowMs: number): string {
  const d = new Date(atMs);
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return d.toDateString() === new Date(nowMs).toDateString() ? hm : `${hm} on ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/** A duration in ms as the largest whole unit that fits (2 h, 30 min, 45 s). */
export function duration(ms: number): string {
  if (ms % 86_400_000 === 0 && ms >= 86_400_000) return `${ms / 86_400_000} d`;
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** The reader's clock, re-read every `everyMs` (countdowns; nothing is fetched again). */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function span(abs: number): string {
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${mins} min` : mins ? `${mins} min` : 'less than a minute';
}

/** How long until `atMs` on the reader's clock ("in 1 d 2 h"), or how long it has been due ("due for 5 min"). */
export function countdown(atMs: number, now: number): string {
  const d = atMs - now;
  return d > 0 ? `in ${span(d)}` : `due for ${span(-d)}`;
}

/** A past or future time relative to now: "in 18 h 50 min", "5 h 12 min ago". */
export function relative(atMs: number, now: number): string {
  const d = atMs - now;
  return d > 0 ? `in ${span(d)}` : `${span(-d)} ago`;
}

/** The UTC day (`YYYY-MM-DD`) and month (`YYYY-MM`) of `ms`: reports and statements are by UTC day and month. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const utcMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export const SIGN_IN_MESSAGES: Record<SignInError, string> = {
  not_invited: 'This Google account isn’t a member of any organisation on the console. Ask an owner of your organisation, or Journear, for an invite.',
  invite_invalid: 'This invite can’t be used: it was used, revoked or has expired, or it was sent to another address or Workspace domain. Ask for a new one.',
  already_member: 'You’re already a member of that organisation. Sign in without the invite.',
  user_disabled: 'This account is disabled. Contact Journear.',
  passkeys_required: 'This invite would create a second partner organisation, which Journear can’t allow here until passkeys are available. Contact Journear.',
  expired: 'That sign-in took too long or was finished in another browser. Start again.',
  rate_limited: 'Too many sign-in attempts from your network. Wait a minute, then start again.',
  internal: 'Something went wrong. Try again in a few minutes.',
};

/** What an org's pages know (OrgShell's outlet context): the org, the role, whether it is frozen, who is signed in. */
export interface OrgContext {
  org: string;
  role: 'owner' | 'viewer';
  frozen: boolean;
  /** The signed-in member's address (a fresh sign-in must use the same Google account). */
  email?: string | undefined;
  /** This console's environment (`GET /api/me` `envName`), for the client snippet; undefined when not answered. */
  envName?: string | undefined;
}

export const useOrg = (): OrgContext => useOutletContext<OrgContext>();

/**
 * A write in progress: `run` keeps the button busy and the error to show inline; the success message `fn` returns is
 * a toast (the design system's transient confirmation), and `done` keeps the last one.
 */
export function useWrite(): { busy: boolean; error: ApiError | undefined; done: string | undefined; run: (fn: () => Promise<string | void>) => Promise<void>; clear: () => void } {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const run = useCallback(
    async (fn: () => Promise<string | void>) => {
      setBusy(true);
      setError(undefined);
      setDone(undefined);
      try {
        const msg = await fn();
        if (msg) {
          setDone(msg);
          toast(msg);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err : unreachable());
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  const clear = useCallback(() => {
    setError(undefined);
    setDone(undefined);
  }, []);
  return { busy, error, done, run, clear };
}

/**
 * Which fields the member has left (validate on blur, not on each keystroke): a field's error shows once it was
 * blurred, and from then on follows what is typed, so it clears as soon as the value is right. `all` marks every
 * field (a submit), so nothing invalid is sent unflagged; `reset` forgets them (Discard).
 */
export function useTouched<K extends string>(): { seen: (k: K) => boolean; blur: (k: K) => () => void; all: () => void; reset: () => void } {
  const [touched, setTouched] = useState<Partial<Record<K | '*', true>>>({});
  return {
    seen: (k) => touched[k] === true || touched['*'] === true,
    blur: (k) => () => setTouched((t) => (t[k] ? t : { ...t, [k]: true })),
    all: () => setTouched({ '*': true } as Partial<Record<K | '*', true>>),
    reset: () => setTouched({}),
  };
}

/**
 * A change that needs a fresh sign-in: the server builds the action, then the member reviews exactly what will be
 * applied on `/actions/:id` and confirms it with Google there. `from` is the page starting it: the confirmation's
 * back link returns there, after Google too (the server keeps it with the action, D711).
 */
export function useStepUp(org: string, from?: ReturnTo): { busy: boolean; error: ApiError | undefined; start: (kind: string, params: unknown) => Promise<void> } {
  const navigate = useNavigate();
  const w = useWrite();
  const page = from?.page;
  const appId = from?.appId;
  const start = useCallback(
    (kind: string, params: unknown) =>
      w.run(async () => {
        const a = await createAction(org, kind, params, page ? { page, ...(appId ? { appId } : {}) } : undefined);
        navigate(`/actions/${a.id}`, { state: { org } });
      }),
    [org, navigate, w, page, appId],
  );
  return { busy: w.busy, error: w.error, start };
}
