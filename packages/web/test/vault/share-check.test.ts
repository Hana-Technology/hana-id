// The share check (Hana Home's "Sign out this device" reaching a tab that is already open): every app's vault reads
// GET /v1/app with its share about once a minute while a session with a share is live in a shown tab, ends the session on
// `share: 'revoked'`, never extends one, backs off on failures, pauses while the tab is hidden, and an approval-popup
// signature needs a fresh `'live'` answer (with a grace when the API can't answer).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base64UrlEncode, bytesEqual, toHex } from '@hana-id/core';
import { functionSelector } from '@hana-id/core/decode';
import type { VaultConfig } from '../../src/vault/config.ts';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { SHARE_FRESH_MS, SHARE_GRACE_MS, SHARE_WAIT_MS, STATUS_READ_BACKOFF_MAX_MS, STATUS_READ_MS, TOUCH_EVERY_MS } from '../../src/vault/vault.ts';
import { APP_ID, Browser, ENV, type Google, HOUR, SCOPE, START_MS, type Tab, type TabOptions, answer, answerConsent, apiError, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
import { CHAIN, EVM_VAULT, evmTx } from './chains.ts';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

const POLICY = () => ({
  v: 1,
  label: 'Swaps on Example',
  maxConsentMs: 6 * HOUR,
  limits: { perDayCount: 5 },
  evm: {
    chains: [
      {
        chainId: CHAIN,
        maxValueWei: '101000',
        maxValueWeiPerDay: '900000',
        maxFeeWei: '100000',
        contracts: [{ address: EVM_VAULT, name: 'Example vault', selectors: [{ selector: functionSelector('deposit(uint256)'), signature: 'deposit(uint256)' }] }],
      },
    ],
  },
});

/** A logged-in tab ('session' mode unless `settings` says otherwise), the API's clock moving with the test's. */
async function signedIn(o: { browser?: Browser; settings?: Partial<VaultConfig['settings']>; key?: string; tab?: Omit<TabOptions, 'config'> } = {}): Promise<Tab> {
  const browser = o.browser ?? new Browser();
  browser.backend.serverNow = () => browser.timers.now;
  const config = makeConfig({ settings: o.settings ?? {}, ...(o.key ? { publishableKey: o.key } : {}) });
  const t = await readyTab(browser, { googleJwk: g.jwk, config, ...o.tab });
  tabs.push(t);
  if (((await t.ready()) as { status: string }).status !== 'logged_in') await login(t, g);
  return t;
}

const eventually = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 300 && !(await check()); i++) await sleepReal(5);
  expect(await check(), what).toBe(true);
};
/** Lets the vault's async work after a timer (the read, its answer, the re-arm) finish. */
const settle = () => sleepReal(25);

const shareOf = (t: Tab) => [...t.browser.backend.shares.values()].at(-1)!;
const reads = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/app');
const shareReads = (t: Tab) => reads(t).filter((c) => c.headers['x-hana-share'] !== undefined);
const statusOf = async (t: Tab): Promise<string> => ((await t.request('hana_status')).result as { status: string }).status;
type Internals = { session: { prk: Uint8Array; lastActivityAt: number; lastTouchAt: number } | null; dormant: unknown };
const internals = (t: Tab) => t.vault as unknown as Internals;
const stored = async (t: Tab) => (await openRecordStore(t.browser.idb)).get(recordKey(ENV.signer, APP_ID, SCOPE, 0));

/** Moves the clock a minute at a time, letting each read finish. */
async function minutes(t: Tab, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    t.browser.timers.advance(60_000);
    await settle();
  }
}

/** An approval-popup stellar_signMessage, answered `approved`; returns the reply. */
async function approvedMessage(t: Tab, message = 'hello'): Promise<Awaited<ReturnType<Tab['request']>>> {
  const reply = t.request('stellar_signMessage', { message });
  await waitLauncher(t, 'Review in Hana');
  const popup = openApproval(t);
  answer(t, popup, await popup.next('hana:approve-request'), true);
  popup.closed = true;
  return reply;
}

/** "Sign out this device" in Hana Home: the share is revoked on the API. */
const signOutFromHome = (t: Tab) => {
  shareOf(t).revoked = true;
};

/** The tab ended as a touch's 410 ends it: disconnect 4900, logged out, PRK zeroed, record gone, other tabs told. */
async function endedByRevoke(t: Tab, prk: Uint8Array, shareId: Uint8Array): Promise<void> {
  await eventually(() => internals(t).session === null, 'the session ended');
  expect(prk.every((b) => b === 0)).toBe(true);
  expect(await t.waitEvent('disconnect')).toEqual({ code: 4900 });
  expect(t.events.filter((e) => e.event === 'accountsChanged').at(-1)!.data).toEqual({ addresses: null });
  expect(await statusOf(t)).toBe('logged_out');
  await eventually(async () => (await stored(t)) === undefined, 'the record deleted');
  expect(t.browser.bus.sent.some((m) => (m.data as { t: string }).t === 'revoked' && bytesEqual((m.data as { shareId: Uint8Array }).shareId, shareId))).toBe(true);
}

describe('a sign-out from Hana Home reaches an open tab within about a minute', () => {
  it('the cadence is the documented minute, with its bounds', () => {
    expect(STATUS_READ_MS).toBe(60_000);
    expect(SHARE_FRESH_MS).toBe(60_000);
    expect(SHARE_GRACE_MS).toBe(10 * 60_000);
    expect(STATUS_READ_BACKOFF_MAX_MS).toBe(8 * 60_000);
  });

  it('an app with no policy: the next minute’s read ends the tab, with no request from the page', async () => {
    const t = await signedIn();
    const prk = internals(t).session!.prk;
    const shareId = Uint8Array.from(shareOf(t).shareId);
    signOutFromHome(t);
    const before = shareReads(t).length;
    t.browser.timers.advance(STATUS_READ_MS);
    await eventually(() => shareReads(t).length === before + 1, 'the minute’s read ran');
    expect(shareReads(t).at(-1)!.headers['x-hana-share']).toBe(base64UrlEncode(shareId));
    await endedByRevoke(t, prk, shareId);
    // Nothing more is read for it.
    await minutes(t, 5);
    expect(shareReads(t).length).toBe(before + 1);
  });

  it('an app with a policy: the same, from the policy’s own read; one request a minute, never two', async () => {
    const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
    // A consent, so the read names both the consent and the share.
    const pending = t.request('hana_requestAutoApprove');
    await waitLauncher(t, 'Review in Hana');
    const popup = openApproval(t);
    answerConsent(t, popup, await popup.next('hana:consent-request'), true);
    expect((await pending).result).toMatchObject({ granted: true });
    const before = reads(t).length;
    await minutes(t, 10);
    expect(reads(t).length).toBe(before + 10);
    for (const c of reads(t).slice(before)) {
      expect(c.headers['x-hana-share']).toBeDefined();
      expect(c.headers['x-hana-consent']).toBeDefined();
    }
    const prk = internals(t).session!.prk;
    const shareId = Uint8Array.from(shareOf(t).shareId);
    signOutFromHome(t);
    await minutes(t, 1);
    await endedByRevoke(t, prk, shareId);
  });

  it('one request a minute in an app with no policy too, and a read made for something else counts (no second read)', async () => {
    const t = await signedIn({ settings: { rawSign: 'approval' }, key: 'pk_live_1111111111111111111111' });
    const before = reads(t).length;
    await minutes(t, 5);
    expect(reads(t).length).toBe(before + 5);
    // 30 s into the next minute a raw request re-reads GET /v1/app (raw signing's own 10 s check)…
    t.browser.timers.now += 30_000;
    const reply = t.request('hana_signRaw', { chain: 'evm', digest: new Uint8Array(32).fill(1) });
    await waitLauncher(t, 'Review in Hana');
    expect(reads(t).length).toBe(before + 6);
    const popup = openApproval(t);
    answer(t, popup, await popup.next('hana:approve-request'), false);
    await reply;
    // …so the timer, due 30 s later, waits out the minute since that read instead of reading again.
    t.browser.timers.advance(30_000);
    await settle();
    expect(reads(t).length).toBe(before + 6);
    t.browser.timers.advance(30_000);
    await settle();
    expect(reads(t).length).toBe(before + 7);
  });

  it('a reloaded tab (unlocked from its record) is checked the same way', async () => {
    const browser = new Browser();
    await signedIn({ browser });
    const again = await signedIn({ browser });
    expect(((await again.ready()) as { status: string }).status).toBe('logged_in');
    const prk = internals(again).session!.prk;
    const shareId = Uint8Array.from(shareOf(again).shareId);
    signOutFromHome(again);
    await minutes(again, 1);
    await endedByRevoke(again, prk, shareId);
  });

  it("'none' mode has no share: no share header, no read a minute without a policy, nothing to check before signing", async () => {
    const t = await signedIn({ settings: { persistence: 'none' } });
    const before = reads(t).length;
    await minutes(t, 5);
    expect(reads(t).length).toBe(before);
    // Long after any read, an approval signature makes none either: there is nothing Hana Home could sign out.
    t.browser.timers.now += SHARE_GRACE_MS;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(reads(t).length).toBe(before);
    expect(t.browser.backend.calls.some((c) => c.headers['x-hana-share'] !== undefined)).toBe(false);
  });

  it("'none' mode with a policy keeps its minute's read, as before, without a share header", async () => {
    const t = await signedIn({ settings: { persistence: 'none', autoApprovePolicy: POLICY() } });
    const before = reads(t).length;
    await minutes(t, 3);
    expect(reads(t).length).toBe(before + 3);
    expect(reads(t).slice(before).every((c) => c.headers['x-hana-share'] === undefined)).toBe(true);
  });

  it('no session, no request: a logged-out tab reads nothing', async () => {
    const browser = new Browser();
    browser.backend.serverNow = () => browser.timers.now;
    const t = await readyTab(browser, { googleJwk: g.jwk });
    tabs.push(t);
    await settle();
    const before = reads(t).length;
    await minutes(t, 5);
    expect(reads(t).length).toBe(before);
  });
});

describe('it only ever ends a session, never extends one', () => {
  it('the minute’s reads move neither the in-memory idle limit nor the share’s server idle (no touch, no counter step)', async () => {
    const t = await signedIn();
    const activity = internals(t).session!.lastActivityAt;
    const counter = shareOf(t).counter;
    const touches = t.browser.backend.count('/v1/vault/touch');
    const prk = internals(t).session!.prk;
    // An hour of reads, then the idle limit (2 h) arrives exactly when it would have without them.
    await minutes(t, 60);
    expect(internals(t).session!.lastActivityAt).toBe(activity);
    t.browser.timers.advance(2 * HOUR - 60 * 60_000 - 1);
    await settle();
    expect(internals(t).session).not.toBeNull();
    t.browser.timers.advance(1);
    await settle();
    expect(prk.every((b) => b === 0)).toBe(true);
    expect(internals(t).session).toBeNull();
    expect(t.browser.backend.count('/v1/vault/touch')).toBe(touches);
    expect(shareOf(t).counter).toBe(counter);
    expect(shareReads(t).length).toBeGreaterThanOrEqual(60);
  });

  it('a dormant session is never read for (a status read must not wake it) and never unlocked by the timer', async () => {
    const t = await signedIn();
    t.browser.timers.advance(2 * HOUR);
    await settle();
    expect(internals(t).dormant).not.toBeNull();
    const before = shareReads(t).length;
    const unlocks = t.browser.backend.count('/v1/vault/unlock');
    // Revoked meanwhile: still nothing is read; the next request that needs the key finds out (as before).
    signOutFromHome(t);
    await minutes(t, 30);
    t.setVisibility('hidden');
    t.setVisibility('visible');
    await settle();
    expect(shareReads(t).length).toBe(before);
    expect(t.browser.backend.count('/v1/vault/unlock')).toBe(unlocks);
    expect(internals(t).dormant).not.toBeNull();
    expect(await statusOf(t)).toBe('logged_in');
  });

  it('a failed read neither ends nor extends the session, and the reads back off: 1, 2, 4, 8, 8 minutes', async () => {
    const t = await signedIn();
    const at: number[] = [];
    t.browser.backend.overrides.set('/v1/app', () => {
      at.push((t.browser.timers.now - START_MS) / 60_000);
      return apiError(503, 'config_unavailable');
    });
    const activity = internals(t).session!.lastActivityAt;
    await minutes(t, 23);
    expect(at).toEqual([1, 3, 7, 15, 23]);
    expect(await statusOf(t)).toBe('logged_in');
    expect(internals(t).session!.lastActivityAt).toBe(activity);
    expect(t.browser.backend.count('/v1/vault/touch')).toBe(0);
    // The API answers again: the next read is back to a minute after it.
    t.browser.backend.overrides.delete('/v1/app');
    await minutes(t, 8);
    const after = shareReads(t).length;
    await minutes(t, 3);
    expect(shareReads(t).length).toBe(after + 3);
  });

  it('an answer without the share field (the API’s D1 read failed) ends nothing', async () => {
    const t = await signedIn();
    signOutFromHome(t);
    t.browser.backend.shareAnswer = () => 'omit';
    await minutes(t, 3);
    expect(await statusOf(t)).toBe('logged_in');
    t.browser.backend.shareAnswer = () => 'maybe';
    await minutes(t, 1);
    expect(await statusOf(t)).toBe('logged_in');
    t.browser.backend.shareAnswer = null;
    await minutes(t, 1);
    await eventually(() => internals(t).session === null, 'ended once the API answers revoked');
  });

  it('a slow read: one at a time, no pile-up, and the session stays until it answers', async () => {
    const t = await signedIn();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    t.browser.backend.overrides.set('/v1/app', async () => {
      await held;
      return undefined;
    });
    const before = reads(t).length;
    await minutes(t, 6);
    expect(reads(t).length).toBe(before + 1);
    expect(await statusOf(t)).toBe('logged_in');
    signOutFromHome(t);
    release();
    t.browser.backend.overrides.delete('/v1/app');
    // The held read answers 'revoked' (the backend reads the share as it answers): the tab ends.
    await eventually(() => internals(t).session === null, 'the session ended');
  });
});

describe('a hidden tab', () => {
  it('reads nothing while hidden; shown again, it checks at once and ends if signed out meanwhile', async () => {
    const t = await signedIn();
    const prk = internals(t).session!.prk;
    const shareId = Uint8Array.from(shareOf(t).shareId);
    t.setVisibility('hidden');
    const before = reads(t).length;
    await minutes(t, 30);
    expect(reads(t).length).toBe(before);
    signOutFromHome(t);
    t.setVisibility('visible');
    await eventually(() => reads(t).length === before + 1, 'one read on being shown');
    await endedByRevoke(t, prk, shareId);
  });

  it('shown again before the minute is up: no extra read, the timer goes on from the last one', async () => {
    const t = await signedIn();
    await minutes(t, 1);
    const before = reads(t).length;
    t.setVisibility('hidden');
    t.browser.timers.advance(20_000);
    t.setVisibility('visible');
    await settle();
    expect(reads(t).length).toBe(before);
    t.browser.timers.advance(40_000);
    await settle();
    expect(reads(t).length).toBe(before + 1);
  });

  it('a tab that starts hidden reads nothing until shown', async () => {
    const browser = new Browser();
    // The tab that signed in, hidden too (the two share one backend and one share).
    (await signedIn({ browser })).setVisibility('hidden');
    const t = await signedIn({ browser, tab: { hidden: true } });
    const before = shareReads(t).length;
    await minutes(t, 5);
    expect(shareReads(t).length).toBe(before);
    t.setVisibility('visible');
    await eventually(() => shareReads(t).length === before + 1, 'read once shown');
  });

  it('a hidden tab of an app with a policy keeps its minute’s read (as before), so it ends too', async () => {
    const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
    t.setVisibility('hidden');
    const before = reads(t).length;
    await minutes(t, 3);
    expect(reads(t).length).toBe(before + 3);
    signOutFromHome(t);
    await minutes(t, 1);
    await eventually(() => internals(t).session === null, 'the session ended');
  });

  it('a host with no visibility counts as shown', async () => {
    const t = await signedIn({ tab: { noVisibility: true } });
    const before = reads(t).length;
    await minutes(t, 2);
    expect(reads(t).length).toBe(before + 2);
  });
});

describe('before an approval-popup signature', () => {
  it('within a minute of the last live answer: no extra read', async () => {
    const t = await signedIn();
    const before = reads(t).length;
    t.browser.timers.now += SHARE_FRESH_MS - 1_000;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(reads(t).length).toBe(before);
  });

  it('older (a throttled or just-shown tab): one read before the popup; signed out → no popup, the session ends', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.timers.now += SHARE_FRESH_MS;
    signOutFromHome(t);
    const before = reads(t).length;
    const reply = await t.request('stellar_signMessage', { message: 'stolen device' });
    expect(reply.error?.code).toBe(4900);
    expect(reads(t).length).toBe(before + 1);
    expect(t.opened.filter((w) => w.url.endsWith('/approve'))).toHaveLength(0);
    expect(t.launcher.label).not.toBe('Review in Hana');
    expect(await statusOf(t)).toBe('logged_out');
  });

  it('older and still live: one read, then the popup and the signature', async () => {
    const t = await signedIn();
    t.browser.timers.now += SHARE_FRESH_MS;
    const before = reads(t).length;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(reads(t).length).toBe(before + 1);
  });

  it('a popup left up past the minute: re-read after Approve; signed out meanwhile → nothing is signed', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    const reply = t.request('stellar_signMessage', { message: 'slow click' });
    await waitLauncher(t, 'Review in Hana');
    const popup = openApproval(t);
    const m = await popup.next('hana:approve-request');
    t.browser.timers.now += SHARE_FRESH_MS + 1;
    signOutFromHome(t);
    answer(t, popup, m, true);
    const r = await reply;
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(4900);
    expect(await statusOf(t)).toBe('logged_out');
  });

  it('the API can’t answer: signs within the 10 minutes’ grace since the last live answer', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    t.browser.timers.now += SHARE_GRACE_MS - 60_000;
    expect((await approvedMessage(t)).error).toBeUndefined();
    // An answer without the share field is no answer either.
    t.browser.backend.overrides.delete('/v1/app');
    t.browser.backend.shareAnswer = () => 'omit';
    expect((await approvedMessage(t, 'again')).error).toBeUndefined();
  });

  it('past the grace with no answer: refused (api_unavailable, share_unconfirmed) before any popup; signing resumes with an answer', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    t.browser.timers.now += SHARE_GRACE_MS;
    const reply = await t.request('stellar_signMessage', { message: 'outage' });
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'share_unconfirmed' } });
    expect(t.opened.filter((w) => w.url.endsWith('/approve'))).toHaveLength(0);
    // The session stays.
    expect(await statusOf(t)).toBe('logged_in');
    t.browser.backend.overrides.delete('/v1/app');
    expect((await approvedMessage(t)).error).toBeUndefined();
  });

  it('a read that hangs is waited for 8 s at most, then counts as no answer', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.backend.overrides.set('/v1/app', () => new Promise<Response | undefined>(() => undefined));
    t.browser.timers.now += SHARE_GRACE_MS;
    const before = reads(t).length;
    const reply = t.request('stellar_signMessage', { message: 'hung' });
    await eventually(() => reads(t).length === before + 1, 'the read sent');
    await sleepReal(20);
    expect(t.replies.length === 0 || !t.replies.some((r) => r.error?.data && (r.error.data as { reason?: string }).reason === 'share_unconfirmed')).toBe(true);
    t.browser.timers.advance(SHARE_WAIT_MS);
    expect((await reply).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'share_unconfirmed' } });
  });

  it('a touch (an approved signature, at most every 10 minutes) also counts as a live answer', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.timers.now += TOUCH_EVERY_MS;
    // The read before this popup confirms it; its approval touches the share.
    expect((await approvedMessage(t)).error).toBeUndefined();
    await eventually(() => t.browser.backend.count('/v1/vault/touch') === 1, 'touched');
    t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    t.browser.timers.now += SHARE_GRACE_MS - 1_000;
    expect((await approvedMessage(t, 'after the touch')).error).toBeUndefined();
  });

  it('auto-signing is unchanged: it needs its own 10 s answer and makes no extra read for the share', async () => {
    const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
    const pending = t.request('hana_requestAutoApprove');
    await waitLauncher(t, 'Review in Hana');
    const popup = openApproval(t);
    answerConsent(t, popup, await popup.next('hana:consent-request'), true);
    await pending;
    const before = reads(t).length;
    t.browser.timers.now += 11_000;
    const tx = evmTx();
    expect(((await t.request('eth_signTransaction', { tx })).result as string).startsWith('0x02')).toBe(true);
    expect(reads(t).length).toBe(before + 1);
    expect(toHex(shareOf(t).shareId)).toBeTruthy();
  });
});
