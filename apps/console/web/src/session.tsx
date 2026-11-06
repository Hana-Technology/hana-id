// The banner above every signed-in page about the console session's end (apps/console/README.md "UI principles",
// "When the session ends"): 5 minutes before its 12 h absolute end ("Your session ends in N min", with Sign in again),
// and once it has ended ("Your session has ended": Sign in again opens sign-in in a new tab, so this tab keeps what was
// typed; Try again sends what was waiting, exactly as it was). The requests themselves wait in api.ts.
import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { session, sessionStore } from './api.ts';
import { relative, useNow } from './lib.tsx';

/** The warning shows this long before the absolute end. */
export const WARN_BEFORE_MS = 5 * 60_000;

const at = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "Sign in again": the console's sign-in in a new tab (its cookie is this tab's too); this tab stays as it is. */
function SignInAgain() {
  return (
    <a className="btn btn-primary" href="/signin" target="_blank" rel="noopener">
      Sign in again
    </a>
  );
}

export function SessionBanner() {
  const s = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const { pathname } = useLocation();
  // Redrawn every 15 s; the time is read at each draw (an answer that just came in counts from now, not the last tick).
  useNow(15_000);
  const now = Date.now();
  const near = s.expiresAt !== null && s.expiresAt - now <= WARN_BEFORE_MS;
  const over = s.expiresAt !== null && now >= s.expiresAt;

  // A move to another page: what waited on the old one is dropped, never sent later.
  useEffect(() => session.dropOtherPages(pathname), [pathname]);

  // At the absolute end on this clock, the server is asked (the clock may be off): 401 is the ended banner.
  const tick = over ? now : 0;
  useEffect(() => {
    if (over && !s.ended) void session.check();
  }, [over, s.ended, tick]);

  // Back on this tab (from the sign-in tab): a session ended or near its end is checked again. Never otherwise, so a
  // check doesn't count as activity against the 2 h idle limit.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === 'hidden') return;
      const st = sessionStore.get();
      if (st.ended || (st.expiresAt !== null && Date.now() >= st.expiresAt - WARN_BEFORE_MS)) void session.check();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  if (s.back)
    return (
      <div className="session-banner session-back" role="status">
        <p className="session-title">You’re signed in again</p>
        <p>Press Try again to send what was waiting: nothing was sent while you were signed out.</p>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => session.retry()}>
            Try again
          </button>
        </div>
      </div>
    );
  if (s.ended)
    return (
      <div className="session-banner session-ended" role="alert">
        <p className="session-title">Your session has ended</p>
        <p>
          {s.waiting > 0
            ? 'Nothing was sent, and what you typed is still here. Sign in again in the new tab, come back to this tab, then press Try again to send it.'
            : 'Nothing on this page is lost. Sign in again in the new tab, then come back to this tab and press Try again.'}
        </p>
        {s.stillOut && <p className="session-still">Still signed out: finish signing in in the other tab (Sign in again opens it), then press Try again.</p>}
        <div className="form-actions">
          <SignInAgain />
          <button type="button" className="btn" onClick={() => session.retry()}>
            Try again
          </button>
        </div>
      </div>
    );
  if (near && s.expiresAt !== null)
    return (
      <div className="session-banner session-ending" role="status">
        <p className="session-title">Your session ends {relative(s.expiresAt, now)}</p>
        <p>At {at(s.expiresAt)}, 12 hours after you signed in. Sign in again opens sign-in in a new tab for a new session; this tab and what you typed stay as they are.</p>
        <div className="form-actions">
          <SignInAgain />
        </div>
      </div>
    );
  return null;
}
