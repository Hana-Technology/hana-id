// Exact decimal amounts for the popup's renderers (render-approval.ts, render-consent.ts). Its own module so the consent
// screen's renderer doesn't import the approval window's (and with it every decoder): the partner console loads the
// consent preview without them (D899).

/** `value` with `decimals` decimal places, trailing zeros trimmed: formatUnits(1500000000000000000n, 18) = "1.5". */
export function formatUnits(value: bigint | string, decimals: number): string {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/u, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

