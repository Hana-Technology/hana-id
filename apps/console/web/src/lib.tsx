// Small shared pieces of the SPA: the data hook (a 401 sends the browser to sign-in), formatting, and the messages for
// sign-in's error codes.
import type { SignInError } from '@hana-id/console-core';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { ApiError, createAction, getJson } from './api.ts';

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | undefined;
  reload: () => void;
}

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
        const e = err instanceof ApiError ? err : new ApiError(0, 'network', 'The console could not be reached');
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

export function when(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A duration in ms as the largest whole unit that fits (2 h, 30 min, 45 s). */
export function duration(ms: number): string {
  if (ms % 86_400_000 === 0 && ms >= 86_400_000) return `${ms / 86_400_000} d`;
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

export const SIGN_IN_MESSAGES: Record<SignInError, string> = {
  not_invited: 'This Google account isn’t a member of any organisation on the console. Ask an owner of your organisation, or Hana, for an invite.',
  invite_invalid: 'This invite can’t be used: it was used, revoked or has expired, or it was sent to another address or Workspace domain. Ask for a new one.',
  already_member: 'You’re already a member of that organisation. Sign in without the invite.',
  user_disabled: 'This account is disabled. Contact Hana.',
  expired: 'That sign-in took too long or was finished in another browser. Start again.',
  rate_limited: 'Too many sign-in attempts from your network. Wait a minute, then start again.',
  internal: 'Something went wrong. Try again in a few minutes.',
};

export function ErrorNote({ error }: { error: ApiError }) {
  return (
    <p className="note note-error" role="alert">
      {error.status === 404 ? 'Not found, or you aren’t a member of it.' : error.message}
    </p>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** What an org's pages know about the member (OrgShell's outlet context): the org, the role, whether it is frozen. */
export interface OrgContext {
  org: string;
  role: 'owner' | 'viewer';
  frozen: boolean;
}

export const useOrg = (): OrgContext => useOutletContext<OrgContext>();

/** A write in progress: `run` keeps the button busy and the error to show; `done` is the last success message. */
export function useWrite(): { busy: boolean; error: ApiError | undefined; done: string | undefined; run: (fn: () => Promise<string | void>) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const msg = await fn();
      if (msg) setDone(msg);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'network', 'The console could not be reached'));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, done, run };
}

/**
 * A change that needs a fresh sign-in: the server builds the action, then the member reviews exactly what will be
 * applied on `/actions/:id` and confirms it with Google there.
 */
export function useStepUp(org: string): { busy: boolean; error: ApiError | undefined; start: (kind: string, params: unknown) => Promise<void> } {
  const navigate = useNavigate();
  const w = useWrite();
  const start = useCallback(
    (kind: string, params: unknown) =>
      w.run(async () => {
        const a = await createAction(org, kind, params);
        navigate(`/actions/${a.id}`, { state: { org } });
      }),
    [org, navigate, w],
  );
  return { busy: w.busy, error: w.error, start };
}

export function WriteNote({ error, done }: { error?: ApiError | undefined; done?: string | undefined }) {
  if (error) return <ErrorNote error={error} />;
  if (done)
    return (
      <p className="note" role="status">
        {done}
      </p>
    );
  return null;
}

/** An origin with its Unicode form and the IDN flag (an `xn--` label), as everywhere in the console and the notices. */
export function OriginText({ origin, display, idn }: { origin: string; display: string; idn: boolean }) {
  return (
    <>
      {display}
      {idn && (
        <span className="badge badge-warn" title={origin}>
          IDN
        </span>
      )}
      {display !== origin && <div className="muted mono">{origin}</div>}
    </>
  );
}

/** A destructive, immediate write: a first click asks, a second one does it (no browser dialog). */
export function ConfirmButton({ label, confirm, busy, onConfirm }: { label: string; confirm: string; busy?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button type="button" disabled={busy} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className="confirm">
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirm}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Keep
      </button>
    </span>
  );
}
