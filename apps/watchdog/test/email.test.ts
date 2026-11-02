// The email issuer's rules (docs/email-login-spec.md "Watchdog", D190–D193) against the stub chain: pinned and
// unpinned email keys per signer (cancel, pause), no confirm for self-issued keys, the signer-policy diff, Hana's
// email JWKS, the link caps (get_link_stats, D200), D139's unrecorded_wallets, and a v2 contract read as "no email issuer".
import { describe, expect, it } from 'vitest';
import { runWatchdog } from '../src/run.ts';
import { alertsOf, emailJwk, HOUR, initialized, jwk, linkStats, linkWindow, MIN, OWNER, pinsOf, SIGNER, T0, UPDATER_KEYS, world } from './helpers.ts';

const severityOf = async (w: Awaited<ReturnType<typeof initialized>>, kind: string) => (await alertsOf(w.store, kind)).map((a) => a.severity);
const openKinds = async (w: Awaited<ReturnType<typeof initialized>>) => (await w.store.openAlerts()).map((a) => a.kind).sort();
/** The overlap the policy-upgrade test sets: `initialized` runs once at T0, the test's first run at T0 + 5 min. */
const T0OVERLAP = T0 + 10 * MIN + 10 * MIN;
const checkOf = (r: { checks: { id: string; outcome: string; detail?: string }[] }, id: string) => r.checks.find((c) => c.id === id);

describe('a v2 contract (sandbox-dev today) reads as no email issuer', () => {
  for (const pinned of [false, true]) {
    it(`raises nothing email-related, ${pinned ? 'with' : 'without'} pins; no get_link_stats is quiet without an email issuer`, async () => {
      const hana = await emailJwk(201);
      const w = await initialized({ pins: pinned ? pinsOf({ hana: [hana] }) : null, before: (x) => void x.chain.asV2() });
      w.deps.config.devEnv = false; // the D139 alert is about the field, which v2 doesn't have
      const r = await w.run();
      await w.run();
      expect(r.outcome).toBe('ok');
      expect(w.writer.calls).toEqual([]);
      expect(await openKinds(w)).toEqual([]);
      expect(await alertsOf(w.store, 'governance_change')).toEqual([]);
      expect(checkOf(r, 'signer_policy')).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('pre-v3') });
      expect(checkOf(r, 'links')).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('no get_link_stats') });
      // No email issuer, so Hana's JWKS isn't compared (pins) or is skipped (none); never an error.
      expect(checkOf(r, 'email_jwks')?.outcome).not.toBe('error');
    });
  }

  it('upgrading to v3 alerts the new fields as a governance change, then stays quiet', async () => {
    const w = await initialized({ before: (x) => void x.chain.asV2() });
    w.chain.v3 = true;
    w.chain.governance.state_version = 3;
    w.chain.unrecordedWallets = true;
    await w.run();
    const [g] = await alertsOf(w.store, 'governance_change');
    expect((g?.details.changes as { field: string }[]).map((c) => c.field).sort()).toEqual(['state_version', 'unrecorded_wallets']);
    // sandbox-dev is a dev env: no unrecorded_wallets alert (D139).
    expect(await alertsOf(w.store, 'unrecorded_wallets')).toEqual([]);
    await w.run();
    expect(await alertsOf(w.store, 'governance_change')).toHaveLength(1);
  });
});

describe('pending email key changes', () => {
  it('a pinned Add for its signer is info only: never confirmed, nothing called', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer() });
    const c = w.chain.propose('Add', hana.kid, { key: hana, by: OWNER, provider: 'email', signer: 'hana', delay: 72 * HOUR });
    const r = await w.run();
    expect(w.writer.calls).toEqual([]);
    const [info] = await alertsOf(w.store, 'self_issued_key_change');
    expect(info).toMatchObject({ severity: 'info', details: { id: c.id, provider: 'email', signer: 'hana', thumbprint: hana.kid } });
    expect(w.notifier.sent).toEqual([]);
    expect(checkOf(r, 'pending_key_changes')?.outcome).toBe('ok');
    // It executes after its delay like any change: reported, still nothing called.
    w.chain.execute(c.id);
    await w.run();
    expect(await alertsOf(w.store, 'key_change_executed')).toHaveLength(1);
    expect(await alertsOf(w.store, 'forged_active_key')).toEqual([]);
    expect(w.writer.calls).toEqual([]);
  });

  it('cancels an Add whose key is not pinned (owner: no updater key deleted), critical', async () => {
    const hana = await emailJwk(201);
    const rogue = await emailJwk(202);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    const c = w.chain.propose('Add', rogue.kid, { key: rogue, by: OWNER, provider: 'email', signer: 'hana' });
    await w.run();
    expect(w.writer.calls).toEqual([{ method: 'cancel_issuer_key_change', args: { id: c.id } }]);
    const [a] = await alertsOf(w.store, 'forged_key_change');
    expect(a).toMatchObject({ severity: 'critical', details: { provider: 'email', reason: 'not_pinned', outcome: 'cancelled', thumbprint: rogue.kid, pinned_for: [], pinned: true, updater_proposed: false } });
    expect(a?.title).toContain('Forged email issuer key');
    expect(w.chain.governance.updater_keys).toEqual(UPDATER_KEYS);
    expect(w.chain.config.paused).toBe(false);
  });

  it('cancels every email Add while nothing is pinned (absent pins = nothing pinned, D190)', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ before: (x) => void x.chain.emailIssuer() });
    w.chain.propose('Add', hana.kid, { key: hana, by: OWNER, provider: 'email', signer: 'hana' });
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.details).toMatchObject({ reason: 'not_pinned', pinned: false });
  });

  it('cancels a key pinned for another signer, and one whose kid is not its thumbprint', async () => {
    const hana = await emailJwk(201);
    const cosign = await emailJwk(203);
    const w = await initialized({ pins: pinsOf({ hana: [hana], cosign: [cosign] }), before: (x) => void x.chain.emailIssuer() });
    const swapped = w.chain.propose('Add', cosign.kid, { key: cosign, by: OWNER, provider: 'email', signer: 'hana' });
    const renamed = w.chain.propose('Add', 'primary', { key: hana, by: OWNER, provider: 'email', signer: 'hana' });
    await w.run();
    expect(w.writer.calls).toEqual([
      { method: 'cancel_issuer_key_change', args: { id: swapped.id } },
      { method: 'cancel_issuer_key_change', args: { id: renamed.id } },
    ]);
    const reasons = (await alertsOf(w.store, 'forged_key_change')).map((a) => [a.details.id, a.details.reason]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        [swapped.id, 'other_signer'],
        [renamed.id, 'kid_not_thumbprint'],
      ]),
    );
  });

  it('cancels an Add with no signer (an email issuer that is not self-issued)', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void (x.chain.emailIss = ['https://api.test/v1/email']) });
    w.chain.propose('Add', hana.kid, { key: hana, by: OWNER, provider: 'email' });
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.details).toMatchObject({ reason: 'no_signer' });
  });

  it('an email change by the updater ("self") stays updater_other_provider: cancel, delete every updater key', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer() });
    const c = w.chain.propose('Add', hana.kid, { key: hana, by: SIGNER, provider: 'email', signer: 'hana' });
    await w.run();
    expect(w.writer.calls).toEqual([
      { method: 'cancel_issuer_key_change', args: { id: c.id } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[0] } },
      { method: 'delete_updater_key', args: { public_key: UPDATER_KEYS[1] } },
    ]);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.details).toMatchObject({ reason: 'updater_other_provider', updater_proposed: true });
  });

  it('a pending email removal is info only', async () => {
    const hana = await emailJwk(201);
    const standby = await emailJwk(204);
    const w = await initialized({ pins: pinsOf({ hana: [hana, standby] }), before: (x) => void x.chain.emailIssuer([hana, standby]) });
    w.chain.propose('Remove', standby.kid, { by: OWNER, provider: 'email' });
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await severityOf(w, 'self_issued_key_change')).toEqual(['info']);
  });

  it("judges email changes even when Google's JWKS can't be fetched", async () => {
    const rogue = await emailJwk(202);
    const w = await initialized({ pins: pinsOf({ hana: [await emailJwk(201)] }), before: (x) => void x.chain.emailIssuer() });
    w.jwks.queue = ['fail'];
    w.chain.propose('Add', rogue.kid, { key: rogue, by: OWNER, provider: 'email', signer: 'hana' });
    const r = await w.run();
    expect(r.outcome).toBe('degraded');
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
  });

  it('pauses in the same run when a forged email change executed before the cancel landed', async () => {
    const rogue = await emailJwk(202);
    const w = await initialized({ pins: pinsOf({ hana: [await emailJwk(201)] }), before: (x) => void x.chain.emailIssuer() });
    const c = w.chain.propose('Add', rogue.kid, { key: rogue, by: OWNER, provider: 'email', signer: 'hana' });
    w.writer.before = (method) => {
      if (method === 'cancel_issuer_key_change' && w.chain.changes.some((x) => x.id === c.id)) w.chain.execute(c.id);
    };
    w.writer.fail.add('cancel_issuer_key_change');
    w.writer.failError = 'Smart contract panicked: No such key change';
    await w.run();
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'pause', 'delete_updater_key', 'delete_updater_key']);
    expect((await alertsOf(w.store, 'forged_key_change'))[0]?.details).toMatchObject({ outcome: 'executed' });
    expect(await severityOf(w, 'protective_action_failed')).toEqual(['critical']);
    expect(await severityOf(w, 'forged_active_key')).toEqual(['critical']);
  });
});

describe('active email keys', () => {
  it('leaves pinned active keys alone', async () => {
    const hana = await emailJwk(201);
    const standby = await emailJwk(204);
    const w = await initialized({ pins: pinsOf({ hana: [hana, standby] }), before: (x) => void x.chain.emailIssuer([hana, standby]) });
    const r = await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await openKinds(w)).toEqual([]);
    expect(checkOf(r, 'active_keys')).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('2 active email') });
  });

  it('pauses on an unpinned active email key, deletes every updater key, critical; once', async () => {
    const hana = await emailJwk(201);
    const rogue = await emailJwk(202);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.chain.emailActive.set(rogue.kid, { n: rogue.n, e: rogue.e, signer: 'hana' });
    await w.run();
    expect(w.writer.methods()).toEqual(['pause', 'delete_updater_key', 'delete_updater_key']);
    const [a] = await alertsOf(w.store, 'forged_active_key');
    expect(a).toMatchObject({ key: `forged_active_key:email:${rogue.kid}`, severity: 'critical', details: { provider: 'email', kid: rogue.kid, reason: 'not_pinned', signer: 'hana' } });
    expect(a?.title).toContain('Active email issuer key');
    w.writer.calls = [];
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await alertsOf(w.store, 'forged_active_key')).toHaveLength(1);
    // Removed by the owner: resolved.
    w.chain.emailActive.delete(rogue.kid);
    await w.run();
    expect((await alertsOf(w.store, 'forged_active_key'))[0]?.resolved_at).not.toBeNull();
  });

  it('pauses on an active email key at the first run too (pins are configuration, not history, D190)', async () => {
    const hana = await emailJwk(201);
    const w = world({ active: [jwk('k1', 1)], pins: pinsOf({ hana: [await emailJwk(205)] }) });
    w.chain.emailIssuer([hana]);
    const r = await w.run();
    expect(r.firstRun).toBe(true);
    expect(w.writer.methods()[0]).toBe('pause');
    expect(await severityOf(w as never, 'forged_active_key')).toEqual(['critical']);
  });

  it('pauses on an active key listed under a signer it is not pinned for', async () => {
    const hana = await emailJwk(201);
    const cosign = await emailJwk(203);
    const w = await initialized({
      pins: pinsOf({ hana: [hana], cosign: [cosign] }),
      before: (x) => {
        x.chain.emailIssuer([hana]);
        x.chain.selfIssued = { signers: ['hana', 'cosign'], required: 1 };
      },
    });
    w.chain.emailActive.set(cosign.kid, { n: cosign.n, e: cosign.e, signer: 'hana' });
    await w.run();
    expect(w.writer.methods()[0]).toBe('pause');
    expect((await alertsOf(w.store, 'forged_active_key'))[0]?.details).toMatchObject({ reason: 'other_signer', signer: 'hana', pinned_for: ['cosign'] });
  });

  it('pauses on any active email key while nothing is pinned', async () => {
    const hana = await emailJwk(201);
    const w = await initialized();
    w.chain.emailIssuer([hana]);
    await w.run();
    expect(w.writer.methods()[0]).toBe('pause');
    expect((await alertsOf(w.store, 'forged_active_key'))[0]?.details).toMatchObject({ reason: 'not_pinned', pinned: false });
  });

  it("an email key judged without Google's JWKS never resolves Google's open forged-key alert", async () => {
    const w = await initialized();
    w.chain.active.set('evil', { n: jwk('evil', 9).n, e: 'AQAB' });
    await w.run();
    expect(await alertsOf(w.store, 'forged_active_key')).toHaveLength(1);
    w.jwks.queue = ['fail', 'fail'];
    await w.run();
    expect((await alertsOf(w.store, 'forged_active_key'))[0]?.resolved_at).toBeNull();
  });
});

describe('signer policy against the pins', () => {
  /** Pins and a chain policy as of the first run (`chain` default: the pins' own policy, so that run is clean). */
  const setup = async (o: { pinned?: 'hana' | 'hana+cosign'; required?: number; chain?: { signers: string[]; required: number } } = {}) => {
    const hana = await emailJwk(201);
    const cosign = await emailJwk(203);
    const pins = o.pinned === 'hana+cosign' ? pinsOf({ hana: [hana], cosign: [cosign] }, o.required ?? 1) : pinsOf({ hana: [hana] }, o.required ?? 1);
    const w = await initialized({
      pins,
      before: (x) => {
        x.chain.emailIssuer([hana]);
        x.chain.selfIssued = o.chain ?? { signers: Object.keys(pins.signers), required: pins.required };
      },
    });
    return { w, hana, cosign };
  };

  it('matches: ok, nothing raised', async () => {
    const { w } = await setup();
    const r = await w.run();
    expect(checkOf(r, 'signer_policy')).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('matches the pins') });
    expect(await alertsOf(w.store, 'signer_policy_mismatch')).toEqual([]);
  });

  it('pauses on a lower required than pinned (weaker), critical', async () => {
    const { w } = await setup({ pinned: 'hana+cosign', required: 2 });
    w.chain.selfIssued = { signers: ['hana', 'cosign'], required: 1 };
    await w.run();
    expect(w.writer.methods()).toEqual(['pause']);
    const [a] = await alertsOf(w.store, 'signer_policy_mismatch');
    expect(a).toMatchObject({ severity: 'critical', key: 'signer_policy_mismatch:email:hana+cosign/1:weaker', details: { weaker: ['required 1 is below the pinned 2'] } });
    expect(a?.title).toContain('weaker, paused');
  });

  it('pauses on a signer the pins do not list', async () => {
    const { w } = await setup();
    w.chain.selfIssued = { signers: ['hana', 'rogue'], required: 1 };
    await w.run();
    expect(w.writer.methods()).toEqual(['pause']);
    expect((await alertsOf(w.store, 'signer_policy_mismatch'))[0]?.details.weaker).toEqual(['signer rogue is not pinned']);
  });

  it('warns without pausing while the pins are ahead of a policy upgrade (a new signer pinned first, D191, L5)', async () => {
    const { w } = await setup({ pinned: 'hana+cosign', required: 1, chain: { signers: ['hana'], required: 1 } });
    const r = await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await alertsOf(w.store, 'signer_policy_mismatch')).toEqual([]);
    const [a] = await alertsOf(w.store, 'signer_policy_transition');
    expect(a).toMatchObject({ severity: 'warning', details: { differences: ['pinned signer cosign is not in the policy'], weaker: [] } });
    expect(checkOf(r, 'signer_policy')?.outcome).toBe('alert');
    // No page, and no repeat while it lasts.
    expect(w.notifier.on('pager')).toEqual([]);
    // The upgrade executes (2-of-2, with the contract's 10-minute overlap): still a transition, not weaker.
    w.chain.selfIssued = { signers: ['hana', 'cosign'], required: 2, overlap_until_ms: w.clock.t + 10 * MIN };
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(await alertsOf(w.store, 'signer_policy_mismatch')).toEqual([]);
    expect((await alertsOf(w.store, 'signer_policy_transition')).map((x) => [x.key, x.resolved_at === null])).toEqual([
      ['signer_policy_transition:email:hana+cosign/2+overlap', true],
      ['signer_policy_transition:email:hana/1', false],
    ]);
    // The overlap ends and the operator raises the pinned required: everything matches, resolved.
    w.chain.selfIssued = { signers: ['hana', 'cosign'], required: 2 };
    w.deps.config.emailPins.pins!.required = 2;
    await w.run();
    expect((await alertsOf(w.store, 'signer_policy_transition')).every((x) => x.resolved_at !== null)).toBe(true);
    // The upgrade itself was a governance change, the overlap included (M3).
    expect((await alertsOf(w.store, 'governance_change')).map((g) => g.details.changes)).toEqual([
      [{ field: 'email_signer_policy', before: { signers: ['hana', 'cosign'], required: 2, overlap_until_ms: T0OVERLAP }, after: { signers: ['hana', 'cosign'], required: 2, overlap_until_ms: null } }],
      [{ field: 'email_signer_policy', before: { signers: ['hana'], required: 1, overlap_until_ms: null }, after: { signers: ['hana', 'cosign'], required: 2, overlap_until_ms: T0OVERLAP } }],
    ]);
  });

  it('pauses on an overlap longer than the contract allows (a weaker previous policy kept alive, M3)', async () => {
    const { w } = await setup({ pinned: 'hana+cosign', required: 2 });
    w.chain.selfIssued = { signers: ['hana', 'cosign'], required: 2, overlap_until_ms: w.clock.t + 30 * 24 * HOUR };
    await w.run();
    expect(w.writer.methods()).toEqual(['pause']);
    const [a] = await alertsOf(w.store, 'signer_policy_mismatch');
    expect(a?.severity).toBe('critical');
    expect(a?.details.weaker).toEqual([expect.stringContaining("longer than the contract's 10-minute overlap")]);
  });

  it('an email issuer with nothing pinned is critical, no pause while no key is active', async () => {
    const w = await initialized({ before: (x) => void (x.chain.emailIss = ['https://api.test/v1/email']) });
    await w.run();
    expect(w.writer.calls).toEqual([]);
    expect((await alertsOf(w.store, 'signer_policy_mismatch'))[0]).toMatchObject({
      key: 'signer_policy_mismatch:email:not-self-issued',
      severity: 'critical',
      details: { differences: ['an email issuer is on chain but the watchdog pins no email keys (watchdog.pinnedIssuerKeys.email)'] },
    });
  });

  it('an email issuer not self-issued yet (the set_issuer to mark_self_issued gap) is a warning, no pause; resolved once marked', async () => {
    const hana = await emailJwk(201);
    const v = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void (x.chain.emailIss = ['https://api.test/v1/email']) });
    await v.run();
    expect(v.writer.calls).toEqual([]);
    expect(await alertsOf(v.store, 'signer_policy_mismatch')).toEqual([]);
    expect((await alertsOf(v.store, 'signer_policy_transition'))[0]).toMatchObject({ severity: 'warning', details: { differences: ['the email issuer is not self-issued yet (no signer policy, no key)'], weaker: [] } });
    // mark_self_issued (batch 6's next step): resolved.
    v.chain.selfIssued = { signers: ['hana'], required: 1 };
    await v.run();
    expect(await alertsOf(v.store, 'signer_policy_transition').then((a) => a.every((x) => x.resolved_at !== null))).toBe(true);
  });

  it('pauses when email keys are active with no signer policy (weaker), even if each key is pinned', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void (x.chain.emailIss = ['https://api.test/v1/email']) });
    w.chain.emailActive.set(hana.kid, { n: hana.n, e: hana.e, signer: null });
    await w.run();
    expect(w.writer.methods()).toEqual(['pause']);
    expect(await alertsOf(w.store, 'forged_active_key')).toEqual([]);
    expect((await alertsOf(w.store, 'signer_policy_mismatch'))[0]?.details.weaker).toEqual(['1 active email key(s) with no signer policy']);
  });

  it('a failed pause is a protective_action_failed', async () => {
    const { w } = await setup({ pinned: 'hana+cosign', required: 2 });
    w.chain.selfIssued = { signers: ['hana', 'cosign'], required: 1 };
    w.writer.fail.add('pause');
    await w.run();
    expect(await severityOf(w, 'protective_action_failed')).toEqual(['critical']);
    expect((await alertsOf(w.store, 'signer_policy_mismatch'))[0]?.title).toContain('pause failed');
  });

  it('pauses again after an unpause while the weaker policy lasts (automatic_action)', async () => {
    const { w } = await setup({ pinned: 'hana+cosign', required: 2 });
    w.chain.selfIssued = { signers: ['hana', 'cosign'], required: 1 };
    await w.run();
    w.chain.config.paused = false;
    w.chain.config.unpaused_at_ms = w.clock.t;
    await w.run();
    expect(w.writer.methods()).toEqual(['pause', 'pause']);
    expect(await severityOf(w, 'automatic_action')).toEqual(['critical']);
  });
});

describe("Hana's email JWKS (warning only)", () => {
  it('matches: ok; a published key not pinned, or an active key not published, warns', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    expect(checkOf(await w.run(), 'email_jwks')?.outcome).toBe('ok');
    const extra = await emailJwk(209);
    w.emailJwks.keys = [extra];
    const r = await w.run();
    expect(w.writer.calls).toEqual([]);
    const [a] = await alertsOf(w.store, 'email_jwks_mismatch');
    expect(a?.severity).toBe('warning');
    expect(a?.details.problems).toEqual([`published key ${extra.kid} is not pinned`, `active email key ${hana.kid} is not published`]);
    expect(checkOf(r, 'email_jwks')?.outcome).toBe('alert');
    expect(w.notifier.sent.map((s) => s.channel).sort()).toEqual(['email', 'slack']);
    w.emailJwks.keys = [hana];
    await w.run();
    expect((await alertsOf(w.store, 'email_jwks_mismatch'))[0]?.resolved_at).not.toBeNull();
  });

  it('a published kid that is not its thumbprint warns', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer() });
    w.emailJwks.keys = [{ ...hana, kid: 'primary' }];
    await w.run();
    expect((await alertsOf(w.store, 'email_jwks_mismatch'))[0]?.details.problems).toEqual(['published key primary: its kid is not its thumbprint']);
  });

  it('warns after 3 failed fetches only while email keys are active', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }) });
    w.emailJwks.fail = true;
    for (let i = 0; i < 3; i++) await w.run();
    expect(await alertsOf(w.store, 'email_jwks_mismatch')).toEqual([]);
    w.chain.emailIssuer([hana]);
    await w.run();
    expect((await alertsOf(w.store, 'email_jwks_mismatch'))[0]).toMatchObject({ key: 'email_jwks_mismatch:fetch', severity: 'warning' });
  });

  it('is skipped (no fetch) with nothing pinned', async () => {
    const w = await initialized();
    const r = await w.run();
    expect(w.emailJwks.fetches).toBe(0);
    expect(checkOf(r, 'email_jwks')).toMatchObject({ outcome: 'skipped', detail: 'nothing pinned' });
  });
});

describe('link caps (get_link_stats, D200)', () => {
  const live = async () => {
    const hana = await emailJwk(201);
    return initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
  };

  it('quiet under half the total cap; reports the hour in the links check and /status meta', async () => {
    const w = await live();
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 249), links_total: 300 });
    const r = await w.run();
    expect(await alertsOf(w.store, 'link_volume_high')).toEqual([]);
    expect(checkOf(r, 'links')).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('249 new link(s) this hour') });
    expect(await w.store.getMeta('link_stats')).toMatchObject({ links_total: 300, current: { total: 249 } });
  });

  it('warns at half the total cap, once per hour', async () => {
    const w = await live();
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 250) });
    await w.run();
    await w.run();
    const a = await alertsOf(w.store, 'link_volume_high');
    expect(a.map((x) => [x.key, x.severity])).toEqual([[`link_volume_high:${linkWindow(w.clock.t).window_start_ms}`, 'warning']]);
    expect(w.writer.calls).toEqual([]);
  });

  it('pages a cap reached, in all and per scope, keyed by window; never pauses (the contract already brakes)', async () => {
    const w = await live();
    const h = linkWindow(w.clock.t).window_start_ms;
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 500, { total_cap_reached: true, capped_scopes: ['s1', 's2'] }) });
    await w.run();
    expect(w.writer.calls).toEqual([]);
    const keys = (await alertsOf(w.store, 'link_cap_reached')).map((x) => x.key).sort();
    expect(keys).toEqual([`link_cap_reached:scope:s1:${h}`, `link_cap_reached:scope:s2:${h}`, `link_cap_reached:total:${h}`]);
    expect((await alertsOf(w.store, 'link_cap_reached')).every((x) => x.severity === 'critical')).toBe(true);
    expect(w.notifier.on('pager').filter((x) => x.msg.kind === 'link_cap_reached')).toHaveLength(3);
    // A cap reached and no longer at half: no extra warning for the same hour.
    expect(await alertsOf(w.store, 'link_volume_high')).toEqual([]);
  });

  it("sees a cap reached in the previous window (between two runs), and resolves once it is neither window", async () => {
    const w = await live();
    const prevHour = linkWindow(w.clock.t - HOUR);
    w.chain.linkStats = linkStats({ previous: { ...prevHour, total: 40, capped_scopes: ['s9'], capped_scopes_truncated: true }, current: linkWindow(w.clock.t, 1) });
    await w.run();
    const keys = (await alertsOf(w.store, 'link_cap_reached')).map((x) => x.key).sort();
    expect(keys).toEqual([`link_cap_reached:more_scopes:${prevHour.window_start_ms}`, `link_cap_reached:scope:s9:${prevHour.window_start_ms}`]);
    w.chain.linkStats = linkStats({ previous: linkWindow(w.clock.t, 1), current: linkWindow(w.clock.t + HOUR) });
    await w.run();
    expect((await alertsOf(w.store, 'link_cap_reached')).every((x) => x.resolved_at !== null)).toBe(true);
  });

  it('warns when an email issuer is on chain but the contract has no get_link_stats', async () => {
    const w = await initialized();
    w.chain.linkStats = null;
    await w.run();
    expect(await alertsOf(w.store, 'link_stats_unavailable')).toEqual([]);
    w.chain.emailIssuer();
    await w.run();
    expect((await alertsOf(w.store, 'link_stats_unavailable'))[0]).toMatchObject({ severity: 'warning', resolved_at: null });
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t) });
    await w.run();
    expect((await alertsOf(w.store, 'link_stats_unavailable'))[0]?.resolved_at).not.toBeNull();
  });

  it('a malformed or failing view marks only the links check: forged Google and email keys are still cancelled in the same run', async () => {
    const hana = await emailJwk(201);
    const rogue = await emailJwk(202);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.chain.linkStatsProblem = 'malformed';
    const g = w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66), by: OWNER });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    const e = w.chain.propose('Add', rogue.kid, { key: rogue, by: OWNER, provider: 'email', signer: 'hana' });
    const r = await w.run();
    expect(w.writer.calls).toEqual([
      { method: 'cancel_issuer_key_change', args: { id: e.id } },
      { method: 'cancel_issuer_key_change', args: { id: g.id } },
    ]);
    expect(checkOf(r, 'chain_read')?.outcome).toBe('ok');
    expect(checkOf(r, 'links')).toMatchObject({ outcome: 'error', detail: expect.stringContaining('unexpected shape') });
    expect((await alertsOf(w.store, 'link_stats_unavailable'))[0]).toMatchObject({ key: 'link_stats_unavailable:malformed', severity: 'warning', details: { reason: 'malformed' } });
    expect((await alertsOf(w.store, 'forged_key_change')).map((a) => a.details.id).sort()).toEqual([e.id, g.id].sort());
    // An active forged email key still pauses too.
    w.chain.emailActive.set(rogue.kid, { n: rogue.n, e: rogue.e, signer: 'hana' });
    w.chain.linkStatsProblem = 'read_failed';
    w.writer.calls = [];
    const r2 = await w.run();
    expect(w.writer.methods()[0]).toBe('pause');
    expect(checkOf(r2, 'links')?.outcome).toBe('error');
    expect((await alertsOf(w.store, 'link_stats_unavailable')).map((a) => a.key).sort()).toEqual(['link_stats_unavailable:malformed', 'link_stats_unavailable:read_failed']);
    // A good answer again: both resolve.
    w.chain.linkStatsProblem = null;
    await w.run();
    expect((await alertsOf(w.store, 'link_stats_unavailable')).every((a) => a.resolved_at !== null)).toBe(true);
  });

  it('a broken or missing view never resolves an open cap or volume alert; a good read under the cap does', async () => {
    const w = await live();
    const open = async () => (await w.store.openAlerts()).filter((a) => a.resolved_at === null && ['link_cap_reached', 'link_volume_high'].includes(a.kind)).map((a) => a.kind).sort();
    // A cap reached, in all and in scope s1: two open critical conditions.
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 500, { total_cap_reached: true, capped_scopes: ['s1'] }) });
    await w.run();
    expect(await open()).toEqual(['link_cap_reached', 'link_cap_reached']);
    w.chain.linkStatsProblem = 'malformed';
    await w.run();
    expect(await open()).toEqual(['link_cap_reached', 'link_cap_reached']);
    w.chain.linkStatsProblem = 'read_failed';
    await w.run();
    expect(await open()).toEqual(['link_cap_reached', 'link_cap_reached']);
    w.chain.linkStatsProblem = null;
    w.chain.linkStats = null; // the view missing (with an email issuer on chain)
    await w.run();
    expect(await open()).toEqual(['link_cap_reached', 'link_cap_reached']);
    // A good read under the cap (a later hour): resolved.
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t + 2 * HOUR, 3), previous: linkWindow(w.clock.t + HOUR, 2) });
    await w.run();
    expect(await open()).toEqual([]);
  });

  it('a broken view keeps an open link_volume_high warning open too', async () => {
    const w = await live();
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 300) });
    await w.run();
    w.chain.linkStatsProblem = 'malformed';
    await w.run();
    expect((await alertsOf(w.store, 'link_volume_high'))[0]?.resolved_at).toBeNull();
    w.chain.linkStatsProblem = null;
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 10) });
    await w.run();
    expect((await alertsOf(w.store, 'link_volume_high'))[0]?.resolved_at).not.toBeNull();
  });

  it('is judged before the run is recorded and its lock released (the protective phase)', async () => {
    const w = await live();
    w.chain.linkStats = linkStats({ current: linkWindow(w.clock.t, 500, { total_cap_reached: true }) });
    let recorded: unknown = 'not yet';
    const finish = w.store.finishRun.bind(w.store);
    w.store.finishRun = async (...a) => {
      recorded = (await alertsOf(w.store, 'link_cap_reached')).length;
      return finish(...a);
    };
    await w.run();
    expect(recorded).toBe(1);
  });

  describe('governance diff of the caps', () => {
    const fields = async (w: Awaited<ReturnType<typeof initialized>>, kind: string) => (await alertsOf(w.store, kind)).flatMap((g) => (g.details.changes as { field: string }[]).map((c) => c.field));

    it('a pending raise appearing is critical; it coming into force as scheduled is info', async () => {
      const w = await live();
      const effective = w.clock.t + 72 * HOUR;
      w.chain.linkStats = linkStats({ pending_limits: { per_scope_per_hour: 100, total_per_hour: 500, effective_at_ms: effective } });
      await w.run();
      expect(await fields(w, 'governance_change')).toEqual(['pending_limits']);
      w.clock.t = effective + MIN;
      w.chain.linkStats = linkStats({ limits: { per_scope_per_hour: 100, total_per_hour: 500 } });
      await w.run();
      expect(await fields(w, 'config_matured')).toEqual(['link_limits']);
      expect(await fields(w, 'governance_change')).toEqual(['pending_limits']);
    });

    it('limits rising at once are critical; lowering is a warning', async () => {
      const w = await live();
      w.chain.linkStats = linkStats({ limits: { per_scope_per_hour: 10, total_per_hour: 100 } });
      await w.run();
      expect(await fields(w, 'config_change')).toEqual(['link_limits']);
      expect(await fields(w, 'governance_change')).toEqual([]);
      w.chain.linkStats = linkStats({ limits: { per_scope_per_hour: 10, total_per_hour: 1000 } });
      await w.run();
      expect(await fields(w, 'governance_change')).toEqual(['link_limits']);
    });

    it('a pending raise cancelled is a warning', async () => {
      const w = await live();
      w.chain.linkStats = linkStats({ pending_limits: { per_scope_per_hour: 100, total_per_hour: 500, effective_at_ms: w.clock.t + 72 * HOUR } });
      await w.run();
      w.chain.linkStats = linkStats();
      await w.run();
      expect(await fields(w, 'config_change')).toEqual(['pending_limits']);
    });
  });
});

describe('unrecorded_wallets (D139)', () => {
  it('critical on an env that is not a dev env, resolved once the owner accepts', async () => {
    const w = await initialized();
    w.deps.config.devEnv = false;
    w.deps.config.envName = 'staging';
    w.chain.unrecordedWallets = true;
    await w.run();
    const [a] = await alertsOf(w.store, 'unrecorded_wallets');
    expect(a).toMatchObject({ severity: 'critical', key: 'unrecorded_wallets' });
    expect(w.notifier.sent.filter((s) => s.msg.kind === 'unrecorded_wallets').map((s) => s.channel).sort()).toEqual(['email', 'pager', 'slack']);
    expect(w.writer.calls).toEqual([]);
    w.chain.unrecordedWallets = false;
    await w.run();
    expect((await alertsOf(w.store, 'unrecorded_wallets'))[0]?.resolved_at).not.toBeNull();
    // accept_unrecorded_wallets is also an owner action in the governance diff.
    expect((await alertsOf(w.store, 'governance_change')).flatMap((g) => (g.details.changes as { field: string }[]).map((c) => c.field))).toEqual(['unrecorded_wallets', 'unrecorded_wallets']);
  });

  it('allowed on a dev env (sandbox-dev between the v3 upgrade and the accept)', async () => {
    const w = await initialized({ before: (x) => void (x.chain.unrecordedWallets = true) });
    const r = await w.run();
    expect(await alertsOf(w.store, 'unrecorded_wallets')).toEqual([]);
    expect(checkOf(r, "governance_diff")?.detail).toContain('dev env');
  });
});

describe('review hardening (H1, M1, L1, L4, L8)', () => {
  it("Hana's email JWKS is read only after the protective work, the delivery and the heartbeat, and its failure blocks none of them", async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    let seen: { actions: number; pings: number; sent: number } | null = null;
    w.deps.fetchEmailJwks = async () => {
      seen = { actions: w.writer.calls.length, pings: w.notifier.pings, sent: w.notifier.on('pager').length };
      throw new Error('a huge or hostile body');
    };
    const pingsBefore = w.notifier.pings;
    const r = await w.run();
    expect(seen).toEqual({ actions: 3, pings: pingsBefore + 1, sent: 1 });
    expect(r.outcome).toBe('ok');
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key']);
  });

  it('records the run and releases the lock before the advisory phase: a hanging advisory read holds nothing (lock M1)', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    let release!: () => void;
    let entered!: () => void;
    const inAdvisory = new Promise<void>((r) => (entered = r));
    w.deps.fetchEmailJwks = () => {
      entered();
      return new Promise<never>((_, reject) => (release = () => reject(new Error('timed out'))));
    };
    const running = runWatchdog(w.deps);
    await inAdvisory;
    // Mid-advisory: the run is recorded with every protective check, and the lock is free for the next cron run.
    const last = await w.store.lastRun();
    expect(last?.finished_at).not.toBeNull();
    expect(last?.checks.find((c) => c.id === 'email_jwks')?.detail).toContain('advisory');
    expect(await w.store.getMeta('run_lock')).toBeNull();
    w.deps.fetchEmailJwks = async () => [hana];
    const next = await runWatchdog(w.deps);
    expect(next.outcome).not.toBe("error");

    release();
    const r = await running;
    expect(r.outcome).toBe('ok');
    expect((await w.store.lastRun())?.id).toBeGreaterThan(r.runId);
    // The advisory outcome was written to its own run afterwards.
    const rows = await w.store.runsSince(0);
    expect(rows.find((x) => x.id === r.runId)?.checks.find((c) => c.id === 'email_jwks')?.outcome).toBe('error');
  });

  it('a throwing advisory phase leaves the run recorded and the lock released', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.store.updateRun = async () => {
      throw new Error('D1 down');
    };
    const r = await w.run();
    expect(r.outcome).toBe('ok');
    expect(await w.store.getMeta('run_lock')).toBeNull();
    expect((await w.store.lastRun())?.finished_at).not.toBeNull();
  });

  it('unreadable pins page as pins_invalid, and email keys are cancelled as pins_unreadable, not "forged" (L4)', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ before: (x) => void x.chain.emailIssuer() });
    w.deps.config.emailPins = { pins: null, problems: ['EMAIL_PINS is malformed: every email key is treated as unpinned'] };
    w.chain.propose('Add', hana.kid, { key: hana, by: OWNER, provider: 'email', signer: 'hana' });
    const r = await w.run();
    expect((await alertsOf(w.store, 'pins_invalid'))[0]).toMatchObject({ severity: 'critical', resolved_at: null });
    expect(r.checks.find((c) => c.id === 'config')?.outcome).toBe('alert');
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change']);
    const [f] = await alertsOf(w.store, 'forged_key_change');
    expect(f?.details.reason).toBe('pins_unreadable');
    expect(f?.title).toContain('unreadable');
  });

  it('an active email key with material that cannot be hashed pauses (bad_material, L1)', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.chain.emailActive.set(hana.kid, { n: 'not*base64', e: 'AQAB', signer: 'hana' });
    await w.run();
    expect(w.writer.methods()[0]).toBe('pause');
    expect((await alertsOf(w.store, 'forged_active_key'))[0]?.details.reason).toBe('bad_material');
  });

  it("pending_key_changes stays ok when the email changes were judged though Google's JWKS failed (L8)", async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer() });
    w.chain.propose('Add', hana.kid, { key: hana, by: OWNER, provider: 'email', signer: 'hana' });
    w.jwks.queue = ['fail'];
    const r = await w.run();
    expect(r.checks.find((c) => c.id === 'pending_key_changes')).toMatchObject({ outcome: 'ok', detail: expect.stringContaining("Google's half skipped") });
  });
});

describe('Google rules unchanged beside a live email issuer', () => {
  it("D153: a key Google just retired is still a warning (cancel, updater keys kept), with email pinned and live", async () => {
    const hana = await emailJwk(201);
    const k2 = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1), k2], pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.jwks.keys = [jwk('k1', 1)];
    const c = w.chain.propose('Add', 'k2', { key: k2 });
    await w.run();
    expect(w.writer.calls).toEqual([{ method: 'cancel_issuer_key_change', args: { id: c.id } }]);
    expect(await severityOf(w, 'retired_key_change')).toEqual(['warning']);
    expect(await alertsOf(w.store, 'forged_key_change')).toEqual([]);
    expect(w.chain.governance.updater_keys).toEqual(UPDATER_KEYS);
  });

  it('still confirms a Google key that matches the JWKS while an email key waits unconfirmed', async () => {
    const hana = await emailJwk(201);
    const standby = await emailJwk(204);
    const k2 = jwk('k2', 2);
    const w = await initialized({ jwks: [jwk('k1', 1), k2], pins: pinsOf({ hana: [hana, standby] }), before: (x) => void x.chain.emailIssuer([hana]) });
    const g = w.chain.propose('Add', 'k2', { key: k2 });
    w.chain.propose('Add', standby.kid, { key: standby, by: OWNER, provider: 'email', signer: 'hana', delay: 72 * HOUR });
    await w.run();
    expect(w.writer.calls).toEqual([{ method: 'confirm_issuer_key_change', args: { id: g.id } }]);
    expect(await severityOf(w, 'self_issued_key_change')).toEqual(['info']);
  });
});

describe('the governance diff sees the owner’s immediate email issuer actions', () => {
  it('set_issuer("email"), mark_self_issued and a policy upgrade are critical governance changes', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }) });
    w.chain.emailIss = ['https://api.test/v1/email'];
    await w.run();
    w.chain.selfIssued = { signers: ['hana'], required: 1 };
    await w.run();
    const fields = (await alertsOf(w.store, 'governance_change')).map((g) => (g.details.changes as { field: string }[]).map((c) => c.field));
    expect(fields).toEqual([['email_signer_policy'], ['email_issuer']]);
  });

  it('an active email kid removed at once (remove_issuer_key) is critical', async () => {
    const hana = await emailJwk(201);
    const standby = await emailJwk(204);
    const w = await initialized({ pins: pinsOf({ hana: [hana, standby] }), before: (x) => void x.chain.emailIssuer([hana, standby]) });
    w.chain.emailActive.delete(standby.kid);
    await w.run();
    expect((await alertsOf(w.store, 'governance_change'))[0]?.details.changes).toEqual([{ field: 'email_issuer_keys', before: [hana.kid, standby.kid].sort(), after: [hana.kid] }]);
  });
});
