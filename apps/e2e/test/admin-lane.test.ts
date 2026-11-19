// The staff admin portal's lane on the local stack (D873, src/server/admin-lane.ts): the Access stand-in against the
// admin Worker's OWN Access check (apps/admin src/access.ts, the code a deployed Worker runs), the lane's chain pool
// that the relayer's pauses are made with, the lane's clock, and the rule that the stand-in lives only here: no test
// hook, bypass or stack control in the admin Worker's code.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_AUD, ACCESS_TEAM, E2E_OUTSIDER, E2E_STAFF, installAccessCerts, newAccessKeys, signAccessJwt } from '../src/server/access.ts';
import { LaneEvm, delegateRuntimeCode } from '../src/server/lane-evm.ts';
import { advanceLaneClock, laneClockOffset, laneNow, resetLaneClock } from '../src/server/lane-clock.ts';
import { LedgerWire, type PGliteLike } from '../src/server/pglite-wire.ts';
import { PGlite } from '@electric-sql/pglite';
import { E2E_SPONSOR_DELEGATE } from '../src/stack.ts';
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { keccak256 } from 'viem';

const ADMIN_SRC = fileURLToPath(new URL('../../admin/src/', import.meta.url));

/** apps/admin src/access.ts, loaded at runtime (its types pull the Worker's Cloudflare types in). */
interface AdminAccess {
  checkStaff(request: Request, env: Record<string, string>, requestId: string, now?: number): Promise<{ ok: true; actor: { kind: string; id: string; email: string } } | { ok: false; code: string }>;
  resetAccessVerifier(): void;
}
const adminAccess = async (): Promise<AdminAccess> => (await import(new URL('../../admin/src/access.ts', import.meta.url).href)) as AdminAccess;

describe('the Access stand-in, checked by the admin Worker’s own code', () => {
  const keys = newAccessKeys();
  installAccessCerts(keys.certs);
  const env = { ACCESS_TEAM_DOMAIN: ACCESS_TEAM, ACCESS_AUD, STAFF_EMAILS: JSON.stringify([E2E_STAFF]) };
  const req = (jwt?: string) => new Request('http://127.0.0.1/api/me', { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });

  it('the staff member’s token passes; someone not on the list is not_staff; none, a forged one or an expired one is unauthenticated', async () => {
    const { checkStaff, resetAccessVerifier } = await adminAccess();
    resetAccessVerifier();
    const ok = await checkStaff(req(signAccessJwt(keys, { email: E2E_STAFF })), env, 'r1');
    expect(ok).toMatchObject({ ok: true, actor: { kind: 'hana', email: E2E_STAFF } });
    expect(await checkStaff(req(signAccessJwt(keys, { email: E2E_OUTSIDER })), env, 'r2')).toMatchObject({ ok: false, code: 'not_staff' });
    expect(await checkStaff(req(), env, 'r3')).toMatchObject({ ok: false, code: 'unauthenticated' });
    const other = newAccessKeys();
    expect(await checkStaff(req(signAccessJwt(other, { email: E2E_STAFF })), env, 'r4')).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(await checkStaff(req(signAccessJwt(keys, { email: E2E_STAFF, nowMs: Date.now() - 2 * 86_400_000, ttlS: 60 })), env, 'r5')).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(await checkStaff(req(signAccessJwt(keys, { email: E2E_STAFF, aud: 'f'.repeat(64) })), env, 'r6')).toMatchObject({ ok: false, code: 'unauthenticated' });
  });

  it('a second set of certs in the same thread is refused (one team per stack)', () => {
    expect(() => installAccessCerts(newAccessKeys().certs)).toThrow(/already serves other Access certs/u);
  });
});

/** Every file under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

describe('the admin Worker has no test hook for the stand-in (D873)', () => {
  it('no `__e2e`, bypass, stand-in name or stack import anywhere under apps/admin/src', () => {
    const found: string[] = [];
    for (const f of files(ADMIN_SRC)) {
      const text = readFileSync(f, 'utf8');
      // (`bypassSuppressions` is SendGrid's, D401: a bypass of anything to do with signing in is what is looked for.)
      for (const re of [/__e2e/u, /(?:access|auth|staff|csrf|jwt|token)[\s_-]*bypass|bypass[\s_-]*(?:access|auth|staff|csrf|jwt|token)/iu, /e2e-access/u, /e2e\.invalid/u, /apps\/e2e|\.\.\/e2e\//u, /HANA_E2E/u, /skip(?:Access|Auth|Csrf)/iu]) if (re.test(text)) found.push(`${f.slice(ADMIN_SRC.length)}: ${re}`);
    }
    expect(found).toEqual([]);
    // The staff check reads only its three vars and the request's header: no env name, network or flag can turn it off.
    const access = readFileSync(join(ADMIN_SRC, 'access.ts'), 'utf8');
    expect(new Set([...access.matchAll(/env\.([A-Z_]+)/gu)].map((m) => m[1]))).toEqual(new Set(['ACCESS_AUD', 'ACCESS_TEAM_DOMAIN', 'STAFF_EMAILS']));
  });

  it('the stand-in’s names appear in no app’s source, only under apps/e2e', () => {
    const apps = fileURLToPath(new URL('../../', import.meta.url));
    const found: string[] = [];
    for (const app of readdirSync(apps).filter((a) => a !== 'e2e')) {
      const src = join(apps, app, 'src');
      if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const f of files(src)) if (/e2e-access\.invalid|\/__e2e\/access\/|\/__e2e\/lane\//u.test(readFileSync(f, 'utf8'))) found.push(f.slice(apps.length));
    }
    expect(found).toEqual([]);
  });
});

describe('the lane’s chain (lane-evm.ts)', () => {
  const rpc = async (evm: LaneEvm, method: string, params: unknown[] = []) => {
    const res = await evm.handler()(new Request('http://evm.admin-lane.localhost/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    return (await res.json()) as { result?: unknown; error?: { message: string } };
  };
  const signed = async (key: `0x${string}`, nonce: number) => privateKeyToAccount(key).signTransaction({ chainId: 31337, type: 'eip1559', nonce, to: privateKeyToAccount(key).address, value: 0n, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n });

  it('answers the pinned delegate’s real runtime code (its hash is core’s pin)', async () => {
    expect(keccak256(delegateRuntimeCode())).toBe((SPONSOR_DELEGATES[31337] as { runtimeCodeHash: string }).runtimeCodeHash);
    const evm = new LaneEvm(generatePrivateKey());
    expect((await rpc(evm, 'eth_getCode', [E2E_SPONSOR_DELEGATE, 'latest'])).result).toBe(delegateRuntimeCode());
  });

  it('hold pools the relayer’s transactions (pending ahead of latest); release mines them in nonce order', async () => {
    const key = generatePrivateKey();
    const me = privateKeyToAccount(key).address;
    const evm = new LaneEvm(key);
    evm.hold = true;
    const a = await rpc(evm, 'eth_sendRawTransaction', [await signed(key, 0)]);
    expect(a.result).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(await rpc(evm, 'eth_sendRawTransaction', [await signed(key, 0)])).toMatchObject({ error: { message: 'transaction already imported' } });
    expect([(await rpc(evm, 'eth_getTransactionCount', [me, 'latest'])).result, (await rpc(evm, 'eth_getTransactionCount', [me, 'pending'])).result]).toEqual(['0x0', '0x1']);
    expect((await rpc(evm, 'eth_getTransactionReceipt', [a.result])).result).toBeNull();
    expect(await evm.release()).toBe(1);
    expect((await rpc(evm, 'eth_getTransactionCount', [me, 'latest'])).result).toBe('0x1');
    expect((await rpc(evm, 'eth_getTransactionReceipt', [a.result])).result).toMatchObject({ status: '0x1' });
    expect(await rpc(evm, 'eth_sendRawTransaction', [await signed(key, 0)])).toMatchObject({ error: { message: 'nonce too low' } });
  });

  it('refuse answers as a node does for an unfunded sender; foreign takes a slot the relayer’s pooled one waited in', async () => {
    const key = generatePrivateKey();
    const evm = new LaneEvm(key);
    evm.refuse = true;
    expect(await rpc(evm, 'eth_sendRawTransaction', [await signed(key, 0)])).toMatchObject({ error: { message: 'Insufficient funds for gas * price + value' } });
    evm.refuse = false;
    evm.hold = true;
    await rpc(evm, 'eth_sendRawTransaction', [await signed(key, 0)]);
    await evm.foreign(0);
    expect(evm.view()).toMatchObject({ latest: 1, pending: 1, pooled: [] });
    const pooled = await evm.foreign(1, { pool: true });
    expect(evm.view()).toMatchObject({ latest: 1, pending: 2, pooled: [{ nonce: 1, foreign: true }] });
    expect(evm.drop(pooled)).toBe(true);
    expect(evm.view()).toMatchObject({ latest: 1, pending: 1, pooled: [] });
  });
});

describe('the lane’s clock (lane-clock.ts)', () => {
  afterEach(resetLaneClock);

  it('moves only forward, and back to real time only on a reset', () => {
    const before = laneNow();
    advanceLaneClock(60_000);
    expect(laneClockOffset()).toBe(60_000);
    expect(laneNow() - before).toBeGreaterThanOrEqual(60_000);
    expect(() => advanceLaneClock(-1)).toThrow();
    resetLaneClock();
    expect(laneClockOffset()).toBe(0);
  });
});

describe('the lane’s ledger: PGlite behind the wire-protocol listener (pglite-wire.ts)', () => {
  /** The admin Worker's own `pg` (apps/admin's dependency), as its ledger and ops stores connect. */
  const pg = createRequire(new URL('../../admin/package.json', import.meta.url))('pg') as { Client: new (o: { connectionString: string }) => { connect(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } };

  it('the admin’s pg client connects as usage_admin with its real grants; connections take turns, a left-open transaction rolled back', async () => {
    const db = new PGlite() as unknown as PGliteLike & { close(): Promise<void> };
    const dir = new URL('../../api/migrations-usage/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
    const wire = new LedgerWire(db, 'usage_admin');
    const url = await wire.listen();
    expect(url).toMatch(/^postgresql:\/\/usage_admin:[^@]+@127\.0\.0\.1:\d+\/usage$/u);
    try {
      const a = new pg.Client({ connectionString: url });
      await a.connect();
      expect((await a.query('SELECT current_user AS u, $1::int + 1 AS n', [41])).rows).toEqual([{ u: 'usage_admin', n: 42 }]);
      // The role's grants hold: it may not write an event.
      await expect(a.query("INSERT INTO usage.events (request_id) VALUES ('x')")).rejects.toThrow(/permission denied/u);
      // A second client waits for the first, which leaves a transaction open and goes.
      const b = new pg.Client({ connectionString: url });
      const bReady = b.connect();
      await a.query('BEGIN');
      await a.query("SET LOCAL application_name = 'left-open'");
      await a.end();
      await bReady;
      expect((await b.query("SELECT current_user AS u, current_setting('application_name') AS app")).rows).toEqual([{ u: 'usage_admin', app: '' }]);
      await b.end();
    } finally {
      wire.close();
      await db.close();
    }
  });
});

describe('the Gas sponsorship page’s path (D879)', () => {
  it('staff-demo prints, and the specs open, the path the admin Worker links its tile to', async () => {
    const { evmRelayPath } = (await import(new URL('../../admin/src/evm-relay.ts', import.meta.url).href)) as { evmRelayPath(id: number): string };
    expect(evmRelayPath(31337)).toBe('/gas-sponsorship/31337');
    const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(read('../src/staff-demo.ts')).toContain('${lane}/gas-sponsorship/31337');
    expect(read('../tests/admin-fixtures.ts')).toContain('export const DETAIL = `/gas-sponsorship/${CHAIN}`;');
    // The old path is nowhere in the suite (nothing of the page was deployed under it: no redirect is kept).
    const root = fileURLToPath(new URL('../', import.meta.url));
    const old = ['src', 'tests', 'test']
      .flatMap((d) => files(join(root, d)))
      .filter((f) => !f.endsWith('admin-lane.test.ts') && readFileSync(f, 'utf8').includes('free-network-fees'));
    expect(old).toEqual([]);
  });
});
