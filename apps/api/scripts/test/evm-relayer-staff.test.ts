// The EVM relayer's staff tools (D851) stay out of the sponsorship path: the staff module (src/evm-relayer-staff.ts),
// its guard, the object's staff methods and the module's admin view are named only by the object itself, that module
// and (D843) AdminRpc (src/rpc/admin.ts: staff actors only), which imports exactly the three admin-view functions and
// never a tool, the guard or a staff method itself. Nothing under src/evm/ (the sponsorship handlers), no route handler
// (src/index.ts, src/handlers.ts) and no other file in src/ imports the staff module or names any of them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
const STAFF = /evm-relayer-staff|EVM_RELAYER_STAFF_GUARD|\bstaff(?:Status|Resume|Close|Cancel|Fill|AdoptNonce)\b|evmRelayerStaff[A-Z]/u;
/** The allowlist, deliberately short: the object, its staff module, and AdminRpc (D843). */
const ALLOWED = new Set(['evm-relayer.ts', 'evm-relayer-staff.ts', join('rpc', 'admin.ts')]);
/** What AdminRpc may take from the staff module: the admin view only (each tool runs inside `evmRelayerStaffAct`). */
const ADMIN_IMPORT = "import { evmRelayerStaffAct, evmRelayerStaffDetail, evmRelayerStaffOverview } from '../evm-relayer-staff.ts';";

describe('the EVM relayer’s staff tools', () => {
  it('are named only by the object, its staff module and AdminRpc: never by the sponsorship handlers, the routes or anything else in src/', () => {
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

  it('AdminRpc imports only the admin view, names no tool, guard or staff method, and calls it only from staff-only methods', () => {
    const admin = readFileSync(join(src, 'rpc', 'admin.ts'), 'utf8');
    const imports = admin.split('\n').filter((l) => /^import\b/u.test(l) && /evm-relayer-staff/u.test(l));
    expect(imports).toEqual([ADMIN_IMPORT]);
    expect(admin).not.toMatch(/EVM_RELAYER_STAFF_GUARD|\bstaff(?:Status|Resume|Close|Cancel|Fill|AdoptNonce)\b|evmRelayerStaff(?:Status|Resume|Close|Cancel|Fill|AdoptNonce)\b|EVM_RELAYER\b/u);
    // Each use sits in a method whose runRpc takes hana actors only (no system, member or link actor).
    const methods = admin.split(/\n  (?=[a-zA-Z]+\(c: unknown\) \{)/u);
    const users = methods.filter((m) => /evmRelayerStaff(?:Act|Detail|Overview)\(/u.test(m));
    expect(users.map((m) => /^[a-zA-Z]+/u.exec(m)?.[0])).toEqual(['systemStatus', 'evmRelayDetail', 'evmRelayAct']);
    for (const m of users) expect(m, m.slice(0, 40)).toMatch(/\{ actors: HANA \}/u);
  });

  it('the staff module holds the guard and reaches every staff method; the object checks the guard on each', () => {
    const staff = readFileSync(join(src, 'evm-relayer-staff.ts'), 'utf8');
    const object = readFileSync(join(src, 'evm-relayer.ts'), 'utf8');
    for (const m of ['staffStatus', 'staffResume', 'staffClose', 'staffCancel', 'staffFill', 'staffAdoptNonce']) {
      expect(staff).toMatch(new RegExp(`stub\\.${m}\\(EVM_RELAYER_STAFF_GUARD`, 'u'));
      expect(object).toMatch(new RegExp(`async ${m}\\(guard: string`, 'u'));
    }
  });
});
