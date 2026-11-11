// Plain text plus HTML for every email (docs/batch-c-spec.md "Email"): no remote image, no script, links only to
// `console.origin`, never an approve link. The HTML is plain semantic markup, or, for a mail that passes `design`
// (the partner invite, D672; the security notices partners receive, D700; the feed's digests, D704), Hana's designed layout (@hana-id/brand/email)
// built from the same blocks, with the same text part; in it every paragraph, table value, list item and warning is
// written so mail clients don't turn a host or address into a link, preformatted JSON included. Partner-controlled text (app and org names, origins, policy labels) is escaped for HTML and stripped of
// control characters; a subject is one line.
import { MAIL_INVISIBLE_SOURCE, type MailBlock, mailHtml, mailLogoUrl } from '@hana-id/brand/email';

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'warn'; text: string }
  | { kind: 'kv'; rows: [string, string][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'pre'; text: string }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'rows'; items: LogRow[] };

/**
 * A digest's log row (D704): `line` is its one line in the text part (and the plain HTML's list item), as the digests
 * always wrote it; the designed HTML part shows the same facts as a title, labelled lines and the details.
 */
export interface LogRow {
  line: string;
  title: string;
  fields: [string, string][];
  detail?: string;
}

/** A mail drawn with the designed layout: its heading (the subject without the env and Hana prefixes) and its preview line. */
export interface Design {
  heading: string;
  preheader: string;
  /** The env's files origin, for the hosted logo (D685); absent, the text wordmark. */
  filesOrigin?: string;
}

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

/**
 * What mail text may not hold: the display-safety rule (`@hana-id/core` `isDisplaySafeLine`, by Unicode property) as
 * the mail layout applies it: controls but tab and line feed, format characters (bidi, zero-width, soft hyphen, tag
 * characters, …), private use, line and paragraph separators, and the invisible fillers.
 */
const CONTROL = new RegExp(MAIL_INVISIBLE_SOURCE, 'gu');

/** One line of display text: no control characters or line breaks, collapsed spaces, at most `max` characters. */
export function oneLine(s: string, max = 200): string {
  const flat = s.replace(/[\r\n\t]+/gu, ' ').replace(CONTROL, '').replace(/ {2,}/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Multi-line text with control characters removed (line feeds kept, CRLF and CR made LF). */
const clean = (s: string): string => s.replace(/\r\n?/gu, '\n').replace(CONTROL, '');

export const escapeHtml = (s: string): string => s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');

/** Throws unless `url` is on the console origin (the only origin an email may link to). */
export function consoleLink(consoleOrigin: string, path: string): string {
  if (!path.startsWith('/')) throw new Error('A console link is a path');
  const url = new URL(path, consoleOrigin);
  if (url.origin !== consoleOrigin) throw new Error('A link must stay on the console origin');
  return url.toString();
}

/**
 * `label` (D419): a non-production env's label (`[SANDBOX]`, `[STAGING]`, …), first in the subject and the body's
 * first line, on staff and partner mail alike, so test mail never reads as production; empty on production.
 */
export function render(env: string, subject: string, blocks: Block[], consoleOrigin: string, label = '', design?: Design): Rendered {
  const text: string[] = [];
  const html: string[] = [];
  const tag = oneLine(label, 20);
  const notice = tag ? `${tag} Not production: this email is from Hana ID ${oneLine(env, 60)} (testnet), for testing.` : '';
  if (notice) {
    text.push(notice);
    html.push(`<p><strong>${escapeHtml(notice)}</strong></p>`);
  }
  const designed: MailBlock[] = design ? [{ kind: 'heading', text: oneLine(design.heading, 200) }] : [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'p':
        text.push(clean(b.text));
        html.push(`<p>${escapeHtml(clean(b.text))}</p>`);
        // Written so clients don't link a name that looks like a host (D687).
        designed.push({ kind: 'p', text: [{ unlinked: clean(b.text) }] });
        break;
      case 'warn':
        text.push(`WARNING: ${clean(b.text)}`);
        html.push(`<p><strong>Warning:</strong> ${escapeHtml(clean(b.text))}</p>`);
        // A warning can quote an origin (an IDN's ASCII form): unlinked, as every partner-influenced value (D700).
        designed.push({ kind: 'callout', tone: 'warn', text: [{ strong: 'Warning: ' }, { unlinked: clean(b.text) }] });
        break;
      case 'kv': {
        const width = Math.max(...b.rows.map(([k]) => k.length));
        text.push(b.rows.map(([k, v]) => `${`${k}:`.padEnd(width + 2)}${oneLine(v, 500)}`).join('\n'));
        html.push(`<table>${b.rows.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(oneLine(v, 500))}</td></tr>`).join('')}</table>`);
        // Values are written so clients don't link them (an origin, an app or org name, an address; D700).
        designed.push({ kind: 'kv', rows: b.rows.map(([k, v]) => [k, [{ unlinked: oneLine(v, 500) }]] as const) });
        break;
      }
      case 'list':
        text.push(b.items.map((i) => `- ${oneLine(i, 500)}`).join('\n'));
        html.push(`<ul>${b.items.map((i) => `<li>${escapeHtml(oneLine(i, 500))}</li>`).join('')}</ul>`);
        designed.push({ kind: 'list', items: b.items.map((i) => [{ unlinked: oneLine(i, 500) }]) });
        break;
      case 'rows':
        text.push(b.items.map((r) => `- ${oneLine(r.line, 500)}`).join('\n'));
        html.push(`<ul>${b.items.map((r) => `<li>${escapeHtml(oneLine(r.line, 500))}</li>`).join('')}</ul>`);
        // Every part of a row can carry a partner's text (an origin, an address, a label in the details): unlinked.
        designed.push({
          kind: 'entries',
          items: b.items.map((r) => ({
            title: [{ unlinked: oneLine(r.title, 500) }],
            fields: r.fields.map(([k, v]) => [k, [{ unlinked: oneLine(v, 500) }]] as const),
            ...(r.detail ? { detail: [{ unlinked: oneLine(r.detail, 500) }] } : {}),
          })),
        });
        break;
      case 'pre':
        text.push(clean(b.text));
        html.push(`<pre>${escapeHtml(clean(b.text))}</pre>`);
        // A policy's or a change's JSON can hold a partner's free text (a label with a URL): unlinked (D700).
        designed.push({ kind: 'pre', text: clean(b.text), unlinked: true });
        break;
      case 'link': {
        if (new URL(b.url).origin !== consoleOrigin) throw new Error('A link must stay on the console origin');
        text.push(`${clean(b.label)}:\n${b.url}`);
        html.push(`<p><a href="${escapeHtml(b.url)}">${escapeHtml(clean(b.label))}</a></p>`);
        designed.push({ kind: 'button', label: clean(b.label), url: b.url });
        break;
      }
    }
  }
  const footer = 'Sent by Hana ID security. Hana never asks you to approve anything from an email. To reach Hana security, reply to this address or write to your Hana contact.';
  text.push(footer);
  html.push(`<p><small>${escapeHtml(footer)}</small></p>`);
  return {
    subject: oneLine(`${tag ? `${tag} ` : ''}[Hana ID ${env}] ${subject}`, 200),
    text: `${text.join('\n\n')}\n`,
    html: design
      ? mailHtml({ title: oneLine(design.heading, 200), preheader: oneLine(design.preheader, 200), blocks: designed, footer, ...(notice ? { envNotice: notice } : {}), ...(design.filesOrigin ? { logoUrl: mailLogoUrl(design.filesOrigin)! } : {}) })
      : `<!doctype html><html><body>${html.join('\n')}</body></html>`,
  };
}

/** A duration for people: "24 h", "60 s", "1 h 30 min", "7 d". */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'no time';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const parts = [d ? `${d} d` : '', h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean);
  return parts.slice(0, 2).join(' ') || '0 s';
}

/**
 * An exact UTC time (copyable, sortable): `2026-11-18T04:54:59.777Z`, whole seconds without `.000`. Staff mails' tables
 * and the digests' rows use it (D697, D704); the partner notices use `readableTime`. Throws on an invalid time (a digest
 * row uses `rowTime`, which doesn't).
 */
export const isoTime = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * A digest row's time (D704): `isoTime`, or, for a time that isn't one, the raw value flagged ("not a valid time: …"),
 * so one bad row is still mailed with the rest and never stops its source's cursor (a digest is after the fact; the
 * blocking notices still refuse to render, `readableTime`).
 */
export function rowTime(ms: unknown): { text: string; valid: boolean } {
  const n = typeof ms === 'number' ? new Date(ms).getTime() : Number.NaN;
  return Number.isFinite(n) ? { text: isoTime(n), valid: true } : { text: `not a valid time: ${oneLine(String(ms), 40)}`, valid: false };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/**
 * A UTC time as a person reads it: `18 November 2026, 04:54 UTC` (to the minute, seconds dropped). Throws a RangeError
 * on a time that isn't one (NaN, past the Date range), as `isoTime` does, so a mail with a bad time (a chain value, say)
 * is never sent and its notice stays unacked, as before (fails closed).
 */
export function readableTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) throw new RangeError('Invalid time value');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
