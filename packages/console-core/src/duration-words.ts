// A wait in words for a partner, as the admin Worker's notices write it ("1 day", "1 hour 30 minutes", "1 minute") and the
// partner console's Request labels tab repeats it (D899): one function, so the email and the page name the same wait.
// Pure; its own subpath so the console's SPA takes it without the rest of console-core.

/** A wait in words for a partner: "1 day", "1 hour 30 minutes", "7 days", "1 minute" (the two largest units). */
export function durationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'less than a minute';
  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];
  const parts: string[] = [];
  let left = ms;
  for (const [size, name] of units) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
  }
  return parts.slice(0, 2).join(' ');
}
