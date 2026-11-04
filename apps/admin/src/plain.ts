// Bounded plain data from a party the admin Worker doesn't control (the watchdog's answers; batch C14). The SPA writes
// text only (textContent, never HTML), so markup can't run; this keeps what it shows bounded and honest as text too:
// control and bidirectional-override characters (which can make `abc` display as `cba`, or hide part of a value)
// become U+FFFD, long strings are cut with an ellipsis, deep or wide structures are cut, and only JSON's own types
// survive (a non-finite number is null).

export const PLAIN_LIMITS = {
  /** Characters per string (an alert's details carry on-chain strings the watchdog already escapes). */
  string: 2000,
  /** Items per array (the watchdog's own lists are smaller: 50 actions, 200 open alerts, ≤ 200 per page). */
  array: 500,
  /** Keys per object. */
  keys: 200,
  /** Nesting depth. */
  depth: 8,
} as const;

/** C0 and C1 controls (but tab, newline and CR, which text shows harmlessly), DEL, and the bidi controls. */
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;

export function plainString(s: string, max: number = PLAIN_LIMITS.string): string {
  const cleaned = s.replace(UNSAFE, '�');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** A JSON value reduced as above. Object keys are cleaned and cut to 100 characters. */
export function plain(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return plainString(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (depth >= PLAIN_LIMITS.depth) return '…';
  if (Array.isArray(v)) {
    const out = v.slice(0, PLAIN_LIMITS.array).map((x) => plain(x, depth + 1));
    if (v.length > PLAIN_LIMITS.array) out.push(`… ${v.length - PLAIN_LIMITS.array} more`);
    return out;
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries.slice(0, PLAIN_LIMITS.keys)) out[plainString(k, 100)] = plain(x, depth + 1);
    if (entries.length > PLAIN_LIMITS.keys) out['…'] = `${entries.length - PLAIN_LIMITS.keys} more keys`;
    return out;
  }
  return null;
}

/** Typed reads of plain data: the value, or the fallback when it has another type. */
export const str = (v: unknown): string | null => (typeof v === 'string' ? plainString(v) : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
export const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
