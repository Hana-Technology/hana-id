// Plain text plus simple HTML for every email (docs/batch-c-spec.md "Email"): no remote image, no script, no style
// sheet, links only to `console.origin`, never an approve link. Partner-controlled text (app and org names, origins,
// policy labels) is escaped for HTML and stripped of control characters; a subject is one line.

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'warn'; text: string }
  | { kind: 'kv'; rows: [string, string][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'pre'; text: string }
  | { kind: 'link'; label: string; url: string };

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

/** A character class of code point ranges (built from numbers, so the source holds no invisible character). */
const charClass = (ranges: [number, number][]): string => ranges.map(([a, b]) => (a === b ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)).join('');

/** C0 controls but tab and line feed, DEL, C1, the Unicode line and paragraph separators and the bidi controls. */
const INVISIBLE: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];
const CONTROL = new RegExp(`[${charClass(INVISIBLE)}]`, 'gu');

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
export function render(env: string, subject: string, blocks: Block[], consoleOrigin: string, label = ''): Rendered {
  const text: string[] = [];
  const html: string[] = [];
  const tag = oneLine(label, 20);
  if (tag) {
    const notice = `${tag} Not production: this email is from Hana ID ${oneLine(env, 60)} (testnet), for testing.`;
    text.push(notice);
    html.push(`<p><strong>${escapeHtml(notice)}</strong></p>`);
  }
  for (const b of blocks) {
    switch (b.kind) {
      case 'p':
        text.push(clean(b.text));
        html.push(`<p>${escapeHtml(clean(b.text))}</p>`);
        break;
      case 'warn':
        text.push(`WARNING: ${clean(b.text)}`);
        html.push(`<p><strong>Warning:</strong> ${escapeHtml(clean(b.text))}</p>`);
        break;
      case 'kv': {
        const width = Math.max(...b.rows.map(([k]) => k.length));
        text.push(b.rows.map(([k, v]) => `${`${k}:`.padEnd(width + 2)}${oneLine(v, 500)}`).join('\n'));
        html.push(`<table>${b.rows.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(oneLine(v, 500))}</td></tr>`).join('')}</table>`);
        break;
      }
      case 'list':
        text.push(b.items.map((i) => `- ${oneLine(i, 500)}`).join('\n'));
        html.push(`<ul>${b.items.map((i) => `<li>${escapeHtml(oneLine(i, 500))}</li>`).join('')}</ul>`);
        break;
      case 'pre':
        text.push(clean(b.text));
        html.push(`<pre>${escapeHtml(clean(b.text))}</pre>`);
        break;
      case 'link': {
        if (new URL(b.url).origin !== consoleOrigin) throw new Error('A link must stay on the console origin');
        text.push(`${clean(b.label)}:\n${b.url}`);
        html.push(`<p><a href="${escapeHtml(b.url)}">${escapeHtml(clean(b.label))}</a></p>`);
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
    html: `<!doctype html><html><body>${html.join('\n')}</body></html>`,
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

export const isoTime = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
