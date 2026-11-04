// The emailed cancel links (docs/batch-c-spec.md "Notice and cancel", "Invites and owner grants"): `/cancel/:changeId#t=`
// (a guarded change) and `/cancel-owner/:grantId#t=` (an owner grant). No session. The token is read from the fragment
// (which no server sees), dropped from the address bar at once, and sent only in a POST body after the person presses
// the button: a GET never cancels, so a mail scanner that opens the link changes nothing. The token is single use: the
// server answers a second confirm `not_pending`.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, postJson } from '../api.ts';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;

/** The fragment's `t`, once, then the fragment is cleared. */
function useFragmentToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('t');
    window.history.replaceState(null, '', window.location.pathname);
    setToken(t && TOKEN_RE.test(t) ? t : null);
  }, []);
  return token;
}

const MESSAGES: Record<string, string> = {
  not_pending: 'Nothing to cancel any more: it was already cancelled, or it has already taken effect. If it is in force and shouldn’t be, contact Hana security at once.',
  forbidden: 'This link isn’t valid. Use the exact link from the email, or contact Hana security.',
  rate_limited: 'Too many attempts from your network. Wait a minute and try again, or contact Hana security.',
};

function CancelPage({ what, idOk, post }: { what: string; idOk: boolean; post: (token: string) => Promise<unknown> }) {
  const token = useFragmentToken();
  const [state, setState] = useState<'ready' | 'busy' | 'done' | { error: string }>('ready');
  if (token === undefined) return null;
  if (!token || !idOk)
    return (
      <main className="narrow">
        <h1>Cancel {what}</h1>
        <p className="note note-error" role="alert">
          This link is incomplete. Open the whole link from the email, or contact Hana security.
        </p>
      </main>
    );
  return (
    <main className="narrow">
      <h1>Cancel {what}</h1>
      {state === 'done' ? (
        <p className="note" role="status">
          Cancelled. Hana and the organisation’s owners have a record of it.
        </p>
      ) : (
        <>
          <p>Press the button to cancel it. Nothing happens until you do.</p>
          <button
            type="button"
            className="primary"
            disabled={state === 'busy'}
            onClick={() => {
              setState('busy');
              post(token).then(
                () => setState('done'),
                (err: unknown) => setState({ error: err instanceof ApiError ? (MESSAGES[err.code] ?? err.message) : 'The console could not be reached. Try again, or contact Hana security.' }),
              );
            }}
          >
            Cancel {what}
          </button>
          {typeof state === 'object' && (
            <p className="note note-error" role="alert">
              {state.error}
            </p>
          )}
        </>
      )}
    </main>
  );
}

export function CancelChange() {
  const { changeId } = useParams();
  const ok = /^gc_[A-Za-z0-9]{1,64}$/u.test(changeId ?? '');
  return <CancelPage what="this change" idOk={ok} post={(token) => postJson('/api/cancel', { changeId, token })} />;
}

export function CancelOwner() {
  const { grantId } = useParams();
  const ok = /^og_[A-Za-z0-9]{1,64}$/u.test(grantId ?? '');
  return <CancelPage what="this new owner" idOk={ok} post={(token) => postJson('/api/owner-grants/cancel', { grantId, token })} />;
}
