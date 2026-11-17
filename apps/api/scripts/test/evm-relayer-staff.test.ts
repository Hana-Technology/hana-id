// The EVM relayer's staff operation (D837) stays out of the sponsorship handlers' path: `staffReconcile` and its guard
// are referenced only by the object itself (src/evm-relayer.ts) and src/evm-relayer-staff.ts (for the admin package);
// never by apps/api/src/evm/sponsor*.ts, and by nothing else in src/ until the admin package wires it through AdminRpc.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
const ALLOWED = new Set(['evm-relayer.ts', 'evm-relayer-staff.ts']);

describe('the EVM relayer’s staff reconcile', () => {
  it('is referenced only by the object and its staff module: never by the sponsorship handlers', () => {
    const offenders = files(src)
      .filter((f) => !ALLOWED.has(relative(src, f)))
      .filter((f) => /staffReconcile|EVM_RELAYER_STAFF_GUARD|evm-relayer-staff/u.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f));
    expect(offenders).toEqual([]);
    // The handlers' files, whenever they exist, are covered by the walk above; this names the rule for them.
    for (const f of files(join(src, 'evm')).filter((f) => /\/sponsor[^/]*\.ts$/u.test(f))) expect(readFileSync(f, 'utf8')).not.toMatch(/staffReconcile|STAFF_GUARD/u);
  });
});
