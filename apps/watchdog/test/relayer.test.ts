// Relayer funds monitoring (read-only): the relayer account's available balance and each pool key's allowance against
// their thresholds, as condition alerts that resolve once refilled; never a transaction.
import { describe, expect, it } from 'vitest';
import { alertText } from '../src/alerts.ts';
import { formatNear, level, nearToYocto, relayerFundsFrom, relayerThresholds } from '../src/relayer.ts';
import { alertsOf, initialized, NEAR, OWNER_POOL_KEY, OWNER_POOL_METHODS, RELAYER, relayerKey, SESSION_KEYS, SESSION_METHODS, SIGNER } from './helpers.ts';

const open = async (w: Awaited<ReturnType<typeof initialized>>, kind: string) => (await alertsOf(w.store, kind)).filter((a) => a.resolved_at === null);
const channelsOf = (w: Awaited<ReturnType<typeof initialized>>, kind: string) => w.notifier.sent.filter((s) => s.msg.kind === kind).map((s) => s.channel).sort();

describe('relayer.ts', () => {
  it('converts and formats NEAR amounts', () => {
    expect(nearToYocto(2)).toBe(2n * NEAR);
    expect(nearToYocto(0.02)).toBe(2n * 10n ** 22n);
    expect(nearToYocto(0)).toBe(0n);
    expect(() => nearToYocto(-1)).toThrow();
    expect(() => nearToYocto(Number.NaN)).toThrow();
    expect(formatNear(2n * NEAR)).toBe('2 NEAR');
    expect(formatNear(15n * 10n ** 23n)).toBe('1.5 NEAR');
    expect(formatNear(2n * 10n ** 22n)).toBe('0.02 NEAR');
    expect(formatNear(0n)).toBe('0 NEAR');
    expect(formatNear(5n)).toBe('<0.0001 NEAR');
  });

  it('reads thresholds: defaults, overrides per pair, and a fallback for anything invalid', () => {
    const d = relayerThresholds(undefined);
    expect(d.problems).toEqual([]);
    expect(d.thresholds).toEqual({
      balance: { warn: 5n * NEAR, critical: NEAR },
      session: { warn: nearToYocto(0.5), critical: nearToYocto(0.1) },
      owner: { warn: nearToYocto(0.1), critical: nearToYocto(0.02) },
    });
    const o = relayerThresholds(JSON.stringify({ balance: { warn: 20, critical: 3 } }));
    expect(o.thresholds.balance).toEqual({ warn: 20n * NEAR, critical: 3n * NEAR });
    expect(o.thresholds.session).toEqual(d.thresholds.session);
    expect(relayerThresholds('{nope').problems[0]).toMatch(/not JSON/u);
    expect(relayerThresholds('[1]').problems[0]).toMatch(/not a JSON object/u);
    const bad = relayerThresholds(JSON.stringify({ sessionAllowance: { warn: 0.1, critical: 0.5 }, ownerAllowance: 'x' }));
    expect(bad.thresholds).toEqual(d.thresholds);
    expect(bad.problems).toHaveLength(2);
  });

  it('builds a reading: available = amount minus storage; pool keys by methods; other keys listed, never judged', () => {
    const f = relayerFundsFrom(RELAYER, SIGNER, { amount: (3n * NEAR).toString(), locked: '0', storage_usage: 1000 }, [
      { public_key: 'ed25519:full', access_key: { permission: 'FullAccess' } },
      relayerKey('ed25519:s1', SESSION_METHODS, 2),
      relayerKey('ed25519:o1', OWNER_POOL_METHODS, null),
      relayerKey('ed25519:u1', ['set_issuer_key'], 1),
      { public_key: 'ed25519:elsewhere', access_key: { permission: { FunctionCall: { allowance: '1', receiver_id: 'other.near', method_names: ['derive_key'] } } } },
      { public_key: 'ed25519:junk', access_key: { permission: { FunctionCall: { allowance: '-5', receiver_id: SIGNER, method_names: ['derive_key'] } } } },
    ]);
    expect(f.available).toBe((3n * NEAR - 10n ** 22n).toString());
    expect(f.keys).toEqual([
      { public_key: 'ed25519:s1', pool: 'session', allowance: (2n * NEAR).toString() },
      { public_key: 'ed25519:o1', pool: 'owner', allowance: null },
    ]);
    expect(f.other_keys).toEqual(['ed25519:u1', 'ed25519:junk']);
    // No account, or storage above the amount: nothing available.
    expect(relayerFundsFrom(RELAYER, SIGNER, null, [])).toMatchObject({ exists: false, available: '0', keys: [] });
    expect(relayerFundsFrom(RELAYER, SIGNER, { amount: '5', storage_usage: 1000 }, []).available).toBe('0');
    expect(level(5n, { warn: 10n, critical: 5n })).toBe('warn');
    expect(level(4n, { warn: 10n, critical: 5n })).toBe('critical');
    expect(level(10n, { warn: 10n, critical: 5n })).toBe('ok');
  });
});

describe('relayer_funds check', () => {
  it('is quiet for a funded relayer and reports the pools in /status data', async () => {
    const w = await initialized();
    const r = await w.run();
    expect(r.alerts).toEqual([]);
    const check = r.checks.find((c) => c.id === 'relayer_funds');
    expect(check).toMatchObject({ outcome: 'ok' });
    expect(check?.detail).toContain('49.99 NEAR available; pool keys: 3 session, 1 owner');
    const meta = await w.store.getMeta<{ account: string; keys: unknown[]; thresholds: { balance: { warn: string } } }>('relayer_funds');
    expect(meta?.account).toBe(RELAYER);
    expect(meta?.keys).toHaveLength(4);
    expect(meta?.thresholds.balance.warn).toBe((5n * NEAR).toString());
  });

  it('warns below the warning balance, escalates to critical, and resolves once refilled; never sends a transaction', async () => {
    const w = await initialized();
    w.chain.setBalance(4);
    await w.run();
    const [low] = await open(w, 'relayer_balance_low');
    expect(low).toMatchObject({ severity: 'warning', details: { account: RELAYER, available: '4 NEAR', warn_below: '5 NEAR', critical_below: '1 NEAR' } });
    expect(channelsOf(w, 'relayer_balance_low')).toEqual(['email', 'slack']);
    // Still low: the same alert, not a new one.
    await w.run();
    expect(await alertsOf(w.store, 'relayer_balance_low')).toHaveLength(1);

    w.chain.setBalance(0.5);
    w.notifier.clear();
    await w.run();
    const [crit] = await open(w, 'relayer_balance_critical');
    expect(crit?.severity).toBe('critical');
    expect(crit?.title).toContain('0.5 NEAR available (critical below 1 NEAR)');
    expect(channelsOf(w, 'relayer_balance_critical')).toEqual(['email', 'pager', 'slack']);
    expect(await open(w, 'relayer_balance_low')).toEqual([]);

    w.chain.setBalance(30);
    await w.run();
    expect(await open(w, 'relayer_balance_critical')).toEqual([]);
    expect(await open(w, 'relayer_balance_low')).toEqual([]);
    expect(w.writer.calls).toEqual([]);
  });

  it('alerts per pool key on its allowance, with the pool thresholds, and resolves when the key is replaced', async () => {
    const w = await initialized();
    w.chain.setAllowance(SESSION_KEYS[0]!, 0.4);
    w.chain.setAllowance(SESSION_KEYS[1]!, 0.05);
    w.chain.setAllowance(OWNER_POOL_KEY, 0.08);
    await w.run();
    const low = await open(w, 'relayer_allowance_low');
    expect(low.map((a) => a.details.public_key).sort()).toEqual([SESSION_KEYS[0], OWNER_POOL_KEY].sort());
    expect(low.find((a) => a.details.pool === 'owner')?.details).toMatchObject({ allowance: '0.08 NEAR', warn_below: '0.1 NEAR', critical_below: '0.02 NEAR' });
    const [crit] = await open(w, 'relayer_allowance_critical');
    expect(crit?.details).toMatchObject({ pool: 'session', public_key: SESSION_KEYS[1], allowance: '0.05 NEAR' });
    expect(crit?.title).toContain('critical below 0.1 NEAR');

    // deploy-contract replaces the used-up key with a new one at the full allowance.
    w.chain.relayer.keys = w.chain.relayer.keys.filter((k) => k.public_key !== SESSION_KEYS[1]);
    w.chain.relayer.keys.push(relayerKey('ed25519:NewSessionKey11111111111111111111111111111111', SESSION_METHODS, 2));
    await w.run();
    expect(await open(w, 'relayer_allowance_critical')).toEqual([]);
    expect(await open(w, 'relayer_allowance_low')).toHaveLength(2);
    expect(w.writer.calls).toEqual([]);
  });

  it("doesn't judge an unlimited allowance (the balance bounds it)", async () => {
    const w = await initialized();
    w.chain.setAllowance(OWNER_POOL_KEY, null);
    const r = await w.run();
    expect(r.alerts).toEqual([]);
  });

  it('pages critical for a pool with no key, and for a relayer account that does not exist', async () => {
    const w = await initialized();
    w.chain.relayer.keys = w.chain.relayer.keys.filter((k) => k.public_key !== OWNER_POOL_KEY);
    await w.run();
    const [empty] = await open(w, 'relayer_pool_empty');
    expect(empty).toMatchObject({ severity: 'critical', key: 'relayer_pool_empty:owner', details: { pool: 'owner', receiver: SIGNER } });

    w.chain.relayer = { view: null, keys: [] };
    await w.run();
    expect((await open(w, 'relayer_pool_empty')).map((a) => a.details.pool).sort()).toEqual(['owner', 'session']);
    const [gone] = await open(w, 'relayer_balance_critical');
    expect(gone?.title).toBe(`Relayer account ${RELAYER} does not exist: every relay fails`);
  });

  it('a failed relayer read degrades the run and leaves open alerts open', async () => {
    const w = await initialized();
    w.chain.setBalance(0.2);
    await w.run();
    expect(await open(w, 'relayer_balance_critical')).toHaveLength(1);
    w.chain.failRelayer = true;
    const r = await w.run();
    expect(r.outcome).toBe('degraded');
    expect(r.checks.find((c) => c.id === 'relayer_funds')).toMatchObject({ outcome: 'error', detail: 'relayer account read failed' });
    expect(await open(w, 'relayer_balance_critical')).toHaveLength(1);
  });

  it('is skipped without a relayer account or a chain read', async () => {
    const w = await initialized();
    w.deps.config.relayer = null;
    let r = await w.run();
    expect(r.checks.find((c) => c.id === 'relayer_funds')).toMatchObject({ outcome: 'skipped', detail: 'RELAYER_ACCOUNT not set' });
    expect(w.chain.relayerReads).toBe(1); // only the initialising run read it
    w.deps.config.relayer = RELAYER;
    w.chain.chain = 'mainnet';
    r = await w.run();
    expect(r.checks.find((c) => c.id === 'relayer_funds')).toMatchObject({ outcome: 'skipped', detail: 'no chain read' });
  });

  it('shows invalid thresholds in the config check, and uses the defaults', async () => {
    const w = await initialized();
    w.deps.config.relayerThresholds = relayerThresholds('{"balance":{"warn":1,"critical":2}}');
    w.chain.setBalance(4);
    const r = await w.run();
    expect(r.checks.find((c) => c.id === 'config')?.detail).toContain('RELAYER_FUNDS.balance is invalid');
    expect(await open(w, 'relayer_balance_low')).toHaveLength(1);
  });

  it('alert texts are printable and name the playbook; on-chain key strings are escaped', async () => {
    const w = await initialized();
    const hostile = 'ed25519:bad\nkey <!channel>';
    w.chain.relayer.keys.push(relayerKey(hostile, SESSION_METHODS, 0.01));
    await w.run();
    const [crit] = await open(w, 'relayer_allowance_critical');
    expect(crit?.title).not.toMatch(/[\r\n]/u);
    expect(crit?.title).toContain('"ed25519:bad\\nkey <!channel>"');
    const text = alertText(crit!, 'sandbox-test');
    for (const line of text.split('\n')) expect(line).toMatch(/^[\x20-\x7e]*$/u);
    expect(text).toContain('Playbook: relayer-out-of-funds');
  });
});
