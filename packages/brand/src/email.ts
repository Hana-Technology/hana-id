// Journear Passport's email layout (D765, the Journear Passport design system v0.5 as mail clients can show it): the
// HTML part of a mail whose text part the caller writes. One string template, no rendering library and nothing loaded
// at send time, so it costs a Worker almost no CPU.
//
// Written for mail clients, not browsers: tables and inline styles (clients drop or rewrite style sheets), at most
// 560 px wide, a system font stack (web fonts don't load reliably in mail; a reader who has IBM Plex installed gets
// it, as it leads the stack), the system's colours (teal primary, ink, the teal-biased neutrals, the semantic
// colours), its radii (8 px buttons and code blocks, 12 px cards), no script, no form, and one remote resource at
// most: the logo (D685), the same URL for every mail, its `alt` styled as the text wordmark, so a client that blocks
// images shows the same mail. One `<style>` in the head only
// adds what inline styles can't: dark colours for clients that honour `prefers-color-scheme`, a narrow-screen
// padding, and neutral styling for links a client adds by itself. Without it the mail is still the light layout.
//
// Every string a block carries is text: it is escaped here, and control, bidi and invisible characters are dropped,
// so a partner's name can't add markup, a link or hidden text. A button's URL must be an http(s) URL (http only for
// a loopback host); a code may hold digits and capital letters only. Callers still decide which strings a mail may
// show at all.
import { MAIL_LOGO_HEIGHT, MAIL_LOGO_PATH, MAIL_LOGO_WIDTH } from './mail-logo.ts';

/**
 * A run of text inside a paragraph or callout. `host` shows a host name as monospaced text that mail clients don't
 * link; `unlinked` is ordinary text written the same way (a partner's name: even one that looks like a host stays
 * text).
 */
export type MailInline = string | { strong: string } | { host: string } | { unlinked: string };

export type MailBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'p'; text: string | readonly MailInline[]; muted?: boolean }
  /** A one-time code: large, monospaced, one selectable token, with an optional line under it. */
  | { kind: 'code'; code: string; caption?: string }
  /** A boxed paragraph: `info` for guidance (anti-phishing), `warn` for a warning. */
  | { kind: 'callout'; text: string | readonly MailInline[]; tone: 'info' | 'warn' }
  /** One button, with its URL repeated under it as text (the only link; the text copy isn't a link). */
  | { kind: 'button'; label: string; url: string; urlLabel?: string }
  /** A value or an item may be inline runs (`{ unlinked }` for an origin or a partner's name that clients mustn't link). */
  | { kind: 'kv'; rows: readonly (readonly [string, string | readonly MailInline[]])[] }
  | { kind: 'list'; items: readonly (string | readonly MailInline[])[] }
  /** Preformatted text; `unlinked`: each `.`, `/`, `#`, `?` and `=` in its own element (D700), copying gives the same text. */
  | { kind: 'pre'; text: string; unlinked?: boolean }
  /** Log rows (a digest, D704): each entry a bold title, an optional code, labelled lines and an optional detail, in compact markup. */
  | { kind: 'entries'; items: readonly MailEntry[] };

/**
 * One log row: what happened (the title, with its code under it), labelled lines (when, who, where) and the row's details. Every part may be
 * inline runs (`{ unlinked }` for ids, origins, addresses and JSON that clients mustn't link). Markup is kept small (the
 * font and colours set once per row, inherited below) so a digest of 50 rows stays under clients' clipping size.
 */
export interface MailEntry {
  title: string | readonly MailInline[];
  /** A code under the title, small, muted and monospaced (the row's code beside its words, for support). */
  code?: string | readonly MailInline[];
  fields: readonly (readonly [string, string | readonly MailInline[]])[];
  detail?: string | readonly MailInline[];
}

export interface MailLayout {
  /** The document title (the subject, without any env prefix). */
  title: string;
  /**
   * The hidden preview line clients show beside the subject. Keep a code out of it: previews show on lock screens.
   * It is padded so a client doesn't fill the rest of the preview from the body.
   */
  preheader: string;
  /** A non-production env's notice, shown as a banner above the card; empty or absent on production. */
  envNotice?: string;
  blocks: readonly MailBlock[];
  /** Small print under the card. */
  footer?: string | readonly MailInline[];
  /** The hosted logo (`mailLogoUrl`); absent, or not an https URL: the text wordmark. */
  logoUrl?: string;
}

/**
 * Colours: packages/brand tokens.css, light and dark (D765). Every text/surface pair the layout uses is WCAG AA (4.5:1)
 * in both schemes (test/email.test.ts). `accent` is the button's fill: the system's primary teal (its orange accent
 * isn't used in mail: a mail is one action at most).
 */
export const MAIL_COLOURS = {
  light: {
    /** --jp-bg-subtle */
    page: '#f5f8f7',
    /** --jp-surface */
    card: '#fcfdfd',
    /** --jp-border */
    line: '#d5dedb',
    /** --jp-fg */
    ink: '#0b1f1e',
    /** --jp-gray-600 */
    ink2: '#46534f',
    /** --jp-fg-muted */
    muted: '#5f6f6a',
    /** --jp-primary: the button, the wordmark */
    accent: '#0f766e',
    /** --jp-on-primary */
    onAccent: '#fcfdfd',
    /** --jp-primary-soft, --jp-teal-200: the one-time code's box */
    codeBg: '#eef7f5',
    codeLine: '#a6d8cf',
    /** --jp-bg-subtle, --jp-border: preformatted text */
    preBg: '#f5f8f7',
    preLine: '#d5dedb',
    /** --jp-info-bg: guidance (anti-phishing) */
    infoBg: '#e8eefc',
    /** --jp-info */
    infoLine: '#1d4ed8',
    /** --jp-warning-bg, --jp-warning: a warning, the env banner */
    warnBg: '#fbf3e3',
    warnLine: '#935f12',
  },
  dark: {
    page: '#0e1716',
    card: '#142322',
    line: '#223634',
    ink: '#ecf2f0',
    /** --jp-gray-200 */
    ink2: '#d5dedb',
    muted: '#9fb1ac',
    accent: '#2e9c90',
    onAccent: '#06201d',
    codeBg: '#11302d',
    codeLine: '#2f4845',
    preBg: '#122020',
    preLine: '#223634',
    infoBg: '#14213a',
    infoLine: '#7fa7ff',
    warnBg: '#2e2410',
    warnLine: '#fbbf24',
  },
} as const;

const L = MAIL_COLOURS.light;
const D = MAIL_COLOURS.dark;

/** The system's body face where the reader has it installed, then the platform's own sans (no web font in mail). */
export const MAIL_FONT = "'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
/** The system's mono face where installed (codes, hosts, preformatted text), then the platform's. */
export const MAIL_MONO = "'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono','Courier New',monospace";
const FONT = MAIL_FONT;
const MONO = MAIL_MONO;

/**
 * What text in a mail may not hold: the display-safety rule of `@hana-id/core` `isDisplaySafeLine` (display-safe.ts),
 * by Unicode property rather than a list. Controls (Cc) but tab and line feed, which preformatted blocks keep; format
 * characters (Cf: bidi controls and isolates, zero-width characters, U+00AD, U+061C, U+180E, U+FEFF, U+FFF9–U+FFFB, the
 * tag characters U+E0000–U+E007F, …); private use (Co); line and paragraph separators (Zl, Zp); and the other
 * invisible fillers: U+034F, the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, U+17B4, U+17B5, the Mongolian
 * selectors U+180B–U+180F, the braille blank U+2800 and every variation selector. Escapes only, so this source holds
 * no invisible character.
 */
export const MAIL_INVISIBLE_SOURCE =
  '[\\u{0}-\\u{8}\\u{b}-\\u{1f}\\u{7f}-\\u{9f}\\p{Cf}\\p{Co}\\p{Zl}\\p{Zp}\\u{34f}\\u{115f}\\u{1160}\\u{17b4}\\u{17b5}\\u{180b}-\\u{180f}\\u{2800}\\u{3164}\\u{fe00}-\\u{fe0f}\\u{ffa0}\\u{e0100}-\\u{e01ef}]';
const INVISIBLE = new RegExp(MAIL_INVISIBLE_SOURCE, 'gu');

/** Text for HTML: invisible characters dropped, then `& < > " '` escaped. */
export function mailText(s: string): string {
  return s.replace(INVISIBLE, '').replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Text that mail clients shouldn't turn into a link (a host name, a URL shown as text): each `.`, `/`, `#`, `?` and `=`
 * in its own element, so no single text node looks like an address, with a break opportunity after it. Copying
 * it gives the original characters: nothing invisible is added.
 */
function unlinked(s: string): string {
  return s
    .replace(INVISIBLE, '')
    .split(/([./#?=])/u)
    .map((piece, i) => (i % 2 === 1 ? `<span>${mailText(piece)}</span><wbr>` : mailText(piece)))
    .join('');
}

function inline(parts: string | readonly MailInline[]): string {
  if (typeof parts === 'string') return mailText(parts);
  return parts
    .map((p) => {
      if (typeof p === 'string') return mailText(p);
      if ('strong' in p) return `<strong style="font-weight:700">${mailText(p.strong)}</strong>`;
      if ('unlinked' in p) return unlinked(p.unlinked);
      return `<span class="hm-host" style="font-family:${MONO};font-size:0.92em;color:inherit;text-decoration:none;overflow-wrap:anywhere">${unlinked(p.host)}</span>`;
    })
    .join('');
}

/**
 * Loopback, as the URL parser writes the host: `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]` and IPv4-mapped
 * 127.0.0.0/8, each also with a trailing dot (`@hana-id/env` `isLoopbackHost`; a test keeps the two equal).
 */
export function isMailLoopbackHost(hostname: string): boolean {
  const h = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/u.test(h) || h === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(h);
}

/** A URL a button or the logo may carry: https, or http on a loopback host (local envs); nothing that could be script. */
export function mailUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && isMailLoopbackHost(u.hostname)) return null;
  return 'only https URLs';
}

const CODE_RE = /^[0-9A-Z]{4,12}$/u;

// Sizes from the system's type scale (body 15, small 13, caps 11, mono 12 to 13; a 24 px heading, between its h3 and
// h2, for a phone's width); headings track tight, numbers are tabular.
const P = `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${L.ink}`;
const TABULAR = 'font-variant-numeric:tabular-nums';

function block(b: MailBlock): string {
  switch (b.kind) {
    case 'heading':
      return `<h1 class="hm-ink" style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-0.48px;color:${L.ink}">${mailText(b.text)}</h1>`;
    case 'p':
      return b.muted
        ? `<p class="hm-muted" style="margin:0 0 16px;font-family:${FONT};font-size:13px;line-height:1.55;color:${L.muted}">${inline(b.text)}</p>`
        : `<p class="hm-ink" style="${P}">${inline(b.text)}</p>`;
    case 'code': {
      if (!CODE_RE.test(b.code)) throw new Error('A mail code is 4-12 digits or capital letters');
      // One text node, no spaces or cells between the characters: a double-click or a long press selects all of it.
      // The letter spacing is undone after the last character by the right margin. `<strong>` keeps it bold in a
      // client that drops styles.
      const caption = b.caption ? `<div class="hm-ink2" style="margin-top:10px;font-family:${FONT};font-size:13px;line-height:1.4;font-weight:500;color:${L.ink2}">${mailText(b.caption)}</div>` : '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:separate"><tr><td class="hm-codebox" align="center" style="padding:20px 12px;background-color:${L.codeBg};border:1px solid ${L.codeLine};border-radius:12px"><div class="hm-code hm-ink" style="font-family:${MONO};font-size:32px;line-height:1.2;font-weight:600;letter-spacing:8px;margin-right:-8px;color:${L.ink};${TABULAR};white-space:nowrap;-webkit-user-select:all;user-select:all"><strong style="font-weight:600">${b.code}</strong></div>${caption}</td></tr></table>`;
    }
    case 'callout': {
      // The system's inline alerts: the tone's soft background, the text in ink; a rule in the tone's colour on the
      // left so the kind still shows where a client drops the background.
      const warn = b.tone === 'warn';
      const style = warn ? `background-color:${L.warnBg};border-left:3px solid ${L.warnLine}` : `background-color:${L.infoBg};border-left:3px solid ${L.infoLine}`;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate"><tr><td class="hm-ink ${warn ? 'hm-warn' : 'hm-info'}" style="padding:12px 14px;border-radius:8px;${style};color:${L.ink};font-family:${FONT};font-size:14px;line-height:1.55">${inline(b.text)}</td></tr></table>`;
    }
    case 'button': {
      const problem = mailUrlProblem(b.url);
      if (problem) throw new Error(`A mail button's URL: ${problem}`);
      const href = mailText(b.url);
      const raw = `<p class="hm-muted" style="margin:12px 0 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:${L.muted}">${mailText(b.urlLabel ?? 'Or copy this address into your browser:')}<br><span class="hm-host hm-ink2" style="font-family:${MONO};font-size:12px;color:${L.ink2};word-break:break-all">${unlinked(b.url)}</span></p>`;
      // The system's large primary button: 48 px high, 8 px radius, semibold label.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;border-collapse:separate"><tr><td class="hm-btn" align="center" bgcolor="${L.accent}" style="border-radius:8px;background-color:${L.accent}"><a class="hm-btn-a" href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 24px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${L.onAccent};text-decoration:none;border-radius:8px">${mailText(b.label)}</a></td></tr></table>${raw}`;
    }
    case 'kv':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">${b.rows
        .map(
          ([k, v]) =>
            `<tr><td class="hm-muted hm-line" valign="top" style="padding:8px 12px 8px 0;border-top:1px solid ${L.line};font-family:${FONT};font-size:13px;line-height:1.5;color:${L.muted};width:34%">${mailText(k)}</td><td class="hm-ink hm-line" valign="top" style="padding:8px 0;border-top:1px solid ${L.line};font-family:${FONT};font-size:13px;line-height:1.5;color:${L.ink};font-weight:500;${TABULAR};word-break:break-word">${inline(v)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'list':
      return `<ul class="hm-ink" style="margin:0 0 16px;padding-left:22px;font-family:${FONT};font-size:15px;line-height:1.6;color:${L.ink}">${b.items.map((i) => `<li style="margin:0 0 6px">${inline(i)}</li>`).join('')}</ul>`;
    case 'pre':
      return `<pre class="hm-prebox hm-ink" style="margin:0 0 16px;padding:12px 14px;background-color:${L.preBg};border:1px solid ${L.preLine};border-radius:8px;font-family:${MONO};font-size:12px;line-height:1.5;color:${L.ink};white-space:pre-wrap;word-break:break-all">${b.unlinked ? unlinked(b.text) : mailText(b.text)}</pre>`;
    case 'entries':
      // One row per entry, a rule above each; the code small and muted under the title, the labels muted, the values in
      // ink, the detail smaller. Sizes and the font are set on the cell and inherited, so each entry costs well under a
      // kilobyte of markup (50 rows with full details must fit the digest budget, D704: nothing more per row).
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">${b.items
        .map(
          (e) =>
            `<tr><td class="hm-ink hm-line" style="padding:10px 0;border-top:1px solid ${L.line};font-family:${FONT};font-size:14px;line-height:1.5;color:${L.ink};word-break:break-word"><div style="font-weight:600">${inline(e.title)}</div>${e.code === undefined ? '' : `<div class="hm-muted" style="font-size:12px;color:${L.muted}">${inline(e.code)}</div>`}${e.fields
              .map(([k, v]) => `<div><span class="hm-muted" style="color:${L.muted}">${mailText(k)}</span> ${inline(v)}</div>`)
              .join('')}${e.detail === undefined ? '' : `<div class="hm-ink2" style="margin-top:2px;font-size:13px;color:${L.ink2}">${inline(e.detail)}</div>`}</td></tr>`,
        )
        .join('')}</table>`;
  }
}

// Dark colours for clients that honour the media query (Apple Mail, Outlook for Mac and iOS, some others); Outlook.com
// marks its dark mode with [data-ogsc]/[data-ogsb]. Clients that ignore it (Gmail's apps) invert the light layout
// themselves: its colours are chosen to survive that (no white text on a light surface, no meaning in colour alone).
const DARK = `.hm-page{background-color:${D.page}!important}.hm-card{background-color:${D.card}!important;border-color:${D.line}!important}.hm-ink{color:${D.ink}!important}.hm-ink2{color:${D.ink2}!important}.hm-muted{color:${D.muted}!important}.hm-brand{color:${D.accent}!important}.hm-line{border-color:${D.line}!important}.hm-codebox{background-color:${D.codeBg}!important;border-color:${D.codeLine}!important}.hm-prebox{background-color:${D.preBg}!important;border-color:${D.preLine}!important}.hm-info{background-color:${D.infoBg}!important;border-color:${D.infoLine}!important}.hm-warn{background-color:${D.warnBg}!important;border-color:${D.warnLine}!important}.hm-btn{background-color:${D.accent}!important}.hm-btn-a{color:${D.onAccent}!important}`;

const STYLE = `:root{color-scheme:light dark;supported-color-schemes:light dark}body{margin:0!important;padding:0!important;width:100%!important}a[x-apple-data-detectors],.hm-host a,.hm-code a{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}@media (max-width:480px){.hm-pad{padding:24px 20px 20px!important}.hm-outer{padding:16px 8px!important}.hm-code{font-size:28px!important;letter-spacing:6px!important;margin-right:-6px!important}}@media (prefers-color-scheme:dark){${DARK}}${DARK.replace(/(^|\})\./gu, '$1[data-ogsc] .')}`;

// Invisible joiners and non-breaking spaces after the preheader, about 300 characters: clients fill a preview to its
// length from the body otherwise, which would put the code there. Best effort (D671): a client that previews more
// than this, or previews the text part, still reaches the code.
const PREVIEW_PAD = '&#847;&zwnj;&nbsp;'.repeat(100);

/** The words of the logo's `alt` and of the text wordmark (D765: the product's name). */
export const MAIL_LOGO_ALT = 'Journear Passport';

/**
 * The header: the hosted logo (D685), the Journear lockup (mark and wordmark) on a light plate, when the env has one;
 * its `alt` "Journear Passport" styled as the text wordmark (the brand's teal, heavy, tight) so a client that blocks
 * images shows the same words. Without a logo URL, the text wordmark itself: "Journear" heavy and "PASSPORT" in small
 * spaced capitals beside it (never as big as "Journear", the logo rules). The one place a logo changes.
 */
function header(logoUrl: string | undefined): string {
  const td = `<tr><td style="padding:0 4px 14px;font-family:${FONT};font-size:20px;line-height:1.2;font-weight:800;letter-spacing:-0.4px">`;
  if (logoUrl !== undefined && mailUrlProblem(logoUrl) === null) {
    return `${td}<img class="hm-brand" src="${mailText(logoUrl)}" width="${MAIL_LOGO_WIDTH}" height="${MAIL_LOGO_HEIGHT}" alt="${MAIL_LOGO_ALT}" style="display:block;border:0;outline:none;text-decoration:none;width:${MAIL_LOGO_WIDTH}px;height:${MAIL_LOGO_HEIGHT}px;font-family:${FONT};font-size:20px;line-height:${MAIL_LOGO_HEIGHT}px;font-weight:800;letter-spacing:-0.4px;color:${L.accent}"></td></tr>`;
  }
  return `${td}<span class="hm-brand" style="color:${L.accent}">Journear</span> <span class="hm-ink" style="font-size:11px;font-weight:700;letter-spacing:1.3px;color:${L.ink}">PASSPORT</span></td></tr>`;
}

/** The logo's URL on an env's files origin (D685): the same for every recipient and every mail, no query, no token. */
export const mailLogoUrl = (filesOrigin: string | undefined): string | undefined => (filesOrigin ? `${filesOrigin.replace(/\/+$/u, '')}${MAIL_LOGO_PATH}` : undefined);

/** The whole HTML part. */
export function mailHtml(m: MailLayout): string {
  const banner = m.envNotice
    ? `<tr><td style="padding:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td class="hm-ink hm-warn" style="padding:10px 14px;background-color:${L.warnBg};border-left:3px solid ${L.warnLine};border-radius:8px;color:${L.ink};font-family:${FONT};font-size:13px;line-height:1.45;font-weight:600">${mailText(m.envNotice)}</td></tr></table></td></tr>`
    : '';
  const footer = m.footer ? `<tr><td class="hm-muted" style="padding:16px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${L.muted}">${inline(m.footer)}</td></tr>` : '';
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${mailText(m.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    `<body class="hm-page" style="margin:0;padding:0;background-color:${L.page};-webkit-text-size-adjust:100%;text-size-adjust:100%">`,
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${L.page}">${mailText(m.preheader)}${PREVIEW_PAD}</div>`,
    `<table role="presentation" class="hm-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${L.page}"><tr><td class="hm-outer" align="center" style="padding:28px 12px">`,
    '<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto">`,
    header(m.logoUrl),
    banner,
    // The system's card: its surface, a 1 px border, a 12 px radius; no shadow (clients drop them) and no decoration.
    `<tr><td><table role="presentation" class="hm-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${L.card};border:1px solid ${L.line};border-radius:12px;border-collapse:separate">`,
    `<tr><td class="hm-pad" style="padding:32px 32px 16px;font-family:${FONT};color:${L.ink};word-break:break-word;overflow-wrap:anywhere">${m.blocks.map(block).join('')}</td></tr>`,
    '</table></td></tr>',
    footer,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
}
