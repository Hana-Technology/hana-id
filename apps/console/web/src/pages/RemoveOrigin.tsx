// D931 (docs/partner-platform-spec.md A11 "Remove a confirmed web address", A15; D917): the page the confirmation
// notice's removal link opens, `/remove/:changeId#t=`. No sign-in: the token is the proof. As on the cancel pages
// (Cancel.tsx), the token is read from the fragment (which no server sees), dropped from the address bar at once and
// sent only in a POST body: first to `POST /api/remove/preview`, which only reads (the app, the web address, who
// confirmed it and when, until when the link works), then to `POST /api/remove` when the person presses the one
// button. Opening the page never removes anything. The link works for 7 days and once.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, postJson } from '../api.ts';
import { CONFIRM_WORDS } from '../confirm-words.ts';
import { useFragmentToken, when } from '../lib.tsx';
import { Callout, IdnWarning, Loading, OriginText } from '../ui.tsx';
import { AuthCard } from './SignIn.tsx';

export interface RemovalPreview {
  changeId: string;
  appName: string;
  origin: string;
  display: string;
  idn: boolean;
  confirmedAt: number;
  confirmedByKind: 'member' | 'hana';
  /** The confirmer's address while they are a member, null for a former member, or "Journear staff". */
  confirmedBy: string | null;
  until: number;
  removable: boolean;
}

const TITLE = 'Remove a web address';

/** The refusals, in plain words. */
export const REMOVE_MESSAGES: Record<string, string> = {
  forbidden: 'This link isn’t valid, or it has expired (it works for 7 days after the email). An owner can remove the web address in the partner portal.',
  not_pending: 'This web address was already removed: it doesn’t work any more. Nothing more to do.',
  not_found: 'The app was deleted, so there is nothing to remove.',
  rate_limited: 'Too many attempts from your network. Wait a minute and try again.',
  bad_request: 'This link is incomplete. Open the whole link from the email again.',
};

const refusal = (err: unknown): { error: string; code: string } =>
  err instanceof ApiError ? { error: REMOVE_MESSAGES[err.code] ?? 'Something went wrong. Try again in a few minutes, or contact Journear security.', code: err.code } : { error: 'The partner portal could not be reached. Try again, or contact Journear security.', code: 'network' };

export function RemoveOrigin() {
  const { changeId } = useParams();
  const idOk = /^gc_[A-Za-z0-9]{1,64}$/u.test(changeId ?? '');
  const token = useFragmentToken('t');
  const [preview, setPreview] = useState<RemovalPreview | { error: string; code: string } | undefined>();
  const [state, setState] = useState<'ready' | 'busy' | 'done' | { error: string; code: string }>('ready');
  // One preview per page (React's development double effect would send a second).
  const asked = useRef(false);
  useEffect(() => {
    if (!token || !idOk || asked.current) return;
    asked.current = true;
    postJson<RemovalPreview>('/api/remove/preview', { changeId, token }).then(setPreview, (err: unknown) => setPreview(refusal(err)));
  }, [token, idOk, changeId]);
  if (token === undefined) return null;
  if (!token || !idOk)
    return (
      <AuthCard title={TITLE}>
        <Callout tone="danger" role="alert">
          This link is incomplete. Open the whole link from the email again, or contact Journear security.
        </Callout>
      </AuthCard>
    );
  if (preview === undefined)
    return (
      <AuthCard title={TITLE}>
        <Loading label="Reading the link…" />
      </AuthCard>
    );
  if ('error' in preview)
    return (
      <AuthCard title={TITLE}>
        <Callout tone="danger" role="alert" title={preview.error}>
          <p className="support-code">
            Error code <code>{preview.code}</code>
          </p>
        </Callout>
      </AuthCard>
    );
  const p = preview;
  const who = p.confirmedByKind === 'hana' ? 'Journear staff' : (p.confirmedBy ?? 'a former member of your organisation');
  return (
    <AuthCard title={TITLE}>
      <dl className="facts jp-kv key-facts">
        <dt>App</dt>
        <dd>
          <strong>{p.appName}</strong>
        </dd>
        <dt>Web address</dt>
        <dd>
          <OriginText origin={p.origin} display={p.display} idn={p.idn} />
        </dd>
        <dt>Confirmed by</dt>
        <dd>
          {who}, {when(p.confirmedAt)}
        </dd>
        <dt>This link works until</dt>
        <dd>{when(p.until)}</dd>
      </dl>
      {p.idn && <IdnWarning one />}
      {state === 'done' ? (
        <Callout tone="ok" role="status" title={CONFIRM_WORDS.removed}>
          Journear and your organisation’s owners have a record of it.
        </Callout>
      ) : !p.removable ? (
        <Callout tone="info" role="status">
          {REMOVE_MESSAGES.not_pending}
        </Callout>
      ) : (
        <>
          <p className="lede">
            This stops {p.appName} using this wallet on {p.display} at once. Anyone signed in there is signed out. You don’t need to sign in.
          </p>
          <p>Press the button to remove it. Nothing happens until you do.</p>
          <button
            type="button"
            className="jp-btn jp-btn-danger jp-btn-lg block"
            disabled={state === 'busy'}
            onClick={() => {
              setState('busy');
              postJson('/api/remove', { changeId, token }).then(
                () => setState('done'),
                (err: unknown) => setState(refusal(err)),
              );
            }}
          >
            {CONFIRM_WORDS.removeButton}
          </button>
          {typeof state === 'object' && (
            <Callout tone="danger" role="alert" title={state.error}>
              <p className="support-code">
                Error code <code>{state.code}</code>
              </p>
            </Callout>
          )}
        </>
      )}
    </AuthCard>
  );
}
