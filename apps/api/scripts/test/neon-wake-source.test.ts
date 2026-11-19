// D872: every usage-ledger connection of the API is noted as a Neon wake-up (src/usage/neon-compute.ts withNeonWake),
// so the free plan's estimate sees them all. A source check: only the two transports dial pg, and every call of either
// is wrapped.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Neon wake-ups (D872)', () => {
  it('every ledger call in the API’s code goes through withNeonWake (source check)', () => {
    const dir = new URL('../../src/', import.meta.url).pathname;
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${d}${e.name}/`) : e.name.endsWith('.ts') ? [`${d}${e.name}`] : []));
    const offenders: string[] = [];
    let seen = 0;
    for (const f of files(dir)) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|\*)/u.test(l)) return;
        // The transports themselves (record.ts, reports.ts) are the only places that dial: `new pg.Client`.
        if (/new pg\.Client\(/u.test(l) && !/usage\/(record|reports)\.ts$/u.test(f)) offenders.push(`${f}:${i + 1} dials pg`);
        if (/(usageTransport\.query|reportTransport\.rows)\(/u.test(l) && !/async (query|rows)\(/u.test(l)) {
          seen++;
          // The usage event's write is inside `send` (its retry), whose one call is wrapped (the rule below).
          const inSend = /usage\/record\.ts$/u.test(f) && /usageTransport\.query\(binding, RECORD_EVENT_SQL/u.test(l);
          if (!inSend && !/withNeonWake\(env, \(\) => (usageTransport\.query|reportTransport\.rows)\(/u.test(l)) offenders.push(`${f}:${i + 1}`);
        }
        if (/await send\(binding/u.test(l) && !/withNeonWake\(env, \(\) => send\(/u.test(l)) offenders.push(`${f}:${i + 1} send`);
      });
    }
    expect(offenders).toEqual([]);
    expect(seen).toBeGreaterThanOrEqual(9);
  });
});
