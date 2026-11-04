// /signin and /invite (docs/batch-c-spec.md "Code flow" step 1). The invite token arrives in the fragment
// (`/invite#t=<b64url>`), so it is never sent to a server in a URL; the page removes it from the address bar at once
// and sends it only in the body of `POST /api/auth/start`. A failed sign-in comes back as `/signin#error=<code>`.
import type { SignInError } from '@hana-id/console-core';
import { useEffect, useState } from 'react';
import { ApiError, startSignIn } from '../api.ts';
import { SIGN_IN_MESSAGES } from '../lib.tsx';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;

/** The `key=value` pairs of the current fragment. */
function fragment(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/u, ''));
}

/** Clears the fragment without a navigation (the token or code isn't kept in history either). */
function clearFragment(): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function SignInButton({ invite, label }: { invite?: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await startSignIn(invite);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'invite_invalid') setError(SIGN_IN_MESSAGES.invite_invalid);
      else if (err instanceof ApiError && err.code === 'rate_limited') setError(SIGN_IN_MESSAGES.rate_limited);
      else setError(SIGN_IN_MESSAGES.internal);
    }
  };
  return (
    <>
      <button type="button" className="primary" onClick={() => void go()} disabled={busy}>
        {busy ? 'Opening Google…' : label}
      </button>
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function SignIn() {
  const [error, setError] = useState<SignInError | null>(null);
  useEffect(() => {
    const code = fragment().get('error');
    if (code !== null) {
      setError(Object.hasOwn(SIGN_IN_MESSAGES, code) ? (code as SignInError) : 'internal');
      clearFragment();
    }
  }, []);
  return (
    <main className="narrow">
      <h1>Hana ID console</h1>
      <p>Sign in with the Google account your organisation invited.</p>
      {error && (
        <p className="note note-error" role="alert">
          {SIGN_IN_MESSAGES[error]}
        </p>
      )}
      <SignInButton label="Sign in with Google" />
    </main>
  );
}

export function Invite() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const t = fragment().get('t');
    clearFragment();
    setToken(t !== null && TOKEN_RE.test(t) ? t : null);
  }, []);
  if (token === undefined) return null;
  return (
    <main className="narrow">
      <h1>Accept your invite</h1>
      {token === null ? (
        <p className="note note-error" role="alert">
          This invite link is incomplete. Open the link from the invite email again.
        </p>
      ) : (
        <>
          <p>Sign in with the Google account the invite was sent to. The invite works once, for that address only.</p>
          <SignInButton invite={token} label="Sign in with Google to accept" />
        </>
      )}
    </main>
  );
}
