'use client';
// useIdentityToken (docs/identity-token-spec.md "SDK surface"): the partner identity token as React state.
//
// It re-renders on the client's identityTokenChanged (a mint here, in another tab of the session, or null at logout and
// expiry). While logged in and mounted it mints lazily on first use, then keeps the token fresh with a timer at
// exp − 5 min, only while the page is visible: a hidden tab doesn't refresh (it catches up when it becomes visible),
// so background tabs don't mint for nothing. A failed refresh lands in `error` and is retried after a minute.
import type { HanaError, HanaClient } from '@hana-id/web';
import { HanaError as HanaErrorClass } from '@hana-id/web';
import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { HanaContext } from './provider.tsx';
import { INITIAL_STATE } from './store.ts';

/** Refresh this long before `exp` (the vault's own margin: it would mint then anyway). */
export const IDENTITY_REFRESH_BEFORE_MS = 5 * 60_000;
/** After a failed refresh, the next try. */
export const IDENTITY_RETRY_MS = 60_000;

export interface UseIdentityTokenResult {
  /** The current identity token, or null (logged out, not minted yet, or the last refresh failed). */
  identityToken: string | null;
  /** Gets a token now (the cached one unless it is older than `maxAgeMs` or near its end); the result also lands in state. */
  refresh(opts?: { maxAgeMs?: number }): Promise<string | null>;
  /** The last refresh's failure (identity_unavailable, session_ended, rate_limited), cleared by a success. */
  error: HanaError | null;
}

const noop = (): void => {};
const notMounted = (): Promise<never> => Promise.reject(new HanaErrorClass(4900, 'Journear Passport is not mounted yet (HanaProvider has not run its effect)'));

function asError(e: unknown): HanaError {
  return e instanceof HanaErrorClass ? e : new HanaErrorClass(-32603, e instanceof Error ? e.message : 'Internal error');
}

const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function subscribeToken(client: HanaClient | null) {
  return (onChange: () => void): (() => void) => {
    if (!client) return noop;
    client.on('identityTokenChanged', onChange);
    return () => client.off('identityTokenChanged', onChange);
  };
}

export function useIdentityToken(): UseIdentityTokenResult {
  const ctx = useContext(HanaContext);
  if (ctx === null) throw new Error('useIdentityToken must be used inside <HanaProvider>');
  const { client } = ctx;
  const status = useSyncExternalStore(ctx.store.subscribe, () => ctx.store.getSnapshot().status, () => INITIAL_STATE.status);
  const subscribe = useMemo(() => subscribeToken(client), [client]);
  const identityToken = useSyncExternalStore(
    subscribe,
    () => client?.identityToken ?? null,
    () => null,
  );
  const [error, setError] = useState<HanaError | null>(null);

  const refresh = useCallback(
    (opts?: { maxAgeMs?: number }): Promise<string | null> => {
      if (!client) return notMounted();
      return client.getIdentityToken(opts).then(
        (token) => {
          setError(null);
          return token;
        },
        (e: unknown) => {
          const err = asError(e);
          setError(err);
          throw err;
        },
      );
    },
    [client],
  );

  // Lazy first mint and the refresh timer, while logged in and visible.
  useEffect(() => {
    if (!client || status !== 'logged_in') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = (delayMs: number) => {
      clearTimeout(timer);
      if (stopped || !visible()) return;
      timer = setTimeout(run, Math.max(0, Math.min(delayMs, 0x7fffffff)));
    };
    const run = () => {
      if (stopped || !visible()) return;
      refresh().then(
        () => undefined,
        () => schedule(IDENTITY_RETRY_MS),
      );
    };
    const due = () => {
      const exp = client.identityTokenExpiresAtMs;
      return client.identityToken === null || exp === null ? 0 : exp - IDENTITY_REFRESH_BEFORE_MS - Date.now();
    };
    schedule(due());
    const onVisibility = () => {
      if (visible()) schedule(due());
      else clearTimeout(timer);
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [client, status, identityToken, refresh]);

  return useMemo(() => ({ identityToken, refresh, error }), [identityToken, refresh, error]);
}
