// Hana's email layout: the HTML part of a mail whose text part the caller writes. One string template, no rendering
// library and nothing loaded at send time, so it costs a Worker almost no CPU.
//
// Written for mail clients, not browsers: tables and inline styles (clients drop or rewrite style sheets), at most
// 560 px wide, the system font stack (web fonts don't load reliably), no image, no script, no form, no remote
// anything. The wordmark is text, so a client that blocks images shows the same mail. One `<style>` in the head only
// adds what inline styles can't: dark colours for clients that honour `prefers-color-scheme`, a narrow-screen
// padding, and neutral styling for links a client adds by itself. Without it the mail is still the light layout.
//
// Every string a block carries is text: it is escaped here, and control, bidi and invisible characters are dropped,
// so a partner's name can't add markup, a link or hidden text. A button's URL must be an http(s) URL (http only for
// a loopback host); a code may hold digits and capital letters only. Callers still decide which strings a mail may
// show at all.

/** A run of text inside a paragraph or callout. `host` shows a host name as text that mail clients don't link. */
export type MailInline = string | { strong: string } | { host: string };

export type MailBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'p'; text: string | readonly MailInline[]; muted?: boolean }
  /** A one-time code: large, monospaced, one selectable token, with an optional line under it. */
  | { kind: 'code'; code: string; caption?: string }
  /** A boxed paragraph: `info` for guidance (anti-phishing), `warn` for a warning. */
  | { kind: 'callout'; text: string | readonly MailInline[]; tone: 'info' | 'warn' }
  /** One button, with its URL repeated under it as text (the only link; the text copy isn't a link). */
  | { kind: 'button'; label: string; url: string; urlLabel?: string }
  | { kind: 'kv'; rows: readonly (readonly [string, string])[] }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'pre'; text: string };

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
}

/** Colours: packages/brand tokens.css, light and dark (D426's palette, AA on their surfaces). */
export const MAIL_COLOURS = {
  light: {
    page: '#f4f2f9',
    card: '#ffffff',
    line: '#e6e0f7',
    ink: '#16073a',
    ink2: '#4c3d7f',
    muted: '#665d80',
    accent: '#3308a8',
    onAccent: '#ffffff',
    codeBg: '#f4f2f9',
    codeLine: '#c9bfe6',
    infoBg: '#ebe5fb',
    warnBg: '#fff3d1',
    warnLine: '#e8c977',
    warnInk: '#7a4f00',
    gradientFrom: '#6256e9',
  },
  dark: {
    page: '#0d0229',
    card: '#170b36',
    line: '#2c1b57',
    ink: '#f1edfc',
    ink2: '#d4c5f9',
    muted: '#a99cc9',
    accent: '#bba8f6',
    onAccent: '#0d0229',
    codeBg: '#1f133f',
    codeLine: '#4a3683',
    infoBg: '#2b1c5e',
    warnBg: '#33290f',
    warnLine: '#6b551d',
    warnInk: '#f0c565',
  },
} as const;

const L = MAIL_COLOURS.light;
const D = MAIL_COLOURS.dark;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono','Courier New',monospace";

/** Control characters but tab and LF, DEL and C1, zero-width space, LRM/RLM, line/paragraph separators, bidi controls, word joiners and BOM. */
// Built from numbers, so this source holds no invisible character.
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
];
const cp = (n: number): string => `\\u{${n.toString(16)}}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? cp(a) : `${cp(a)}-${cp(b)}`)).join('')}]`, 'gu');

/** Text for HTML: invisible characters dropped, then `& < > " '` escaped. */
export function mailText(s: string): string {
  return s.replace(INVISIBLE, '').replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Text that mail clients shouldn't turn into a link (a host name, a URL shown as text): each `.`, `/`, `#`, `?`, `=`
 * and `&` in its own element, so no single text node looks like an address, with a break opportunity after it. Copying
 * it gives the original characters: nothing invisible is added.
 */
function unlinked(s: string): string {
  return s
    .replace(INVISIBLE, '')
    .split(/([./#?=&])/u)
    .map((piece, i) => (i % 2 === 1 ? `<span>${mailText(piece)}</span><wbr>` : mailText(piece)))
    .join('');
}

function inline(parts: string | readonly MailInline[]): string {
  if (typeof parts === 'string') return mailText(parts);
  return parts
    .map((p) => {
      if (typeof p === 'string') return mailText(p);
      if ('strong' in p) return `<strong style="font-weight:700">${mailText(p.strong)}</strong>`;
      return `<span class="hm-host" style="font-family:${MONO};font-size:0.92em;color:inherit;text-decoration:none;overflow-wrap:anywhere">${unlinked(p.host)}</span>`;
    })
    .join('');
}

/** A URL a button may carry: http(s) only, http only on a loopback host; nothing that could be script. */
export function mailUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return null;
  return 'only https URLs';
}

const CODE_RE = /^[0-9A-Z]{4,12}$/u;

const P = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.55;color:${L.ink}`;

function block(b: MailBlock): string {
  switch (b.kind) {
    case 'heading':
      return `<h1 class="hm-ink" style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${L.ink}">${mailText(b.text)}</h1>`;
    case 'p':
      return b.muted
        ? `<p class="hm-muted" style="margin:0 0 16px;font-family:${FONT};font-size:14px;line-height:1.55;color:${L.muted}">${inline(b.text)}</p>`
        : `<p class="hm-ink" style="${P}">${inline(b.text)}</p>`;
    case 'code': {
      if (!CODE_RE.test(b.code)) throw new Error('A mail code is 4-12 digits or capital letters');
      // One text node, no spaces or cells between the characters: a double-click or a long press selects all of it.
      // The letter spacing is undone after the last character by the right margin. `<strong>` keeps it bold in a
      // client that drops styles.
      const caption = b.caption ? `<div class="hm-ink2" style="margin-top:10px;font-family:${FONT};font-size:14px;line-height:1.4;font-weight:600;color:${L.ink2}">${mailText(b.caption)}</div>` : '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:separate"><tr><td class="hm-codebox" align="center" style="padding:20px 12px;background-color:${L.codeBg};border:1px solid ${L.codeLine};border-radius:12px"><div class="hm-code hm-ink" style="font-family:${MONO};font-size:34px;line-height:1.2;font-weight:700;letter-spacing:8px;margin-right:-8px;color:${L.ink};white-space:nowrap;-webkit-user-select:all;user-select:all"><strong style="font-weight:700">${b.code}</strong></div>${caption}</td></tr></table>`;
    }
    case 'callout': {
      const warn = b.tone === 'warn';
      const style = warn
        ? `background-color:${L.warnBg};border:1px solid ${L.warnLine};color:${L.warnInk}`
        : `background-color:${L.infoBg};border-left:4px solid ${L.accent};color:${L.ink}`;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate"><tr><td class="${warn ? 'hm-warn' : 'hm-info'}" style="padding:14px 16px;border-radius:10px;${style};font-family:${FONT};font-size:15px;line-height:1.55">${inline(b.text)}</td></tr></table>`;
    }
    case 'button': {
      const problem = mailUrlProblem(b.url);
      if (problem) throw new Error(`A mail button's URL: ${problem}`);
      const href = mailText(b.url);
      const raw = `<p class="hm-muted" style="margin:12px 0 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:${L.muted}">${mailText(b.urlLabel ?? 'Or copy this address into your browser:')}<br><span class="hm-host hm-ink2" style="font-family:${MONO};font-size:12px;color:${L.ink2};word-break:break-all">${unlinked(b.url)}</span></p>`;
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;border-collapse:separate"><tr><td class="hm-btn" align="center" bgcolor="${L.accent}" style="border-radius:999px;background-color:${L.accent}"><a class="hm-btn-a" href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;line-height:1.2;font-weight:700;color:${L.onAccent};text-decoration:none;border-radius:999px">${mailText(b.label)}</a></td></tr></table>${raw}`;
    }
    case 'kv':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">${b.rows
        .map(
          ([k, v]) =>
            `<tr><td class="hm-muted hm-line" valign="top" style="padding:8px 12px 8px 0;border-top:1px solid ${L.line};font-family:${FONT};font-size:14px;line-height:1.45;color:${L.muted};width:34%">${mailText(k)}</td><td class="hm-ink hm-line" valign="top" style="padding:8px 0;border-top:1px solid ${L.line};font-family:${FONT};font-size:14px;line-height:1.45;color:${L.ink};font-weight:600;word-break:break-word">${mailText(v)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'list':
      return `<ul class="hm-ink" style="margin:0 0 16px;padding-left:22px;font-family:${FONT};font-size:15px;line-height:1.55;color:${L.ink}">${b.items.map((i) => `<li style="margin:0 0 6px">${mailText(i)}</li>`).join('')}</ul>`;
    case 'pre':
      return `<pre class="hm-codebox hm-ink" style="margin:0 0 16px;padding:12px;background-color:${L.codeBg};border:1px solid ${L.codeLine};border-radius:8px;font-family:${MONO};font-size:12px;line-height:1.45;color:${L.ink};white-space:pre-wrap;word-break:break-all">${mailText(b.text)}</pre>`;
  }
}

// Dark colours for clients that honour the media query (Apple Mail, Outlook for Mac and iOS, some others); Outlook.com
// marks its dark mode with [data-ogsc]/[data-ogsb]. Clients that ignore it (Gmail's apps) invert the light layout
// themselves: its colours are chosen to survive that (no white text on a light surface, no meaning in colour alone).
const DARK = `.hm-page{background-color:${D.page}!important}.hm-card{background-color:${D.card}!important;border-color:${D.line}!important}.hm-ink{color:${D.ink}!important}.hm-ink2{color:${D.ink2}!important}.hm-muted{color:${D.muted}!important}.hm-accent{color:${D.accent}!important}.hm-line{border-color:${D.line}!important}.hm-codebox{background-color:${D.codeBg}!important;border-color:${D.codeLine}!important}.hm-info{background-color:${D.infoBg}!important;border-color:${D.accent}!important;color:${D.ink}!important}.hm-warn{background-color:${D.warnBg}!important;border-color:${D.warnLine}!important;color:${D.warnInk}!important}.hm-btn{background-color:${D.accent}!important}.hm-btn-a{color:${D.onAccent}!important}`;

const STYLE = `:root{color-scheme:light dark;supported-color-schemes:light dark}body{margin:0!important;padding:0!important;width:100%!important}a[x-apple-data-detectors],.hm-host a,.hm-code a{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}@media (max-width:480px){.hm-pad{padding:24px 20px 20px!important}.hm-outer{padding:16px 8px!important}.hm-code{font-size:30px!important;letter-spacing:6px!important;margin-right:-6px!important}}@media (prefers-color-scheme:dark){${DARK}}${DARK.replace(/(^|\})\./gu, '$1[data-ogsc] .')}`;

// Zero-width non-joiners and non-breaking spaces after the preheader: clients fill a preview to its length from the
// body otherwise, which would put the code there.
const PREVIEW_PAD = '&#847;&zwnj;&nbsp;'.repeat(40);

/** The whole HTML part. */
export function mailHtml(m: MailLayout): string {
  const banner = m.envNotice
    ? `<tr><td style="padding:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td class="hm-warn" style="padding:10px 14px;background-color:${L.warnBg};border:1px solid ${L.warnLine};border-radius:10px;color:${L.warnInk};font-family:${FONT};font-size:13px;line-height:1.45;font-weight:700">${mailText(m.envNotice)}</td></tr></table></td></tr>`
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
    // The wordmark, as text: the same with images blocked.
    `<tr><td style="padding:0 4px 14px;font-family:${FONT};font-size:20px;line-height:1.2;font-weight:800;letter-spacing:-0.3px"><span class="hm-ink" style="color:${L.ink}">Hana</span> <span class="hm-accent" style="color:${L.accent}">ID</span></td></tr>`,
    banner,
    `<tr><td><table role="presentation" class="hm-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${L.card};border:1px solid ${L.line};border-radius:16px;border-collapse:separate">`,
    // Hana's gradient as a thin top rule (decoration only: a client without gradients shows its first colour).
    `<tr><td height="4" style="height:4px;font-size:0;line-height:0;background-color:${L.gradientFrom};background-image:linear-gradient(90deg,#6256e9,#7e5deb 45%,#d772d3);border-radius:15px 15px 0 0">&nbsp;</td></tr>`,
    `<tr><td class="hm-pad" style="padding:30px 32px 16px;font-family:${FONT};color:${L.ink};word-break:break-word;overflow-wrap:anywhere">${m.blocks.map(block).join('')}</td></tr>`,
    '</table></td></tr>',
    footer,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
}
