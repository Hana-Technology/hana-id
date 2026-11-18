// The EVM relayer's staff tools (D851) stay out of the sponsorship path: the staff module (src/evm-relayer-staff.ts),
// its guard and the object's staff methods are named only by the object itself and that module. Nothing under
// src/evm/ (the sponsorship handlers), no route handler (src/index.ts, src/handlers.ts) and no other file in src/
// imports the staff module or names the guard or a staff method, until the admin package wires it through AdminRpc.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
const STAFF = /evm-relayer-staff|EVM_RELAYER_STAFF_GUARD|\bstaff(?:Status|Resume|Close|Fill|AdoptNonce)\b|evmRelayerStaff[A-Z]/u;
const ALLOWED = new Set(['evm-relayer.ts', 'evm-relayer-staff.ts']);

describe('the EVM relayer’s staff tools', () => {
  it('are named only by the object and its staff module: never by the sponsorship handlers, the routes or anything else in src/', () => {
    const offenders = files(src)
      .filter((f) => !ALLOWED.has(relative(src, f)))
      .filter((f) => STAFF.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });

  it('in particular nothing under src/evm/ and no route handler imports the staff module', () => {
    const watched = [...files(join(src, 'evm')), join(src, 'index.ts'), join(src, 'handlers.ts')];
    expect(watched.length).toBeGreaterThan(2);
    for (const f of watched) expect(readFileSync(f, 'utf8'), relative(src, f)).not.toMatch(/from\s+['"][^'"]*evm-relayer-staff(?:\.ts)?['"]|import\(\s*['"][^'"]*evm-relayer-staff/u);
  });

  it('the staff module holds the guard and reaches every staff method; the object checks the guard on each', () => {
    const staff = readFileSync(join(src, 'evm-relayer-staff.ts'), 'utf8');
    const object = readFileSync(join(src, 'evm-relayer.ts'), 'utf8');
    for (const m of ['staffStatus', 'staffResume', 'staffClose', 'staffFill', 'staffAdoptNonce']) {
      expect(staff).toMatch(new RegExp(`stub\\.${m}\\(EVM_RELAYER_STAFF_GUARD`, 'u'));
      expect(object).toMatch(new RegExp(`async ${m}\\(guard: string`, 'u'));
    }
  });
});
