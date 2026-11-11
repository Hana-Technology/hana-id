// The share check (Hana Home's "Sign out this device" reaching a tab that is already open, D680–D684, D690–D694): every
// app's vault asks about its share about once a minute while a session with a share is live in a shown, active tab
// (every 5 minutes once the tab is idle), with the light POST /v1/vault/share-status, or the policy's own GET /v1/app in
// an app with a policy; it ends the session on `'revoked'`, never extends one, backs off on failures, pauses while the tab
// is hidden, and a signature from the approval popup or a cached identity token needs a fresh `'live'` answer (with a
// 3-minute grace when the API can't answer). A session it ends says it was signed out (D695): `disconnectReason
// {signed_out}` before its `disconnect`, `data.reason: 'signed_out'` on what it refuses; one that ended otherwise doesn't.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base64UrlEncode, bytesEqual } from '@hana-id/core';
import { functionSelector } from '@hana-id/core/decode';
import type { VaultConfig } from '../../src/vault/config.ts';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import {
  SHARE_FRESH_MS,
  SHARE_GRACE_MS,
  SHARE_NO_ANSWER_REUSE_MS,
  SHARE_WAIT_MS,
  STATUS_READ_TIMEOUT_MS,
  STATUS_IDLE_AFTER_MS,
  STATUS_IDLE_READ_MS,
  STATUS_READ_BACKOFF_MAX_MS,
  STATUS_READ_MS,
  TOUCH_EVERY_MS,
} from '../../src/vault/vault.ts';
import {
  APP_ID,
  Browser,
  ENV,
  type Google,
  HOUR,
  SCOPE,
  START_MS,
  type Tab,
  type TabOptions,
  answer,
  answerConsent,
  apiError,
  disconnectedWith,
  google,
  login,
  makeConfig,
  openApproval,
  readyTab,
  shareBroadcasts,
  sleepReal,
  waitLauncher,
} from './harness.ts';
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
const appReads = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/app');
const lightReads = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/vault/share-status');
/** Every request that asks about the share: the light read, and GET /v1/app with `x-hana-share`. */
const checks = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/vault/share-status' || (c.path === '/v1/app' && c.headers['x-hana-share'] !== undefined));
const statusOf = async (t: Tab): Promise<string> => ((await t.request('hana_status')).result as { status: string }).status;
type Internals = { session: { prk: Uint8Array; lastActivityAt: number; lastTouchAt: number } | null; dormant: unknown };
const internals = (t: Tab) => t.vault as unknown as Internals;
const stored = async (t: Tab) => (await openRecordStore(t.browser.idb)).get(recordKey(ENV.signer, APP_ID, SCOPE, 0));

/** Moves the clock a minute at a time, letting each read finish; `active`: the page makes a request each minute. */
async function minutes(t: Tab, n: number, o: { active?: boolean } = {}): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (o.active) await t.request('hana_status');
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

/**
 * The tab ended as a touch's 410 ends it: disconnect 4900 right after `disconnectReason {signed_out}` (D695), logged
 * out, PRK zeroed, record gone, other tabs told (`signedOut`, then `revoked`).
 */
async function endedByRevoke(t: Tab, prk: Uint8Array, shareId: Uint8Array): Promise<void> {
  await eventually(() => internals(t).session === null, 'the session ended');
  expect(prk.every((b) => b === 0)).toBe(true);
  expect(await t.waitEvent('disconnect')).toEqual({ code: 4900 });
  expect(disconnectedWith(t)).toEqual(['signed_out']);
  expect(t.events.filter((e) => e.event === 'accountsChanged').at(-1)!.data).toEqual({ addresses: null });
  expect(await statusOf(t)).toBe('logged_out');
  await eventually(async () => (await stored(t)) === undefined, 'the record deleted');
  // Every tab that found it says so the same way (two tabs on one share each tell the other): whole `signedOut`,
  // `revoked` pairs, so the list always ends in `revoked`, which tabs of an older build end on.
  const told = shareBroadcasts(t.browser, shareId);
  expect(told.length).toBeGreaterThan(0);
  expect(told.length % 2).toBe(0);
  expect(told.at(-1)).toBe('revoked');
  expect(told).toEqual(told.map((_, i) => (i % 2 === 0 ? 'signedOut' : 'revoked')));
}

const outage = (t: Tab) => {
  t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
  t.browser.backend.overrides.set('/v1/vault/share-status', () => apiError(503, 'share_status_unavailable'));
};
const endOutage = (t: Tab) => {
  t.browser.backend.overrides.delete('/v1/app');
  t.browser.backend.overrides.delete('/v1/vault/share-status');
};

describe('a sign-out from Hana Home reaches an open tab within about a minute', () => {
  it('the cadence and bounds are the documented ones', () => {
    expect(STATUS_READ_MS).toBe(60_000);
    expect(SHARE_FRESH_MS).toBe(60_000);
    expect(SHARE_GRACE_MS).toBe(3 * 60_000);
    expect(SHARE_NO_ANSWER_REUSE_MS).toBe(5_000);
    expect(STATUS_READ_BACKOFF_MAX_MS).toBe(8 * 60_000);
    expect(STATUS_IDLE_AFTER_MS).toBe(5 * 60_000);
    expect(STATUS_IDLE_READ_MS).toBe(5 * 60_000);
  });

  it('an app with no policy: the next minute’s light read ends the tab, with no request from the page', async () => {
    const t = await signedIn();
    const prk = internals(t).session!.prk;
    const shareId = Uint8Array.from(shareOf(t).shareId);
    signOutFromHome(t);
    const before = lightReads(t).length;
    t.browser.timers.advance(STATUS_READ_MS);
    await eventually(() => lightReads(t).length === before + 1, 'the minute’s read ran');
    expect(lightReads(t).at(-1)!.body).toEqual({ shareId: Array.from(shareId) });
    await endedByRevoke(t, prk, shareId);
    await minutes(t, 5);
    expect(checks(t).length).toBe(before + 1);
  });

  it('an app with no policy makes one light read a minute and no GET /v1/app; a GET /v1/app made for something else counts', async () => {
    const t = await signedIn({ settings: { rawSign: 'approval' }, key: 'pk_live_1111111111111111111111' });
    const light = lightReads(t).length;
    const app = appReads(t).length;
    await minutes(t, 4, { active: true });
    expect(lightReads(t).length).toBe(light + 4);
    expect(appReads(t).length).toBe(app);
    // 30 s into the next minute a raw request re-reads GET /v1/app (its own 10 s check, with the share)…
    t.browser.timers.now += 30_000;
    const reply = t.request('hana_signRaw', { chain: 'evm', digest: new Uint8Array(32).fill(1) });
    await waitLauncher(t, 'Review in Hana');
    expect(appReads(t).length).toBe(app + 1);
    const popup = openApproval(t);
    answer(t, popup, await popup.next('hana:approve-request'), false);
    await reply;
    // …so the timer, due 30 s later, waits out the minute since that read instead of reading again.
    t.browser.timers.advance(30_000);
    await settle();
    expect(checks(t).length).toBe(light + 4 + 1);
    t.browser.timers.advance(30_000);
    await settle();
    expect(lightReads(t).length).toBe(light + 5);
  });

  it('an app with a policy: its own GET /v1/app carries the share, one request a minute, no light read', async () => {
    const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
    const pending = t.request('hana_requestAutoApprove');
    await waitLauncher(t, 'Review in Hana');
    const popup = openApproval(t);
    answerConsent(t, popup, await popup.next('hana:consent-request'), true);
    expect((await pending).result).toMatchObject({ granted: true });
    const app = appReads(t).length;
    const light = lightReads(t).length;
    await minutes(t, 10, { active: true });
    expect(appReads(t).length).toBe(app + 10);
    expect(lightReads(t).length).toBe(light);
    for (const c of appReads(t).slice(app)) {
      expect(c.headers['x-hana-share']).toBeDefined();
      expect(c.headers['x-hana-consent']).toBeDefined();
    }
    const prk = internals(t).session!.prk;
    const shareId = Uint8Array.from(shareOf(t).shareId);
    signOutFromHome(t);
    await minutes(t, 1);
    await endedByRevoke(t, prk, shareId);
  });

  it('an app with a policy whose GET /v1/app fails (a NEAR outage behind it): the light read answers instead', async () => {
    const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
    t.browser.backend.overrides.set('/v1/app', () => apiError(502, 'near_unavailable'));
    const light = lightReads(t).length;
    await minutes(t, 1, { active: true });
    expect(lightReads(t).length).toBe(light + 1);
    signOutFromHome(t);
    await minutes(t, 1, { active: true });
    await eventually(() => internals(t).session === null, 'ended by the light read');
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

  it("'none' mode has no share: no share read, nothing to check before signing", async () => {
    const t = await signedIn({ settings: { persistence: 'none' } });
    const before = t.browser.backend.calls.length;
    await minutes(t, 5, { active: true });
    t.browser.timers.now += SHARE_GRACE_MS;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(checks(t)).toHaveLength(0);
    expect(t.browser.backend.calls.slice(before).filter((c) => c.path === '/v1/app')).toHaveLength(0);
  });

  it("'none' mode with a policy keeps its minute's read, as before, without a share header", async () => {
    const t = await signedIn({ settings: { persistence: 'none', autoApprovePolicy: POLICY() } });
    const before = appReads(t).length;
    await minutes(t, 3, { active: true });
    expect(appReads(t).length).toBe(before + 3);
    expect(checks(t)).toHaveLength(0);
  });

  it('no session, no request: a logged-out tab reads nothing', async () => {
    const browser = new Browser();
    browser.backend.serverNow = () => browser.timers.now;
    const t = await readyTab(browser, { googleJwk: g.jwk });
    tabs.push(t);
    await settle();
    const before = browser.backend.calls.length;
    await minutes(t, 5, { active: true });
    expect(browser.backend.calls.slice(before).filter((c) => c.path !== '/v1/app' || c.headers['x-hana-share'])).toHaveLength(0);
    expect(checks(t)).toHaveLength(0);
  });
});

describe('an idle tab reads every 5 minutes (D684, D694)', () => {
  it('after 5 minutes with no activity the reads slow to every 5 minutes; a request from the page brings back the minute', async () => {
    const t = await signedIn();
    const at: number[] = [];
    const before = lightReads(t).length;
    for (let m = 1; m <= 25; m++) {
      t.browser.timers.advance(60_000);
      await settle();
      if (lightReads(t).length > before + at.length) at.push(m);
    }
    // Login was the last activity: every minute up to 5 minutes later, then every 5.
    expect(at).toEqual([1, 2, 3, 4, 9, 14, 19, 24]);
    // The page asks something (any request is activity): within about a minute again, then each minute.
    await t.request('hana_status');
    const n = lightReads(t).length;
    t.browser.timers.advance(10_000);
    await settle();
    t.browser.timers.advance(50_000);
    await settle();
    expect(lightReads(t).length).toBe(n + 1);
    await minutes(t, 3, { active: true });
    expect(lightReads(t).length).toBe(n + 4);
  });

  it('a message from a Hana window (a person in a popup) is activity too, and so is the tab being shown again', async () => {
    const t = await signedIn();
    await minutes(t, 12);
    const n = lightReads(t).length;
    t.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: {} });
    t.browser.timers.advance(10_000);
    await settle();
    expect(lightReads(t).length).toBe(n + 1);
    // A message from any other origin is not.
    await minutes(t, 12);
    const m = lightReads(t).length;
    t.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: 'https://elsewhere.test', source: {} });
    t.browser.timers.advance(10_000);
    await settle();
    expect(lightReads(t).length).toBe(m);
  });

  it('a page that stays silent to slow the reads still can’t sign after a sign-out: the check before the popup catches it', async () => {
    const t = await signedIn();
    await minutes(t, 12);
    signOutFromHome(t);
    t.browser.timers.now += 2 * 60_000;
    const reply = await t.request('stellar_signMessage', { message: 'silent page' });
    expect(reply.error?.code).toBe(4900);
    expect(t.opened.filter((w) => w.url.endsWith('/approve'))).toHaveLength(0);
  });

  it('activity never extends a session: a page asking every minute still reaches the idle limit at 2 h', async () => {
    const t = await signedIn();
    const prk = internals(t).session!.prk;
    await minutes(t, 119, { active: true });
    expect(internals(t).session).not.toBeNull();
    t.browser.timers.advance(60_000);
    await settle();
    expect(prk.every((b) => b === 0)).toBe(true);
    expect(internals(t).session).toBeNull();
  });
});

describe('it only ever ends a session, never extends one', () => {
  it('the reads move neither the in-memory idle limit nor the share’s server idle (no touch, no counter step)', async () => {
    const t = await signedIn();
    const activity = internals(t).session!.lastActivityAt;
    const counter = shareOf(t).counter;
    const prk = internals(t).session!.prk;
    await minutes(t, 60);
    expect(internals(t).session!.lastActivityAt).toBe(activity);
    t.browser.timers.advance(2 * HOUR - 60 * 60_000 - 1);
    await settle();
    expect(internals(t).session).not.toBeNull();
    t.browser.timers.advance(1);
    await settle();
    expect(prk.every((b) => b === 0)).toBe(true);
    expect(t.browser.backend.count('/v1/vault/touch')).toBe(0);
    expect(shareOf(t).counter).toBe(counter);
    expect(checks(t).length).toBeGreaterThanOrEqual(12);
  });

  it('a dormant session is never read for by the timer and never unlocked', async () => {
    const t = await signedIn();
    t.browser.timers.advance(2 * HOUR);
    await settle();
    expect(internals(t).dormant).not.toBeNull();
    const before = checks(t).length;
    const unlocks = t.browser.backend.count('/v1/vault/unlock');
    signOutFromHome(t);
    await minutes(t, 30, { active: true });
    t.setVisibility('hidden');
    t.setVisibility('visible');
    await settle();
    expect(checks(t).length).toBe(before);
    expect(t.browser.backend.count('/v1/vault/unlock')).toBe(unlocks);
    expect(internals(t).dormant).not.toBeNull();
  });

  it('failed reads neither end nor extend the session, and back off: 1, 2, 4, 8, 8 minutes apart', async () => {
    const t = await signedIn();
    const at: number[] = [];
    t.browser.backend.overrides.set('/v1/vault/share-status', () => {
      at.push((t.browser.timers.now - START_MS) / 60_000);
      return apiError(503, 'share_status_unavailable');
    });
    t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    const activity = internals(t).session!.lastActivityAt;
    await minutes(t, 23, { active: true });
    expect(at).toEqual([1, 3, 7, 15, 23]);
    expect(await statusOf(t)).toBe('logged_in');
    expect(internals(t).session!.lastActivityAt).toBe(activity);
    expect(t.browser.backend.count('/v1/vault/touch')).toBe(0);
    endOutage(t);
    await minutes(t, 8, { active: true });
    const after = lightReads(t).length;
    await minutes(t, 3, { active: true });
    expect(lightReads(t).length).toBe(after + 3);
  });

  it('a 429, a 503 or an answer of another shape is no answer: nothing ends', async () => {
    const t = await signedIn();
    signOutFromHome(t);
    t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    t.browser.backend.overrides.set('/v1/vault/share-status', () => apiError(429, 'rate_limited', {}));
    await minutes(t, 3, { active: true });
    expect(await statusOf(t)).toBe('logged_in');
    t.browser.backend.overrides.delete('/v1/vault/share-status');
    t.browser.backend.shareAnswer = () => 'maybe';
    await minutes(t, 4, { active: true });
    expect(await statusOf(t)).toBe('logged_in');
    t.browser.backend.shareAnswer = null;
    await minutes(t, 8, { active: true });
    await eventually(() => internals(t).session === null, 'ended once the API answers revoked');
  });

  it('a slow read: one at a time, never stacked, and the session stays until it answers', async () => {
    const t = await signedIn();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    t.browser.backend.overrides.set('/v1/vault/share-status', async () => {
      await held;
      return undefined;
    });
    const before = lightReads(t).length;
    t.browser.timers.advance(STATUS_READ_MS);
    await eventually(() => lightReads(t).length === before + 1, 'the read sent');
    // Within its 15 s: being shown again, or a page request, joins it rather than sending another.
    t.browser.timers.advance(5_000);
    t.setVisibility('hidden');
    t.setVisibility('visible');
    await t.request('hana_status');
    await settle();
    expect(lightReads(t).length).toBe(before + 1);
    expect(await statusOf(t)).toBe('logged_in');
    signOutFromHome(t);
    release();
    t.browser.backend.overrides.delete('/v1/vault/share-status');
    await eventually(() => internals(t).session === null, 'the session ended');
  });

  it('a new session never joins the previous session’s check in flight: its own share is asked about', async () => {
    const t = await signedIn();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    t.browser.backend.overrides.set('/v1/vault/share-status', async () => {
      if (hold) await held;
      return undefined;
    });
    t.browser.timers.advance(STATUS_READ_MS);
    await eventually(() => lightReads(t).length > 0, 'the first read sent');
    await login(t, g, { sub: '220000000000000000001' });
    hold = false;
    const second = Array.from(shareOf(t).shareId);
    t.setVisibility('hidden');
    t.browser.timers.now += SHARE_FRESH_MS;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(lightReads(t).some((c) => JSON.stringify((c.body as { shareId: number[] }).shareId) === JSON.stringify(second))).toBe(true);
    release();
  });

  it('an answer about an earlier session’s share never touches the next one (an account switch)', async () => {
    const t = await signedIn();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    t.browser.backend.overrides.set('/v1/vault/share-status', async () => {
      await held;
      return undefined;
    });
    t.browser.timers.advance(STATUS_READ_MS);
    await eventually(() => lightReads(t).length > 0, 'the read sent');
    const first = Uint8Array.from(shareOf(t).shareId);
    // Another account signs in in this tab: a new session and share; the old one is revoked by that login.
    await login(t, g, { sub: '220000000000000000001' });
    const second = Uint8Array.from(shareOf(t).shareId);
    expect(bytesEqual(first, second)).toBe(false);
    t.browser.backend.overrides.delete('/v1/vault/share-status');
    release();
    await settle();
    // The held read answered 'revoked' about the first share: the second session stays.
    expect(await statusOf(t)).toBe('logged_in');
    expect(internals(t).session).not.toBeNull();
  });
});

describe('when the API last said live', () => {
  it('an unlock counts from when it was sent, not when it answered (a slow unlock leaves less of the minute)', async () => {
    const browser = new Browser();
    await signedIn({ browser });
    // The reload's unlock takes two minutes to answer, and no share read answers afterwards (the page's first GET
    // /v1/app would otherwise confirm the share at once).
    browser.backend.overrides.set('/v1/vault/unlock', () => {
      browser.timers.now += 2 * 60_000;
      return undefined;
    });
    browser.backend.shareAnswer = () => 'omit';
    const t = await signedIn({ browser, tab: { hidden: true } });
    browser.backend.overrides.delete('/v1/vault/unlock');
    expect(await statusOf(t)).toBe('logged_in');
    const before = checks(t).length;
    // Two minutes since it was sent: past the fresh minute, so a check (no answer), and within the grace, so it signs.
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(checks(t).length).toBeGreaterThan(before);
    // A minute later the unlock's send time is past the 3-minute grace: refused (the answer's time would still be in it).
    t.browser.timers.now += 60_000 + SHARE_NO_ANSWER_REUSE_MS;
    expect((await t.request('stellar_signMessage', { message: 'later' })).error).toMatchObject({ data: { reason: 'share_unconfirmed' } });
  });

  it('a share create counts from when it was sent', async () => {
    const browser = new Browser();
    browser.backend.serverNow = () => browser.timers.now;
    browser.backend.overrides.set('/v1/vault/shares', () => {
      browser.timers.now += 2 * 60_000;
      return undefined;
    });
    const t = await signedIn({ browser, tab: { hidden: true } });
    browser.backend.overrides.delete('/v1/vault/shares');
    const before = checks(t).length;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(checks(t).length).toBe(before + 1);
  });
});

describe('a hidden tab', () => {
  it('reads nothing while hidden; shown again, it checks at once and ends if signed out meanwhile', async () => {
    const t = await signedIn();
    const prk = internals(t).session!.prk;
    const shareId = Uint8Array.from(shareOf(t).shareId);
    t.setVisibility('hidden');
    const before = checks(t).length;
    await minutes(t, 30);
    expect(checks(t).length).toBe(before);
    signOutFromHome(t);
    t.setVisibility('visible');
    await eventually(() => checks(t).length === before + 1, 'one read on being shown');
    await endedByRevoke(t, prk, shareId);
  });

  it('a page restored from the back/forward cache (timers frozen, then shown) checks at once', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    // Frozen: the clock moves, no timer runs.
    t.browser.timers.now += 20 * 60_000;
    signOutFromHome(t);
    t.setVisibility('visible');
    await eventually(() => internals(t).session === null, 'ended at once');
  });

  it('a back/forward-cache restore (pageshow, persisted) with no visibilitychange checks at once too', async () => {
    const t = await signedIn();
    t.browser.timers.now += 20 * 60_000;
    signOutFromHome(t);
    t.pageRestore();
    await eventually(() => internals(t).session === null, 'ended at once');
  });

  it('shown again before the minute is up: no extra read, the timer goes on from the last one', async () => {
    const t = await signedIn();
    await minutes(t, 1);
    const before = checks(t).length;
    t.setVisibility('hidden');
    t.browser.timers.advance(20_000);
    t.setVisibility('visible');
    await settle();
    expect(checks(t).length).toBe(before);
    t.browser.timers.advance(40_000);
    await settle();
    expect(checks(t).length).toBe(before + 1);
  });

  it('a tab that starts hidden reads nothing until shown', async () => {
    const browser = new Browser();
    (await signedIn({ browser })).setVisibility('hidden');
    const t = await signedIn({ browser, tab: { hidden: true } });
    const before = checks(t).length;
    await minutes(t, 5);
    expect(checks(t).length).toBe(before);
    t.setVisibility('visible');
    await eventually(() => checks(t).length === before + 1, 'read once shown');
  });

  it('a hidden tab of an app with a policy keeps its policy read (as before), so it ends too', async () => {
    const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
    t.setVisibility('hidden');
    const before = appReads(t).length;
    await minutes(t, 3, { active: true });
    expect(appReads(t).length).toBe(before + 3);
    signOutFromHome(t);
    await minutes(t, 1, { active: true });
    await eventually(() => internals(t).session === null, 'the session ended');
  });

  it('a host with no visibility counts as shown', async () => {
    const t = await signedIn({ tab: { noVisibility: true } });
    const before = checks(t).length;
    await minutes(t, 2, { active: true });
    expect(checks(t).length).toBe(before + 2);
  });
});

describe('before an approval-popup signature', () => {
  it('within a minute of the last live answer: no extra read', async () => {
    const t = await signedIn();
    const before = checks(t).length;
    t.browser.timers.now += SHARE_FRESH_MS - 1_000;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(checks(t).length).toBe(before);
  });

  it('older: one light read before the popup; signed out → no popup, the session ends', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.timers.now += SHARE_FRESH_MS;
    signOutFromHome(t);
    const before = checks(t).length;
    const reply = await t.request('stellar_signMessage', { message: 'stolen device' });
    expect(reply.error).toEqual({ code: 4900, message: 'This session was revoked', data: { reason: 'signed_out' } });
    expect(disconnectedWith(t)).toEqual(['signed_out']);
    expect(checks(t).length).toBe(before + 1);
    expect(lightReads(t).length).toBeGreaterThan(0);
    expect(t.opened.filter((w) => w.url.endsWith('/approve'))).toHaveLength(0);
    expect(await statusOf(t)).toBe('logged_out');
  });

  it('older and still live: one read, then the popup and the signature', async () => {
    const t = await signedIn();
    t.browser.timers.now += SHARE_FRESH_MS;
    const before = checks(t).length;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(checks(t).length).toBe(before + 1);
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
    expect(r.error).toMatchObject({ code: 4900, data: { reason: 'signed_out' } });
    expect(disconnectedWith(t)).toEqual(['signed_out']);
  });

  it('a popup still open when the minute’s read finds the device signed out: the popup ends and the request is refused, signed out', async () => {
    const t = await signedIn();
    const reply = t.request('stellar_signMessage', { message: 'still deciding' });
    await waitLauncher(t, 'Review in Hana');
    const popup = openApproval(t);
    await popup.next('hana:approve-request');
    signOutFromHome(t);
    t.browser.timers.advance(STATUS_READ_MS);
    const r = await reply;
    expect(r.result).toBeUndefined();
    expect(r.error).toEqual({ code: 4900, message: 'This session was signed out', data: { reason: 'signed_out' } });
    expect(disconnectedWith(t)).toEqual(['signed_out']);
  });

  it('the API can’t answer: signs within the 3 minutes’ grace since the last live answer', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    outage(t);
    t.browser.timers.now += SHARE_GRACE_MS - 10_000;
    expect((await approvedMessage(t)).error).toBeUndefined();
  });

  it('past the grace with no answer: refused (api_unavailable, share_unconfirmed) before any popup; signing resumes with an answer', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    outage(t);
    t.browser.timers.now += SHARE_GRACE_MS;
    const reply = await t.request('stellar_signMessage', { message: 'outage' });
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'share_unconfirmed' } });
    expect(t.opened.filter((w) => w.url.endsWith('/approve'))).toHaveLength(0);
    expect(await statusOf(t)).toBe('logged_in');
    endOutage(t);
    t.browser.timers.now += SHARE_NO_ANSWER_REUSE_MS;
    expect((await approvedMessage(t)).error).toBeUndefined();
  });

  it('a 429 from the light read is no answer: the grace applies, never a sign-out', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.backend.overrides.set('/v1/vault/share-status', () => apiError(429, 'rate_limited'));
    t.browser.backend.overrides.set('/v1/app', () => apiError(429, 'rate_limited'));
    t.browser.timers.now += SHARE_FRESH_MS;
    expect((await approvedMessage(t)).error).toBeUndefined();
    t.browser.timers.now += SHARE_GRACE_MS;
    expect((await t.request('stellar_signMessage', { message: 'x' })).error).toMatchObject({ data: { reason: 'share_unconfirmed' } });
    expect(await statusOf(t)).toBe('logged_in');
  });

  it('sign requests in a row during an outage share one check (a no-answer is reused for 5 s)', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    outage(t);
    t.browser.timers.now += SHARE_GRACE_MS;
    const before = t.browser.backend.calls.length;
    for (let i = 0; i < 4; i++) expect((await t.request('stellar_signMessage', { message: `m${i}` })).error).toMatchObject({ data: { reason: 'share_unconfirmed' } });
    // One check: the light read and its GET /v1/app fallback, once.
    expect(t.browser.backend.calls.slice(before).filter((c) => c.path === '/v1/vault/share-status')).toHaveLength(1);
    t.browser.timers.now += SHARE_NO_ANSWER_REUSE_MS;
    await t.request('stellar_signMessage', { message: 'later' });
    expect(t.browser.backend.calls.slice(before).filter((c) => c.path === '/v1/vault/share-status')).toHaveLength(2);
  });

  it.each([
    ['as a browser sees it (a failed preflight)', 'old'],
    ['a readable 404 not_found', 'old-readable'],
  ] as const)('an API older than the light read, %s: GET /v1/app answers instead, it is never a sign-out, and it sticks for a while', async (_name, mode) => {
    const t = await signedIn();
    t.browser.backend.shareStatusEndpoint = mode;
    t.setVisibility('hidden');
    t.browser.timers.now += SHARE_FRESH_MS;
    expect((await approvedMessage(t)).error).toBeUndefined();
    expect(await statusOf(t)).toBe('logged_in');
    const light = lightReads(t).length;
    // From then on GET /v1/app alone (no OPTIONS-and-fail per check), which still ends a signed-out tab.
    t.setVisibility('visible');
    await minutes(t, 3, { active: true });
    expect(lightReads(t).length).toBe(light);
    // Half an hour on, the light read is tried again; once the API has it, it is used again.
    t.browser.backend.shareStatusEndpoint = true;
    await minutes(t, 30, { active: true });
    expect(lightReads(t).length).toBeGreaterThan(light);
    const now = lightReads(t).length;
    await minutes(t, 2, { active: true });
    expect(lightReads(t).length).toBe(now + 2);
    signOutFromHome(t);
    await minutes(t, 1, { active: true });
    await eventually(() => internals(t).session === null, 'ended');
  });

  it('a light read that fails as a network error while GET /v1/app fails too (offline) doesn’t stick', async () => {
    const t = await signedIn();
    t.browser.backend.shareStatusEndpoint = 'old';
    t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    await minutes(t, 1, { active: true });
    t.browser.backend.shareStatusEndpoint = true;
    t.browser.backend.overrides.delete('/v1/app');
    const light = lightReads(t).length;
    await minutes(t, 3, { active: true });
    expect(lightReads(t).length).toBeGreaterThan(light);
  });

  it('a read that hangs is waited for 8 s at most, given up after 15 s, and the checks recover when the API is back', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    const never = () => new Promise<Response | undefined>(() => undefined);
    t.browser.backend.overrides.set('/v1/vault/share-status', never);
    t.browser.backend.overrides.set('/v1/app', never);
    t.browser.timers.now += SHARE_GRACE_MS;
    const before = lightReads(t).length;
    const reply = t.request('stellar_signMessage', { message: 'hung' });
    await eventually(() => lightReads(t).length === before + 1, 'the read sent');
    t.browser.timers.advance(SHARE_WAIT_MS);
    expect((await reply).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'share_unconfirmed' } });
    // The stalled light read and then its GET /v1/app fallback are each given up at 15 s: the check settles.
    t.browser.timers.advance(STATUS_READ_TIMEOUT_MS);
    await settle();
    await eventually(() => appReads(t).length > 0 && t.browser.backend.calls.at(-1)!.path === '/v1/app', 'the fallback sent');
    t.browser.timers.advance(STATUS_READ_TIMEOUT_MS);
    await settle();
    // The API is back: the next check is a new request (not the dead one), it answers, and signing works, no reload.
    endOutage(t);
    t.browser.timers.now += SHARE_NO_ANSWER_REUSE_MS;
    const n = lightReads(t).length;
    expect((await approvedMessage(t, 'after the outage')).error).toBeUndefined();
    expect(lightReads(t).length).toBe(n + 1);
  });

  it('the background timer survives a stalled read too: re-armed after the timeout, it ends a signed-out tab', async () => {
    const t = await signedIn();
    const never = () => new Promise<Response | undefined>(() => undefined);
    t.browser.backend.overrides.set('/v1/vault/share-status', never);
    t.browser.backend.overrides.set('/v1/app', never);
    await minutes(t, 1, { active: true });
    t.browser.timers.advance(STATUS_READ_TIMEOUT_MS);
    await settle();
    t.browser.timers.advance(STATUS_READ_TIMEOUT_MS);
    await settle();
    endOutage(t);
    signOutFromHome(t);
    await minutes(t, 4, { active: true });
    await eventually(() => internals(t).session === null, 'ended by a later check');
  });

  it('the grace is aged on both clocks: a device clock set back doesn’t stretch it, nor does a monotonic clock stopped by sleep', async () => {
    // The device clock goes back 10 minutes: the corrected clock stands still, the monotonic one runs on.
    const a = await signedIn({ tab: { fakePerf: true } });
    a.setVisibility('hidden');
    outage(a);
    a.browser.timers.now -= 10 * 60_000;
    a.browser.timers.perf += SHARE_GRACE_MS;
    expect((await a.request('stellar_signMessage', { message: 'clock back' })).error).toMatchObject({ data: { reason: 'share_unconfirmed' } });
    // The device slept: the monotonic clock stopped, the device clock moved on.
    const b = await signedIn({ tab: { fakePerf: true } });
    b.setVisibility('hidden');
    outage(b);
    b.browser.timers.now += SHARE_GRACE_MS;
    expect((await b.request('stellar_signMessage', { message: 'slept' })).error).toMatchObject({ data: { reason: 'share_unconfirmed' } });
    // Within the grace on both clocks it signs.
    const c = await signedIn({ tab: { fakePerf: true } });
    c.setVisibility('hidden');
    outage(c);
    c.browser.timers.now += SHARE_GRACE_MS - 30_000;
    c.browser.timers.perf += SHARE_GRACE_MS - 30_000;
    expect((await approvedMessage(c)).error).toBeUndefined();
  });

  it('a touch (an approved signature, at most every 10 minutes) also counts as a live answer', async () => {
    const t = await signedIn();
    t.setVisibility('hidden');
    t.browser.timers.now += TOUCH_EVERY_MS;
    expect((await approvedMessage(t)).error).toBeUndefined();
    await eventually(() => t.browser.backend.count('/v1/vault/touch') === 1, 'touched');
    outage(t);
    t.browser.timers.now += SHARE_GRACE_MS - 1_000;
    expect((await approvedMessage(t, 'after the touch')).error).toBeUndefined();
  });

  it('auto-signing is unchanged: it needs its own 10 s answer and makes no light read', async () => {
    const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
    const pending = t.request('hana_requestAutoApprove');
    await waitLauncher(t, 'Review in Hana');
    const popup = openApproval(t);
    answerConsent(t, popup, await popup.next('hana:consent-request'), true);
    await pending;
    const app = appReads(t).length;
    const light = lightReads(t).length;
    t.browser.timers.now += 11_000;
    expect(((await t.request('eth_signTransaction', { tx: evmTx() })).result as string).startsWith('0x02')).toBe(true);
    expect(appReads(t).length).toBe(app + 1);
    expect(lightReads(t).length).toBe(light);
  });
});

describe('a cached identity token (D692)', () => {
  async function withToken(t: Tab): Promise<string> {
    const r = await t.request('hana_identityToken');
    const token = (r.result as { identityToken: string }).identityToken;
    expect(token).toMatch(/\./u);
    return token;
  }

  it('fresh: served from the cache with no read', async () => {
    const t = await signedIn();
    const token = await withToken(t);
    const before = checks(t).length;
    t.browser.timers.now += SHARE_FRESH_MS - 1_000;
    expect(((await t.request('hana_identityToken')).result as { identityToken: string }).identityToken).toBe(token);
    expect(checks(t).length).toBe(before);
  });

  it('a hidden tab signed out from Home: the next request checks, ends the session and hands out nothing', async () => {
    const t = await signedIn();
    await withToken(t);
    t.setVisibility('hidden');
    t.browser.timers.now += 10 * 60_000;
    signOutFromHome(t);
    expect((await t.request('hana_identityToken')).result).toEqual({ identityToken: null, expiresAtMs: null });
    expect(await statusOf(t)).toBe('logged_out');
    expect(disconnectedWith(t)).toEqual(['signed_out']);
  });

  it('a dormant session’s token: the light read, no unlock; signed out → dropped', async () => {
    const t = await signedIn();
    // A token that outlives the 2 h idle limit (the real API caps it at the session's end).
    t.browser.backend.identityTtlS = 3 * 3600;
    await withToken(t);
    t.browser.timers.advance(2 * HOUR - 1);
    await settle();
    t.browser.timers.advance(1);
    await settle();
    expect(internals(t).dormant).not.toBeNull();
    // Its last live answer is over a minute old (the timer never reads for a dormant session).
    t.browser.timers.now += SHARE_FRESH_MS;
    const unlocks = t.browser.backend.count('/v1/vault/unlock');
    const light = lightReads(t).length;
    signOutFromHome(t);
    expect((await t.request('hana_identityToken')).result).toEqual({ identityToken: null, expiresAtMs: null });
    expect(lightReads(t).length).toBe(light + 1);
    expect(t.browser.backend.count('/v1/vault/unlock')).toBe(unlocks);
    expect(internals(t).dormant).toBeNull();
    // A dormant session ends signed out too (D695).
    expect(disconnectedWith(t)).toEqual(['signed_out']);
    expect(shareBroadcasts(t.browser, shareOf(t).shareId)).toEqual(['signedOut', 'revoked']);
  });

  it('the API can’t answer past the grace: refused (share_unconfirmed), the session stays', async () => {
    const t = await signedIn();
    await withToken(t);
    t.setVisibility('hidden');
    outage(t);
    t.browser.timers.now += SHARE_GRACE_MS;
    expect((await t.request('hana_identityToken')).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'share_unconfirmed' } });
    expect(await statusOf(t)).toBe('logged_in');
  });
});

it('the share header names the share (base64url) on GET /v1/app', async () => {
  const t = await signedIn({ settings: { autoApprovePolicy: POLICY() } });
  await minutes(t, 1, { active: true });
  expect(appReads(t).at(-1)!.headers['x-hana-share']).toBe(base64UrlEncode(shareOf(t).shareId));
});
