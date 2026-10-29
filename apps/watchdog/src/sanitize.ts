// Alert text is built from on-chain strings (kids, providers, proposers, public keys) that a compromised owner or
// updater chooses: up to 128 bytes of any UTF-8 for a kid. Nothing on chain may reach a channel unescaped:
//   - identifiers in titles and texts go through `ident` (an allow-list, else an escaped and quoted form);
//   - every other on-chain value in a text goes through `printable` (control and non-ASCII characters escaped);
//   - each channel then makes the whole message safe for its own format: `headerValue` for anything in an HTTP header
//     (the ntfy title, the Pushover and email subject lines), `slackEscape` for Slack mrkdwn (`<!channel>`,
//     `<https://…|links>` and `&` entities can't be injected).

/** Characters an identifier may show as is. */
const IDENT = /^[A-Za-z0-9._:-]+$/u;
/** Longest identifier shown in full; longer ones are cut (the full value stays in the alert's stored details). */
export const MAX_IDENT_CHARS = 80;

const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '"': '\\"', '\\': '\\\\' };

/** Escapes everything outside printable ASCII (and `"`, `\` when `quote`) as JSON does, with \uXXXX for the rest. */
function escapeText(s: string, quote: boolean): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (quote && (ch === '"' || ch === '\\')) out += ESCAPES[ch];
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (ESCAPES[ch]) out += ESCAPES[ch];
    else {
      // Astral characters as their UTF-16 surrogate pair, as JSON does.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}

/** Cuts `s` to `max` characters, marking the cut with `...`. */
function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

/**
 * An on-chain identifier (kid, provider, account, public key, op) for a title or text: as is when it only has
 * [A-Za-z0-9._:-] and at most MAX_IDENT_CHARS characters, else JSON-quoted with every non-printable or non-ASCII
 * character escaped, cut to MAX_IDENT_CHARS. Always printable ASCII (no CR or LF); `<`, `>` and `&` are left to the
 * channel's own escaping (`slackEscape`).
 */
export function ident(value: unknown): string {
  const s = typeof value === 'string' ? value : value === null || value === undefined ? String(value) : JSON.stringify(value) ?? String(value);
  if (s.length > 0 && s.length <= MAX_IDENT_CHARS && IDENT.test(s)) return s;
  return cut(`"${escapeText(s, true)}"`, MAX_IDENT_CHARS);
}

/** Any other on-chain text for an alert body line: printable ASCII, control and non-ASCII characters escaped. */
export function printable(s: string): string {
  return escapeText(s, false);
}

/** A value for an HTTP header or a subject line: CR, LF and every other non-printable or non-ASCII character removed. */
export function headerValue(s: string, max = 250): string {
  return cut(
    s
      .replace(/[^\x20-\x7e]+/gu, ' ')
      .replace(/ {2,}/gu, ' ')
      .trim(),
    max,
  );
}

/** Slack mrkdwn: `&`, `<` and `>` as entities, so no `<!channel>`, `<@user>` or `<url|text>` can be injected. */
export function slackEscape(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
