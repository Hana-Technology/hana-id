'use client';
// useProfile: the name the user set in Hana Home and shared with this app, as React state (`hana.profile`).
//
// It re-renders on the client's profileChanged, which fires only when a new identity token (or none) carries a
// different name. Like useIdentityToken, while logged in, mounted and visible it gets a token lazily on first use and
// again at exp − 5 min (the vault answers from its cache when it can), so the name follows the tokens without any
// call from the page. A failed refresh lands in `error` and is retried after a minute.
//
// For display only: the page doesn't verify the token. A change in Hana Home reaches the page with the next token
// minted for this app, up to about 55 min later; `refresh({ maxAgeMs })` asks for a fresher one.
import type { HanaClient, HanaError, HanaProfile } from '@hana-id/web';
import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import { asError, notMounted, subscribeToken, useIdentityUpkeep } from './identity.ts';
import { HanaContext } from './provider.tsx';
import { INITIAL_STATE } from './store.ts';

export interface UseProfileResult {
  /**
   * `{givenName, familyName}` (each null when not set or not shared) from the current identity token; null while
   * logged out or before the first token.
   */
  profile: HanaProfile | null;
  /**
   * `hana.getProfile(opts)`: the name in a token minted at most `maxAgeMs` ago (at least 30 s), else the cached one
   * unless near its end. The result also lands in `profile`.
   */
  refresh(opts?: { maxAgeMs?: number }): Promise<HanaProfile | null>;
  /** The last refresh's failure (identity_unavailable, session_ended, rate_limited), cleared by a success. */
  error: HanaError | null;
}

const noop = (): void => {};

function subscribeProfile(client: HanaClient | null) {
  return (onChange: () => void): (() => void) => {
    if (!client) return noop;
    client.on('profileChanged', onChange);
    return () => client.off('profileChanged', onChange);
  };
}

export function useProfile(): UseProfileResult {
  const ctx = useContext(HanaContext);
  if (ctx === null) throw new Error('useProfile must be used inside <HanaProvider>');
  const { client } = ctx;
  const status = useSyncExternalStore(ctx.store.subscribe, () => ctx.store.getSnapshot().status, () => INITIAL_STATE.status);
  // The token only times the refreshes; the profile is what the hook returns.
  const subscribeT = useMemo(() => subscribeToken(client), [client]);
  const identityToken = useSyncExternalStore(subscribeT, () => client?.identityToken ?? null, () => null);
  const subscribeP = useMemo(() => subscribeProfile(client), [client]);
  // hana.profile is the same object until profileChanged, as useSyncExternalStore needs.
  const profile = useSyncExternalStore(subscribeP, () => client?.profile ?? null, () => null);
  const [error, setError] = useState<HanaError | null>(null);

  const refresh = useCallback(
    (opts?: { maxAgeMs?: number }): Promise<HanaProfile | null> => {
      if (!client) return notMounted();
      return client.getProfile(opts).then(
        (p) => {
          setError(null);
          return p;
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

  useIdentityUpkeep(client, status, identityToken, refresh);

  return useMemo(() => ({ profile, refresh, error }), [profile, refresh, error]);
}
