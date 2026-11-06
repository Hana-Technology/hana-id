// The SPA's UI kit: notes and errors, panels, empty states, badges, copy buttons, the in-page confirm, the fresh
// sign-in hint and the guarded-change timeline. Styles are classes in styles.css only (the CSP has no
// 'unsafe-inline': no style prop anywhere), and text is always text (no HTML is ever injected).
import { MARK_PATHS, MARK_RADIUS, MARK_VIEWBOX } from '@hana-id/brand';
import type { GuardedChange } from '@hana-id/console-core';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from './api.ts';
import { relative, when } from './lib.tsx';
import { explain } from './messages.ts';

// ---- icons (inline SVG, one 1.75 stroke, decorative: aria-hidden) ----

const svg = (d: ReactNode) => (
  <svg className="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {d}
  </svg>
);
export const IconCopy = () => svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>);
export const IconCheck = () => svg(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconLock = () => svg(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
export const IconBack = () => svg(<path d="M15 18 9 12l6-6" />);
export const IconInfo = () => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>);
export const IconClock = () => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);

/** Hana's mark (packages/brand, from Hana's own apps), drawn inline; its colours are the stylesheet's (.mark-bg, .mark-fg). */
export function Mark() {
  return (
    <svg className="mark" viewBox={MARK_VIEWBOX} width="28" height="28" aria-hidden="true" focusable="false">
      <rect className="mark-bg" width="50" height="50" rx={MARK_RADIUS} />
      {MARK_PATHS.map((d) => (
        <path key={d} className="mark-fg" d={d} />
      ))}
    </svg>
  );
}

// ---- notes ----

/** An API error in plain language, with the server's detail when it adds something and the code for support. */
export function ErrorNote({ error, onRetry }: { error: ApiError; onRetry?: (() => void) | undefined }) {
  const { text, detail } = explain(error.code, error.message, error.status);
  return (
    <div className="callout callout-error" role="alert">
      <p className="callout-title">{text}</p>
      {error.problems.length > 0 ? (
        <ul className="problems">
          {error.problems.map((p) => (
            <li key={p} className="mono">
              {p}
            </li>
          ))}
        </ul>
      ) : (
        detail && <p className="callout-detail">{detail}</p>
      )}
      <p className="support-code">
        Error code <code>{error.code}</code>
        {error.status ? ` · HTTP ${error.status}` : ''}
        {onRetry && (
          <>
            {' '}
            <button type="button" className="btn-link" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </p>
    </div>
  );
}

export function WriteNote({ error, done }: { error?: ApiError | undefined; done?: string | undefined }) {
  if (error) return <ErrorNote error={error} />;
  if (done)
    return (
      <p className="callout callout-ok" role="status">
        <IconCheck /> {done}
      </p>
    );
  return null;
}

export function Callout({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`callout callout-${tone}${className ? ` ${className}` : ''}`}>
      {title && <p className="callout-title">{title}</p>}
      {children}
    </div>
  );
}

/** Why an action isn't offered here, in one line (instead of a control that can't work). */
export function Why({ children }: { children: ReactNode }) {
  return (
    <p className="why">
      <IconInfo /> <span>{children}</span>
    </p>
  );
}

/** Under a control that opens a fresh sign-in: what happens next. */
export function StepUpHint({ email }: { email?: string | undefined }) {
  return (
    <p className="stepup-hint">
      <IconLock /> <span>Next you review the change, then confirm it with a fresh Google sign-in{email ? ` as ${email}` : ''}.</span>
    </p>
  );
}

// ---- structure ----

export function PageHeader({ title, description, back, actions, children }: { title: ReactNode; description?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      {back && (
        <Link to={back.to} className="back">
          <IconBack /> {back.label}
        </Link>
      )}
      <div className="page-head-row">
        <div className="page-head-text">
          <h1>{title}</h1>
          {description && <p className="lede">{description}</p>}
        </div>
        {actions && <div className="page-head-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Panel({ title, description, actions, children, className }: { title?: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`panel${className ? ` ${className}` : ''}`} aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <div className="panel-head">
          <div>
            {title && <h2 id={id}>{title}</h2>}
            {description && <p className="panel-desc">{description}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      <span className="skeleton" />
      <span className="skeleton short" />
      <span className="skeleton" />
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** An origin with its Unicode form and the IDN flag (an `xn--` label), as everywhere in the console and the notices. */
export function OriginText({ origin, display, idn }: { origin: string; display: string; idn: boolean }) {
  return (
    <>
      <span className="origin">{display}</span>
      {idn && (
        <span className="badge badge-warn" title={origin}>
          IDN
        </span>
      )}
      {display !== origin && <div className="muted mono small">{origin}</div>}
    </>
  );
}

// ---- copy ----

/** Copies `value` (public things only: ids, publishable keys, snippets). Falls back to selecting the text. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('manual');
    }
  };
  return (
    <button type="button" className="btn-copy" onClick={() => void copy()} aria-label={`Copy ${label}`}>
      {state === 'copied' ? <IconCheck /> : <IconCopy />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'manual' ? 'Select and copy' : 'Copy'}</span>
    </button>
  );
}

/** A labelled value with a copy button. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <span className="copy-row">
        <code className="copy-value">{value}</code>
        <CopyButton value={value} label={label} />
      </span>
      {hint && <span className="copy-hint">{hint}</span>}
    </div>
  );
}

export function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="snippet">
      <pre className="mono">{code}</pre>
      <CopyButton value={code} label={label} />
    </div>
  );
}

// ---- confirm in page ----

/**
 * A destructive, immediate write: a first click shows what it does and asks, a second one does it (no browser dialog).
 * The confirm button takes the focus; Escape or "Keep" goes back.
 */
export function ConfirmButton({ label, confirm, detail, busy, onConfirm, className }: { label: string; confirm: string; detail?: string; busy?: boolean; onConfirm: () => void; className?: string }) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) yes.current?.focus();
  }, [asking]);
  if (!asking)
    return (
      <button type="button" className={className ?? 'btn btn-small'} disabled={busy} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className="confirm" onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}>
      {detail && <span className="confirm-detail">{detail}</span>}
      <span className="confirm-buttons">
        <button
          ref={yes}
          type="button"
          className="btn btn-danger btn-small"
          disabled={busy}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirm}
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setAsking(false)}>
          Keep
        </button>
      </span>
    </span>
  );
}

// ---- guarded changes ----

/** Where a guarded change is: requested → announced → in effect (or cancelled), with when. */
export function ChangeTrack({ change, now }: { change: GuardedChange; now: number }) {
  if (change.status === 'cancelled') return <p className="track-line muted">Cancelled {when(change.cancelledAt)}.</p>;
  const announced = change.notifiedAt !== undefined;
  const active = change.status === 'active' || (typeof change.activeFrom === 'number' && change.activeFrom <= now);
  const steps = [
    { label: 'Requested', at: change.proposedAt, done: true },
    { label: 'Announced by email', at: change.notifiedAt, done: announced },
    { label: active ? 'In effect' : 'Takes effect', at: change.activeFrom ?? undefined, done: active },
  ];
  return (
    <ol className="track" aria-label="Progress of this change">
      {steps.map((s, i) => {
        const current = !s.done && (i === 0 || steps[i - 1]!.done);
        return (
          <li key={s.label} className={s.done ? 'done' : current ? 'current' : ''}>
            <span className="track-dot" aria-hidden="true" />
            <span className="track-label">{s.label}</span>
            <span className="track-when">
              {s.at !== undefined ? (
                <>
                  {when(s.at)}
                  {!s.done && <span className="track-rel"> ({relative(s.at, now)})</span>}
                </>
              ) : i === 1 ? (
                'Not sent yet'
              ) : (
                'Set when announced'
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Who asked for a change, as a partner may see it. */
export const proposer = (c: GuardedChange): string => (c.proposedByKind === 'hana' ? 'Hana' : c.proposedByKind === 'system' ? 'the system' : 'a member') + (c.requestCountry ? ` (from ${c.requestCountry})` : '');
