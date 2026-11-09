// Auto-approve consents on the API (Hana Home, D45, D98 item 13, D465, D510–D513, D530–D536): the vault records a
// consent before it stores it, fails closed, reads its status with the existing 10 s read, and stops it when it is revoked.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode, fromHex, toHex } from '@hana-id/core';
import { functionSelector } from '@hana-id/core/decode';
import { CONSENT_ASK_AGAIN_MS, CONSENT_NOT_VISIBLE_RETRIES, CONSENT_RETRY_MAX_MS, POLICY_FRESH_MS, POLICY_REFRESH_MS } from '../../src/vault/vault.ts';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { APP_ID, Browser, ENV, type FakeWindow, type Google, HOUR, type Tab, SCOPE, answer, answerConsent, apiError, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
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

async function session(browser = new Browser(), over: Parameters<typeof makeConfig>[0] = {}): Promise<S> {
  browser.backend.serverNow = () => browser.timers.now;
  const config = makeConfig({ ...over, settings: { autoApprovePolicy: POLICY(), ...over.settings } });
  const t = await readyTab(browser, { googleJwk: g.jwk, config });
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
/** A share's id, as the backend holds it. */
const shareOf = (s: S) => [...s.t.browser.backend.shares.values()].at(-1)!;

async function consentScreen(s: S): Promise<{ popup: FakeWindow; m: Record<string, unknown> }> {
  await waitLauncher(s.t, 'Review in Hana');
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
    ['410 share_revoked', 410, 'share_revoked'],
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
    backend.overrides.set('/v1/vault/consents', (call) => {
      const b = call.body as { counter: number };
      return b.counter < shareOf(s).counter + 1 ? apiError(409, 'bad_counter', { expected: shareOf(s).counter + 1 }) : apiError(409, 'consent_exists');
    });
    const { reply } = await allow(s);
    expect(reply.error?.code).toBe('api_unavailable');
    expect(registers(s)).toBe(1);
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

  it('a revoked share stops auto-signing within about 10 s: signing goes on until the next read, then stops', async () => {
    const s = await session();
    const popup = await grant(s);
    await signAuto(s);
    // "Sign out this device" on Home: the share ends, and the consent's status reads 'revoked' from it.
    shareOf(s).revoked = true;
    // Within the 10 s freshness the tab still auto-signs: the design's bound.
    await signAuto(s, '0x8');
    s.t.browser.timers.now += POLICY_FRESH_MS;
    const reply = s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x9' }) });
    const a = await popup.next('hana:approve-request');
    expect(a.autoApprove).toBeUndefined();
    answer(s.t, popup, a, false);
    expect((await reply).error?.code).toBe(4001);
    expect(await status(s)).toBeNull();
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
