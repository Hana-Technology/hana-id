// The SPA's UI kit, on the Journear Passport design system's component classes (`.jp-*`, packages/brand
// components.css): the lockup, inline alerts and errors, cards, empty and loading states, badges, copy buttons, the
// in-page confirm (danger behind a second click), fields that validate on blur, setting rows, choice cards, the save
// bar, the stats strip, the fresh sign-in hint and the guarded-change timeline. Styles are classes only (the CSP has no
// 'unsafe-inline': no style prop anywhere), and text is always text (no HTML is ever injected).
import { BRAND, LOCKUP, MARK_BRACKET, MARK_CARD } from '@hana-id/brand';
import type { GuardedChange } from '@hana-id/console-core';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from './api.ts';
import { IconAlert, IconBack, IconCheck, IconCheckCircle, IconCopy, IconInfo, IconShield } from './icons.tsx';
import { relative, when } from './lib.tsx';
import { explain } from './messages.ts';

export * from './icons.tsx';

// ---- the lockup ----

/** The lockup's height at a given width, in its own proportions (LOCKUP's viewBox). */
const lockupHeight = (width: number): number => Math.round((width * LOCKUP.height) / LOCKUP.width);

/**
 * The Journear Passport lockup (packages/brand logo/journear-lockup.svg, D789), drawn inline from `LOCKUP` so it needs
 * no image request: the mark, the outlined "Journear" and the outlined "PASSPORT" beneath it, as the file lays them out.
 * Its colours are the stylesheet's: the teal card and the orange bracket in both schemes, the type ink on light and
 * white on dark, as the brand's white variant has it (never otherwise recoloured).
 */
export function Lockup({ className }: { className?: string }) {
  return (
    <svg className={`lockup${className ? ` ${className}` : ''}`} viewBox={LOCKUP.viewBox} width="176" height={lockupHeight(176)} role="img" aria-label={BRAND.product} focusable="false">
      <g transform={LOCKUP.mark}>
        <path className="lk-card" d={MARK_CARD} />
        <path className="lk-bracket" d={MARK_BRACKET} />
      </g>
      <path className="lk-word" transform={LOCKUP.word.transform} d={LOCKUP.word.d} />
      <path className="lk-sub" transform={LOCKUP.sub.transform} d={LOCKUP.sub.d} />
    </svg>
  );
}

// ---- alerts ----

type Tone = 'info' | 'warn' | 'danger' | 'ok';
const ALERT: Record<Tone, string> = { info: 'jp-alert-info', warn: 'jp-alert-warning', danger: 'jp-alert-danger', ok: 'jp-alert-success' };
const ALERT_ICON: Record<Tone, typeof IconInfo> = { info: IconInfo, warn: IconAlert, danger: IconAlert, ok: IconCheckCircle };

/** An inline alert (never floating): a tone, an optional bold title, the body. */
export function Callout({ tone = 'info', title, children, className, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string; role?: 'alert' | 'status' | 'note' }) {
  const Icon = ALERT_ICON[tone];
  return (
    <div className={`jp-alert ${ALERT[tone]}${className ? ` ${className}` : ''}`} role={role}>
      <Icon className="ic" />
      <div className="body">
        {title && <b className="alert-title">{title}</b>}
        {children}
      </div>
    </div>
  );
}

/** An API error in plain language, with the server's detail when it adds something and the code for support. */
export function ErrorNote({ error, onRetry }: { error: ApiError; onRetry?: (() => void) | undefined }) {
  const { text, detail } = explain(error.code, error.message, error.status);
  return (
    <Callout tone="danger" role="alert" title={text}>
      {error.problems.length > 0 ? (
        <ul className="problems">
          {error.problems.map((p) => (
            <li key={p} className="mono">
              {p}
            </li>
          ))}
        </ul>
      ) : (
        detail && <p className="alert-detail">{detail}</p>
      )}
      <p className="support-code">
        Error code <code>{error.code}</code>
        {error.status ? ` · HTTP ${error.status}` : ''}
        {onRetry && (
          <>
            {' '}
            <button type="button" className="link-btn" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </p>
    </Callout>
  );
}

/** A write's error, inline where the write was started (its success is a toast: lib.tsx `useWrite`). */
export function WriteNote({ error }: { error?: ApiError | undefined }) {
  return error ? <ErrorNote error={error} /> : null;
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
      <IconShield /> <span>Next you review the change, then confirm it with a fresh Google sign-in{email ? ` as ${email}` : ''}.</span>
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

/** A card: a title, one line of what it is, actions on the right, then its content. */
export function Panel({ title, description, actions, children, className }: { title?: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`jp-card panel${className ? ` ${className}` : ''}`} aria-labelledby={title ? id : undefined}>
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

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="jp-empty">
      {icon ?? <IconInfo className="ic" />}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** The skeleton while a read is on its way (the label is for screen readers). */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      <span className="jp-skel" aria-hidden="true" />
      <span className="jp-skel short" aria-hidden="true" />
      <span className="jp-skel" aria-hidden="true" />
    </div>
  );
}

type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';
const BADGE: Record<BadgeTone, string> = { neutral: 'jp-badge', accent: 'jp-badge jp-badge-primary', ok: 'jp-badge jp-badge-success', warn: 'jp-badge jp-badge-warning', danger: 'jp-badge jp-badge-danger', info: 'jp-badge jp-badge-info' };

/** A state or a label. `accent` is the brand teal (the stamp orange is kept for the logo: one accent per screen). */
export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={BADGE[tone]} title={title}>
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
        <>
          {' '}
          <Badge tone="warn" title={origin}>
            IDN
          </Badge>
        </>
      )}
      {display !== origin && <div className="muted mono small">{origin}</div>}
    </>
  );
}

// ---- forms ----

export interface FieldControl {
  id: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: true | undefined;
}

/**
 * A labelled control: the label above (6 px), the hint below, "Optional" on the optional ones (required is the
 * default). `error` shows in place of the hint; pages pass it only once the field was left (validate on blur).
 */
export function Field({ label, optional, hint, error, className, children }: { label: ReactNode; optional?: boolean; hint?: ReactNode; error?: ReactNode; className?: string; children: (c: FieldControl) => ReactNode }) {
  const id = useId();
  const described = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`jp-field${error ? ' is-invalid' : ''}${className ? ` ${className}` : ''}`}>
      <label className="jp-label" htmlFor={id}>
        {label}
        {optional && <span className="opt">Optional</span>}
      </label>
      {children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <span className="jp-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="jp-error" id={`${id}-error`}>
          <IconAlert className="ic" />
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * A setting as a row: its title, one line of what it does, the control on the right (the design system's setting
 * row). The title labels the control (`children` gets its id); an error shows under the line once the field was left.
 */
export function SettingRow({ title, description, error, optional, children }: { title: ReactNode; description?: ReactNode; error?: ReactNode; optional?: boolean; children: (c: FieldControl) => ReactNode }) {
  const id = useId();
  const described = [description ? `${id}-desc` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`jp-setting setting-row${error ? ' is-invalid' : ''}`}>
      <span>
        <label htmlFor={id} className="setting-title">
          {title}
          {optional && <span className="opt">Optional</span>}
        </label>
        {description && <small id={`${id}-desc`}>{description}</small>}
        {error && (
          <span className="jp-error" id={`${id}-error`}>
            <IconAlert className="ic" />
            {error}
          </span>
        )}
      </span>
      <span className="setting-control">{children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined })}</span>
    </div>
  );
}

/** A switch row: the whole row is the label, as the design system's setting rows are. */
export function ToggleRow({ title, description, checked, onChange, disabled }: { title: ReactNode; description?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <label className="jp-setting setting-row">
      <span>
        <b>{title}</b>
        {description && <small id={`${id}-desc`}>{description}</small>}
      </span>
      <span className="jp-toggle">
        <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={description ? `${id}-desc` : undefined} onChange={(e) => onChange(e.target.checked)} />
        <span className="t" />
      </span>
    </label>
  );
}

export interface Choice<T extends string> {
  value: T;
  title: ReactNode;
  detail: ReactNode;
  badge?: ReactNode;
}

/** Choice cards, in place of radios where an option has consequences: each says what it does. */
export function ChoiceCards<T extends string>({ legend, name, value, options, onChange, hint }: { legend: ReactNode; name: string; value: T; options: readonly Choice<T>[]; onChange: (v: T) => void; hint?: ReactNode }) {
  return (
    <fieldset className="choice-group">
      <legend className="jp-label">{legend}</legend>
      <div className="jp-cards">
        {options.map((o) => (
          <label key={o.value} className="jp-choice">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span className="t">
              {o.title}
              {o.badge}
            </span>
            <span className="d">{o.detail}</span>
          </label>
        ))}
      </div>
      {hint && <p className="jp-hint">{hint}</p>}
    </fieldset>
  );
}

/**
 * The save bar: slides up at the first change to saved settings, counts them, and offers Discard and Save. Render it
 * inside the form: Save submits it. `note` says what Save does when it isn't immediate (a fresh sign-in).
 */
export function SaveBar({ count, onDiscard, saveLabel = 'Save changes', busy, invalid, note }: { count: number; onDiscard: () => void; saveLabel?: string; busy?: boolean; invalid?: boolean; note?: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="jp-savebar fixed on" role="region" aria-label="Unsaved changes">
      <span>
        <b>{count === 1 ? '1 unsaved change' : `${count} unsaved changes`}</b>
        {invalid ? <small className="savebar-note">Fix the highlighted field to save.</small> : note && <small className="savebar-note">{note}</small>}
      </span>
      <button type="button" className="jp-btn jp-btn-ghost" disabled={busy} onClick={onDiscard}>
        Discard
      </button>
      <button type="submit" className="jp-btn jp-btn-primary" disabled={busy || invalid}>
        {saveLabel}
      </button>
    </div>
  );
}

/** The stats strip: a few figures side by side in one divided band. */
export function Stats({ items, label }: { items: { label: string; value: ReactNode; note?: ReactNode }[]; label?: string }) {
  return (
    <div className="jp-stats" role="group" aria-label={label}>
      {items.map((s) => (
        <div key={s.label} className="jp-statcell">
          <div className="jp-stat">
            <span className="k">{s.label}</span>
            <span className="v">{s.value}</span>
          </div>
          {s.note && <span className="stat-note">{s.note}</span>}
        </div>
      ))}
    </div>
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
    <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm copy-btn" onClick={() => void copy()} aria-label={`Copy ${label}`}>
      {state === 'copied' ? <IconCheck /> : <IconCopy />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'manual' ? 'Select and copy' : 'Copy'}</span>
    </button>
  );
}

/**
 * A long public value (a wallet address, an id) shortened to its two ends on one line, as the policy ID is shortened
 * on the Signing tab: the full value is in the hover title, read out by screen readers (the short form is hidden from
 * them), and copied whole by its button.
 */
export function ShortValue({ value, label, head = 6, tail = 4 }: { value: string; label: string; head?: number; tail?: number }) {
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  return (
    <span className="nowrap">
      <code className="mono small" title={value}>
        <span aria-hidden="true">{short}</span>
        <span className="visually-hidden">{value}</span>
      </code>{' '}
      <CopyButton value={value} label={label} />
    </span>
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
      {hint && <span className="jp-hint">{hint}</span>}
    </div>
  );
}

/** A code block (the design system's ink surface) with its copy button. */
export function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="snippet">
      <pre className="jp-code">{code}</pre>
      <CopyButton value={code} label={label} />
    </div>
  );
}

// ---- confirm in page ----

/**
 * A destructive, immediate write: a first click shows what it does and asks, a second one does it (no browser dialog).
 * The confirm button takes the focus; Escape or "Keep" goes back. The second button is the danger one, unless the
 * action undoes nothing (`tone="primary"`, a rotation).
 */
export function ConfirmButton({ label, confirm, detail, busy, onConfirm, tone = 'danger' }: { label: string; confirm: string; detail?: string; busy?: boolean; onConfirm: () => void; tone?: 'danger' | 'primary' }) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) yes.current?.focus();
  }, [asking]);
  if (!asking)
    return (
      <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" disabled={busy} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className={`confirm confirm-${tone}`} onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}>
      {detail && <span className="confirm-detail">{detail}</span>}
      <span className="confirm-buttons">
        <button
          ref={yes}
          type="button"
          className={`jp-btn jp-btn-sm ${tone === 'danger' ? 'jp-btn-danger' : 'jp-btn-primary'}`}
          disabled={busy}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirm}
        </button>
        <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" onClick={() => setAsking(false)}>
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
export const proposer = (c: GuardedChange): string => (c.proposedByKind === 'hana' ? BRAND.company : c.proposedByKind === 'system' ? 'the system' : 'a member') + (c.requestCountry ? ` (from ${c.requestCountry})` : '');
