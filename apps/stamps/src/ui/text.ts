// What the UI shows of the view's strings and links. The site passes chain data through already parsed and
// neutralised (D753's rules); the UI repeats the cheap part so it is safe on its own: every string goes into a text node
// (never markup), invisible and direction-changing code points are replaced with U+FFFD, and a link is kept only when
// it resolves to http or https.

/** Invisible or direction-changing code points: controls, format characters (bidi, zero-width), private use, separators, lone surrogates. */
const UNSAFE = /^[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const ZWJ = '‍';
const VS16 = '️';

/**
 * A string made safe to put in a text node: tab, LF and CR become spaces; every other unsafe code point becomes U+FFFD
 * (so a right-to-left override can't reorder what follows and hidden characters show), except a zero-width joiner
 * between two pictographs (an emoji sequence); at most `max` code points, then "…".
 */
export function safeText(s: unknown, max = 400): string {
  if (typeof s !== 'string') return '';
  const cps = [...s.slice(0, max * 4)];
  const out: string[] = [];
  for (let i = 0; i < cps.length && out.length <= max; i++) {
    const c = cps[i]!;
    if (c === '\t' || c === '\n' || c === '\r') {
      out.push(' ');
      continue;
    }
    if (c === ZWJ) {
      const prev = cps[i - 1] === VS16 ? cps[i - 2] : cps[i - 1];
      const next = cps[i + 1];
      if (prev !== undefined && next !== undefined && PICTOGRAPH.test(prev) && PICTOGRAPH.test(next)) {
        out.push(c);
        continue;
      }
    }
    out.push(UNSAFE.test(c) ? '�' : c);
  }
  return out.length > max ? `${out.slice(0, max).join('')}…` : out.join('');
}

/** Unicode scalar values, as the contract counts a note. */
export const scalarCount = (s: string): number => [...s].length;

/** `6e5e4e…f35000` for an implicit account, a long named account cut in the middle, a short one as is. */
export function shortAccount(id: string): string {
  const s = safeText(id, 128);
  if (/^[0-9a-f]{64}$/u.test(s)) return `${s.slice(0, 6)}…${s.slice(-6)}`;
  return s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-10)}` : s;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const pad = (n: number) => String(n).padStart(2, '0');

const validMs = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;

/** "13 NOV 2026" in UTC, as a date stamp reads; "" for a time that isn't one. */
export function stampDate(ms: unknown): string {
  if (!validMs(ms)) return '';
  const d = new Date(ms);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "14:05 UTC". */
export function stampTime(ms: unknown): string {
  if (!validMs(ms)) return '';
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "13 Nov 2026, 14:05 UTC" for a title or a screen reader. */
export function longDate(ms: unknown): string {
  if (!validMs(ms)) return '';
  const d = new Date(ms);
  const m = MONTHS[d.getUTCMonth()]!;
  return `${d.getUTCDate()} ${m[0]}${m.slice(1).toLowerCase()} ${d.getUTCFullYear()}, ${stampTime(ms)}`;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago", else the date. */
export function relativeTime(ms: unknown, now: number): string {
  if (!validMs(ms)) return '';
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
  return longDate(ms).split(',')[0]!;
}

/**
 * A link target the UI will use: an absolute http(s) URL, or a path on this site (resolved against the page), else
 * null: javascript:, data:, mailto: and every other scheme, credentials in the URL, control characters or spaces. The
 * caller picks the target by origin (another site opens in a new tab).
 */
export function safeHref(href: unknown, base: string): URL | null {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048) return null;
  // Control characters and spaces never belong in a link the site builds; refuse rather than let the parser strip them.
  if (/[\u0000- \u007F-\u009F]/u.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}
