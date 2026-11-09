// Every rule of docs/governance-spec.md "Watchdog service" steps 3–8 and every action D82 allows, against a stub
// chain, a scripted JWKS and recording channels.
import { describe, expect, it } from 'vitest';
import type { KeyChange } from '../src/chain.ts';
import {
  ABSENCE_RECHECK_MS,
  ABSENT_FETCHES_TO_ACT,
  NEW_KID_CANCEL_LEAD_MS,
  NEW_KID_GRACE_MS,
  newKidDeadline,
  REMOVAL_ABSENT_SPAN_MS,
  REMOVAL_UNSEEN_MS,
  RETIRED_ABSENT_SPAN_MS,
  RETIRED_KEY_GRACE_MS,
  RETIRED_MIN_KEY_AGE_MS,
  RETIRED_UNSEEN_MS,
  removalConfirmable,
  retiredAddDue,
  retiredAt,
} from '../src/run.ts';
import { alertsOf, councilPolicy, HOUR, initialized, jwk, MIN, NO_GRACE, OWNER, retiredLongAgo, runsOverRetiredSpan, SIGNER, T0, UPDATER_KEYS, WATCHDOG, world } from './helpers.ts';

const channelsOf = (w: { notifier: { sent: { channel: string; msg: { kind: string } }[] } }, kind: string) =>
  w.notifier.sent.filter((s) => s.msg.kind === kind).map((s) => s.channel).sort();

describe('pending additions (step 3)', () => {
  it('confirms a pending key that matches Google’s JWKS', async () => {
    const k2 = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1), k2] });
    const c = w.chain.propose('Add', 'k2', { key: k2 });
    const r = await w.run();
    expect(w.writer.calls).toEqual([{ method: 'confirm_issuer_key_change', args: { id: c.id } }]);
    expect(w.chain.active.has('k2')).toBe(true);
    const [confirmed] = await alertsOf(w.store, 'key_change_confirmed');
    expect(confirmed?.severity).toBe('info');
    // Info goes to the status endpoint and the digest only.
    expect(w.notifier.sent).toEqual([]);
    expect(r.checks.find((x) => x.id === 'pending_key_changes')?.outcome).toBe('ok');
  });

  it('compares key material after stripping leading zeros', async () => {
    const onChain = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1), jwk('k2', 2, true)] });
    w.chain.propose('Add', 'k2', { key: onChain });
    await w.run();
    expect(w.writer.methods()).toEqual(['confirm_issuer_key_change']);
  });

  it("doesn't confirm before its confirm_from_ms, but still cancels and pauses", async () => {
    const w = await initialized({ jwks: [jwk('k1', 1), jwk('k2', 2)] });
    w.chain.governance.watchdogs = [{ account_id: WATCHDOG, confirm_from_ms: w.clock.t + HOUR }];
    w.chain.propose('Add', 'k2', { key: jwk('k2', 2) });
    w.chain.propose('Add', 'k3', { key: jwk('k3', 3) });
    w.jwks.keys = [jwk('k1', 1), jwk('k2', 2), jwk('k3', 30)];
    const r = await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key']);
    expect(r.checks.find((x) => x.id === 'watchdog_role')?.detail).toContain('confirms from');
  });

  it('cancels a key with other key material, deletes every updater key (updater proposed) and pages critical', async () => {
    const w = await initialized();
    const forged = w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    const r = await w.run();
    expect(w.writer.calls).toEqual([
      { method: 'cancel_issuer_key_change', args: { id: forged.id } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[0] } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[1] } },
    ]);
    expect(w.chain.changes).toEqual([]);
    expect(w.chain.governance.updater_keys).toEqual([]);
    // Never a pause for a pending key (D82: pause only when such a key is active).
    expect(w.chain.config.paused).toBe(false);
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.severity).toBe('critical');
    expect(alert?.details).toMatchObject({ id: forged.id, kid: 'k1x', reason: 'other_key_material', updater_proposed: true });
    expect((alert?.details.actions as { method: string; ok: boolean }[]).map((a) => [a.method, a.ok])).toEqual([
      ['cancel_issuer_key_change', true],
      ['delete_updater_key', true],
      ['delete_updater_key', true],
    ]);
    expect(channelsOf(w, 'forged_key_change')).toEqual(['email', 'pager', 'slack']);
    expect(r.actions.map((a) => a.ok)).toEqual([true, true, true]);
    // The actions log has each transaction.
    expect((await w.store.listActions(null, 10)).map((a) => [a.method, a.tx_hash])).toEqual([
      ['delete_updater_key', 'tx3'],
      ['delete_updater_key', 'tx2'],
      ['cancel_issuer_key_change', 'tx1'],
    ]);
  });

  it('cancels an owner-posted forged key without deleting updater keys', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'k1', { key: jwk('k1', 66), by: OWNER });
    w.chain.active.clear(); // so the kid isn't active (the contract refuses a pending add of an active kid)
    w.chain.active.set('k0', { n: jwk('k0', 0).n, e: 'AQAB' });
    w.jwks.keys = [jwk('k1', 1), jwk('k0', 0)];
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.details).toMatchObject({ by: OWNER, updater_proposed: false });
  });

  it('cancels a kid absent from two fetches at least 60 s apart, in the same run', async () => {
    const w = await initialized();
    const forged = w.chain.propose('Add', 'ghost', NO_GRACE);
    const fetchesBefore = w.jwks.fetches;
    await w.run();
    expect(w.sleeps).toEqual([ABSENCE_RECHECK_MS]);
    expect(w.jwks.fetches - fetchesBefore).toBe(2);
    expect(w.writer.calls[0]).toEqual({ method: 'cancel_issuer_key_change', args: { id: forged.id } });
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.details).toMatchObject({ reason: 'not_published' });
  });

  it('does nothing when the kid shows up on the second fetch, and confirms it if it matches', async () => {
    const k2 = jwk('k2', 2);
    const w = await initialized();
    w.chain.propose('Add', 'k2', { key: k2 });
    w.jwks.queue = [[jwk('k1', 1)], [jwk('k1', 1), k2]];
    await w.run();
    expect(w.writer.methods()).toEqual(['confirm_issuer_key_change']);
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([]);
  });

  it('waits for the next run when the second fetch fails, then cancels without another wait', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'ghost', NO_GRACE);
    w.jwks.queue = [[jwk('k1', 1)], 'fail'];
    await w.run();
    expect(w.writer.calls).toEqual([]);
    w.sleeps.length = 0;
    await w.run();
    // The absence recorded 5 min ago and this fetch are ≥ 60 s apart.
    expect(w.sleeps).toEqual([]);
    expect(w.writer.methods()[0]).toBe('cancel_issuer_key_change');
  });

  it('retries a failed cancel, keeps one condition alert, and alerts each later action', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66), by: OWNER });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    w.writer.fail.add('cancel_issuer_key_change');
    await w.run();
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'cancel_issuer_key_change']);
    expect(await alertsOf(w.store, 'protective_action_failed')).toHaveLength(1);
    expect(await alertsOf(w.store, 'forged_key_change')).toHaveLength(1);
    w.writer.fail.clear();
    await w.run();
    expect(w.chain.changes).toEqual([]);
    const repeat = await alertsOf(w.store, 'automatic_action');
    expect(repeat.map((a) => a.severity)).toEqual(['critical']);
    // The failure condition is resolved once the cancel went through.
    await w.run();
    expect((await alertsOf(w.store, 'protective_action_failed'))[0]?.resolved_at).not.toBeNull();
  });

  it("doesn't call a cancel of a change someone else cancelled first a failed protection, nor say it cancelled it", async () => {
    const w = await initialized();
    const first = w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    // The owner cancels between the watchdog's read and its cancel.
    w.writer.before = (method, args) => {
      if (method === 'cancel_issuer_key_change') w.chain.changes = w.chain.changes.filter((c) => c.id !== args.id);
    };
    w.writer.fail.add('cancel_issuer_key_change').add('delete_updater_key');
    w.writer.failError = 'Smart contract panicked: No such key change';
    await w.run();
    // Another forgery; its cancel goes through, but the owner already deleted the updater keys.
    w.writer.before = null;
    w.writer.fail.delete('cancel_issuer_key_change');
    w.writer.failError = 'Smart contract panicked: Not an updater key';
    w.chain.propose('Add', 'k1y', { key: jwk('k1y', 67) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7), jwk('k1y', 8)];
    await w.run();
    expect(await alertsOf(w.store, 'protective_action_failed')).toEqual([]);
    const forged = (await alertsOf(w.store, 'forged_key_change')).find((a) => a.details.id === first.id);
    expect(forged?.title).toContain('already gone from the queue without taking effect');
    expect(forged?.title).not.toContain('; cancelled');
    expect(forged?.details.outcome).toBe('gone');
  });

  it('re-reads the chain when the cancel finds the change gone: an executed forgery is a failed protection, and pauses', async () => {
    const w = await initialized();
    const forged = w.chain.propose('Add', 'ghost', { key: jwk('ghost', 50), ...NO_GRACE });
    // Someone executes the forged change between the watchdog's read and its cancel.
    w.writer.before = (method, args) => {
      if (method === 'cancel_issuer_key_change') w.chain.execute(args.id as number);
    };
    w.writer.fail.add('cancel_issuer_key_change');
    w.writer.failError = 'Smart contract panicked: No such key change';
    await w.run();
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.title).toContain('EXECUTED before the watchdog could cancel it');
    expect(alert?.title).not.toContain('; cancelled');
    expect(alert?.details.outcome).toBe('executed');
    const [failed] = await alertsOf(w.store, 'protective_action_failed');
    expect(failed?.severity).toBe('critical');
    expect(failed?.title).toBe(`Forged key change ${forged.id} (Add google ghost) was executed before the watchdog could cancel it`);
    // The updater proposed it: its keys are deleted all the same; and the now-active key pauses the contract in
    // this same run (step 5 judges the re-read active set).
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key', 'pause']);
    expect(w.chain.config.paused).toBe(true);
    expect((await alertsOf(w.store, 'forged_active_key'))[0]?.title).toContain('Active issuer key ghost');
  });

  it("alerts a failed protection when the cancel finds the change gone and the re-read fails; never claims it cancelled", async () => {
    const w = await initialized();
    w.chain.propose('Add', 'ghost', { key: jwk('ghost', 50), by: OWNER });
    w.writer.before = (method) => {
      if (method === 'cancel_issuer_key_change') w.chain.failReads = true;
    };
    w.writer.fail.add('cancel_issuer_key_change');
    w.writer.failError = 'Smart contract panicked: No such key change';
    await w.run();
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.details.outcome).toBe('unknown');
    expect(alert?.title).toContain('could not tell whether it was executed');
    expect(await alertsOf(w.store, 'protective_action_failed')).toHaveLength(1);
  });

  it('says the cancel failed (not "cancelled") when it did', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'ghost', { key: jwk('ghost', 50), by: OWNER });
    w.writer.fail.add('cancel_issuer_key_change');
    await w.run();
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.title).toMatch(/; the cancel failed$/u);
    expect(alert?.details.outcome).toBe('failed');
  });
});

describe("a key Google just retired (D153)", () => {
  // Google published k2 at the first run; it's gone now, and the API cron's fetch still had it when it proposed.
  async function retiring() {
    const k2 = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1), k2] });
    w.jwks.keys = [jwk('k1', 1)];
    return { w, k2 };
  }

  it("cancels the updater's Add of a provably retired kid (D422: known > 7 days, unlisted > 6 h, missed by fetches over 30 min), keeps the updater keys, warns", async () => {
    const k2 = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1), k2] });
    await retiredLongAgo(w, [jwk('k1', 1)]);
    const lastListed = w.clock.t - RETIRED_UNSEEN_MS - 5 * MIN;
    const c = w.chain.propose('Add', 'k2', { key: k2 });
    // The first run (two fetches 60 s apart) and the ones before 30 min of absences only wait.
    await w.run();
    expect(w.writer.calls).toEqual([]);
    await runsOverRetiredSpan(w);
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
    expect(w.writer.calls[0]?.args).toEqual({ id: c.id });
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([]);
    const [alert] = await alertsOf(w.store, 'retired_key_change');
    expect(alert?.severity).toBe('warning');
    expect(alert?.title).toContain('updater key kept');
    expect(alert?.details).toMatchObject({ id: c.id, kid: 'k2', outcome: 'cancelled', last_seen_jwks_at: lastListed });
    expect(channelsOf(w, 'retired_key_change')).toEqual(['email', 'slack']);
  });

  it("doesn't cancel a new kid that flickers in Google's JWKS (seen 30 min ago, missing from both fetches), and confirms it once a fetch lists it (D422)", async () => {
    const k2 = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1)] });
    // Google's edges mid-rollout: one fetch lists k2, the next ones don't.
    w.jwks.keys = [jwk('k1', 1), k2];
    await w.run();
    w.jwks.keys = [jwk('k1', 1)];
    w.clock.t += 25 * MIN;
    const c = w.chain.propose('Add', 'k2', { key: k2 });
    for (let i = 0; i < 6; i++) await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await alertsOf(w.store, 'retired_key_change')).toEqual([]);
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([]);
    expect(w.chain.governance.updater_keys).toEqual(UPDATER_KEYS);
    w.jwks.queue = [[jwk('k1', 1), k2]];
    await w.run();
    expect(w.writer.calls).toEqual([{ method: 'confirm_issuer_key_change', args: { id: c.id } }]);
  });

  it('retiredAddDue needs all three: unlisted ≥ 6 h, known ≥ 7 days, ≥ 3 absent fetches over ≥ 30 min', () => {
    const now = T0 + 30 * 24 * HOUR;
    const seen = { provider: 'google', kid: 'k2', n: 'n', e: 'AQAB', source: 'jwks' as const, first_seen_at: now - RETIRED_MIN_KEY_AGE_MS, last_seen_at: now - RETIRED_UNSEEN_MS };
    const absence = { first: now - RETIRED_ABSENT_SPAN_MS, fetches: ABSENT_FETCHES_TO_ACT };
    expect(retiredAddDue(seen, absence, now)).toBe(true);
    expect(retiredAddDue({ ...seen, last_seen_at: now - RETIRED_UNSEEN_MS + 1 }, absence, now)).toBe(false);
    expect(retiredAddDue({ ...seen, first_seen_at: now - RETIRED_MIN_KEY_AGE_MS + 1 }, absence, now)).toBe(false);
    expect(retiredAddDue(seen, { ...absence, fetches: ABSENT_FETCHES_TO_ACT - 1 }, now)).toBe(false);
    expect(retiredAddDue(seen, { ...absence, first: now - RETIRED_ABSENT_SPAN_MS + 1 }, now)).toBe(false);
    expect(retiredAddDue(seen, undefined, now)).toBe(false);
  });

  it('treats the same kid with other key material as forged', async () => {
    const { w } = await retiring();
    w.chain.propose('Add', 'k2', { key: jwk('k2', 66) });
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', ...UPDATER_KEYS.map(() => 'delete_updater_key')]);
    expect(await alertsOf(w.store, 'retired_key_change')).toEqual([]);
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.details).toMatchObject({ reason: 'not_published', updater_proposed: true });
  });

  it("falls back to forged when the watchdog can't read what Google published", async () => {
    const { w, k2 } = await retiring();
    w.chain.propose('Add', 'k2', { key: k2 });
    const real = w.store.seenKids.bind(w.store);
    let reads = 0;
    w.store.seenKids = async (p) => {
      if (reads++ === 0) throw new Error('D1 down');
      return real(p);
    };
    await w.run();
    expect(w.writer.methods()).toContain('delete_updater_key');
    expect(await alertsOf(w.store, 'forged_key_change')).toHaveLength(1);
  });

  it('treats a kid Google last published more than 24 h ago as forged', async () => {
    const { w, k2 } = await retiring();
    w.clock.t += RETIRED_KEY_GRACE_MS + MIN;
    w.chain.propose('Add', 'k2', { key: k2 });
    await w.run();
    expect(w.writer.methods()).toContain('delete_updater_key');
    expect(await alertsOf(w.store, 'forged_key_change')).toHaveLength(1);
  });

  it("keeps the owner's Add of a retired kid on the forged path (it never deletes updater keys)", async () => {
    const { w, k2 } = await retiring();
    w.chain.propose('Add', 'k2', { key: k2, by: OWNER });
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
    expect(await alertsOf(w.store, 'forged_key_change')).toHaveLength(1);
  });

  it('retiredAt ignores baseline kids, kids without material, and changes without material', () => {
    const c = { id: 1, provider: 'google', kid: 'k2', op: 'Add', by: SIGNER, proposed_at_ms: T0, executable_at_ms: T0, n: jwk('k2', 2).n, e: 'AQAB' } as KeyChange;
    const seen = { provider: 'google', kid: 'k2', n: jwk('k2', 2).n, e: 'AQAB', source: 'jwks' as const, first_seen_at: T0, last_seen_at: T0 };
    expect(retiredAt(seen, c, T0 + HOUR)).toBe(T0);
    expect(retiredAt({ ...seen, source: 'baseline', last_seen_at: null }, c, T0)).toBeNull();
    expect(retiredAt({ ...seen, n: null }, c, T0)).toBeNull();
    expect(retiredAt(seen, { ...c, n: null }, T0)).toBeNull();
    expect(retiredAt(undefined, c, T0)).toBeNull();
  });
});

describe('a new kid the watchdog has not seen yet (D432)', () => {
  const unseenAt = async (w: Awaited<ReturnType<typeof initialized>>) => alertsOf(w.store, 'unseen_key_change');
  /** Runs (every 5 min) while the clock is before `until`; returns the writer calls made meanwhile. */
  async function runUntil(w: Awaited<ReturnType<typeof initialized>>, until: number) {
    while (w.clock.t < until) await w.run();
    return w.writer.calls;
  }

  it('leaves the updater’s Add of a kid no fetch listed pending, warns once, and confirms it when a fetch lists it', async () => {
    const k2 = jwk('k2', 2);
    const w = await initialized();
    // Google's rotation: the API cron's edge serves k2, the watchdog's fetches don't yet.
    const c = w.chain.propose('Add', 'k2', { key: k2, at: w.clock.t });
    const r = await w.run();
    expect(w.sleeps).toEqual([ABSENCE_RECHECK_MS]);
    for (let i = 0; i < 11; i++) await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(w.chain.governance.updater_keys).toEqual(UPDATER_KEYS);
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([]);
    const warnings = await unseenAt(w);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
    expect(warnings[0]?.details).toMatchObject({ id: c.id, kid: 'k2', by: SIGNER, new_kid_deadline_ms: newKidDeadline(c), absent_fetches: 2 });
    expect(channelsOf(w, 'unseen_key_change')).toEqual(['email', 'slack']);
    expect(r.checks.find((x) => x.id === 'pending_key_changes')?.detail).toContain('judged forged at');
    w.jwks.keys = [jwk('k1', 1), k2];
    await w.run();
    expect(w.writer.calls).toEqual([{ method: 'confirm_issuer_key_change', args: { id: c.id } }]);
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([]);
  });

  it('cancels it as forged at its deadline (18 min before it is executable), deletes every updater key, and pages', async () => {
    const w = await initialized();
    const c = w.chain.propose('Add', 'forged', { key: jwk('forged', 77), at: w.clock.t });
    const deadline = newKidDeadline(c);
    expect(deadline).toBe(c.executable_at_ms - NEW_KID_CANCEL_LEAD_MS);
    expect(await runUntil(w, deadline)).toEqual([]);
    const at = w.clock.t;
    await w.run();
    expect(w.writer.calls).toEqual([
      { method: 'cancel_issuer_key_change', args: { id: c.id } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[0] } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[1] } },
    ]);
    // Judged within one run of the deadline: at least two more runs before anyone may execute it.
    expect(at - deadline).toBeLessThan(5 * MIN);
    expect(c.executable_at_ms - at).toBeGreaterThan(2 * (5 * MIN + MIN));
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.severity).toBe('critical');
    expect(alert?.details).toMatchObject({ id: c.id, reason: 'not_published', outcome: 'cancelled', updater_proposed: true, new_kid_deadline_ms: deadline });
    expect(channelsOf(w, 'forged_key_change')).toEqual(['email', 'pager', 'slack']);
    expect(await unseenAt(w)).toHaveLength(1);
  });

  it('newKidDeadline: 6 h after the proposal at most, never later than 18 min before it is executable', () => {
    const c = { id: 1, provider: 'google', kid: 'k', op: 'Add', by: SIGNER, n: 'n', e: 'AQAB', proposed_at_ms: T0, executable_at_ms: T0 + 2 * HOUR } as KeyChange;
    expect(NEW_KID_CANCEL_LEAD_MS).toBe(18 * MIN);
    expect(NEW_KID_GRACE_MS).toBe(6 * HOUR);
    // Mainnet's provisional 2 h delay: 1 h 42 min of grace.
    expect(newKidDeadline(c)).toBe(T0 + 2 * HOUR - 18 * MIN);
    // The contract's longest delay: the 6 h cap.
    expect(newKidDeadline({ ...c, executable_at_ms: T0 + 7 * 24 * HOUR })).toBe(T0 + 6 * HOUR);
    // At the security bound, and below it (sandbox-dev's 2 min): no grace, judged at once as before D432.
    expect(newKidDeadline({ ...c, executable_at_ms: T0 + 18 * MIN })).toBe(T0);
    expect(newKidDeadline({ ...c, executable_at_ms: T0 + 2 * MIN })).toBeLessThan(T0);
  });

  it('cancels at once, with no grace, on a delay at or below the security bound', async () => {
    const w = await initialized();
    const c = w.chain.propose('Add', 'forged', { key: jwk('forged', 77), at: w.clock.t, delay: 2 * MIN });
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key']);
    expect(await unseenAt(w)).toEqual([]);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.details).toMatchObject({ id: c.id, new_kid_deadline_ms: newKidDeadline(c) });
  });

  it('cancels at once when a fetch in the grace lists the kid with other key material', async () => {
    const w = await initialized();
    const c = w.chain.propose('Add', 'k2', { key: jwk('k2', 2), at: w.clock.t });
    await w.run();
    expect(w.writer.calls).toEqual([]);
    w.jwks.keys = [jwk('k1', 1), jwk('k2', 66)];
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key']);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.details).toMatchObject({ id: c.id, reason: 'other_key_material' });
  });

  it('ends the grace of every unseen Add in a run that finds the updater forging another change', async () => {
    const w = await initialized();
    const unseen = w.chain.propose('Add', 'k2', { key: jwk('k2', 2), at: w.clock.t });
    await w.run();
    expect(await unseenAt(w)).toHaveLength(1);
    const forged = w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66), at: w.clock.t });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    await w.run();
    expect(w.writer.calls).toEqual([
      { method: 'cancel_issuer_key_change', args: { id: forged.id } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[0] } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[1] } },
      { method: 'cancel_issuer_key_change', args: { id: unseen.id } },
    ]);
    const alerts = await alertsOf(w.store, 'forged_key_change');
    expect(alerts.find((a) => a.details.id === unseen.id)?.details).toMatchObject({ reason: 'not_published', grace_ended: 'updater_forged' });
  });

  it('gives no grace when the same run already found the updater forging (here: an email change from the updater)', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'e1', { key: jwk('e1', 5), provider: 'email', at: w.clock.t });
    const unseen = w.chain.propose('Add', 'k2', { key: jwk('k2', 2), at: w.clock.t });
    await w.run();
    expect(w.writer.calls.filter((x) => x.method === 'cancel_issuer_key_change').map((x) => x.args.id)).toContain(unseen.id);
    expect(await unseenAt(w)).toEqual([]);
  });

  it("gives the owner's Add of an unseen kid no grace (cancelled at once, the updater keys kept)", async () => {
    const w = await initialized();
    w.chain.propose('Add', 'k2', { key: jwk('k2', 2), at: w.clock.t, by: OWNER });
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
    expect(await unseenAt(w)).toEqual([]);
  });

  it("gives no grace when the watchdog can't act (people then need the whole delay to cancel)", async () => {
    const w = await initialized({ writer: false });
    w.chain.propose('Add', 'k2', { key: jwk('k2', 2), at: w.clock.t });
    await w.run();
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.details).toMatchObject({ reason: 'not_published', outcome: 'not_sent' });
    expect(await unseenAt(w)).toEqual([]);
  });

  it("gives no grace when it can't read which kids it has seen (fail safe)", async () => {
    const w = await initialized();
    w.chain.propose('Add', 'k2', { key: jwk('k2', 2), at: w.clock.t });
    const real = w.store.seenKids.bind(w.store);
    let reads = 0;
    w.store.seenKids = async (p) => {
      if (reads++ === 0) throw new Error('D1 down');
      return real(p);
    };
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key']);
    expect(await unseenAt(w)).toEqual([]);
  });

  it("past the deadline, cancels on earlier fetches' absences when this run's JWKS fetch fails", async () => {
    const w = await initialized();
    const c = w.chain.propose('Add', 'forged', { key: jwk('forged', 77), at: w.clock.t });
    expect(await runUntil(w, newKidDeadline(c))).toEqual([]);
    w.jwks.queue = ['fail'];
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key']);
    const [alert] = await alertsOf(w.store, 'forged_key_change');
    expect(alert?.details).toMatchObject({ id: c.id, reason: 'not_published', judged_without_fetch: true });
    expect(alert?.details.absent_fetches as number).toBeGreaterThanOrEqual(2);
  });

  it('ends the grace without a fetch too, in a run that finds the updater forging (an email change from it)', async () => {
    const w = await initialized();
    const unseen = w.chain.propose('Add', 'k2', { key: jwk('k2', 2), at: w.clock.t });
    await w.run();
    await w.run();
    expect(w.writer.calls).toEqual([]);
    w.chain.propose('Add', 'e1', { key: jwk('e1', 5), provider: 'email', at: w.clock.t });
    w.jwks.queue = ['fail'];
    await w.run();
    expect(w.writer.calls.filter((x) => x.method === 'cancel_issuer_key_change').map((x) => x.args.id)).toContain(unseen.id);
    expect((await alertsOf(w.store, 'forged_key_change')).find((a) => a.details.id === unseen.id)?.details).toMatchObject({ judged_without_fetch: true, grace_ended: 'updater_forged' });
  });

  it('judges nothing without a fetch when no earlier fetch missed the kid, then cancels on the next good fetch', async () => {
    const w = await initialized();
    // Proposed 1 h 50 min ago while every fetch failed: past its deadline, no absence recorded.
    const c = w.chain.propose('Add', 'forged', { key: jwk('forged', 77), at: w.clock.t - 110 * MIN });
    w.jwks.queue = ['fail'];
    await w.run();
    expect(w.writer.calls).toEqual([]);
    await w.run();
    expect(w.writer.calls[0]).toEqual({ method: 'cancel_issuer_key_change', args: { id: c.id } });
  });

  it("never cancels at the deadline a kid one of its fetches listed (D422's rollout rule): it waits for the delay", async () => {
    const k2 = jwk('k2', 2);
    const w = await initialized();
    // Cancels and pauses at once, but can't confirm yet: a listing then only records the kid as seen.
    w.chain.governance.watchdogs = [{ account_id: WATCHDOG, confirm_from_ms: w.clock.t + 24 * HOUR }];
    const c = w.chain.propose('Add', 'k2', { key: k2, at: w.clock.t });
    await w.run();
    w.jwks.queue = [[jwk('k1', 1), k2]];
    await w.run();
    expect(await runUntil(w, newKidDeadline(c) + 10 * MIN)).toEqual([]);
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([]);
    expect(w.chain.governance.updater_keys).toEqual(UPDATER_KEYS);
  });
});

describe('the updater for other providers', () => {
  it('cancels any change the updater proposed for a provider other than Google and deletes every updater key', async () => {
    const w = await initialized();
    const c = w.chain.propose('Add', 'x1', { provider: 'apple', by: SIGNER });
    const r = w.chain.propose('Remove', 'x0', { provider: 'apple', by: SIGNER });
    await w.run();
    expect(w.writer.calls).toEqual([
      { method: 'cancel_issuer_key_change', args: { id: c.id } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[0] } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[1] } },
      { method: 'cancel_issuer_key_change', args: { id: r.id } },
    ]);
    const alerts = await alertsOf(w.store, 'forged_key_change');
    expect(alerts.map((a) => [a.details.id, a.details.reason, a.details.outcome]).sort()).toEqual([
      [c.id, 'updater_other_provider', 'cancelled'],
      [r.id, 'updater_other_provider', 'cancelled'],
    ]);
    expect(alerts.find((a) => a.details.id === c.id)?.title).toBe(
      `Forged Add of apple key x1 by the updater (change ${c.id}): the updater only serves Google, so its key is stolen; cancelled`,
    );
    expect(await alertsOf(w.store, 'unverifiable_key_change')).toEqual([]);
  });
});

describe('overlapping runs', () => {
  it('skips a run while another holds the lock, and takes over a stale lock', async () => {
    const w = await initialized();
    expect(await w.store.acquireLock(999, w.clock.t, 10 * MIN)).toBe(true);
    const skipped = await w.run();
    expect(skipped.outcome).toBe('degraded');
    expect(skipped.checks.every((c) => c.outcome === 'skipped')).toBe(true);
    expect(w.notifier.pings).toBe(1); // only the first run's
    w.clock.t += 10 * MIN; // the holder died
    const r = await w.run();
    expect(r.outcome).toBe('ok');
    // Released at the end: the next run goes ahead.
    expect((await w.run()).outcome).toBe('ok');
  });
});

describe('pending removals (step 4)', () => {
  it('alerts critical on a removal of a kid Google still publishes and calls nothing, once', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.chain.propose('Remove', 'k2');
    await w.run();
    await w.run();
    expect(w.writer.calls).toEqual([]);
    const alerts = await alertsOf(w.store, 'published_key_removal');
    expect(alerts.map((a) => a.severity)).toEqual(['critical']);
    expect(channelsOf(w, 'published_key_removal')).toEqual(['email', 'pager', 'slack']);
  });

  it('confirms a removal early only once fetches in a row over 10 min miss the kid and none listed it for 24 h (D422)', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.jwks.keys = [jwk('k1', 1)];
    w.clock.t += REMOVAL_UNSEEN_MS;
    const c = w.chain.propose('Remove', 'k2');
    // Two fetches 60 s apart: absent, not yet enough.
    await w.run();
    expect(w.writer.calls).toEqual([]);
    await w.run();
    expect(w.writer.calls).toEqual([]);
    await w.run();
    expect(w.writer.calls).toEqual([{ method: 'confirm_issuer_key_change', args: { id: c.id } }]);
    expect(w.chain.active.has('k2')).toBe(false);
  });

  it('never confirms a removal of a kid Google listed within 24 h, however long it has been missing since; a fetch that lists it alerts critical (D422)', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.clock.t += 2 * HOUR;
    await w.run(); // k2 listed at this run
    w.jwks.keys = [jwk('k1', 1)];
    w.chain.propose('Remove', 'k2');
    for (let i = 0; i < 12; i++) await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(w.chain.active.has('k2')).toBe(true);
    expect(await alertsOf(w.store, 'published_key_removal')).toEqual([]);
    w.jwks.queue = [[jwk('k1', 1), jwk('k2', 2)]];
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect((await alertsOf(w.store, 'published_key_removal')).map((a) => a.severity)).toEqual(['critical']);
  });

  it('removalConfirmable needs ≥ 3 absent fetches over ≥ 10 min and no listing for 24 h', () => {
    const now = T0 + 30 * 24 * HOUR;
    const seen = { provider: 'google', kid: 'k2', n: 'n', e: 'AQAB', source: 'jwks' as const, first_seen_at: T0, last_seen_at: now - REMOVAL_UNSEEN_MS };
    const absence = { first: now - REMOVAL_ABSENT_SPAN_MS, fetches: ABSENT_FETCHES_TO_ACT };
    expect(removalConfirmable(seen, absence, now)).toBe(true);
    expect(removalConfirmable(undefined, absence, now)).toBe(true);
    expect(removalConfirmable({ ...seen, last_seen_at: now - REMOVAL_UNSEEN_MS + 1 }, absence, now)).toBe(false);
    expect(removalConfirmable(seen, { ...absence, fetches: 2 }, now)).toBe(false);
    expect(removalConfirmable(seen, { ...absence, first: now - REMOVAL_ABSENT_SPAN_MS + 1 }, now)).toBe(false);
    expect(removalConfirmable(seen, undefined, now)).toBe(false);
  });
});

describe('active keys (step 5)', () => {
  it('pauses on an active key Google never published, deletes every updater key, and alerts critical', async () => {
    const w = await initialized();
    w.chain.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' }); // e.g. by delay while the watchdog was down
    await w.run();
    // Pause first (every login stops at once), then the updater keys: whoever proposed the key, a stolen updater key
    // can't post again.
    expect(w.writer.methods()).toEqual(['pause', 'delete_updater_key', 'delete_updater_key']);
    expect(w.chain.config.paused).toBe(true);
    expect(w.chain.governance.updater_keys).toEqual([]);
    const [alert] = await alertsOf(w.store, 'forged_active_key');
    expect(alert).toMatchObject({ severity: 'critical' });
    expect(alert?.details).toMatchObject({ kid: 'forged', reason: 'never_published' });
    expect(alert?.title).toContain('paused, 2 updater key(s) deleted');
    expect(alert?.details.actions).toHaveLength(3);
    expect(channelsOf(w, 'forged_active_key')).toEqual(['email', 'pager', 'slack']);
  });

  it('pauses on an active kid Google publishes with other key material', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.chain.active.set('k2', { n: jwk('k2', 77).n, e: 'AQAB' });
    await w.run();
    expect(w.writer.methods()).toEqual(['pause', 'delete_updater_key', 'delete_updater_key']);
    expect((await alertsOf(w.store, 'forged_active_key'))[0]?.details).toMatchObject({ reason: 'other_key_material' });
  });

  it('pauses on a dropped kid whose on-chain material differs from what Google published', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.jwks.keys = [jwk('k1', 1)];
    w.chain.active.set('k2', { n: jwk('k2', 77).n, e: 'AQAB' });
    await w.run();
    expect(w.writer.methods()).toEqual(['pause', 'delete_updater_key', 'delete_updater_key']);
  });

  it("doesn't pause again while paused, and doesn't re-alert while the condition lasts", async () => {
    const w = await initialized();
    w.chain.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' });
    await w.run();
    await w.run();
    expect(w.writer.methods()).toEqual(['pause', 'delete_updater_key', 'delete_updater_key']);
    expect(await alertsOf(w.store, 'forged_active_key')).toHaveLength(1);
  });

  it('pauses again after an unpause while the key is still active, with a new critical alert', async () => {
    const w = await initialized();
    w.chain.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' });
    await w.run();
    w.chain.config.paused = false; // the owner unpauses at once (D82)
    await w.run();
    expect(w.writer.methods()).toEqual([...['pause', 'delete_updater_key', 'delete_updater_key'], 'pause']);
    expect((await alertsOf(w.store, 'automatic_action')).map((a) => a.title)).toEqual([expect.stringContaining('Paused again')]);
  });

  it('deletes an updater key re-added while the forged key is still active (recover in order: remove, re-add, unpause)', async () => {
    const w = await initialized();
    w.chain.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' });
    await w.run();
    w.chain.governance.updater_keys = ['ed25519:readded']; // re-added before the forged key was removed
    await w.run();
    expect(w.writer.methods()).toEqual([...['pause', 'delete_updater_key', 'delete_updater_key'], 'delete_updater_key']);
    expect((await alertsOf(w.store, 'automatic_action')).map((a) => a.title)).toEqual([expect.stringContaining('delete_updater_key')]);
  });

  it('only warns (Slack + email) on a kid Google dropped more than 27 h ago (the cron removes after 24 h, D422), and never pauses on it', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.jwks.keys = [jwk('k1', 1)];
    await w.run();
    expect(await alertsOf(w.store, 'stale_active_key')).toEqual([]);
    w.clock.t += 24 * HOUR;
    await w.run();
    expect(await alertsOf(w.store, 'stale_active_key')).toEqual([]);
    w.clock.t += 3 * HOUR;
    await w.run();
    expect(w.writer.calls).toEqual([]);
    const [stale] = await alertsOf(w.store, 'stale_active_key');
    expect(stale?.severity).toBe('warning');
    expect(channelsOf(w, 'stale_active_key')).toEqual(['email', 'slack']);
    // Resolved once the kid leaves the active set.
    w.chain.active.delete('k2');
    await w.run();
    expect((await alertsOf(w.store, 'stale_active_key'))[0]?.resolved_at).not.toBeNull();
  });

  it('checks by kid only (warning) on a contract without get_issuer_keys', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.chain.hasIssuerKeys = false;
    w.chain.active.set('k2', { n: jwk('k2', 77).n, e: 'AQAB' });
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect((await alertsOf(w.store, 'active_key_material_unavailable'))[0]?.severity).toBe('warning');
  });
});

describe('first run', () => {
  it('records the JWKS as known, alerts critical on an active kid not in it, and never pauses', async () => {
    const w = world({ active: [jwk('k1', 1), jwk('old', 9)], jwks: [jwk('k1', 1), jwk('k2', 2)] });
    const r = await w.run();
    expect(r.firstRun).toBe(true);
    expect(w.writer.calls).toEqual([]);
    const [unknown] = await alertsOf(w.store, 'unknown_active_key_first_run');
    expect(unknown).toMatchObject({ severity: 'critical' });
    expect(unknown?.details).toMatchObject({ kid: 'old', reason: 'not_in_jwks' });
    expect(channelsOf(w, 'unknown_active_key_first_run')).toEqual(['email', 'pager', 'slack']);
    expect((await w.store.allSeenKids()).map((k) => [k.kid, k.source])).toEqual([
      ['k1', 'jwks'],
      ['k2', 'jwks'],
      ['old', 'baseline'],
    ]);
    // Later runs treat the baseline kid as history: no pause.
    const r2 = await w.run();
    expect(r2.firstRun).toBe(false);
    expect(w.writer.calls).toEqual([]);
  });

  it('alerts without pausing on an active kid with other material at the first run; the next run pauses', async () => {
    const w = world({ active: [jwk('k1', 66)], jwks: [jwk('k1', 1)] });
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect((await alertsOf(w.store, 'unknown_active_key_first_run'))[0]?.details).toMatchObject({ reason: 'other_key_material' });
    await w.run();
    expect(w.writer.methods()).toEqual(['pause', 'delete_updater_key', 'delete_updater_key']);
  });

  it("isn't the first run until both the chain and the JWKS were read", async () => {
    const w = world({ active: [jwk('k1', 1), jwk('old', 9)], jwks: [jwk('k1', 1)] });
    w.jwks.queue = ['fail'];
    const r = await w.run();
    expect(r.firstRun).toBe(false);
    expect(r.outcome).toBe('degraded');
    const r2 = await w.run();
    expect(r2.firstRun).toBe(true);
    expect(w.writer.calls).toEqual([]);
  });

  it('still cancels a forged pending key at the first run (cancel is DoS-only)', async () => {
    const w = world({ active: [jwk('k1', 1)] });
    w.chain.propose('Add', 'ghost', NO_GRACE);
    await w.run();
    expect(w.writer.methods()[0]).toBe('cancel_issuer_key_change');
  });
});

describe('governance diff (step 6): alert only', () => {
  it('alerts critical with the values on an upgrade proposal and calls nothing', async () => {
    const w = await initialized();
    w.chain.governance.pending_upgrade = { code_hash: 'Hash1111', proposed_at_ms: T0, executable_at_ms: T0 + 72 * HOUR };
    await w.run();
    expect(w.writer.calls).toEqual([]);
    const [g] = await alertsOf(w.store, 'governance_change');
    expect(g?.severity).toBe('critical');
    expect(g?.details.changes).toEqual([{ field: 'pending_upgrade', before: null, after: { code_hash: 'Hash1111', proposed_at_ms: T0, executable_at_ms: T0 + 72 * HOUR } }]);
    expect(channelsOf(w, 'governance_change')).toEqual(['email', 'pager', 'slack']);
  });

  it("alerts critical on the owner's immediate remove_issuer_key, which leaves no pending state", async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.chain.active.delete('k2');
    await w.run();
    expect(w.writer.calls).toEqual([]);
    const [g] = await alertsOf(w.store, 'governance_change');
    expect(g?.severity).toBe('critical');
    expect(g?.title).toBe('Governance change: issuer_keys');
    expect(g?.details.changes).toEqual([{ field: 'issuer_keys', before: ['k1', 'k2'], after: ['k1'] }]);
    expect(channelsOf(w, 'governance_change')).toEqual(['email', 'pager', 'slack']);
  });

  it('does not alert a removal that went through the queue (it is reported as executed)', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    const c = w.chain.propose('Remove', 'k2'); // Google still lists k2: alert only, nothing confirmed
    await w.run();
    w.chain.execute(c.id);
    await w.run();
    expect(await alertsOf(w.store, 'governance_change')).toEqual([]);
    expect((await alertsOf(w.store, 'key_change_executed')).map((a) => a.details.id)).toEqual([c.id]);
  });

  it("alerts critical on the owner's set_issuer (iss values changed at once)", async () => {
    const w = await initialized();
    w.chain.issValues = ['https://accounts.google.com', 'https://evil.example'];
    await w.run();
    const [g] = await alertsOf(w.store, 'governance_change');
    expect(g?.details.changes).toEqual([
      { field: 'issuer', before: { provider: 'google', iss_values: ['https://accounts.google.com'] }, after: { provider: 'google', iss_values: ['https://accounts.google.com', 'https://evil.example'] } },
    ]);
    // The snapshot now holds the issuer: no second alert.
    await w.run();
    expect(await alertsOf(w.store, 'governance_change')).toHaveLength(1);
  });

  it('takes the issuer of a snapshot stored before it was recorded as the baseline', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    const { issuer: _i, ...older } = (await w.store.getMeta<Record<string, unknown>>('snapshot'))!;
    await w.store.setMeta('snapshot', older);
    w.chain.active.delete('k2');
    await w.run();
    expect(await alertsOf(w.store, 'governance_change')).toEqual([]);
  });

  it.each([
    ['pending_owner', (w: Awaited<ReturnType<typeof initialized>>) => (w.chain.governance.pending_owner = { owner: 'dao.test.near', acceptable_at_ms: T0 })],
    ['pending_withdrawal', (w: Awaited<ReturnType<typeof initialized>>) => (w.chain.governance.pending_withdrawal = { receiver: OWNER, amount: '1', executable_at_ms: T0 })],
    ['watchdogs', (w: Awaited<ReturnType<typeof initialized>>) => w.chain.governance.watchdogs.push({ account_id: 'w2.test.near', confirm_from_ms: T0 })],
    ['updater_keys', (w: Awaited<ReturnType<typeof initialized>>) => w.chain.governance.updater_keys.pop()],
    ['pending_issuer_key_delay', (w: Awaited<ReturnType<typeof initialized>>) => (w.chain.config.pending_issuer_key_delay = { change_delay_ms: MIN, effective_at_ms: T0 + 72 * HOUR })],
    ['governance_delay_ms', (w: Awaited<ReturnType<typeof initialized>>) => (w.chain.config.governance_delay_ms = 96 * HOUR)],
    ['pending_console_audiences', (w: Awaited<ReturnType<typeof initialized>>) => w.chain.config.pending_console_audiences.push({ provider: 'google', aud: 'evil.apps', effective_at_ms: T0 + HOUR })],
    ['paused', (w: Awaited<ReturnType<typeof initialized>>) => (w.chain.config.paused = true)],
    ['owner', (w: Awaited<ReturnType<typeof initialized>>) => (w.chain.config.owner = 'dao.test.near')],
  ])('alerts critical on a %s change', async (field, change) => {
    const w = await initialized();
    change(w);
    await w.run();
    expect(w.writer.calls).toEqual([]);
    const [g] = await alertsOf(w.store, 'governance_change');
    expect((g?.details.changes as { field: string }[]).map((c) => c.field)).toEqual([field]);
  });

  it("alerts critical when the owner DAO's policy changes (AddMember, ChangePolicy) and calls nothing", async () => {
    const w = await initialized();
    const policy = councilPolicy(['a.test.near', 'b.test.near', 'c.test.near', 'mallory.test.near']);
    w.chain.owner = { ...w.chain.owner, policy };
    await w.run();
    expect(w.writer.calls).toEqual([]);
    const [g] = await alertsOf(w.store, 'governance_change');
    expect(g?.severity).toBe('critical');
    expect(g?.details.changes).toEqual([{ field: 'owner_policy', before: councilPolicy(), after: policy }]);
    expect(channelsOf(w, 'governance_change')).toEqual(['email', 'pager', 'slack']);
    // The next run compares with the new policy: no second alert.
    await w.run();
    expect(await alertsOf(w.store, 'governance_change')).toHaveLength(1);
  });

  it('alerts critical on a pause and unpause that both fell between two runs', async () => {
    const w = await initialized();
    w.chain.config.unpaused_at_ms = w.clock.t - MIN;
    w.chain.config.changes_unlock_floor_ms = w.clock.t + HOUR;
    await w.run();
    expect(((await alertsOf(w.store, 'governance_change'))[0]?.details.changes as { field: string }[]).map((c) => c.field)).toEqual(['unpaused_at_ms']);
  });

  it('alerts critical on an unpause', async () => {
    const w = await initialized();
    w.chain.config.paused = true;
    await w.run();
    w.chain.config.paused = false;
    await w.run();
    expect((await alertsOf(w.store, 'governance_change')).map((a) => a.title)).toEqual([expect.stringContaining('paused'), expect.stringContaining('paused')]);
  });

  it('warns on shared-client, sponsor and public-registration changes', async () => {
    const w = await initialized();
    w.chain.config.sponsors = [];
    w.chain.config.public_registration = true;
    await w.run();
    const [c] = await alertsOf(w.store, 'config_change');
    expect(c?.severity).toBe('warning');
    expect((c?.details.changes as { field: string }[]).map((x) => x.field)).toEqual(['sponsors', 'public_registration']);
    expect(channelsOf(w, 'config_change')).toEqual(['email', 'slack']);
  });

  it('reports a delay decrease or an audience addition coming into force as info only', async () => {
    const w = await initialized();
    w.chain.config.pending_issuer_key_delay = { change_delay_ms: HOUR, effective_at_ms: w.clock.t + MIN };
    w.chain.config.pending_console_audiences = [{ provider: 'google', aud: 'c2.apps', effective_at_ms: w.clock.t + MIN }];
    await w.run(); // the decrease and the addition are scheduled: critical
    w.notifier.clear();
    w.chain.config.issuer_key_delay_ms = HOUR;
    w.chain.config.pending_issuer_key_delay = null;
    w.chain.config.console_audiences.push(['google', 'c2.apps']);
    w.chain.config.pending_console_audiences = [];
    await w.run();
    expect(await alertsOf(w.store, 'governance_change')).toHaveLength(1);
    const [m] = await alertsOf(w.store, 'config_matured');
    expect((m?.details.changes as { field: string }[]).map((x) => x.field)).toEqual(['issuer_key_delay_ms', 'console_audiences']);
    expect(w.notifier.sent).toEqual([]);
  });

  it("doesn't alert twice on its own pause or updater-key deletions", async () => {
    const w = await initialized();
    w.chain.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' });
    w.chain.propose('Add', 'ghost');
    await w.run();
    expect(w.chain.config.paused).toBe(true);
    expect(w.chain.governance.updater_keys).toEqual([]);
    await w.run();
    expect(await alertsOf(w.store, 'governance_change')).toEqual([]);
  });

  it('alerts at the first run on anything already pending', async () => {
    const w = world({ active: [jwk('k1', 1)] });
    w.chain.governance.pending_upgrade = { code_hash: 'Hash1111', proposed_at_ms: T0, executable_at_ms: T0 + HOUR };
    await w.run();
    expect(((await alertsOf(w.store, 'governance_change'))[0]?.details.changes as { field: string }[]).map((c) => c.field)).toEqual(['pending_upgrade']);
  });
});

describe('other alerts', () => {
  it('alerts critical (no action) on a pending change the owner proposed for a provider it has no JWKS for', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'x1', { provider: 'apple', by: OWNER });
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect((await alertsOf(w.store, 'unverifiable_key_change'))[0]?.severity).toBe('critical');
  });

  it("alerts critical and calls nothing when it isn't a watchdog of the contract", async () => {
    const w = await initialized();
    w.chain.governance.watchdogs = [];
    w.chain.propose('Add', 'ghost');
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await alertsOf(w.store, 'not_a_watchdog')).toHaveLength(1);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.title).toContain('could not act');
  });

  it('alerts critical without a usable key and still reports forgeries', async () => {
    const w = await initialized({ writer: false });
    // At once, despite the 2 h delay: no new-kid grace when the watchdog can't act (D432).
    w.chain.propose('Add', 'ghost');
    await w.run();
    expect(await alertsOf(w.store, 'watchdog_key_missing')).toHaveLength(1);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.title).toContain('could not act');
  });

  it('alerts critical and acts on nothing on the wrong network', async () => {
    const w = await initialized();
    w.chain.chain = 'mainnet';
    w.chain.propose('Add', 'ghost');
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await alertsOf(w.store, 'wrong_network')).toHaveLength(1);
  });

  it('warns after 3 failed chain reads in a row, and resolves once reads work', async () => {
    const w = await initialized();
    w.chain.failReads = true;
    await w.run();
    await w.run();
    expect(await alertsOf(w.store, 'rpc_failing')).toEqual([]);
    const r = await w.run();
    expect(r.outcome).toBe('degraded');
    expect((await alertsOf(w.store, 'rpc_failing'))[0]?.severity).toBe('warning');
    expect(channelsOf(w, 'rpc_failing')).toEqual(['email', 'slack']);
    w.chain.failReads = false;
    await w.run();
    expect((await alertsOf(w.store, 'rpc_failing'))[0]?.resolved_at).not.toBeNull();
  });

  it('warns after 3 failed JWKS fetches in a row and judges nothing meanwhile', async () => {
    const w = await initialized();
    w.chain.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' });
    w.jwks.queue = ['fail', 'fail', 'fail'];
    await w.run();
    await w.run();
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect((await alertsOf(w.store, 'jwks_failing'))[0]?.severity).toBe('warning');
  });

  it('warns on a matured key change nobody executed for more than 1 h', async () => {
    const w = await initialized({ active: [jwk('k1', 1), jwk('k2', 2)] });
    w.chain.propose('Remove', 'k2', { delay: 0, at: w.clock.t - 2 * HOUR }); // Google still lists k2: alert-only
    await w.run();
    expect((await alertsOf(w.store, 'unexecuted_key_change'))[0]?.severity).toBe('warning');
  });

  it('reports changes others executed or cancelled as info', async () => {
    const k2 = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1), k2] });
    // Never confirms (a value past the Date range must not break a run either).
    w.chain.governance.watchdogs = [{ account_id: WATCHDOG, confirm_from_ms: Number.MAX_SAFE_INTEGER }];
    const a = w.chain.propose('Add', 'k2', { key: k2 });
    const b = w.chain.propose('Add', 'k3', { key: jwk('k3', 3) });
    w.jwks.keys = [jwk('k1', 1), k2, jwk('k3', 3)];
    await w.run();
    await w.run(); // watchdogs change alerted already; now the queue moves
    w.chain.execute(a.id);
    w.chain.changes = w.chain.changes.filter((c) => c.id !== b.id);
    await w.run();
    expect((await alertsOf(w.store, 'key_change_executed')).map((x) => x.details.id)).toEqual([a.id]);
    expect((await alertsOf(w.store, 'key_change_cancelled')).map((x) => x.details.id)).toEqual([b.id]);
  });

  it('warns when a channel or the heartbeat has no credentials', async () => {
    const w = await initialized();
    w.notifier.unconfigured.add('pager');
    await w.run();
    expect((await alertsOf(w.store, 'channel_not_configured')).map((a) => a.details.channel)).toEqual(['pager']);
  });
});

describe("dead-man's switch (step 7) and the run record (step 8)", () => {
  it('pings the heartbeat every run', async () => {
    const w = await initialized();
    const before = w.notifier.pings;
    await w.run();
    await w.run();
    expect(w.notifier.pings - before).toBe(2);
    expect(await w.store.getMeta('heartbeat')).toMatchObject({ ok: true, failures: 0 });
  });

  it('warns after 3 failed pings in a row', async () => {
    const w = await initialized();
    w.notifier.failing.add('heartbeat');
    await w.run();
    await w.run();
    await w.run();
    await w.run(); // the warning raised by the third run is delivered by this one
    expect((await alertsOf(w.store, 'heartbeat_failing'))[0]?.severity).toBe('warning');
    expect(channelsOf(w, 'heartbeat_failing')).toEqual(['email', 'slack']);
  });

  it('records each run with every check', async () => {
    const w = await initialized();
    const r = await w.run();
    const last = await w.store.lastRun();
    expect(last?.id).toBe(r.runId);
    expect(last?.outcome).toBe('ok');
    expect(last?.checks.map((c) => c.id)).toEqual(['config', 'jwks_fetch', 'chain_read', 'watchdog_role', 'pending_key_changes', 'active_keys', 'signer_policy', 'links', 'exit_clients', 'identity_on_chain', 'governance_diff', 'unexecuted_changes', 'relayer_funds', 'alert_delivery', 'digest', 'heartbeat', 'email_jwks', 'identity_jwks']);
    expect(last?.checks.every((c) => c.outcome !== 'error')).toBe(true);
  });

  it('records a run that failed outside the reads as an error and skips the heartbeat', async () => {
    const w = await initialized();
    const before = w.notifier.pings;
    // Chain and JWKS failures are handled; a failure elsewhere (here D1) fails the run, so the dead-man's switch fires.
    w.store.seenKids = async () => {
      throw new Error('D1 down');
    };
    const r = await w.run();
    expect(r.outcome).toBe('error');
    expect(w.notifier.pings).toBe(before);
    expect((await w.store.lastRun())?.outcome).toBe('error');
  });

  it('still delivers the alerts raised before a run failed', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    // Fails after the pending-key check (in the active-key check).
    w.store.seenKids = async () => {
      throw new Error('D1 down');
    };
    const r = await w.run();
    expect(r.outcome).toBe('error');
    expect(w.writer.methods()[0]).toBe('cancel_issuer_key_change');
    expect(channelsOf(w, 'forged_key_change')).toEqual(['email', 'pager', 'slack']);
  });
});
