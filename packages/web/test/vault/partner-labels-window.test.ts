// D896: the vault hands the approval window the partner labels of its own fresh `GET /v1/app` read, and nothing else.
// A request whose labels' read is older than PARTNER_LABELS_FRESH_MS waits for one fresh read (at most
// PARTNER_LABELS_WAIT_MS), once, then goes with what is fresh, or with none; a read that fails, is late, or answers
// none means no labels, never an error and never a blocked request. Only documents of the request's chain go, only
// documents the vault's own check passed, and two describing the same contract go neither.
import { sha256, toHex } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POLICY_FRESH_MS } from '../../src/vault/vault.ts';
import { PARTNER_LABELS_FRESH_MS, PARTNER_LABELS_WAIT_MS } from '../../src/vault/partner-labels.ts';
import { Browser, type Google, type Tab, answer, apiError, google, login, openApproval, readyTab, waitLauncher } from './harness.ts';
import { Asset, Operation } from '@stellar/stellar-base';
import { PASSPHRASE, stellarTx } from './chains.ts';

/** The app's till: a random public key no one has the secret key of (an address book refuses a public seed's account). */
const TILL = 'GC4OI7BDJ3EGZCOJOA3FNHCHQFQ4OKHXKZK6MXS2WFZBVMZ37I2NS4HC';
const payment = () => Operation.payment({ destination: TILL, asset: Asset.native(), amount: '1' });

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

const PAYMENT_DOC = JSON.stringify({
  schema: 'journear-labels/1',
  context: { stellar: { networkPassphrase: PASSPHRASE } },
  metadata: { addressBook: [{ account: TILL, name: 'Coffee Club till' }] },
  display: { formats: { payment: { call: { memo: 'none' }, intent: { verb: 'pay', object: 'the coffee' }, sentence: ['verb', 'object'], fields: [] } } },
});
const NEAR_DOC = JSON.stringify({
  schema: 'journear-labels/1',
  context: { near: { network: 'testnet', account: 'club.testnet', codeHash: 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn' } },
  display: { formats: { join: { call: { args: {} }, intent: { verb: 'join', object: 'the club' }, sentence: ['verb', 'object'], fields: [] } } },
});
const hash = (t: string) => toHex(sha256(new TextEncoder().encode(t)));
let seq = 0;
const delivered = (text: string, o: Record<string, unknown> = {}) => ({ id: `pl_A${++seq}`, changeId: `lc_B${seq}`, version: 'journear-labels/1', sha256: hash(text), text, effectiveSince: 1, previousEffectiveSince: null, ...o });

async function session(partnerLabels?: unknown): Promise<Tab> {
  const browser = new Browser();
  if (partnerLabels !== undefined) browser.backend.app = { ...browser.backend.app, partnerLabels };
  const t = await readyTab(browser, { googleJwk: g.jwk, fakePerf: true });
  tabs.push(t);
  await login(t, g);
  return t;
}

const appReads = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/app').length;

/** A Stellar payment for approval: the request the popup gets. */
async function shownPayment(t: Tab) {
  const stellar = ((t.replies.find((r) => (r.result as { addresses?: unknown } | undefined)?.addresses)?.result as { addresses: { stellar: string } }).addresses).stellar;
  const reply = t.request('stellar_signTransaction', { xdr: stellarTx(stellar, [payment()]), networkPassphrase: PASSPHRASE });
  await waitLauncher(t, 'Review in Journear Passport');
  const popup = openApproval(t);
  const m = await popup.next('hana:approve-request');
  return { reply, popup, m };
}

/** Waits until the vault's first GET /v1/app (in the background after `ready`) has answered. */
async function settled(t: Tab): Promise<void> {
  for (let i = 0; i < 200 && appReads(t) === 0; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 5));
}

describe('the freshness window', () => {
  it('is the policies’ 10 s (POLICY_FRESH_MS), and the wait for a fresh read is 3 s', () => {
    expect(PARTNER_LABELS_FRESH_MS).toBe(10_000);
    expect(PARTNER_LABELS_FRESH_MS).toBe(POLICY_FRESH_MS);
    expect(PARTNER_LABELS_WAIT_MS).toBe(3_000);
  });
});

describe('what the window gets', () => {
  it('a fresh read: the checked documents of the request’s chain, as their text, and nothing of another chain', async () => {
    const t = await session([delivered(PAYMENT_DOC), delivered(NEAR_DOC)]);
    await settled(t);
    const { reply, popup, m } = await shownPayment(t);
    expect(m.partnerLabels).toEqual([PAYMENT_DOC]);
    answer(t, popup, m, true);
    expect((await reply).error).toBeUndefined();
  });

  it('no labels delivered (the switch off, an older API): the message is exactly the older one, and no extra read', async () => {
    const t = await session();
    await settled(t);
    t.browser.timers.advance(PARTNER_LABELS_FRESH_MS + 1);
    const before = appReads(t);
    const { popup, m } = await shownPayment(t);
    expect(m).not.toHaveProperty('partnerLabels');
    expect(appReads(t)).toBe(before);
    answer(t, popup, m, false);
  });

  it('an empty list, a refused document, another network, or two documents for one contract: no labels', async () => {
    const mainnet = PAYMENT_DOC.replace(PASSPHRASE, 'Public Global Stellar Network ; September 2015');
    const claim = PAYMENT_DOC.replace('the coffee', 'the verified coffee');
    for (const served of [[], [delivered(claim)], [delivered(mainnet)], [delivered(PAYMENT_DOC), delivered(PAYMENT_DOC)], [delivered(PAYMENT_DOC, { sha256: hash(`${PAYMENT_DOC} `) })]]) {
      const t = await session(served);
      await settled(t);
      const { popup, m } = await shownPayment(t);
      expect(m).not.toHaveProperty('partnerLabels');
      answer(t, popup, m, false);
    }
  });
});

describe('a stale read', () => {
  it('older than the window: one fresh read first; what it serves is what the window gets', async () => {
    const t = await session([delivered(PAYMENT_DOC)]);
    await settled(t);
    t.browser.timers.advance(PARTNER_LABELS_FRESH_MS);
    const before = appReads(t);
    const { popup, m } = await shownPayment(t);
    expect(appReads(t)).toBe(before + 1);
    expect(m.partnerLabels).toEqual([PAYMENT_DOC]);
    answer(t, popup, m, false);
  });

  it('a staff switch or block in between: the fresh read serves none, and the window gets none', async () => {
    const t = await session([delivered(PAYMENT_DOC)]);
    await settled(t);
    t.browser.timers.advance(PARTNER_LABELS_FRESH_MS + 5);
    t.browser.backend.app = { ...t.browser.backend.app, partnerLabels: [] };
    const { popup, m } = await shownPayment(t);
    expect(m).not.toHaveProperty('partnerLabels');
    answer(t, popup, m, false);
  });

  it('the fresh read fails: the request is still shown, without labels', async () => {
    const t = await session([delivered(PAYMENT_DOC)]);
    await settled(t);
    t.browser.timers.advance(PARTNER_LABELS_FRESH_MS + 5);
    t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'unavailable'));
    const { reply, popup, m } = await shownPayment(t);
    expect(m).not.toHaveProperty('partnerLabels');
    answer(t, popup, m, true);
    expect((await reply).error).toBeUndefined();
  });

  it('the fresh read never answers: after PARTNER_LABELS_WAIT_MS the request is shown without labels', async () => {
    const t = await session([delivered(PAYMENT_DOC)]);
    await settled(t);
    t.browser.timers.advance(PARTNER_LABELS_FRESH_MS + 5);
    t.browser.backend.overrides.set('/v1/app', () => new Promise<Response>(() => undefined));
    const { popup, m } = await shownPayment(t);
    expect(m).not.toHaveProperty('partnerLabels');
    answer(t, popup, m, false);
  });

  it('only the device clock went back (a monotonic clock that moved on): still stale', async () => {
    const t = await session([delivered(PAYMENT_DOC)]);
    await settled(t);
    t.browser.timers.perf += PARTNER_LABELS_FRESH_MS + 5;
    t.browser.backend.app = { ...t.browser.backend.app, partnerLabels: [] };
    const { popup, m } = await shownPayment(t);
    expect(m).not.toHaveProperty('partnerLabels');
    answer(t, popup, m, false);
  });
});
