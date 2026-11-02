// Runtime-independent Unicode checks for normalization (D156). No regex with lookbehind or Unicode property escapes:
// both depend on the engine (lookbehind fails to parse before Safari 16.4; property escapes use the engine's Unicode
// data). test/unicode.test.ts keeps both out of src.

import { ASSIGNED_AFTER_CUTOFF } from './unicode-age.ts';

let table: Uint32Array | undefined;

/** [lo0, hi0, lo1, hi1, …], sorted, parsed once from the vendored, hash-pinned table. */
function ranges(): Uint32Array {
  if (table) return table;
  const items = ASSIGNED_AFTER_CUTOFF.split(/\s+/).filter((s) => s.length > 0);
  const t = new Uint32Array(items.length * 2);
  items.forEach((item, i) => {
    const [lo, hi = lo] = item.split('..') as [string, string?];
    t[2 * i] = parseInt(lo, 16);
    t[2 * i + 1] = parseInt(hi, 16);
  });
  table = t;
  return t;
}

/** True when the code point was assigned after the cutoff Unicode version (`EMAIL_V1.unicodeCutoff`). */
export function assignedAfterCutoff(cp: number): boolean {
  const t = ranges();
  let lo = 0;
  let hi = t.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < t[2 * mid]!) hi = mid - 1;
    else if (cp > t[2 * mid + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/** True when any code point of `s` was assigned after the cutoff. */
export function hasPostCutoffCodePoint(s: string): boolean {
  for (const ch of s) if (assignedAfterCutoff(ch.codePointAt(0)!)) return true;
  return false;
}

/** True when `s` holds an unpaired UTF-16 surrogate (a manual scan, no lookbehind). */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}
