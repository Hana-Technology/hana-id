// Unit tests of the vault's pure pieces: the inlined config parser and parent rule, the policy in force, the record
// and consent encryption, the clock, the launcher queue and the in-page lock.
import { describe, expect, it } from 'vitest';
import { APPROVAL_MAX_BYTES, type ApprovalSubject, parseWindowMessage, recordAad, utf8 } from '@hana-id/core';
import { Approvals, LATE_CLOSE_MS, MAX_PENDING_APPROVALS, POPUP_REUSE_MS, POPUP_WAIT_MS } from '../../src/vault/approvals.ts';
import { parentAllowed, parseVaultConfig, policyInForce } from '../../src/vault/config.ts';
import { Launcher, type LauncherView } from '../../src/vault/launcher.ts';
import { type RecordBinding, type RecordV1, openConsent, openPrk, parseRecord, recordKey, sealConsent, sealPrk } from '../../src/vault/record.ts';
import { Clock, type Timers, localLocks } from '../../src/vault/runtime.ts';
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
    const evm = { chains: [{ chainId: 1, maxValueWei: '1', maxValueWeiPerDay: '1', maxFeeWei: '1', contracts: [{ address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', name: 'Vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)' }] }] }] };
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

  function make(timers: Timers & { now: number } = new TestTimers()) {
    const view = new FakeLauncherView();
    const opened: FakeWindow[] = [];
    const parent = new FakeWindow('partner');
    const windowEvents: boolean[] = [];
    const approvals = new Approvals({
      authOrigin: ENV.authOrigin,
      parentWindow: parent,
      onWindow: (open) => windowEvents.push(open),
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
    /** A popup the partner page opened in the user's click (its opener is the partner window), saying hello. */
    const partnerPopup = (opener: unknown = parent, origin = ENV.authOrigin): FakeWindow => {
      const popup = new FakeWindow(`${ENV.authOrigin}/approve?from=partner&v=hana-vault-x`, 'hana-approve-p', '', opener);
      approvals.handleMessage({ data: { v: 1, t: 'hana:approve-hello' }, origin, source: popup, ports: [] });
      return popup;
    };
    return { approvals, timers, connect, send, view, opened, parent, partnerPopup, windowEvents };
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

  it("refuses a request whose message the popup's validator would drop (bytes over the 192 KiB cap), at once", async () => {
    const { approvals } = make();
    await expect(approvals.requestApproval(subject(new Uint8Array(APPROVAL_MAX_BYTES + 1)))).rejects.toMatchObject({ code: 4100, data: { reason: 'invalid_request' } });
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

  describe('a popup the partner page opened in the click (D95)', () => {
    const requests = (w: FakeWindow) => w.posted.filter((p) => p.message.t === 'hana:approve-request').map((p) => p.message);
    const closes = (w: FakeWindow) => w.posted.filter((p) => p.message.t === 'hana:approve-close');

    it('is adopted for the request: it gets the request, the launcher never shows, the vault opens nothing', async () => {
      const { approvals, view, opened, partnerPopup, send, windowEvents } = make(new ManualTimers());
      const claim = approvals.claim();
      const outcome = approvals.requestApproval(subject());
      expect(view.label).toBeNull();
      const popup = partnerPopup();
      const [m] = requests(popup);
      expect(m).toMatchObject({ kind: 'personal_sign', position: 1, queued: 1 });
      expect(popup.posted[0]!.targetOrigin).toBe(ENV.authOrigin);
      send(popup, { t: 'hana:approve-result', id: m!.id, approved: true, digest: approveDigest(m!) });
      expect(await outcome).toBe('approved');
      claim.release();
      // Shown and answered: the window stays for a follow-up (it is not told to close).
      expect(closes(popup)).toHaveLength(0);
      expect(view.history).toEqual([]);
      expect(opened).toHaveLength(0);
      expect(windowEvents).toEqual([true]);
    });

    it('is adopted when its hello comes first, and the request then goes to it', async () => {
      const { approvals, view, partnerPopup, send } = make(new ManualTimers());
      const popup = partnerPopup();
      expect(requests(popup)).toHaveLength(0);
      const claim = approvals.claim();
      const outcome = approvals.requestApproval(subject());
      const [m] = requests(popup);
      expect(m).toBeDefined();
      send(popup, { t: 'hana:approve-result', id: m!.id, approved: false, digest: approveDigest(m!) });
      expect(await outcome).toBe('rejected');
      claim.release();
      expect(view.history).toEqual([]);
    });

    it('a hello from a window not opened by the partner page, or from another origin, is ignored', () => {
      const { approvals, view, partnerPopup, timers } = make(new ManualTimers());
      const claim = approvals.claim();
      void approvals.requestApproval(subject());
      const stranger = partnerPopup(new FakeWindow('https://evil.test'));
      const noOpener = partnerPopup(null);
      const wrongOrigin = partnerPopup(undefined, 'https://evil.test');
      const vaultOrigin = partnerPopup(undefined, ENV.vaultOrigin);
      for (const w of [stranger, noOpener, wrongOrigin, vaultOrigin]) expect(w.posted).toEqual([]);
      // The launcher is the fallback once the wait is over.
      (timers as ManualTimers).advance(POPUP_WAIT_MS);
      expect(view.label).toBe('Review in Hana');
      claim.release();
      approvals.cancelAll();
    });

    it(`holds the launcher ${POPUP_WAIT_MS} ms for the popup's hello, then shows it; a late hello still adopts the popup`, () => {
      const { approvals, view, partnerPopup, timers } = make(new ManualTimers());
      const claim = approvals.claim();
      void approvals.requestApproval(subject());
      (timers as ManualTimers).advance(POPUP_WAIT_MS - 1);
      expect(view.label).toBeNull();
      (timers as ManualTimers).advance(1);
      expect(view.label).toBe('Review in Hana');
      const popup = partnerPopup();
      expect(requests(popup)).toHaveLength(1);
      expect(view.label).toBeNull();
      claim.release();
      approvals.cancelAll();
    });

    it('a request that ends without an approval screen (auto-approved, refused) closes the popup at once; nothing can be approved there', async () => {
      const { approvals, partnerPopup, send, view, windowEvents } = make(new ManualTimers());
      const popup = partnerPopup();
      const claim = approvals.claim();
      // The vault signed it under the accepted policy (or refused it): no requestApproval.
      claim.release();
      expect(closes(popup)).toHaveLength(1);
      expect(closes(popup)[0]!.targetOrigin).toBe(ENV.authOrigin);
      expect(popup.closed).toBe(true);
      expect(requests(popup)).toHaveLength(0);
      expect(windowEvents).toEqual([true, false]);
      // An answer from that window, even a well-formed one for a request queued since, is never taken.
      const next = approvals.requestApproval(subject());
      expect(view.label).toBe('Review in Hana');
      const id = 'ab'.repeat(16);
      send(popup, { t: 'hana:approve-result', id, approved: true, digest: approveDigest({ id, kind: 'personal_sign', chain: 'evm', address: ADDRESS, context: {}, bytes: utf8('hi'), parentOrigin: PARTNER }) });
      send(popup, { t: 'hana:approve-hello' });
      expect(requests(popup)).toHaveLength(0);
      approvals.cancelAll();
      expect(await next).toBe('cancelled');
    });

    it(`closes a popup whose hello comes after its request ended, within ${LATE_CLOSE_MS} ms; later it is adopted again`, () => {
      const { approvals, partnerPopup, timers } = make(new ManualTimers());
      approvals.claim().release();
      const late = partnerPopup();
      expect(closes(late)).toHaveLength(1);
      // Once is enough: the next popup (another click) is adopted.
      const next = partnerPopup();
      expect(closes(next)).toHaveLength(0);
      approvals.cancelAll();
      approvals.claim().release();
      (timers as ManualTimers).advance(LATE_CLOSE_MS);
      const afterWindow = partnerPopup();
      expect(closes(afterWindow)).toHaveLength(0);
    });

    it('keeps a popup another request still uses: release closes only a window that showed nothing', async () => {
      const { approvals, partnerPopup, send } = make(new ManualTimers());
      const popup = partnerPopup();
      const a = approvals.claim();
      const b = approvals.claim();
      const outcome = approvals.requestApproval(subject());
      a.release(); // A's request was auto-approved; B's is on show.
      expect(closes(popup)).toHaveLength(0);
      const [m] = requests(popup);
      send(popup, { t: 'hana:approve-result', id: m!.id, approved: true, digest: approveDigest(m!) });
      expect(await outcome).toBe('approved');
      b.release();
      expect(closes(popup)).toHaveLength(0);
    });

    it('requests queued before it keep their order; the adopted popup shows them first, with their positions', async () => {
      const { approvals, partnerPopup, send } = make(new ManualTimers());
      const first = approvals.requestApproval(subject(utf8('first')));
      const second = approvals.requestApproval(subject(utf8('second')));
      const claim = approvals.claim();
      const third = approvals.requestApproval(subject(utf8('third')));
      const popup = partnerPopup();
      const answer = async (p: Promise<unknown>, text: string, n: number) => {
        const m = requests(popup)[n]!;
        expect(new TextDecoder().decode(m.bytes as Uint8Array)).toBe(text);
        expect(m).toMatchObject({ position: n + 1, queued: 3 });
        send(popup, { t: 'hana:approve-result', id: m.id, approved: true, digest: approveDigest(m) });
        expect(await p).toBe('approved');
      };
      await answer(first, 'first', 0);
      await answer(second, 'second', 1);
      await answer(third, 'third', 2);
      claim.release();
    });

    it('a second window while one is in use is told to close; the one in use keeps the queue', async () => {
      const { approvals, connect, partnerPopup, send } = make(new ManualTimers());
      const outcome = approvals.requestApproval(subject());
      const inUse = connect();
      const [m] = requests(inUse);
      const claim = approvals.claim();
      const second = approvals.requestApproval(subject(utf8('two')));
      const newcomer = partnerPopup();
      expect(closes(newcomer)).toHaveLength(1);
      expect(requests(newcomer)).toHaveLength(0);
      expect(inUse.focused).toBeGreaterThan(0);
      send(inUse, { t: 'hana:approve-result', id: m!.id, approved: true, digest: approveDigest(m!) });
      expect(await outcome).toBe('approved');
      const [, m2] = requests(inUse);
      expect(new TextDecoder().decode(m2!.bytes as Uint8Array)).toBe('two');
      send(inUse, { t: 'hana:approve-result', id: m2!.id, approved: true, digest: approveDigest(m2!) });
      expect(await second).toBe('approved');
      claim.release();
    });

    it('a stale idle window is replaced by the new one', () => {
      const { approvals, partnerPopup, timers } = make(new ManualTimers());
      const old = partnerPopup();
      (timers as ManualTimers).advance(POPUP_REUSE_MS + 1);
      const fresh = partnerPopup();
      expect(closes(old)).toHaveLength(1);
      expect(closes(fresh)).toHaveLength(0);
      void approvals.requestApproval(subject());
      expect(requests(fresh)).toHaveLength(1);
      approvals.cancelAll();
    });

    it('logout (cancelAll) tells the adopted popup to close', () => {
      const { approvals, partnerPopup } = make(new ManualTimers());
      const popup = partnerPopup();
      void approvals.requestApproval(subject());
      approvals.cancelAll();
      expect(closes(popup)).toHaveLength(1);
    });

    it('reports the window open and closed (approvalWindow) as it is adopted and as it closes', () => {
      const { approvals, partnerPopup, timers, windowEvents } = make(new ManualTimers());
      const popup = partnerPopup();
      expect(windowEvents).toEqual([true]);
      popup.closed = true;
      (timers as ManualTimers).advance(500);
      expect(windowEvents).toEqual([true, false]);
      void approvals;
    });
  });
});

/** Timers that run only when the test advances them (TestTimers runs short ones on the next real tick). */
class ManualTimers implements Timers {
  now = 1_800_000_000_000;
  private seq = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.due.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.due.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
    }
    this.now = end;
  }
}
