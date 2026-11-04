// Exact decimal amounts for the report screens: NEAR from yoctoNEAR (10^24), USD from micro-dollars (10^6), the same
// rule as console-core's `formatUnits` (trailing zeros dropped, `0` for zero; D324). The SPA imports only types from
// console-core (D297: no server code in the bundle), so the few lines live here too; web/test/reports.test.tsx checks
// they agree with console-core's on the same values.

const DECIMAL = /^(0|[1-9]\d*)$/u;

/** A non-negative integer amount of `10^-decimals` units as an exact decimal, or null when it isn't one. */
export function formatUnits(v: string, decimals: number): string | null {
  if (!DECIMAL.test(v)) return null;
  const s = v.padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/u, '');
  return frac ? `${int}.${frac}` : int;
}

/** yoctoNEAR → NEAR; '—' when absent or malformed. */
export const near = (yocto: string | undefined): string => (yocto === undefined ? '—' : (formatUnits(yocto, 24) ?? '—'));
/** Micro-dollars → USD; '—' when absent (no NEAR/USD rate for the period yet) or malformed. */
export const usd = (micros: string | undefined): string => (micros === undefined ? '—' : (formatUnits(micros, 6) ?? '—'));
