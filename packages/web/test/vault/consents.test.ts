// Auto-approve consents on the API (Hana Home, D45, D98 item 13, D465, D510–D513, D530–D538): the vault records a
// consent before it stores it, fails closed, reads its status with the existing 10 s read, and stops it when it is revoked.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode, fromHex, toHex } from '@hana-id/core';
import { functionSelector } from '@hana-id/core/decode';
import { CONSENT_ASK_AGAIN_MS, CONSENT_NOT_VISIBLE_RETRIES, CONSENT_RETRY_MAX_MS, POLICY_FRESH_MS, POLICY_REFRESH_MS } from '../../src/vault/vault.ts';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { APP_ID, Browser, ENV, type FakeWindow, type Google, HOUR, type Tab, type TabOptions, SCOPE, START_MS, answer, answerConsent, apiError, disconnectedWith, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
import { CHAIN, EVM_VAULT, evmTx, evmTxSigner } from './chains.ts';

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

interface S {
  t: Tab;
  evm: string;
}

async function session(browser = new Browser(), over: Parameters<typeof makeConfig>[0] = {}, options?: TabOptions['options']): Promise<S> {
  browser.backend.serverNow = () => browser.timers.now;
  const config = makeConfig({ ...over, settings: { autoApprovePolicy: POLICY(), ...over.settings } });
  const t = await readyTab(browser, { googleJwk: g.jwk, config, ...(options ? { options } : {}) });
  tabs.push(t);
  const status = (await t.ready()) as { status: string; addresses?: { evm: string } };
  if (status.status === 'logged_in') return { t, evm: status.addresses!.evm };
  const { reply } = await login(t, g);
  return { t, evm: (reply.result as { addresses: { evm: string } }).addresses.evm };
}

const none = { settings: { persistence: 'none' as const } };
const registers = (s: S) => s.t.browser.backend.count('/v1/vault/consents');
const revokes = (s: S) => s.t.browser.backend.count('/v1/vault/consents/revoke');
const registerCalls = (s: S) => s.t.browser.backend.calls.filter((c) => c.path === '/v1/vault/consents');
const status = async (s: S): Promise<unknown> => (await s.t.request('hana_autoApproveStatus')).result;
const consentId = (s: S): string => [...s.t.browser.backend.consents.keys()].at(-1)!;
const eventually = async (check: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await sleepReal(5);
  expect(check(), what).toBe(true);
};
const eventually2 = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 200 && !(await check()); i++) await sleepReal(5);
  expect(await check(), what).toBe(true);
};
type Internals = { session: { consent: { consentId: string } | null } | null; confirmConsent: unknown; consentConfirmed(id: string): boolean };
const internals = (s: S) => s.t.vault as unknown as Internals;
/** A share's id, as the backend holds it. */
const shareOf = (s: S) => [...s.t.browser.backend.shares.values()].at(-1)!;

async function consentScreen(s: S): Promise<{ popup: FakeWindow; m: Record<string, unknown> }> {
  await waitLauncher(s.t, 'Review in Journear Passport');
  const popup = openApproval(s.t);
  return { popup, m: await popup.next('hana:consent-request') };
}

/** Grants through hana_requestAutoApprove; returns the popup and the reply. */
async function allow(s: S): Promise<{ popup: FakeWindow; reply: Awaited<ReturnType<Tab['request']>> }> {
  const pending = s.t.request('hana_requestAutoApprove');
  const { popup, m } = await consentScreen(s);
  answerConsent(s.t, popup, m, true);
  return { popup, reply: await pending };
}

async function grant(s: S): Promise<FakeWindow> {
  const { popup, reply } = await allow(s);
  expect(reply.result).toMatchObject({ granted: true });
  return popup;
}

const signAuto = async (s: S, nonce = '0x7'): Promise<void> => {
  const tx = evmTx({ nonce });
  expect(evmTxSigner((await s.t.request('eth_signTransaction', { tx })).result as string, tx)).toBe(s.evm);
};

/** An auto-sign that needs (and gets) a fresh status read for the consent held now. */
const signAutoAfterRead = (s: S): Promise<void> => signAuto(s, '0x6');

const responseWith = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error: code, code, requestId: 'rq' }), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('register before use', () => {
  it('on Allow the consent is recorded first, signed for the share at the next counter; then it auto-signs', async () => {
    const s = await session();
    await grant(s);
    expect(registers(s)).toBe(1);
    const body = registerCalls(s)[0]!.body as { shareId: number[]; counter: number; consentId: number[] };
    expect(toHex(Uint8Array.from(body.shareId))).toBe(toHex(shareOf(s).shareId));
    expect(body.counter).toBe(shareOf(s).counter);
    expect(s.t.browser.backend.consents.get(toHex(Uint8Array.from(body.consentId)))).toMatchObject({ revoked: false });
    await signAuto(s);
  });

  it('"none" mode: the proof has no shareId and counter 0', async () => {
    const s = await session(new Browser(), none);
    await grant(s);
    expect(registers(s)).toBe(1);
    const body = registerCalls(s)[0]!.body as Record<string, unknown>;
    expect('shareId' in body).toBe(false);
    expect(body.counter).toBe(0);
    await signAuto(s);
  });

  it('a consent ending after the share\'s absolute end is clamped to it (the API\'s rule, D513)', async () => {
    const s = await session();
    shareOf(s).absExpiresAtMs = s.t.browser.timers.now + HOUR;
    (s.t.vault as unknown as { session: { share: { absExpiresAtMs: number } } }).session.share.absExpiresAtMs = shareOf(s).absExpiresAtMs;
    await grant(s);
    expect((registerCalls(s)[0]!.body as { expiresAtMs: number }).expiresAtMs).toBe(shareOf(s).absExpiresAtMs);
    await signAuto(s);
  });

  it.each([
    ['503 config_unavailable', 503, 'config_unavailable'],
    ['429 too_many_consents', 429, 'too_many_consents'],
    ['429 rate_limited', 429, 'rate_limited'],
    ['409 consent_exists', 409, 'consent_exists'],
    ['409 policy_not_in_force', 409, 'policy_not_in_force'],
    ['400 bad_expiry', 400, 'bad_expiry'],
    ['401 invalid_signature', 401, 'invalid_signature'],
  ])('fails closed with no retry on %s: no grant, nothing stored', async (_, statusCode, code) => {
    const s = await session();
    s.t.browser.backend.overrides.set('/v1/vault/consents', () => apiError(statusCode, code));
    const { reply } = await allow(s);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { granted: false, reason: 'consent_not_recorded' } });
    expect(registers(s)).toBe(1);
    expect(await status(s)).toBeNull();
    const store = await openRecordStore(s.t.browser.idb);
    const r = (await store.get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) as { consent?: unknown };
    expect(r.consent).toBeUndefined();
  });

  it('a network failure fails closed too, and keeps nothing', async () => {
    const s = await session();
    s.t.browser.backend.overrides.set('/v1/vault/consents', async () => {
      throw new TypeError('Failed to fetch');
    });
    const { reply } = await allow(s);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { granted: false } });
    expect(await status(s)).toBeNull();
  });

  it('a stale counter (409 bad_counter) is retried once with the expected value', async () => {
    const s = await session();
    // Another tab advanced the share's counter behind this tab's back.
    shareOf(s).counter += 4;
    await grant(s);
    const calls = registerCalls(s);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { counter: number }).counter).toBe(shareOf(s).counter);
    expect(s.t.browser.backend.consents.size).toBe(1);
    await signAuto(s);
  });

  it('a repeated id (409 consent_exists) is told apart from a stale counter: not retried', async () => {
    const s = await session();
    const backend = s.t.browser.backend;
    const expected = shareOf(s).counter + 5;
    backend.overrides.set('/v1/vault/consents', (call) => ((call.body as { counter: number }).counter === expected ? apiError(409, 'consent_exists') : apiError(409, 'bad_counter', { expected })));
    const { reply } = await allow(s);
    expect(reply.error?.code).toBe('api_unavailable');
    // One retry, for the stale counter, at exactly the expected value; none for the repeated id.
    const counters = registerCalls(s).map((c) => (c.body as { counter: number }).counter);
    expect(counters).toEqual([shareOf(s).counter + 1, expected]);
  });

  it('a second stale counter is not retried again', async () => {
    const s = await session();
    s.t.browser.backend.overrides.set('/v1/vault/consents', () => apiError(409, 'bad_counter', { expected: 50 }));
    const { reply } = await allow(s);
    expect(reply.error?.code).toBe('api_unavailable');
    expect(registers(s)).toBe(2);
  });

  it('a 410 ends the session as a touch does: no consent, no further screen', async () => {
    const s = await session();
    shareOf(s).revoked = true;
    const { reply } = await allow(s);
    // The API said the share was revoked: signed out (D695), on the refusal and on the event.
    expect(reply.error).toMatchObject({ code: 4900, data: { reason: 'signed_out' } });
    expect(disconnectedWith(s.t)).toEqual(['signed_out']);
    expect((s.t.vault as unknown as { session: unknown }).session).toBeNull();
    expect(((await s.t.request('hana_status')).result as { status: string }).status).toBe('logged_out');
    const store = await openRecordStore(s.t.browser.idb);
    await eventually2(async () => (await store.get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) === undefined, 'the record was deleted');
  });

  it('a 410 for a session that never got its share keeps that session, failing closed', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/vault/shares', () => apiError(503, 'config_unavailable'));
    const s = await session(browser);
    await eventually(() => (s.t.vault as unknown as { session: { persist: unknown } }).session.persist === null, 'the persist gave up');
    browser.backend.overrides.set('/v1/vault/consents', () => apiError(410, 'session_ended', { reason: 'unknown_share' }));
    const { reply } = await allow(s);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { granted: false } });
    expect((s.t.vault as unknown as { session: unknown }).session).not.toBeNull();
  });

  it("an app switched from 'none' to 'session' while the tab is open: the 410 keeps the live session, failing closed", async () => {
    const s = await session(new Browser(), none);
    s.t.browser.backend.overrides.set('/v1/vault/consents', () => apiError(410, 'session_ended', { reason: 'unknown_share' }));
    const { reply } = await allow(s);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { granted: false, reason: 'consent_not_recorded' } });
    expect((s.t.vault as unknown as { session: unknown }).session).not.toBeNull();
    expect(await status(s)).toBeNull();
  });

  it('"none" mode: a 410 because the chain session is over ends the session', async () => {
    const s = await session(new Browser(), none);
    s.t.browser.backend.overrides.set('/v1/vault/consents', () => apiError(410, 'session_ended', { reason: 'no_session' }));
    const { reply } = await allow(s);
    expect(reply.error?.code).toBe(4900);
    expect((s.t.vault as unknown as { session: unknown }).session).toBeNull();
  });

  it('a lowered session TTL: the Allow fails once, and the next asks for the end the API named', async () => {
    const s = await session();
    const cap = s.t.browser.timers.now + HOUR;
    // The app lowered its TTL after this tab loaded: only the API knows the new cap.
    shareOf(s).absExpiresAtMs = cap;
    const first = await allow(s);
    expect(first.reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'consent_not_recorded' } });
    const again = s.t.request('hana_requestAutoApprove');
    const m = await first.popup.next('hana:consent-request', 1);
    expect(m.expiresAtMs).toBe(cap);
    answerConsent(s.t, first.popup, m, true);
    expect((await again).result).toMatchObject({ granted: true, expiresAtMs: cap });
    await signAuto(s);
  });

  it('503 session_not_visible is retried, honouring its Retry-After, then succeeds', async () => {
    const s = await session(new Browser(), none);
    const delays: number[] = [];
    const timers = s.t.browser.timers;
    const original = timers.setTimeout.bind(timers);
    vi.spyOn(timers, 'setTimeout').mockImplementation((fn, ms) => {
      delays.push(ms);
      return original(fn, ms);
    });
    let left = 2;
    s.t.browser.backend.overrides.set('/v1/vault/consents', () => (left-- > 0 ? responseWith(503, 'session_not_visible', { 'retry-after': '2' }) : undefined));
    await grant(s);
    expect(registers(s)).toBe(3);
    expect(delays.filter((d) => d === 2_000)).toHaveLength(2);
    await signAuto(s);
  });

  it('503 session_not_visible keeps retrying only a few times, then fails closed; a long Retry-After is bounded', async () => {
    const s = await session(new Browser(), none);
    const delays: number[] = [];
    const timers = s.t.browser.timers;
    const original = timers.setTimeout.bind(timers);
    vi.spyOn(timers, 'setTimeout').mockImplementation((fn, ms) => {
      delays.push(ms);
      return original(fn, ms);
    });
    s.t.browser.backend.overrides.set('/v1/vault/consents', () => responseWith(503, 'session_not_visible', { 'retry-after': '120' }));
    const { reply } = await allow(s);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { granted: false } });
    expect(registers(s)).toBe(1 + CONSENT_NOT_VISIBLE_RETRIES);
    expect(delays.filter((d) => d === CONSENT_RETRY_MAX_MS)).toHaveLength(CONSENT_NOT_VISIBLE_RETRIES);
    expect(await status(s)).toBeNull();
  });

  it('a covered request whose consent cannot be recorded goes to the approval screen, then later ones skip the consent screen for a while', async () => {
    const s = await session();
    const backend = s.t.browser.backend;
    backend.overrides.set('/v1/vault/consents', () => apiError(503, 'config_unavailable'));
    const first = s.t.request('eth_signTransaction', { tx: evmTx() });
    const { popup, m } = await consentScreen(s);
    answerConsent(s.t, popup, m, true);
    const a = await popup.next('hana:approve-request');
    answer(s.t, popup, a, true);
    expect((await first).result).toMatch(/^0x02/u);
    expect(await status(s)).toBeNull();

    const before = popup.posted.filter((p) => p.message.t === 'hana:consent-request').length;
    const second = s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x2' }) });
    const a2 = await popup.next('hana:approve-request', 1);
    expect(popup.posted.filter((p) => p.message.t === 'hana:consent-request')).toHaveLength(before);
    answer(s.t, popup, a2, false);
    expect((await second).error?.code).toBe(4001);

    // Later, with the API back, a covered request offers the consent screen again.
    backend.overrides.delete('/v1/vault/consents');
    s.t.browser.timers.now += CONSENT_ASK_AGAIN_MS;
    const third = s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x3' }) });
    const { popup: p3, m: m3 } = await consentScreen(s);
    answerConsent(s.t, p3, m3, true);
    expect((await third).result).toMatch(/^0x02/u);
  });

  it('hana_requestAutoApprove can be retried by the partner after a failure, with a fresh consent id', async () => {
    const s = await session();
    const backend = s.t.browser.backend;
    backend.overrides.set('/v1/vault/consents', () => apiError(503, 'config_unavailable'));
    const first = await allow(s);
    expect(first.reply.error?.code).toBe('api_unavailable');
    backend.overrides.delete('/v1/vault/consents');
    // The same popup is reused for the second try (within the reuse window).
    const again = s.t.request('hana_requestAutoApprove');
    answerConsent(s.t, first.popup, await first.popup.next('hana:consent-request', 1), true);
    expect((await again).result).toMatchObject({ granted: true });
    expect(backend.consents.size).toBe(1);
    await signAuto(s);
  });

  it('a session that ends during the register stores nothing and stops the row', async () => {
    const s = await session(new Browser(), none);
    const backend = s.t.browser.backend;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    backend.overrides.set('/v1/vault/consents', async () => {
      await held;
      return undefined;
    });
    const pending = s.t.request('hana_requestAutoApprove');
    const { popup, m } = await consentScreen(s);
    answerConsent(s.t, popup, m, true);
    await eventually(() => registers(s) === 1, 'the register was sent');
    await s.t.request('hana_logout');
    backend.overrides.delete('/v1/vault/consents');
    release();
    expect((await pending).error?.code).toBe(4900);
    await eventually(() => revokes(s) === 1, 'the row is stopped');
    expect(await status(s)).toBeNull();
  });
});

describe('the consent status in the existing 10 s read', () => {
  /** Grants, then makes the next read stale, so an auto-sign must ask again. */
  async function stale(s: S): Promise<FakeWindow> {
    const popup = await grant(s);
    s.t.browser.timers.now += POLICY_FRESH_MS;
    return popup;
  }

  it('names the consent on the read (base64url of its 16 bytes); a fresh register counts as an answer', async () => {
    const s = await session();
    await grant(s);
    const before = s.t.browser.backend.count('/v1/app');
    // Within 10 s of the register: no extra read.
    await signAuto(s);
    expect(s.t.browser.backend.count('/v1/app')).toBe(before);
    s.t.browser.timers.now += POLICY_FRESH_MS;
    await signAuto(s, '0x8');
    expect(s.t.browser.backend.count('/v1/app')).toBe(before + 1);
    const call = s.t.browser.backend.calls.filter((c) => c.path === '/v1/app').at(-1)!;
    expect(call.headers['x-hana-consent']).toBe(base64UrlEncode(fromHex(consentId(s))));
  });

  it('a read made after a reload names the consent held in the record (one read answers policy and status)', async () => {
    const browser = new Browser();
    const s = await session(browser);
    await grant(s);
    await signAuto(s);
    const again = await session(browser);
    const before = browser.backend.count('/v1/app');
    await signAuto(again, '0x9');
    expect(browser.backend.count('/v1/app')).toBeLessThanOrEqual(before + 1);
    expect(browser.backend.calls.filter((c) => c.path === '/v1/app').at(-1)!.headers['x-hana-consent']).toBe(base64UrlEncode(fromHex(consentId(s))));
  });

  it.each(['revoked', 'unknown'])("%s clears the local consent and sends the request to the approval popup (no consent screen)", async (answerValue) => {
    const s = await session();
    const popup = await stale(s);
    const backend = s.t.browser.backend;
    backend.consentAnswer = () => answerValue;
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    const a = await popup.next('hana:approve-request');
    expect(a.autoApprove).toBeUndefined();
    expect(popup.posted.filter((p) => p.message.t === 'hana:consent-request')).toHaveLength(1);
    answer(s.t, popup, a, true);
    expect((await reply).result).toMatch(/^0x02/u);
    expect(await status(s)).toBeNull();
    const store = await openRecordStore(s.t.browser.idb);
    const r = (await store.get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) as { consent?: unknown };
    expect(r.consent).toBeUndefined();
  });

  it('the background read (60 s) clears a consent revoked remotely without any request', async () => {
    const s = await session();
    await grant(s);
    s.t.browser.backend.consentAnswer = () => 'revoked';
    const before = s.t.browser.backend.count('/v1/app');
    s.t.browser.timers.advance(POLICY_REFRESH_MS);
    await eventually(() => s.t.browser.backend.count('/v1/app') > before, 'the 60 s read ran');
    await eventually(() => (s.t.vault as unknown as { session: { consent: unknown } }).session.consent === null, 'the local consent was cleared');
    expect(await status(s)).toBeNull();
  });

  it('a revoked share stops auto-signing within about 10 s, and the next read ends the session (H9: the share is read too)', async () => {
    const s = await session();
    await grant(s);
    await signAuto(s);
    // "Sign out this device" on Home: the share ends, and the consent's status reads 'revoked' from it.
    shareOf(s).revoked = true;
    // Within the 10 s freshness the tab still auto-signs: the design's bound.
    await signAuto(s, '0x8');
    s.t.browser.timers.now += POLICY_FRESH_MS;
    // The next read finds the share taken away: the session ends, nothing is signed, nothing waits for a click.
    const reply = await s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x9' }) });
    expect(reply.result).toBeUndefined();
    expect(reply.error?.code).toBeDefined();
    expect(((await s.t.request('hana_status')).result as { status: string }).status).toBe('logged_out');
  });

  it('an open tab of an app with a policy ends at its next periodic read once Home signs the device out, with no request', async () => {
    const s = await session();
    await grant(s);
    shareOf(s).revoked = true;
    const before = s.t.browser.backend.count('/v1/app');
    s.t.browser.timers.advance(POLICY_REFRESH_MS);
    await eventually(() => s.t.browser.backend.count('/v1/app') > before, 'the 60 s read ran');
    await eventually(() => (s.t.vault as unknown as { session: unknown }).session === null, 'the session ended');
    expect(((await s.t.request('hana_status')).result as { status: string }).status).toBe('logged_out');
    const store = await openRecordStore(s.t.browser.idb);
    await eventually2(async () => (await store.get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) === undefined, 'the record was deleted');
  });

  it('a live share, or a read that fails, never ends the session; the read slides nothing', async () => {
    const s = await session();
    await grant(s);
    const counterBefore = shareOf(s).counter;
    const touches = s.t.browser.backend.count('/v1/vault/touch');
    s.t.browser.timers.now += POLICY_FRESH_MS;
    await signAuto(s, '0x8');
    s.t.browser.backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    s.t.browser.timers.advance(POLICY_REFRESH_MS);
    await sleepReal(20);
    s.t.browser.backend.overrides.delete('/v1/app');
    expect(((await s.t.request('hana_status')).result as { status: string }).status).toBe('logged_in');
    // Nothing moved the share: no touch, no counter step (D55, D539).
    expect(shareOf(s).counter).toBe(counterBefore);
    expect(s.t.browser.backend.count('/v1/vault/touch')).toBe(touches);
  });

  it('a status read that fails (an outage): no auto-sign, the consent stays, and auto-signing resumes when it answers', async () => {
    const s = await session();
    const popup = await stale(s);
    const backend = s.t.browser.backend;
    backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    const a = await popup.next('hana:approve-request');
    expect(a.autoApprove).toBeUndefined();
    answer(s.t, popup, a, true);
    expect((await reply).result).toMatch(/^0x02/u);
    expect(await status(s)).not.toBeNull();
    backend.overrides.delete('/v1/app');
    await signAuto(s, '0x8');
  });

  it.each([
    ['a missing consent field', 'omit'],
    ['a value of an unknown shape', 'maybe'],
  ])('%s is no answer: no auto-sign, the consent stays, no consent screen', async (_, answerValue) => {
    const s = await session();
    const popup = await stale(s);
    const backend = s.t.browser.backend;
    backend.consentAnswer = () => answerValue;
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    const a = await popup.next('hana:approve-request');
    expect(a.autoApprove).toBeUndefined();
    expect(popup.posted.filter((p) => p.message.t === 'hana:consent-request')).toHaveLength(1);
    answer(s.t, popup, a, false);
    await reply;
    expect(await status(s)).not.toBeNull();
    backend.consentAnswer = null;
    await signAuto(s, '0x8');
  });

  it('an answer for an older consent never touches a newer one', async () => {
    const s = await session(new Browser(), none);
    await grant(s);
    const backend = s.t.browser.backend;
    const firstId = consentId(s);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    backend.consentAnswer = (hex) => (hex === firstId ? 'revoked' : undefined);
    backend.overrides.set('/v1/app', async () => {
      await held;
      return undefined;
    });
    s.t.browser.timers.advance(POLICY_REFRESH_MS);
    await eventually(() => backend.calls.some((c) => c.path === '/v1/app' && c.headers['x-hana-consent'] === base64UrlEncode(fromHex(firstId))), 'the read was sent');
    // While that read is out, the local consent is replaced by another (as a newer grant would).
    const held2 = (s.t.vault as unknown as { session: { consent: { consentId: string } } }).session;
    held2.consent = { ...held2.consent, consentId: 'b'.repeat(32) };
    backend.overrides.delete('/v1/app');
    release();
    await sleepReal(20);
    expect((s.t.vault as unknown as { session: { consent: { consentId: string } | null } }).session.consent?.consentId).toBe('b'.repeat(32));
    expect(await status(s)).not.toBeNull();
  });

  it('freshness counts from when the read was sent: an answer that took over 10 s confirms nothing', async () => {
    const s = await session();
    await grant(s);
    const backend = s.t.browser.backend;
    const id = consentId(s);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    backend.overrides.set('/v1/app', async () => {
      await held;
      return undefined;
    });
    s.t.browser.timers.advance(POLICY_REFRESH_MS);
    await eventually(() => backend.calls.some((c) => c.path === '/v1/app' && c.headers['x-hana-consent'] !== undefined), 'the read was sent');
    s.t.browser.timers.now += POLICY_FRESH_MS + 1;
    backend.overrides.delete('/v1/app');
    release();
    await eventually(() => (s.t.vault as unknown as { consentRead: { sent: number; at: number } | null }).consentRead?.at === START_MS + POLICY_REFRESH_MS, 'the late answer was applied');
    expect(internals(s).consentConfirmed(id)).toBe(false);
  });

  it('a device clock going back cannot stretch the 10 s: the status is also aged on a monotonic timer', async () => {
    let perf = 1_000;
    const s = await session(new Browser(), {}, { perfNow: () => perf });
    await grant(s);
    const backend = s.t.browser.backend;
    const before = backend.count('/v1/app');
    // The corrected clock stands still; only the monotonic timer passes 10 s, for the status alone.
    perf += POLICY_FRESH_MS;
    (s.t.vault as unknown as { policyCheckedPerf: number }).policyCheckedPerf = perf;
    await signAuto(s);
    expect(backend.count('/v1/app')).toBe(before + 1);
  });

  it("a device clock going back cannot stretch the policy's 10 s either", async () => {
    let perf = 1_000;
    const s = await session(new Browser(), {}, { perfNow: () => perf });
    const popup = await grant(s);
    const backend = s.t.browser.backend;
    const before = backend.count('/v1/app');
    // The corrected clock stands still; only the monotonic timer passes 10 s, for the policy alone, and the app removed it.
    perf += POLICY_FRESH_MS;
    (s.t.vault as unknown as { consentRead: { sent: number } }).consentRead.sent = perf;
    backend.autoApprovePolicy = null;
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    answer(s.t, popup, await popup.next('hana:approve-request'), false);
    expect((await reply).error?.code).toBe(4001);
    expect(backend.count('/v1/app')).toBe(before + 1);
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });

  it("an 'active' answer for consent A can't authorise consent B", async () => {
    const s = await session(new Browser(), none);
    const popup = await stale(s);
    const backend = s.t.browser.backend;
    const a = consentId(s);
    const session0 = internals(s).session!;
    // A is confirmed; the local consent is now another one.
    await signAutoAfterRead(s);
    session0.consent = { ...session0.consent!, consentId: 'b'.repeat(32) };
    backend.consentAnswer = (hex) => (hex === a ? 'active' : 'omit');
    const reply = s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x8' }) });
    const m = await popup.next('hana:approve-request');
    expect(m.autoApprove).toBeUndefined();
    answer(s.t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
    expect(s.t.events.filter((e) => e.event === 'autoApproved')).toHaveLength(1);
    expect(session0.consent?.consentId).toBe('b'.repeat(32));
  });

  it('the re-check under the lock refuses a status that lapsed after the gate, with no note and no consent screen', async () => {
    const s = await session();
    const popup = await grant(s);
    // The gate has passed (as if the lock then took more than 10 s), but the answer is no longer fresh.
    vi.spyOn(internals(s) as unknown as { confirmConsent: () => Promise<string> }, 'confirmConsent').mockResolvedValue('active');
    s.t.browser.timers.now += POLICY_FRESH_MS - 1_000;
    const live = s.t.vault as unknown as { policyCheckedAt: number };
    live.policyCheckedAt = s.t.browser.timers.now;
    (s.t.vault as unknown as { consentRead: { at: number; sent: number } }).consentRead.at -= 2_000;
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    const m = await popup.next('hana:approve-request');
    expect(m.autoApprove).toBeUndefined();
    expect(popup.posted.filter((p) => p.message.t === 'hana:consent-request')).toHaveLength(1);
    answer(s.t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });

  it('the re-check under the lock refuses a policy dropped after the gate', async () => {
    const s = await session();
    const popup = await grant(s);
    const v = s.t.vault as unknown as { policy: unknown; freshPolicy(): Promise<unknown> };
    const policy = v.policy;
    // The sign path saw the policy; by the time the lock is held it's gone.
    vi.spyOn(v, 'freshPolicy').mockImplementation(async () => {
      v.policy = null;
      return policy;
    });
    vi.spyOn(internals(s) as unknown as { confirmConsent: () => Promise<string> }, 'confirmConsent').mockResolvedValue('active');
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    const m = await popup.next('hana:approve-request');
    expect(m.autoApprove).toBeUndefined();
    answer(s.t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });

  it('hana_requestAutoApprove does not answer granted for a consent it cannot confirm', async () => {
    const s = await session();
    await grant(s);
    const backend = s.t.browser.backend;
    s.t.browser.timers.now += POLICY_FRESH_MS;
    backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    const reply = await s.t.request('hana_requestAutoApprove');
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { granted: false, reason: 'consent_unconfirmed' } });
    backend.overrides.delete('/v1/app');
    expect((await s.t.request('hana_requestAutoApprove')).result).toMatchObject({ granted: true });
  });

  it('a read that lands before the register completes cannot name the consent (its id exists only after the 201)', async () => {
    const s = await session();
    const backend = s.t.browser.backend;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    backend.overrides.set('/v1/vault/consents', async () => {
      await held;
      return undefined;
    });
    const pending = s.t.request('hana_requestAutoApprove');
    const { popup, m } = await consentScreen(s);
    answerConsent(s.t, popup, m, true);
    await eventually(() => registers(s) === 1, 'the register was sent');
    // A read while the register is out names no consent.
    s.t.browser.timers.advance(POLICY_REFRESH_MS);
    await eventually(() => backend.count('/v1/app') >= 2, 'a read went out');
    expect(backend.calls.filter((c) => c.path === '/v1/app').every((c) => c.headers['x-hana-consent'] === undefined)).toBe(true);
    backend.overrides.delete('/v1/vault/consents');
    release();
    expect((await pending).result).toMatchObject({ granted: true });
    await signAuto(s);
  });
});

describe('parallel requests and limits', () => {
  it.each([
    ['perDayCount', { limits: { perDayCount: 2 } }],
    ['maxValueWeiPerDay', { limits: { perDayCount: 50 }, evm: { chains: [{ ...POLICY().evm.chains[0]!, maxValueWeiPerDay: '200000' }] } }],
  ])('"none" mode: parallel covered requests can\'t pass %s', async (_, change) => {
    const s = await session(new Browser(), { settings: { persistence: 'none', autoApprovePolicy: { ...POLICY(), ...change } } });
    await grant(s);
    s.t.browser.timers.now += POLICY_FRESH_MS;
    // Five at once, all waiting on the same status read, so they all resume together when it answers.
    const backend = s.t.browser.backend;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    backend.overrides.set('/v1/app', async () => {
      await held;
      return undefined;
    });
    for (let i = 0; i < 5; i++) void s.t.request('eth_signTransaction', { tx: evmTx({ nonce: `0x${(i + 2).toString(16)}` }) }).catch(() => undefined);
    await sleepReal(30);
    backend.overrides.delete('/v1/app');
    release();
    await eventually(() => s.t.events.filter((e) => e.event === 'autoApproved').length >= 2, 'two signed');
    await sleepReal(50);
    expect(s.t.events.filter((e) => e.event === 'autoApproved')).toHaveLength(2);
    expect(await status(s)).toMatchObject({ used: { count: 2 } });
  });
});

describe('a session that ends while waiting for the lock', () => {
  it('is not read as tampering: the record stays and nothing is opened under the zeroed key', async () => {
    const browser = new Browser();
    const s = await session(browser);
    await grant(s);
    const v = s.t.vault as unknown as { lockName: string; endSession(announce: boolean): void };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inLock = new Promise<void>((r) => (entered = r));
    void browser.locks.request(v.lockName, async () => {
      entered();
      await held;
    });
    await inLock;
    const reply = s.t.request('hana_autoApproveStatus');
    await sleepReal(10);
    v.endSession(false);
    release();
    expect((await reply).error?.code).toBe(4900);
    const store = await openRecordStore(browser.idb);
    const r = (await store.get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) as { consent?: unknown } | undefined;
    expect(r?.consent).toBeDefined();
  });
});

describe('two tabs and another account', () => {
  it('a consent granted in one tab auto-signs in another; stopped in one, the other stops at once', async () => {
    const browser = new Browser();
    const a = await session(browser);
    await grant(a);
    const b = await session(browser);
    await signAuto(b);
    expect(browser.backend.count('/v1/vault/consents')).toBe(1);

    await a.t.request('hana_revokeAutoApprove');
    await eventually(() => browser.backend.consents.get(consentId(a))!.revoked, 'the revoke was applied');
    const reply = b.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x8' }) });
    await waitLauncher(b.t, 'Review in Journear Passport');
    const popup = openApproval(b.t);
    answerConsent(b.t, popup, await popup.next('hana:consent-request'), false);
    answer(b.t, popup, await popup.next('hana:approve-request'), false);
    expect((await reply).error?.code).toBe(4001);
    expect(b.t.events.filter((e) => e.event === 'autoApproved')).toHaveLength(1);
  });

  it("'session' mode: a login as another account ends the old consent and carries nothing over", async () => {
    const browser = new Browser();
    const s = await session(browser);
    await grant(s);
    const oldId = consentId(s);
    const oldShare = shareOf(s);
    await login(s.t, g, { sub: '220248495921238986421' });
    expect(shareOf(s).shareId).not.toEqual(oldShare.shareId);
    await eventually(() => oldShare.revoked, 'the old share was revoked');
    expect(browser.backend.consentStatusOf(oldId)).toBe('revoked');
    expect(await status(s)).toBeNull();
    const before = browser.backend.calls.length;
    s.t.browser.timers.now += POLICY_FRESH_MS;
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    await waitLauncher(s.t, 'Review in Journear Passport');
    const popup = openApproval(s.t);
    answerConsent(s.t, popup, await popup.next('hana:consent-request'), false);
    answer(s.t, popup, await popup.next('hana:approve-request'), false);
    expect((await reply).error?.code).toBe(4001);
    expect(browser.backend.calls.slice(before).every((c) => c.headers['x-hana-consent'] === undefined)).toBe(true);
  });
});

describe('the revoke paths', () => {
  it('hana_revokeAutoApprove clears locally first, then tells the API, signed for this share', async () => {
    const s = await session();
    await grant(s);
    const id = consentId(s);
    expect((await s.t.request('hana_revokeAutoApprove')).result).toBeNull();
    expect(await status(s)).toBeNull();
    await eventually(() => s.t.browser.backend.consents.get(id)!.revoked, 'the revoke was applied');
    expect(revokes(s)).toBe(1);
  });

  it('"none" mode: the revoke is signed with counter 0 and no share', async () => {
    const s = await session(new Browser(), none);
    await grant(s);
    await s.t.request('hana_revokeAutoApprove');
    await eventually(() => revokes(s) === 1, 'the revoke was sent');
    const body = s.t.browser.backend.calls.find((c) => c.path === '/v1/vault/consents/revoke')!.body as Record<string, unknown>;
    expect('shareId' in body).toBe(false);
    expect(body.counter).toBe(0);
  });

  it('sends no server revoke when there is no local consent, however often the page asks', async () => {
    const s = await session();
    await s.t.request('hana_revokeAutoApprove');
    await s.t.request('hana_revokeAutoApprove');
    await sleepReal(10);
    expect(revokes(s)).toBe(0);
    await grant(s);
    await s.t.request('hana_revokeAutoApprove');
    await s.t.request('hana_revokeAutoApprove');
    await eventually(() => revokes(s) === 1, 'one revoke');
    await sleepReal(10);
    expect(revokes(s)).toBe(1);
  });

  it('a failed revoke leaves the local consent cleared', async () => {
    const s = await session();
    await grant(s);
    s.t.browser.backend.overrides.set('/v1/vault/consents/revoke', () => apiError(503, 'config_unavailable'));
    await s.t.request('hana_revokeAutoApprove');
    expect(await status(s)).toBeNull();
  });

  it('"Stop auto-approving" in the popup stops it on the API too', async () => {
    const s = await session();
    const popup = await grant(s);
    s.t.dispatch({ data: { v: 1, t: 'hana:auto-approve-stop' }, origin: ENV.authOrigin, source: popup });
    await eventually(() => revokes(s) === 1, 'the revoke was sent');
    expect(await status(s)).toBeNull();
  });

  it('a dormant session: the sealed consent is deleted and the API told, without unlocking', async () => {
    const s = await session();
    await grant(s);
    await signAuto(s);
    const id = consentId(s);
    const unlocks = () => s.t.browser.backend.count('/v1/vault/unlock');
    s.t.browser.timers.advance(2 * HOUR);
    expect((s.t.vault as unknown as { session: unknown }).session).toBeNull();
    const before = unlocks();
    expect((await s.t.request('hana_revokeAutoApprove')).result).toBeNull();
    await eventually(() => s.t.browser.backend.consents.get(id)!.revoked, 'the revoke was applied');
    expect(unlocks()).toBe(before);
    const store = await openRecordStore(s.t.browser.idb);
    const r = (await store.get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) as { consent?: unknown };
    expect(r.consent).toBeUndefined();
    expect(await status(s)).toBeNull();
  });

  it('logout, "none" mode: clears the consent, then tells the API', async () => {
    const s = await session(new Browser(), none);
    await grant(s);
    const id = consentId(s);
    await s.t.request('hana_logout');
    await eventually(() => s.t.browser.backend.consents.get(id)!.revoked, 'the revoke was applied');
  });

  it("logout, 'session' mode: the share's revoke ends the consent, with no extra consent call", async () => {
    const s = await session();
    await grant(s);
    const id = consentId(s);
    await s.t.request('hana_logout');
    expect(shareOf(s).revoked).toBe(true);
    await sleepReal(10);
    expect(revokes(s)).toBe(0);
    expect(s.t.browser.backend.consentStatusOf(id)).toBe('revoked');
  });

  it('logout with no consent makes no consent call', async () => {
    const s = await session(new Browser(), none);
    await s.t.request('hana_logout');
    await sleepReal(10);
    expect(revokes(s)).toBe(0);
  });

  it('a new login in "none" mode stops the replaced session\'s consent', async () => {
    const browser = new Browser();
    const s = await session(browser, none);
    await grant(s);
    const id = consentId(s);
    await login(s.t, g);
    await eventually(() => browser.backend.consents.get(id)!.revoked, 'the revoke was applied');
  });
});

describe('the partner page never sees a consent id', () => {
  it('not on the port, in any reply or event', async () => {
    const s = await session();
    const popup = await grant(s);
    await signAuto(s);
    await status(s);
    s.t.browser.timers.now += POLICY_FRESH_MS;
    await signAuto(s, '0x8');
    await s.t.request('hana_revokeAutoApprove');
    const hex = consentId(s);
    const id = fromHex(hex);
    for (const haystack of [JSON.stringify(s.t.portMessages), JSON.stringify(popup.posted)]) {
      expect(haystack).not.toContain(hex);
      expect(haystack).not.toContain(base64UrlEncode(id));
      expect(haystack).not.toContain(JSON.stringify(Array.from(id)));
      expect(haystack).not.toContain('consentId');
    }
  });

  it('a port error carries only the reason code, never a consent id, signature or key', async () => {
    const s = await session();
    s.t.browser.backend.overrides.set('/v1/vault/consents', () => apiError(503, 'config_unavailable'));
    const { reply } = await allow(s);
    expect(Object.keys(reply.error!).sort()).toEqual(['code', 'data', 'message']);
    expect(reply.error!.data).toEqual({ granted: false, reason: 'consent_not_recorded' });
    expect(JSON.stringify(reply.error)).not.toMatch(/consentId|signature|prk|session/iu);
  });
});
