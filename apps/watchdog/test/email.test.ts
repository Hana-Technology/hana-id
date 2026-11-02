// The email issuer's rules (docs/email-login-spec.md "Watchdog", D190–D193) against the stub chain: pinned and
// unpinned email keys per signer (cancel, pause), no confirm for self-issued keys, the signer-policy diff, Hana's
// email JWKS, the link-volume check, D139's unrecorded_wallets, and a v2 contract read as "no email issuer".
import { describe, expect, it } from 'vitest';
import { LINK_SCAN_BEHIND_MS, LINK_WINDOW_MS } from '../src/run.ts';
import { alertsOf, emailJwk, HOUR, initialized, jwk, linkEvent, MIN, OWNER, pinsOf, SIGNER, T0, UPDATER_KEYS, world } from './helpers.ts';

const severityOf = async (w: Awaited<ReturnType<typeof initialized>>, kind: string) => (await alertsOf(w.store, kind)).map((a) => a.severity);
const openKinds = async (w: Awaited<ReturnType<typeof initialized>>) => (await w.store.openAlerts()).map((a) => a.kind).sort();
/** The overlap the policy-upgrade test sets: `initialized` runs once at T0, the test's first run at T0 + 5 min. */
const T0OVERLAP = T0 + 10 * MIN + 10 * MIN;
const checkOf = (r: { checks: { id: string; outcome: string; detail?: string }[] }, id: string) => r.checks.find((c) => c.id === id);

describe('a v2 contract (sandbox-dev today) reads as no email issuer', () => {
  for (const pinned of [false, true]) {
    it(`raises nothing email-related, ${pinned ? 'with' : 'without'} pins, and scans no link events`, async () => {
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
      expect(checkOf(r, 'links')?.outcome).toBe('ok');
      expect(w.links.scans).toEqual([]);
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

describe('link volume (identity_link_* events)', () => {
  const live = async (o: { links?: boolean } = {}) => {
    const hana = await emailJwk(201);
    return initialized({ pins: pinsOf({ hana: [hana] }), ...o, before: (x) => void x.chain.emailIssuer([hana]) });
  };

  it('scans nothing while no email issuer is on chain; starts at the head once one is', async () => {
    const w = await initialized();
    await w.run();
    expect(w.links.scans).toEqual([]);
    w.chain.emailIssuer();
    await w.run();
    await w.run();
    expect(w.links.scans).toEqual([null, 1011]);
  });

  it('warns above the per-scope threshold, then resolves when the hour has passed', async () => {
    const w = await live();
    for (let i = 0; i < 21; i++) w.links.queue.push(linkEvent('s1', w.clock.t - MIN, i % 2 ? 'identity_linked' : 'identity_link_proposed', i % 2 === 1));
    w.links.queue.push(linkEvent('s1', w.clock.t - MIN, 'identity_link_cancelled'));
    w.links.queue.push(linkEvent('s2', w.clock.t - MIN));
    const r = await w.run();
    const [a] = await alertsOf(w.store, 'link_volume_high');
    expect(a).toMatchObject({ key: 'link_volume_high:scope:s1', severity: 'warning', details: { new_links: 21, automatic: 10, threshold: 20 } });
    expect(checkOf(r, 'links')?.detail).toContain('22 new link(s) in the last hour');
    expect(w.writer.calls).toEqual([]);
    w.clock.t += LINK_WINDOW_MS;
    await w.run();
    expect((await alertsOf(w.store, 'link_volume_high'))[0]?.resolved_at).not.toBeNull();
  });

  it('warns above the total threshold, and counts an event read twice once', async () => {
    const w = await live();
    w.deps.config.linkVolume.thresholds = { perHour: 3, perScopePerHour: 3 };
    const events = ['a', 'b', 'c', 'd'].map((s) => linkEvent(s, w.clock.t - MIN));
    w.links.queue.push(...events);
    await w.run();
    expect((await alertsOf(w.store, 'link_volume_high')).map((a) => a.key)).toEqual(['link_volume_high:total']);
    // Re-read (a block scanned again): still 4.
    w.links.queue.push(...events);
    await w.run();
    expect((await alertsOf(w.store, 'link_volume_high'))[0]?.details.new_links).toBe(4);
  });

  it('warns when the indexer fails 3 runs in a row (run degraded), resolved once it reads again', async () => {
    const w = await live();
    w.links.fail = true;
    const r = await w.run();
    expect(r.outcome).toBe('degraded');
    expect(checkOf(r, 'links')?.outcome).toBe('error');
    await w.run();
    await w.run();
    expect((await alertsOf(w.store, 'link_events_unavailable'))[0]).toMatchObject({ key: 'link_events_unavailable:failing', severity: 'warning' });
    w.links.fail = false;
    await w.run();
    expect((await alertsOf(w.store, 'link_events_unavailable'))[0]?.resolved_at).not.toBeNull();
  });

  it('warns when the scan is more than an hour behind', async () => {
    const w = await live();
    w.links.behindMs = LINK_SCAN_BEHIND_MS + MIN;
    w.links.truncated = true;
    await w.run();
    expect((await alertsOf(w.store, 'link_events_unavailable'))[0]).toMatchObject({ key: 'link_events_unavailable:behind', details: { truncated: true } });
  });

  it('warns when no indexer is configured while email is on chain, and not before', async () => {
    const w = await initialized({ links: false });
    expect(checkOf(await w.run(), 'links')).toMatchObject({ outcome: 'skipped', detail: 'no indexer configured' });
    expect(await alertsOf(w.store, 'link_events_unavailable')).toEqual([]);
    w.chain.emailIssuer();
    await w.run();
    expect((await alertsOf(w.store, 'link_events_unavailable'))[0]).toMatchObject({ key: 'link_events_unavailable:not_configured', severity: 'warning' });
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
    expect(checkOf(r, 'links')?.detail).toContain('dev env');
  });
});

describe('review hardening (H1, M1, M2, L1, L4, L8)', () => {
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

  it('a link check that throws ends the run degraded, never in error: the snapshot is saved, nothing resolves, the heartbeat pings', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.deps.config.linkVolume.thresholds = { perHour: 100, perScopePerHour: 1 };
    w.links.queue.push(linkEvent('s1', w.clock.t - MIN), linkEvent('s1', w.clock.t - MIN));
    await w.run();
    expect(await alertsOf(w.store, 'link_volume_high')).toHaveLength(1);
    w.store.linkCounts = async () => {
      throw new Error('bad data');
    };
    const pings = w.notifier.pings;
    const r = await w.run();
    expect(r.outcome).toBe('degraded');
    expect(r.checks.find((c) => c.id === 'links')?.outcome).toBe('error');
    expect(w.notifier.pings).toBe(pings + 1);
    expect((await alertsOf(w.store, 'link_volume_high'))[0]?.resolved_at).toBeNull();
    expect((await w.store.getMeta<{ at: number }>('snapshot'))?.at).toBe(w.clock.t - 5 * MIN);
  });

  it('a run that took protective actions skips the link scan (subrequest budget); the next one catches up', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    const scans = w.links.scans.length;
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    const r = await w.run();
    expect(w.links.scans.length).toBe(scans);
    expect(r.checks.find((c) => c.id === 'links')).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('protective actions') });
    await w.run();
    expect(w.links.scans.length).toBe(scans + 1);
  });

  it('a stuck link scan (one block over a page) warns truncated and keeps warning', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.links.stuck = true;
    await w.run();
    expect((await alertsOf(w.store, 'link_events_unavailable'))[0]).toMatchObject({ key: 'link_events_unavailable:truncated', severity: 'warning', details: { reason: 'truncated' } });
  });

  it('ignores and prunes link events dated in the future (L2)', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.deps.config.linkVolume.thresholds = { perHour: 1, perScopePerHour: 1 };
    w.links.queue.push(linkEvent('s1', w.clock.t + 2 * HOUR), linkEvent('s1', w.clock.t + 2 * HOUR));
    await w.run();
    expect(await alertsOf(w.store, 'link_volume_high')).toEqual([]);
    expect(await w.store.linkCounts(0)).toEqual([]);
  });

  it('a scope id like __proto__ is counted like any other (L6)', async () => {
    const hana = await emailJwk(201);
    const w = await initialized({ pins: pinsOf({ hana: [hana] }), before: (x) => void x.chain.emailIssuer([hana]) });
    w.deps.config.linkVolume.thresholds = { perHour: 100, perScopePerHour: 1 };
    w.links.queue.push(linkEvent('__proto__', w.clock.t - MIN), linkEvent('__proto__', w.clock.t - MIN));
    await w.run();
    expect((await alertsOf(w.store, 'link_volume_high'))[0]?.details).toMatchObject({ scope_id: '__proto__', new_links: 2 });
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
