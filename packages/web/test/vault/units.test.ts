// Unit tests of the vault's pure pieces: the inlined config parser and parent rule, the policy in force, the record
// and consent encryption, the clock, the launcher queue and the in-page lock.
import { describe, expect, it } from 'vitest';
import { APPROVAL_MAX_BYTES, type ApprovalSubject, parseWindowMessage, recordAad, utf8 } from '@hana-id/core';
import { Approvals, MAX_PENDING_APPROVALS } from '../../src/vault/approvals.ts';
import { parentAllowed, parseVaultConfig, policyInForce } from '../../src/vault/config.ts';
import { Launcher, type LauncherView } from '../../src/vault/launcher.ts';
import { type RecordBinding, type RecordV1, openConsent, openPrk, parseRecord, recordKey, sealConsent, sealPrk } from '../../src/vault/record.ts';
import { Clock, localLocks } from '../../src/vault/runtime.ts';
import { ENV, FakeLauncherView, FakeWindow, HOUR, PARTNER, TestTimers, approveDigest, makeConfig, sleepReal } from './harness.ts';

describe('parseVaultConfig', () => {
  it('accepts the page config', () => {
    expect(parseVaultConfig(makeConfig())).toEqual(makeConfig());
  });

  it.each([
    ['a signer field', { signer: 'x.testnet' }],
    ['v 2', { v: 2 }],
    ['a bad scope', { scopeId: 'S 1' }],
    ['a bad pk', { publishableKey: 'sk_live_x' }],
    ['21 origins', { origins: Array.from({ length: 21 }, (_, i) => `https://p${i}.test`) }],
    ['a path origin', { origins: [`${PARTNER}/x`] }],
    ['an appId with |', { appId: 'a|b' }],
    ['an empty appName', { appName: '' }],
    ['a negative serverTimeMs', { serverTimeMs: -1 }],
  ])('refuses %s', (_, change) => {
    expect(parseVaultConfig({ ...makeConfig(), ...change })).toBeNull();
  });

  it.each([
    ['persistence', { persistence: 'forever' }],
    ['rawSign', { rawSign: 'silent' }],
    ['a session TTL under 1 h', { sessionTtlMs: HOUR - 1 }],
    ['a session TTL over 23 h 50 min', { sessionTtlMs: 24 * HOUR }],
    ['an idle TTL over the session TTL', { idleTtlMs: 13 * HOUR }],
    ['a policy that is not an object', { autoApprovePolicy: 'x' }],
    ['an extra setting', { appSigned: true }],
  ])('refuses settings with %s', (_, change) => {
    const c = makeConfig();
    expect(parseVaultConfig({ ...c, settings: { ...c.settings, ...change } })).toBeNull();
  });
});

describe('parentAllowed', () => {
  const c = (origins: string[], pk = 'pk_test_1111111111111111111111') => ({ origins, publishableKey: pk });
  it('is an exact match', () => {
    expect(parentAllowed(c([PARTNER]), PARTNER, false)).toBe(true);
    expect(parentAllowed(c([PARTNER]), 'https://partner.test:443', false)).toBe(false);
    expect(parentAllowed(c([PARTNER]), 'https://sub.partner.test', false)).toBe(false);
    expect(parentAllowed(c([PARTNER]), null, false)).toBe(false);
    expect(parentAllowed(c([PARTNER]), 'null', false)).toBe(false);
  });
  it('allows loopback only for pk_test_ in dev envs', () => {
    expect(parentAllowed(c(['http://127.0.0.1:3000']), 'http://127.0.0.1:3000', true)).toBe(true);
    expect(parentAllowed(c(['http://127.0.0.1:3000']), 'http://127.0.0.1:3000', false)).toBe(false);
    expect(parentAllowed(c(['http://127.0.0.1:3000'], 'pk_live_1111111111111111111111'), 'http://127.0.0.1:3000', true)).toBe(false);
    expect(parentAllowed(c(['http://localhost:*']), 'http://localhost:5173', true)).toBe(true);
    expect(parentAllowed(c(['http://localhost:*']), 'http://evil.localhost:5173', true)).toBe(false);
  });
});

describe('policyInForce', () => {
  it('is null with no policy, or one the validator refuses, and carries the policyId otherwise', () => {
    expect(policyInForce(makeConfig().settings)).toBeNull();
    const bad = { ...makeConfig().settings, autoApprovePolicy: { v: 1, label: 'x', maxConsentMs: 60_000, limits: { perDayCount: 1 }, personalSign: true } };
    expect(policyInForce(bad)).toBeNull();
    const evm = { chains: [{ chainId: 1, maxValueWei: '0', maxValueWeiPerDay: '0', maxFeeWei: '1', contracts: [{ address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', name: 'Vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)' }] }] }] };
    const ok = { ...makeConfig().settings, autoApprovePolicy: { v: 1, label: 'x', maxConsentMs: 60_000, limits: { perDayCount: 1 }, evm } };
    expect(policyInForce(ok)?.policyId).toMatch(/^[0-9a-f]{64}$/u);
    // maxConsentMs may not exceed the app's session TTL.
    const long = { ...ok, sessionTtlMs: HOUR, autoApprovePolicy: { ...ok.autoApprovePolicy, maxConsentMs: 2 * HOUR } };
    expect(policyInForce(long)).toBeNull();
  });
});

describe('record encryption', () => {
  const binding: RecordBinding = {
    signer: 'hana-signer.testnet',
    appId: 'app_1',
    path: 's1#google#1#0',
    sessionPk: new Uint8Array(32).fill(3),
    derivationVersion: 1,
    ckdKeyHash: new Uint8Array(32).fill(4),
    parentOrigin: PARTNER,
    expiresAtMs: 1_800_000_000_000,
  };
  const ks = new Uint8Array(32).fill(9);
  const prk = new Uint8Array(32).fill(5);

  it('seals PRK under K_s with the record AAD, and opens it back', async () => {
    const { iv, ct } = await sealPrk(ks, prk, binding);
    const record = { ...binding, iv, ct } as unknown as RecordV1;
    expect(Array.from(await openPrk(ks, record))).toEqual(Array.from(prk));
    // The inputs are untouched; the AAD is core's layout.
    expect(prk.every((b) => b === 5)).toBe(true);
    expect(recordAad({ ...binding, sessionPublicKey: binding.sessionPk }).length).toBeGreaterThan(100);
  });

  it.each(['signer', 'appId', 'path', 'parentOrigin'] as const)('fails when %s changes', async (field) => {
    const { iv, ct } = await sealPrk(ks, prk, binding);
    await expect(openPrk(ks, { ...binding, [field]: `${binding[field]}x`, iv, ct } as unknown as RecordV1)).rejects.toThrow(/does not decrypt/u);
  });

  it('fails with another K_s, expiry, version or CKD key hash', async () => {
    const { iv, ct } = await sealPrk(ks, prk, binding);
    const base = { ...binding, iv, ct } as unknown as RecordV1;
    await expect(openPrk(new Uint8Array(32), base)).rejects.toThrow();
    await expect(openPrk(ks, { ...base, expiresAtMs: base.expiresAtMs + 1 })).rejects.toThrow();
    await expect(openPrk(ks, { ...base, derivationVersion: 2 })).rejects.toThrow();
    await expect(openPrk(ks, { ...base, ckdKeyHash: new Uint8Array(32) })).rejects.toThrow();
  });

  it('seals the consent under a PRK-derived key, bound to the record', async () => {
    const consent = { policyId: 'a'.repeat(64), grantedAt: 1, expiresAtMs: 2, day: 3, count: 1, valueWeiByChain: { '8453': '10' } };
    const sealed = await sealConsent(prk, binding, consent);
    const record = { ...binding, consent: sealed } as unknown as RecordV1;
    expect(await openConsent(prk, record)).toEqual(consent);
    await expect(openConsent(new Uint8Array(32).fill(6), record)).rejects.toThrow();
    await expect(openConsent(prk, { ...record, path: 'other' })).rejects.toThrow();
    expect(await openConsent(prk, { ...binding } as unknown as RecordV1)).toBeNull();
  });

  it('parseRecord refuses wrong shapes and an extractable session key', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const r = { v: 1, ...binding, scopeId: 's1', keyIndex: 0, sessionKeyPair: kp, shareId: new Uint8Array(16), counter: 0, iv: new Uint8Array(12), ct: new Uint8Array(48), addresses: { stellar: 'G', evm: '0x' } };
    expect(parseRecord(r)).toBeNull();
    const nx = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    expect(parseRecord({ ...r, sessionKeyPair: nx })).not.toBeNull();
    expect(parseRecord({ ...r, sessionKeyPair: nx, shareId: new Uint8Array(15) })).toBeNull();
    expect(recordKey('s.testnet', 'app_1', 's1', 0)).toBe('s.testnet|app_1|s1|0');
  });
});

describe('Clock', () => {
  it('corrects the device clock from the server time, and refreshes', () => {
    let device = 1000;
    const clock = new Clock(5000, () => device);
    expect(clock.now()).toBe(5000);
    device = 1500;
    expect(clock.now()).toBe(5500);
    clock.refresh(9000);
    expect(clock.now()).toBe(9000);
    clock.refresh('x');
    clock.refresh(-1);
    expect(clock.now()).toBe(9000);
  });
});

describe('Launcher', () => {
  function make() {
    const shown: (string | null)[] = [];
    let click: (() => void) | null = null;
    const view: LauncherView = {
      show: (l, c) => {
        shown.push(l);
        click = c;
      },
      hide: () => shown.push(null),
    };
    const ui: { launcher: string; label: string }[] = [];
    const timers = new TestTimers();
    return { launcher: new Launcher(view, (u) => ui.push(u), timers), shown, ui, click: () => click?.(), timers };
  }

  it('shows the oldest intent; removing it shows the next, then hides', () => {
    const m = make();
    const clicks: string[] = [];
    const a = m.launcher.push('A', () => clicks.push('A'));
    const b = m.launcher.push('B', () => clicks.push('B'));
    m.click();
    expect(clicks).toEqual(['A']);
    a.remove();
    m.click();
    expect(clicks).toEqual(['A', 'B']);
    b.remove();
    expect(m.launcher.label).toBeNull();
    expect(m.ui).toEqual([
      { launcher: 'show', label: 'A' },
      { launcher: 'show', label: 'B' },
      { launcher: 'hide', label: '' },
    ]);
  });

  it('a flash shows over the intents for its time, without a click action, and clips long labels', async () => {
    const m = make();
    m.launcher.push('A', () => undefined);
    m.launcher.flash(`Signed by Hana under ${'x'.repeat(100)}`, 3000);
    expect(m.launcher.label).toHaveLength(80);
    await sleepReal(20);
    expect(m.launcher.label).toBe('A');
    m.timers.dispose();
  });
});

describe('localLocks', () => {
  it('serialises callers of one name, and continues after a rejection', async () => {
    const locks = localLocks();
    const order: string[] = [];
    const a = locks.request('x', async () => {
      order.push('a1');
      await sleepReal(10);
      order.push('a2');
    });
    const b = locks.request('x', async () => {
      order.push('b');
      throw new Error('b');
    });
    const c = locks.request('x', async () => order.push('c'));
    await a;
    await expect(b).rejects.toThrow('b');
    await c;
    expect(order).toEqual(['a1', 'a2', 'b', 'c']);
  });
});

describe('Approvals', () => {
  const ADDRESS = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
  const subject = (bytes: Uint8Array = utf8('hi')): ApprovalSubject => ({ kind: 'personal_sign', chain: 'evm', address: ADDRESS, context: {}, bytes });

  function make() {
    const timers = new TestTimers();
    const view = new FakeLauncherView();
    const opened: FakeWindow[] = [];
    const approvals = new Approvals({
      authOrigin: ENV.authOrigin,
      appName: 'Partner',
      parentOrigin: PARTNER,
      open: (url, name, features) => {
        const w = new FakeWindow(url, name, features);
        opened.push(w);
        return w;
      },
      launcher: new Launcher(view, () => undefined, timers),
      timers,
      now: () => timers.now,
      onStop: () => undefined,
    });
    const send = (popup: FakeWindow, data: Record<string, unknown>) => approvals.handleMessage({ data: { v: 1, ...data }, origin: ENV.authOrigin, source: popup, ports: [] });
    /** Clicks the launcher and connects the popup it opens. */
    const connect = (): FakeWindow => {
      view.click();
      const popup = opened.at(-1)!;
      send(popup, { t: 'hana:approve-hello' });
      return popup;
    };
    return { approvals, timers, connect, send };
  }

  it(`refuses a request past ${MAX_PENDING_APPROVALS} waiting or on show, at once`, async () => {
    const { approvals } = make();
    const waiting = Array.from({ length: MAX_PENDING_APPROVALS }, () => approvals.requestApproval(subject()));
    expect(approvals.pending).toBe(MAX_PENDING_APPROVALS);
    await expect(approvals.requestApproval(subject())).rejects.toMatchObject({ code: 4100, data: { reason: 'too_many_pending' } });
    await expect(approvals.requestConsent({} as never, 'a'.repeat(64), 1)).rejects.toMatchObject({ code: 4100 });
    approvals.cancelAll();
    expect(await Promise.all(waiting)).toEqual(Array(MAX_PENDING_APPROVALS).fill('cancelled'));
    // Room again.
    const again = approvals.requestApproval(subject());
    approvals.cancelAll();
    expect(await again).toBe('cancelled');
  });

  it("refuses a request whose message the popup's validator would drop (over the 192 KiB cap), at once", async () => {
    const { approvals } = make();
    await expect(approvals.requestApproval(subject(new Uint8Array(APPROVAL_MAX_BYTES)))).rejects.toMatchObject({ code: 4100, data: { reason: 'invalid_request' } });
    expect(approvals.pending).toBe(0);
    // A note the popup would refuse (a reason outside its pattern) is refused the same way.
    await expect(approvals.requestApproval(subject(), { label: 'Swaps', active: true, reason: 'Not A Reason' })).rejects.toMatchObject({ code: 4100 });
  });

  it('keeps position and queued within the protocol (≤ 1000) over a long batch in one popup', async () => {
    const { approvals, connect, send } = make();
    let popup: FakeWindow | null = null;
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 1002; i++) {
      const outcome = approvals.requestApproval(subject(utf8(`m${i}`)));
      popup ??= connect();
      last = popup.posted.at(-1)!.message;
      expect(parseWindowMessage(last, ['hana:approve-request'])).not.toBeNull();
      send(popup, { t: 'hana:approve-result', id: last.id, approved: true, digest: approveDigest(last) });
      expect(await outcome).toBe('approved');
    }
    expect(last).toMatchObject({ position: 1000, queued: 1000 });
  });
});
