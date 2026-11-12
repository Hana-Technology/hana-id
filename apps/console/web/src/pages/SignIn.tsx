// /signin and /invite (docs/batch-c-spec.md "Code flow" step 1). The invite token arrives in the fragment
// (`/invite#t=<b64url>`), so it is never sent to a server in a URL; the page removes it from the address bar at once
// and sends it only in the body of `POST /api/auth/start`. A failed sign-in comes back as `/signin#error=<code>`.
import type { SignInError } from '@hana-id/console-core';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, startSignIn } from '../api.ts';
import { SIGN_IN_MESSAGES, useFragmentToken } from '../lib.tsx';
import { Callout, Lockup } from '../ui.tsx';

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
      <button type="button" className="jp-btn jp-btn-primary jp-btn-lg block" onClick={() => void go()} disabled={busy}>
        {busy && <span className="spin" aria-hidden="true" />}
        {busy ? 'Opening Google…' : label}
      </button>
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
    </>
  );
}

/** The signed-out pages' frame: one centred card, the login modal's shape, with the lockup. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main id="main" className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Lockup />
          <span className="brand-sub">Partner console</span>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function SignIn() {
  const [error, setError] = useState<SignInError | null>(null);
  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.replace(/^#/u, '')).get('error');
    if (code !== null) {
      setError(Object.hasOwn(SIGN_IN_MESSAGES, code) ? (code as SignInError) : 'internal');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }, []);
  return (
    <AuthCard title="Sign in">
      <p className="lede">Manage your organisation’s apps, keys and team. Sign in with the Google account you were invited with.</p>
      {error && (
        <Callout tone="danger" role="alert">
          {SIGN_IN_MESSAGES[error]}
        </Callout>
      )}
      <SignInButton label="Sign in with Google" />
      <p className="auth-foot">No account yet? Ask an owner of your organisation, or Journear, to invite your Google address. The invite email has the link to use.</p>
    </AuthCard>
  );
}

export function Invite() {
  const token = useFragmentToken('t');
  if (token === undefined) return null;
  return (
    <AuthCard title="Accept your invite">
      {token === null ? (
        <Callout tone="danger" role="alert">
          This invite link is incomplete. Open the link from the invite email again.
        </Callout>
      ) : (
        <>
          <p className="lede">Sign in with the Google account the invite was sent to. The invite works once, for that address only.</p>
          <SignInButton invite={token} label="Sign in with Google to accept" />
          <p className="auth-foot">Wrong account in your browser? Google lets you pick another on the next screen.</p>
        </>
      )}
    </AuthCard>
  );
}
