'use client';
// useEmailSharing (D411): `request` opens Hana's email sharing sheet (`hana.requestEmailSharing()`); `state` is the
// last answer this page saw, from `request` or from the client's `emailSharingChanged` (the sheet at login, the
// approval popup's "Stop sharing"); null until one of those happened on this page.
//
// `request` must be called from an onClick, synchronously (it opens the popup in the user's click), like login. Its
// promise is marked handled, so `onClick={request}` never leaves an unhandled rejection: the failure is in `error`
// (`email_sharing_unavailable` with `data.reason`: `off`, `no_address`, `unavailable`).
import { HanaError, type HanaClient } from '@hana-id/web';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { HanaContext } from './provider.tsx';

export type EmailSharingState = 'granted' | 'declined' | 'dismissed';

export interface UseEmailSharingResult {
  /** Opens the sheet; resolves with the answer. Call it synchronously from an onClick. */
  request(): Promise<EmailSharingState>;
  /** The last answer seen on this page (`dismissed`: the sheet was closed), or null. */
  state: EmailSharingState | null;
  /** The last request's failure, cleared by the next request. */
  error: HanaError | null;
}

const notMounted = (): Promise<never> => Promise.reject(new HanaError(4900, 'Journear Passport is not mounted yet (HanaProvider has not run its effect)'));

export function useEmailSharing(): UseEmailSharingResult {
  const ctx = useContext(HanaContext);
  if (ctx === null) throw new Error('useEmailSharing must be used inside <HanaProvider>');
  const client: HanaClient | null = ctx.client;
  const [state, setState] = useState<EmailSharingState | null>(null);
  const [error, setError] = useState<HanaError | null>(null);

  useEffect(() => {
    if (!client) return undefined;
    const onChange = (s: 'granted' | 'declined') => setState(s);
    client.on('emailSharingChanged', onChange);
    return () => {
      client.off('emailSharingChanged', onChange);
    };
  }, [client]);

  // Ignore arguments, so `onClick={request}` (which passes the click event) works.
  const request = useCallback((): Promise<EmailSharingState> => {
    setError(null);
    const p = client ? client.requestEmailSharing() : notMounted();
    p.then(
      (s) => setState(s),
      (e: unknown) => setError(e instanceof HanaError ? e : new HanaError(4900, 'Email sharing failed')),
    );
    return p;
  }, [client]);

  return useMemo(() => ({ request, state, error }), [request, state, error]);
}
