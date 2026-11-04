// Small shared pieces of the SPA: the data hook (a 401 sends the browser to sign-in), formatting, and the messages for
// sign-in's error codes.
import type { SignInError } from '@hana-id/console-core';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, getJson } from './api.ts';

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
