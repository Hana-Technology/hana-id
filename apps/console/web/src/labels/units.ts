// Amounts in the request labels form (D899): the partner types XLM, NEAR or TGas; the document holds stroops (7
// decimals), yoctoNEAR (24) and gas (12), as exact decimal strings. Exact both ways (no floating point).
import { formatUnits } from '../units.ts';

export const STELLAR_DECIMALS = 7;
export const NEAR_DECIMALS = 24;
export const TGAS_DECIMALS = 12;

/**
 * `display` (a decimal number such as `0.01`) in units of 10^-decimals, or null when it isn't one or has more decimals
 * than the unit has. '' is ''.
 */
export function toRaw(display: string, decimals: number): string | null {
  const t = display.trim();
  if (t === '') return '';
  const m = /^(\d+)(?:\.(\d*))?$/u.exec(t);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const raw = `${m[1]}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/u, '');
  return raw;
}

/** A raw amount as the form shows it ('' stays ''; a value that isn't a decimal string is shown as it is). */
export const toDisplay = (raw: string, decimals: number): string => (raw === '' ? '' : (formatUnits(raw, decimals) ?? raw));
