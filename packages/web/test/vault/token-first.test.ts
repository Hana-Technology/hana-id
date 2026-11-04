// token_first, vault side (D269, D270; auth/google.ts GOOGLE_EMAIL_FLOW): in an env with an email issuer every Google
// login carries the follow-up key; an app without email login gets `emailRecord` and sends the access token (slot 1)
// to the issuer's google-record in the background, best effort; an app with email login runs google-match as before.
// The ID token that goes on chain is refused with any claim outside the allow-list, under every flow.
import { type FollowNotice, type RelayPayload, decryptRelayValue, encryptRelayPayload, followSlot, isFollowNotice } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GoogleEmailFlow } from '../../src/auth/google.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { RECORD_TIMEOUT_MS } from '../../src/vault/login.ts';
import { Browser, EMAIL_ENV, ENV, type EmailIssuer, type Google, type LoginRun, SCOPE, SUB, type Tab, apiError, emailIssuer, enableEmail, google, popupHello, readyTab, tokenClaims } from './harness.ts';

let g: Google;
let issuer: EmailIssuer;
const tabs: Tab[] = [];
beforeAll(async () => {
  [g, issuer] = await Promise.all([google(), emailIssuer()]);
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

const ACCESS = 'ya29.token-first-test';

async function tab(browser: Browser, env: HanaEnv = EMAIL_ENV, flow: GoogleEmailFlow = 'token_first'): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, env, options: { googleEmailFlow: flow } });
  tabs.push(t);
  return t;
}

/** What the callback relays under token_first: the access token to slot 1 first, then the ID token with `access: 'follow'`. */
async function tokenFirstAnswer(t: Tab, run: LoginRun, o: { claims?: Record<string, unknown>; slot1?: RelayPayload | null; extra?: Partial<RelayPayload> } = {}): Promise<string> {
  const relayKey = run.params.relayKey as Uint8Array;
  if (o.slot1 !== null) {
    const { id } = followSlot(run.params.followKey as Uint8Array, 1);
    t.browser.backend.writeRelayRaw(id, await encryptRelayPayload(relayKey, id, o.slot1 ?? { accessToken: ACCESS }));
  }
  const token = await g.token(tokenClaims(run.params, o.claims ?? {}, t.browser.timers.now));
  await t.browser.backend.writeRelay(run.params.relayId as string, relayKey, { idToken: token, access: 'follow', ...o.extra } as RelayPayload);
  return token;
}

/** The vault's pending login (kept here: the vault drops it once the login ends), for its background record. */
const pendingLogin = (t: Tab) => (t.vault as unknown as { pending: { recorded: Promise<void> | null } | null }).pending;

const loginReply = async (t: Tab, o: Parameters<typeof tokenFirstAnswer>[2] = {}) => {
  const pending = t.request('hana_login');
  const run = await popupHello(t);
  const login = pendingLogin(t);
  const token = await tokenFirstAnswer(t, run, o);
  return { reply: await pending, run, token, recorded: () => login?.recorded ?? null };
};

describe('token_first in an app without email login (google-record, D269)', () => {
  it('auth-params carry the follow-up key and emailRecord, no methods; the login records the address in the background', async () => {
    const b = new Browser();
    const t = await tab(b);
    const { reply, run, token } = await loginReply(t);
    expect(reply.error).toBeUndefined();
    expect(run.params.followKey).toBeInstanceOf(Uint8Array);
    expect(run.params.emailRecord).toBe(true);
    expect(run.params).not.toHaveProperty('methods');
    await t.waitUntil(() => b.backend.recordCalls.length === 1, 'google-record');
    const r = b.backend.recordCalls[0]!;
    expect(Object.keys(r).sort()).toEqual(['accessToken', 'commitment', 'googleIdToken', 'pk']);
    expect(r).toMatchObject({ pk: 'pk_test_1111111111111111111111', accessToken: ACCESS, googleIdToken: token });
    expect(r.commitment).toMatchObject({ scopeId: SCOPE, keyIndex: 0, maxUses: run.params.maxUses, expiresAtMs: run.params.expiresAtMs });
    // Never google-match, and no follow-up notice (no done, no banners): the popup closed after the ID token.
    expect(b.backend.matchCalls).toEqual([]);
    expect(b.backend.relayWrites).toEqual([]);
    // The ID token that went on chain is the relayed openid one.
    expect((b.backend.calls.find((c) => c.path === '/v1/login')?.body as { jwt: string }).jwt).toBe(token);
  });

  it('a failing, refusing or hung issuer never blocks the login; nor does a missing slot 1', async () => {
    for (const answer of [() => apiError(500, 'internal'), () => apiError(429, 'rate_limited'), () => apiError(400, 'google_account_mismatch'), () => ({ unexpected: true })]) {
      const b = new Browser();
      b.backend.googleRecord = answer;
      const t = await tab(b);
      expect((await loginReply(t)).reply.error).toBeUndefined();
      await t.waitUntil(() => b.backend.recordCalls.length === 1, 'google-record');
    }
    // A hung issuer: the login answers anyway (the record runs beside it, bounded by RECORD_TIMEOUT_MS).
    const b = new Browser();
    b.backend.googleRecord = () => new Promise<never>(() => {});
    const t = await tab(b);
    expect((await loginReply(t)).reply.error).toBeUndefined();
    await t.waitUntil(() => b.backend.recordCalls.length === 1, 'google-record');
    // No slot 1 (the popup never relayed an access token): the login is unaffected; the record gives up at its limit.
    const b2 = new Browser();
    const t2 = await tab(b2);
    const second = await loginReply(t2, { slot1: null });
    expect(second.reply.error).toBeUndefined();
    const rec = second.recorded();
    expect(rec).toBeInstanceOf(Promise);
    t2.browser.timers.advance(RECORD_TIMEOUT_MS);
    await rec;
    expect(b2.backend.recordCalls).toEqual([]);
    // Slot 1 holding something else than an access token: nothing is sent either.
    const b3 = new Browser();
    const t3 = await tab(b3);
    const third = await loginReply(t3, { slot1: { error: 'access_denied' } });
    expect(third.reply.error).toBeUndefined();
    await third.recorded();
    expect(b3.backend.recordCalls).toEqual([]);
  });

  it('a token without `access: follow` (a popup under another flow) logs in and records nothing', async () => {
    const b = new Browser();
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const token = await g.token(tokenClaims(run.params, {}, t.browser.timers.now));
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token });
    expect((await pending).error).toBeUndefined();
    expect(b.backend.recordCalls).toEqual([]);
  });

  it('refuses the email login’s fields in a record-only login (an access token beside the ID token, case B, as)', async () => {
    for (const extra of [{ accessToken: 'ya29.x', access: undefined }, { caseB: { linkTicket: 'T'.repeat(43), emailSub: `e1.${'Q'.repeat(43)}` } }, { as: 'proof' }] as Partial<RelayPayload>[]) {
      const b = new Browser();
      const t = await tab(b);
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      const token = await g.token(tokenClaims(run.params, {}, t.browser.timers.now));
      await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token, ...extra } as RelayPayload);
      expect((await pending).error?.code).toBe('token_invalid');
      expect(b.backend.count('/v1/login')).toBe(0);
    }
  });

  it('no email issuer in the env: no follow-up key, no emailRecord (batch B’s login), nothing recorded', async () => {
    const b = new Browser();
    const t = await tab(b, ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    expect(run.params).not.toHaveProperty('followKey');
    expect(run.params).not.toHaveProperty('emailRecord');
    const token = await g.token(tokenClaims(run.params, {}, t.browser.timers.now));
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token });
    expect((await pending).error).toBeUndefined();
    expect(b.backend.recordCalls).toEqual([]);
  });

  it('second_request (the fallback): an app without email login gets neither, as before', async () => {
    const t = await tab(new Browser(), EMAIL_ENV, 'second_request');
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    expect(run.params).not.toHaveProperty('followKey');
    expect(run.params).not.toHaveProperty('emailRecord');
    t.request('hana_cancelLogin');
    await pending;
  });
});

describe('token_first in an app with email login (google-match, no explainer)', () => {
  it('reads the access token from slot 1 and runs google-match; never google-record', async () => {
    const b = new Browser();
    enableEmail(b.backend, issuer);
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    expect(run.params.methods).toEqual(['google', 'email']);
    expect(run.params).not.toHaveProperty('emailRecord');
    const token = await tokenFirstAnswer(t, run);
    expect((await pending).error).toBeUndefined();
    expect(b.backend.matchCalls).toEqual([expect.objectContaining({ accessToken: ACCESS, googleIdToken: token, link: true })]);
    expect(b.backend.recordCalls).toEqual([]);
  });

  it('D264’s consent screen only for google-match’s google_account_mismatch; a match goes on with no screen (D270)', async () => {
    const notice = async (t: Tab, run: LoginRun, n: number): Promise<FollowNotice> => {
      const { id } = followSlot(run.params.followKey as Uint8Array, n);
      return decryptRelayValue(run.params.relayKey as Uint8Array, id, await t.browser.backend.takeRelay(id), isFollowNotice);
    };
    // A match: the vault's next notice is its last word, never email_consent.
    const ok = new Browser();
    enableEmail(ok.backend, issuer);
    const t = await tab(ok);
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    await tokenFirstAnswer(t, run);
    expect((await pending).error).toBeUndefined();
    expect((await notice(t, run, 2)).t).toBe('done');
    // Another account (the access token's sub isn't the ID token's): the screen says so.
    const bad = new Browser();
    enableEmail(bad.backend, issuer);
    bad.backend.googleMatch = () => apiError(400, 'google_account_mismatch');
    const u = await tab(bad);
    const p2 = u.request('hana_login', { method: 'google' });
    const run2 = await popupHello(u);
    await tokenFirstAnswer(u, run2);
    expect(await notice(u, run2, 2)).toEqual({ t: 'email_consent', reason: 'account_mismatch', loginHint: SUB });
    // Cancel on that screen: the login ends with its own reason.
    const { id } = followSlot(run2.params.followKey as Uint8Array, 3);
    bad.backend.writeRelayValue(id, await encryptRelayPayload(run2.params.relayKey as Uint8Array, id, { error: 'email_cancelled' }));
    expect((await p2).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'google_account_mismatch' } });
  });

  it('D255 still holds: google-match unavailable refuses a Google identity with no wallet', async () => {
    const b = new Browser();
    enableEmail(b.backend, issuer);
    b.backend.googleMatch = () => apiError(500, 'internal');
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    await tokenFirstAnswer(t, run);
    expect((await pending).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'email_match_unavailable' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });
});

describe('the on-chain token stays openid-only (D25, D270), under every flow', () => {
  for (const flow of ['second_request', 'token_first'] as const) {
    it(`${flow}: an ID token carrying email, email_verified or hd is refused (token_has_pii) before any chain call or record`, async () => {
      for (const claim of [{ email: `u${SUB}@gmail.com` }, { email_verified: true }, { hd: 'corp.example' }]) {
        const b = new Browser();
        const t = await tab(b, EMAIL_ENV, flow);
        const pending = t.request('hana_login');
        const run = await popupHello(t);
        const token = await g.token(tokenClaims(run.params, claim, t.browser.timers.now));
        const payload = run.params.followKey ? { idToken: token, access: 'follow' as const } : { idToken: token };
        if (run.params.followKey) {
          const { id } = followSlot(run.params.followKey as Uint8Array, 1);
          b.backend.writeRelayValue(id, await encryptRelayPayload(run.params.relayKey as Uint8Array, id, { accessToken: ACCESS }));
        }
        await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, payload);
        const reply = await pending;
        expect(reply.error).toMatchObject({ code: 'token_has_pii', data: { claim: Object.keys(claim)[0] } });
        expect(b.backend.count('/v1/login')).toBe(0);
        expect(b.backend.recordCalls).toEqual([]);
        expect(b.backend.matchCalls).toEqual([]);
      }
    });
  }

  it('the popup’s own refusal (`{error: token_has_pii}`, nothing relayed) ends the login with token_has_pii', async () => {
    const b = new Browser();
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { error: 'token_has_pii', claim: 'email' });
    // The same error as the vault's own refusal: the partner hears which claim.
    expect((await pending).error).toMatchObject({ code: 'token_has_pii', data: { claim: 'email' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('token_first’s other stops reach the partner as google_error with the popup’s reason', async () => {
    for (const reason of ['tokeninfo_unavailable', 'tokeninfo_client_mismatch', 'google_account_mismatch']) {
      const b = new Browser();
      const t = await tab(b);
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { error: reason });
      expect((await pending).error, reason).toMatchObject({ code: 'google_error', data: { error: reason } });
    }
  });
});
