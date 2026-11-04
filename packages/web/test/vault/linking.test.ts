// Path resolution and linking, vault side (build plan batches 7 and 8b): the path through `get_identity` (golden for an
// unlinked Google identity, the root's for a member, refused while pending), google-match before any chain call and
// the four cases, the D133 checks before the linked CKD payload is signed, D139 (case B only after this popup's email
// step), D137's recovery, the follow-up notices, hana.account(), linkChanged, hana.linkAccount() and a banner's Cancel.
import {
  type FollowNotice,
  type RelayPayload,
  addressesFromCkdSecret,
  autoLinkNonce,
  ckdAppId,
  decryptCkd,
  decryptRelayValue,
  encryptRelayPayload,
  followSlot,
  fromHex,
  identityKey,
  isFollowNotice,
  linkAccountNonce,
  linkNewNonce,
  linkedCkdPayload,
  newAppKey,
  sessionHashOf,
  sessionMessage,
  verifyEd25519,
} from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HanaEnv } from '../../src/hana-env.ts';
import { openRecordStore } from '../../src/vault/record.ts';
import { EMAIL_CONSENT_ROUNDS, PIN_READ_TIMEOUT_MS } from '../../src/vault/login.ts';
import { ACCOUNT_CACHE_MS } from '../../src/vault/vault.ts';
import {
  Browser,
  EMAIL_ENV,
  EMAIL_SUB,
  ENV,
  type EmailIssuer,
  RPC_FALLBACK,
  type Google,
  type LoginRun,
  SCOPE,
  SUB,
  type Tab,
  apiError,
  deliverToken,
  emailClaims,
  emailIssuer,
  enableEmail,
  google,
  login,
  mpcAnswer,
  persisted,
  popupHello,
  readyTab,
  tokenClaims,
} from './harness.ts';

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

const G = { provider: 'google', sub: SUB };
const E = { provider: 'email', sub: EMAIL_SUB };
const ik = (r: { provider: string; sub: string }) => identityKey(SCOPE, r.provider, r.sub);
const pathOf = (r: { provider: string; sub: string }) => `${SCOPE}#${r.provider}#${r.sub}#0`;

/** The envs of these tests, with a second RPC provider: a member's path is confirmed on both (D263). */
const ENV2: HanaEnv = Object.freeze({ ...ENV, rpcFallback: RPC_FALLBACK });
const EMAIL_ENV2: HanaEnv = Object.freeze({ ...EMAIL_ENV, rpcFallback: RPC_FALLBACK });

async function tab(browser: Browser, env: HanaEnv = EMAIL_ENV2): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, env });
  tabs.push(t);
  return t;
}

function emailBrowser(): Browser {
  const b = new Browser();
  enableEmail(b.backend, issuer);
  return b;
}

function addressesOf(path: string) {
  const key = newAppKey();
  return addressesFromCkdSecret(decryptCkd(mpcAnswer(key.publicKey.AppPublicKeyPV.pk1, path), key.a, ckdAppId(ENV.signer, path), ENV.ckdNetworkKey));
}

/** The session this popup's auth-params commit to (the `auto_link` nonce's session hash). */
const sessionOf = (run: LoginRun) => ({
  signer: ENV.signer,
  scopeId: SCOPE,
  sessionPublicKey: run.params.sessionPublicKey as Uint8Array,
  expiresAtMs: run.params.expiresAtMs as number,
  keyIndex: run.params.keyIndex as number,
  maxUses: run.params.maxUses as number,
  salt: run.params.salt as Uint8Array,
});

/** The `auto_link` token the issuer would mint for this login. */
async function linkToken(t: Tab, run: LoginRun, o: { join: 1 | 2; immediate: boolean; epoch?: number; sub?: string }) {
  const eRef = { provider: 'email', sub: o.sub ?? EMAIL_SUB };
  const nonce = autoLinkNonce({
    signer: ENV.signer,
    scopeId: SCOPE,
    sessionHash: sessionHashOf(sessionOf(run)),
    sessionIk: ik(G),
    join: o.join,
    joinerIk: o.join === 1 ? ik(G) : ik(eRef),
    targetRootIk: o.join === 1 ? ik(eRef) : ik(G),
    targetEpoch: o.epoch ?? 0,
    immediate: o.immediate,
  });
  return issuer.token(emailClaims(run.params, { nonce, sub: eRef.sub }, t.browser.timers.now));
}

/** The vault's notice in follow-up slot `n`, read as the popup reads it. */
async function notice(t: Tab, run: LoginRun, n: number): Promise<FollowNotice> {
  const { id } = followSlot(run.params.followKey as Uint8Array, n);
  return decryptRelayValue(run.params.relayKey as Uint8Array, id, await t.browser.backend.takeRelay(id), isFollowNotice);
}

/** The popup's answer to the notice in slot `n`. */
async function answer(t: Tab, run: LoginRun, n: number, payload: RelayPayload): Promise<void> {
  const { id } = followSlot(run.params.followKey as Uint8Array, n + 1);
  t.browser.backend.writeRelayValue(id, await encryptRelayPayload(run.params.relayKey as Uint8Array, id, payload));
}

/** Google's token in the first slot, with the access token (one-request mode) and optionally case B's proof. */
async function googleAnswer(t: Tab, run: LoginRun, extra: Partial<RelayPayload> = {}, claims: Record<string, unknown> = {}): Promise<string> {
  const token = await g.token(tokenClaims(run.params, claims, t.browser.timers.now));
  await t.browser.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token, accessToken: 'ya29.test', ...extra } as RelayPayload);
  return token;
}

const loginBody = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/login').at(-1)?.body as Record<string, unknown> | undefined;
const linkEvents = (t: Tab) => t.events.filter((e) => e.event === 'linkChanged').map((e) => e.data);

/** The login body's session signature is over the linked CKD payload for its link token (D133). */
async function signedLinked(body: Record<string, unknown>): Promise<boolean> {
  const payload = linkedCkdPayload(body.pk1 as string, body.pk2 as string, body.linkJwt as string, body.linkImmediate === true);
  return verifyEd25519(Uint8Array.from(body.sessionPublicKey as number[]), Uint8Array.from(body.signature as number[]), sessionMessage(1, payload));
}

describe('the path through get_identity (batch 7)', () => {
  it('golden: an unlinked Google identity opens batch B’s path byte for byte, read from get_identity', async () => {
    const t = await tab(new Browser(), ENV);
    const { reply } = await login(t, g);
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(`${SCOPE}#google#${SUB}#0`));
    expect([...t.browser.backend.sessions.values()][0]!.path).toBe(`s1#google#110248495921238986420#0`);
    expect(t.browser.backend.rpcCalls.map((c) => c.params.method_name)).toContain('get_identity');
    // A Google-only app's popup gets no follow-up key, and nothing is written to the relay by the vault.
    expect(t.browser.backend.relayWrites).toHaveLength(0);
  });

  it('an active member opens its account root’s path (a Google member of an email wallet)', async () => {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    b.backend.link(E, G);
    const t = await tab(b, ENV2);
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    expect([...b.backend.sessions.values()][0]!.path).toBe(pathOf(E));
  });

  it('a pending member is refused before any chain call, with when it activates', async () => {
    const b = new Browser();
    b.backend.link(E, G, { active: false, effectiveAtMs: 1_900_000_000_000 });
    const t = await tab(b, ENV);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'link_pending', data: { effectiveAtMs: 1_900_000_000_000 } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('a view whose key isn’t this identity’s is refused (never another path)', async () => {
    const b = new Browser();
    const t = await tab(b, ENV);
    const real = b.backend.identityView.bind(b.backend);
    b.backend.identityView = (p, s) => ({ ...real(p, s), key: '00'.repeat(32) });
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'identity_unchecked' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });
});

describe('google-match and the four cases (batch 8b)', () => {
  it('sends google-match the access token, the Google token and the session commitment, from the vault only', async () => {
    const b = emailBrowser();
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    expect(run.params.followKey).toBeInstanceOf(Uint8Array);
    const token = await googleAnswer(t, run);
    expect((await pending).error).toBeUndefined();
    const m = b.backend.matchCalls[0]!;
    expect(m).toMatchObject({ pk: 'pk_test_1111111111111111111111', accessToken: 'ya29.test', googleIdToken: token, link: true });
    expect(m.commitment).toMatchObject({ scopeId: SCOPE, keyIndex: 0, maxUses: run.params.maxUses });
    expect(m).not.toHaveProperty('linkTicket');
    // The vault's last word to the popup: done, no banner.
    expect(await notice(t, run, 2)).toEqual({ t: 'done', banners: [] });
  });

  it('case A, Google-hosted: links silently; the session key signs the linked payload; the login opens the email wallet', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 1, immediate: true });
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: true, linkable: true, emailToken, linkImmediate: true });
    await googleAnswer(t, run);
    const reply = await pending;
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    const body = loginBody(t)!;
    expect(body.linkJwt).toBe(emailToken);
    expect(body.linkImmediate).toBe(true);
    expect(await signedLinked(body)).toBe(true);
    expect(linkEvents(t)).toContainEqual({ provider: 'google', status: 'active', effectiveAtMs: expect.any(Number) });
    expect(t.events.map((e) => e.event === 'loginProgress' && (e.data as { stage: string }).stage)).toContain('linking');
    const done = await notice(t, run, 2);
    expect(done).toMatchObject({ t: 'done', banners: [{ provider: 'google', status: 'active', fresh: true }] });
  });

  it('case A, Google-hosted: a link token whose nonce doesn’t match the vault’s own reads is refused (D133), nothing relayed', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const stale = await linkToken(t, run, { join: 1, immediate: true, epoch: 7 });
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: true, linkable: true, emailToken: stale, linkImmediate: true });
    await googleAnswer(t, run);
    expect((await pending).error?.code).toBe('token_invalid');
    expect(b.backend.count('/v1/login')).toBe(0);
    expect(await notice(t, run, 2)).toEqual({ t: 'stop', code: 'token_invalid' });
  });

  it('case A minted at google-match for an address Google doesn’t host is refused (only after this popup’s code, D139)', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 1, immediate: true });
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: false, linkable: true, emailToken, linkImmediate: true });
    await googleAnswer(t, run);
    expect((await pending).error).toMatchObject({ code: 'token_invalid', data: { reason: 'link_mismatch' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('case A, not hosted: “Link and continue” in the popup; the code step’s token links, at once', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const challenge = { challengeId: 'C'.repeat(43), expiresAtMs: 1_800_000_600_000, to: 'a…@example.com' };
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: false, linkable: true, challenge });
    await googleAnswer(t, run);
    expect(await notice(t, run, 2)).toEqual({ t: 'link_code', ...challenge });
    await answer(t, run, 2, { idToken: await linkToken(t, run, { join: 1, immediate: true }), as: 'link' });
    const reply = await pending;
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    expect(await signedLinked(loginBody(t)!)).toBe(true);
    expect((await notice(t, run, 4)).t).toBe('done');
  });

  it('case A, not hosted: “Sign in with email” is an email login to that wallet (Google’s token unused, no link)', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: false, linkable: true, challenge: { challengeId: 'C'.repeat(43), expiresAtMs: 1, to: 'a…@example.com' } });
    await googleAnswer(t, run);
    expect((await notice(t, run, 2)).t).toBe('link_code');
    await answer(t, run, 2, { idToken: await issuer.token(emailClaims(run.params, {}, t.browser.timers.now)), as: 'session' });
    const reply = await pending;
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    expect(loginBody(t)).not.toHaveProperty('linkJwt');
    expect((loginBody(t)!.jwt as string).startsWith('{')).toBe(true);
  });

  it('case A that can’t link: only “Sign in with email”; a cancel ends the login, Google’s identity opens nothing', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: true, linkable: false });
    await googleAnswer(t, run);
    expect(await notice(t, run, 2)).toEqual({ t: 'use_email', reason: 'provider_taken' });
    await answer(t, run, 2, { error: 'email_cancelled' });
    expect((await pending).error?.code).toBe('login_cancelled');
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('case B: with this popup’s email step (caseB), the email joins the Google wallet pending 24 h; linkChanged pending', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 2, immediate: false });
    b.backend.googleMatch = (body) => (body.linkTicket === 'T'.repeat(43) ? { decision: 'case_b', googleHosted: false, linkable: true, emailToken, linkImmediate: false } : { decision: 'case_b', googleHosted: false, linkable: true });
    await googleAnswer(t, run, { caseB: { linkTicket: 'T'.repeat(43), emailSub: EMAIL_SUB } });
    const reply = await pending;
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
    expect(b.backend.matchCalls[0]).toMatchObject({ linkTicket: 'T'.repeat(43) });
    const body = loginBody(t)!;
    expect(body.linkImmediate).toBe(false);
    expect(await signedLinked(body)).toBe(true);
    expect(linkEvents(t)).toContainEqual({ provider: 'email', status: 'pending', effectiveAtMs: expect.any(Number) });
    // The popup shows the pending banner with a Cancel (a fresh Google sign-in over the cancel nonce).
    const done = await notice(t, run, 2);
    expect(done).toMatchObject({ t: 'done', banners: [{ provider: 'email', status: 'pending', fresh: true, action: { kind: 'cancel', prove: { method: 'google', loginHint: SUB } } }] });
  });

  it('D139: a case-B token without this popup’s email step, or for another address, is refused', async () => {
    for (const caseB of [undefined, { linkTicket: 'T'.repeat(43), emailSub: `e1.${'Z'.repeat(43)}` }]) {
      const b = emailBrowser();
      b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
      const t = await tab(b);
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      const emailToken = await linkToken(t, run, { join: 2, immediate: true });
      b.backend.googleMatch = () => ({ decision: 'case_b', googleHosted: true, linkable: true, emailToken, linkImmediate: true });
      await googleAnswer(t, run, caseB ? { caseB } : {});
      expect((await pending).error).toMatchObject({ code: 'token_invalid', data: { reason: 'link_mismatch' } });
      expect(b.backend.count('/v1/login')).toBe(0);
    }
  });

  it('case B without a token (a plain Google login): the Google wallet, no link', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    b.backend.googleMatch = () => ({ decision: 'case_b', googleHosted: true, linkable: true });
    const t = await tab(b);
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    expect(loginBody(t)).not.toHaveProperty('linkJwt');
  });

  it('google-match unreachable: a Google identity without a wallet is refused (it might be case A); one with a wallet logs in', async () => {
    const b = emailBrowser();
    b.backend.googleMatch = () => {
      throw new TypeError('Failed to fetch');
    };
    const t = await tab(b);
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'email_match_unavailable' } });
    expect(b.backend.count('/v1/login')).toBe(0);
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const u = await tab(b);
    expect((await login(u, g)).reply.error).toBeUndefined();
  });

  it('D137: a linked login answered “session key in use” revokes the session and never derives plainly', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 1, immediate: true });
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: true, linkable: true, emailToken, linkImmediate: true });
    // A front-runner opened the session with the same key first (a bare create_session, D137).
    const pkHex = Buffer.from(run.params.sessionPublicKey as Uint8Array).toString('hex');
    b.backend.sessions.set(pkHex, { path: pathOf(G), scope_id: SCOPE, expires_at_ms: run.params.expiresAtMs as number, max_uses: 1, used: 0 });
    await googleAnswer(t, run);
    expect((await pending).error).toMatchObject({ code: 'derive_failed', data: { reason: 'link_restart' } });
    expect(b.backend.count('/v1/derive')).toBe(0);
    expect(b.backend.count('/v1/sessions/revoke')).toBe(1);
    expect(b.backend.sessions.has(pkHex)).toBe(false);
  });

  it('an email login of a pending member: link_pending with when it activates, told to the popup', async () => {
    const b = emailBrowser();
    b.backend.link(G, E, { active: false, effectiveAtMs: 1_800_090_000_000 });
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'email' });
    const run = await popupHello(t);
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: await issuer.token(emailClaims(run.params, {}, t.browser.timers.now)) });
    expect((await pending).error).toMatchObject({ code: 'link_pending', data: { effectiveAtMs: 1_800_090_000_000 } });
    expect(await notice(t, run, 2)).toEqual({ t: 'stop', code: 'link_pending', effectiveAtMs: 1_800_090_000_000 });
  });

  it('an email login of an active member opens the Google root’s wallet', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    b.backend.link(G, E);
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'email' });
    const run = await popupHello(t);
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: await issuer.token(emailClaims(run.params, {}, t.browser.timers.now)) });
    const reply = await pending;
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
  });
});

describe('the wallet’s sign-in methods', () => {
  it('hana.account(): the root and its members, no sub; linkChanged reports what changed', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const t = await tab(b);
    await login(t, g);
    expect((await t.request('hana_account')).result).toEqual({ methods: [{ provider: 'google', status: 'active', effectiveAtMs: null, root: true }] });
    b.backend.link(G, E, { active: false, effectiveAtMs: 1_800_090_000_000 });
    t.browser.timers.advance(ACCOUNT_CACHE_MS);
    expect((await t.request('hana_account')).result).toEqual({
      methods: [
        { provider: 'google', status: 'active', effectiveAtMs: null, root: true },
        { provider: 'email', status: 'pending', effectiveAtMs: 1_800_090_000_000, root: false },
      ],
    });
    expect(linkEvents(t)).toContainEqual({ provider: 'email', status: 'pending', effectiveAtMs: 1_800_090_000_000 });
    b.backend.accounts.clear();
    t.browser.timers.advance(ACCOUNT_CACHE_MS);
    await t.request('hana_account');
    expect(linkEvents(t)).toContainEqual({ provider: 'email', status: 'removed', effectiveAtMs: null });
    expect(JSON.stringify((await t.request('hana_account')).result)).not.toContain(SUB);
  });

  it('hana.account() calls within ACCOUNT_CACHE_MS share one get_account read; a later call reads again (W-L4)', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const t = await tab(b);
    await login(t, g);
    // The vault's own read after the login settles first.
    await new Promise((r) => setTimeout(r, 20));
    const reads = () => b.backend.rpcCalls.filter((c) => c.params.method_name === 'get_account').length;
    const before = reads();
    const [one, two] = await Promise.all([t.request('hana_account'), t.request('hana_account')]);
    expect(one.result).toEqual(two.result);
    await t.request('hana_account');
    expect(reads() - before).toBeLessThanOrEqual(1);
    const cached = reads();
    b.backend.link(G, E, { active: false, effectiveAtMs: 1_800_090_000_000 });
    // Still the shared read: the new member shows once the cache has aged.
    expect(((await t.request('hana_account')).result as { methods: unknown[] }).methods).toHaveLength(1);
    t.browser.timers.advance(ACCOUNT_CACHE_MS);
    expect(((await t.request('hana_account')).result as { methods: unknown[] }).methods).toHaveLength(2);
    expect(reads()).toBe(cached + 1);
  });

  it('hana.account() logged out is 4100', async () => {
    const t = await tab(emailBrowser());
    expect((await t.request('hana_account')).error?.code).toBe(4100);
  });

  it('a banner’s Cancel: a Google proof over the link_change nonce, relayed as cancel_link; linkChanged removed', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 2, immediate: false });
    b.backend.googleMatch = () => ({ decision: 'case_b', googleHosted: false, linkable: true, emailToken, linkImmediate: false });
    await googleAnswer(t, run, { caseB: { linkTicket: 'T'.repeat(43), emailSub: EMAIL_SUB } });
    expect((await pending).error).toBeUndefined();
    await persisted(t);
    const done = (await notice(t, run, 2)) as Extract<FollowNotice, { t: 'done' }>;
    const prove = done.banners[0]!.action!.prove as { method: 'google'; nonce: string };
    // A proof with another nonce cancels nothing.
    await answer(t, run, 2, { idToken: await g.token(tokenClaims({ nonce: 'x'.repeat(43) }, {}, t.browser.timers.now)), as: 'proof' });
    expect(await notice(t, run, 4)).toEqual({ t: 'stop', code: 'token_invalid' });
    expect(b.backend.count('/v1/link/cancel')).toBe(0);
    void prove;
  });

  it('a banner’s Cancel with the right proof cancels the pending link', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 2, immediate: false });
    b.backend.googleMatch = () => ({ decision: 'case_b', googleHosted: false, linkable: true, emailToken, linkImmediate: false });
    await googleAnswer(t, run, { caseB: { linkTicket: 'T'.repeat(43), emailSub: EMAIL_SUB } });
    expect((await pending).error).toBeUndefined();
    const done = (await notice(t, run, 2)) as Extract<FollowNotice, { t: 'done' }>;
    const prove = done.banners[0]!.action!.prove as { method: 'google'; nonce: string };
    await answer(t, run, 2, { idToken: await g.token(tokenClaims({ nonce: prove.nonce }, {}, t.browser.timers.now)), as: 'proof' });
    expect(await notice(t, run, 4)).toEqual({ t: 'done', banners: [] });
    expect(b.backend.calls.find((c) => c.path === '/v1/link/cancel')?.body).toMatchObject({ memberKey: Buffer.from(ik(E)).toString('hex'), epoch: 1 });
    await t.waitUntil(() => linkEvents(t).some((e) => (e as { status: string }).status === 'removed'), 'linkChanged removed');
  });

  it('hana.linkAccount({method: email}): the new address over link_new, then the Google root over link_account, then /v1/link', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const t = await tab(b);
    await login(t, g);
    const pending = t.request('hana_linkAccount', { method: 'email' });
    const run = await popupHello(t);
    const task = run.params.task as { kind: string; provider: string; prove: { method: string; purpose: string; commitment: { epoch: number; salt: number[]; rootIk: string } } };
    expect(task).toMatchObject({ kind: 'link', provider: 'email', prove: { method: 'email', purpose: 'link_new', commitment: { scopeId: SCOPE, epoch: 0, rootIk: Buffer.from(ik(G)).toString('hex') } } });
    const salt = Uint8Array.from(task.prove.commitment.salt);
    const newNonce = linkNewNonce(ENV.signer, SCOPE, ik(G), 'email', 0, salt);
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: await issuer.token(emailClaims(run.params, { nonce: newNonce }, t.browser.timers.now)) });
    const n2 = await notice(t, run, 2);
    expect(n2).toMatchObject({ t: 'prove', why: 'link_account', provider: 'google', prove: { method: 'google', loginHint: SUB, nonce: linkAccountNonce(ENV.signer, SCOPE, ik(G), ik(E), 0, salt) } });
    await answer(t, run, 2, { idToken: await g.token(tokenClaims({ nonce: (n2 as { prove: { nonce: string } }).prove.nonce }, {}, t.browser.timers.now)), as: 'proof' });
    const reply = await pending;
    expect(reply.result).toEqual({ provider: 'email', status: 'pending', effectiveAtMs: expect.any(Number) });
    expect(b.backend.calls.find((c) => c.path === '/v1/link')?.body).toMatchObject({ epoch: 0, salt: Array.from(salt) });
    expect(await notice(t, run, 4)).toMatchObject({ t: 'done', banners: [{ provider: 'email', status: 'pending', fresh: true }] });
    expect(linkEvents(t)).toContainEqual({ provider: 'email', status: 'pending', effectiveAtMs: expect.any(Number) });
  });

  it('hana.linkAccount refuses a method the wallet already has, before any popup params', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const t = await tab(b);
    await login(t, g);
    expect((await t.request('hana_linkAccount', { method: 'google' })).error).toMatchObject({ code: 'link_refused', data: { reason: 'provider_taken' } });
    expect((await tab(emailBrowser())).vault).toBeDefined();
    const u = await tab(emailBrowser());
    expect((await u.request('hana_linkAccount', { method: 'email' })).error?.code).toBe(4100);
    void fromHex;
  });
});

describe('Google’s email permission and google-match’s availability (D264, G-M1, G-M3, G-L2)', () => {
  /** The login's token with `access: 'follow'` (two-request mode); slot 1 is then written by the test. */
  async function followLogin(b: Browser) {
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    const token = await g.token(tokenClaims(run.params, {}, t.browser.timers.now));
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token, access: 'follow' } as RelayPayload);
    return { t, run, pending };
  }
  /** A busy google-match, with the issuer's CORS (it exposes `retry-after`) unless `expose` is false. */
  const busy = (status: number, retryAfter?: string, expose = true) =>
    new Response(JSON.stringify({ error: 'busy', code: status === 429 ? 'rate_limited' : 'unavailable', requestId: 'rq' }), {
      status,
      headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}), ...(expose ? { 'access-control-expose-headers': 'retry-after' } : {}) },
    });

  it('declined (access_denied in slot 1), a new Google identity: the popup explains; “Sign in with email instead” logs in with email', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const { t, run, pending } = await followLogin(b);
    await answer(t, run, 0, { error: 'access_denied' });
    expect(await notice(t, run, 2)).toEqual({ t: 'email_consent', reason: 'declined', loginHint: SUB });
    await answer(t, run, 2, { idToken: await issuer.token(emailClaims(run.params, {}, t.browser.timers.now)), as: 'session' });
    const reply = await pending;
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    expect(b.backend.matchCalls).toHaveLength(0);
  });

  it('declined, then “Try Google again” granted: the new access token goes to google-match and the login goes on', async () => {
    const b = emailBrowser();
    b.backend.googleMatch = () => ({ decision: 'none', googleHosted: false, linkable: false });
    const { t, run, pending } = await followLogin(b);
    await answer(t, run, 0, { error: 'access_denied' });
    expect((await notice(t, run, 2)).t).toBe('email_consent');
    await answer(t, run, 2, { accessToken: 'ya29.again' });
    const reply = await pending;
    expect(reply.error).toBeUndefined();
    expect(b.backend.matchCalls.map((m) => m.accessToken)).toEqual(['ya29.again']);
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
  });

  it('declined, then Cancel: login_cancelled with its own reason (never email_match_unavailable)', async () => {
    const b = emailBrowser();
    const { t, run, pending } = await followLogin(b);
    await answer(t, run, 0, { error: 'access_denied' });
    expect((await notice(t, run, 2)).t).toBe('email_consent');
    await answer(t, run, 2, { error: 'email_cancelled' });
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'email_consent_declined' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('declined every time: EMAIL_CONSENT_ROUNDS (3, D264) screens, then the login ends (email_consent_declined)', async () => {
    expect(EMAIL_CONSENT_ROUNDS).toBe(3);
    const b = emailBrowser();
    const { t, run, pending } = await followLogin(b);
    await answer(t, run, 0, { error: 'access_denied' });
    for (let i = 1; i <= EMAIL_CONSENT_ROUNDS; i++) {
      expect((await notice(t, run, 2 * i)).t).toBe('email_consent');
      await answer(t, run, 2 * i, { error: 'access_denied' });
    }
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'email_consent_declined' } });
    // No fourth screen.
    expect(b.backend.relay.has(followSlot(run.params.followKey as Uint8Array, 2 * EMAIL_CONSENT_ROUNDS + 2).id)).toBe(false);
  });

  it('declined by an identity that already has a wallet: a plain login, no screen', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const { t, run, pending } = await followLogin(b);
    await answer(t, run, 0, { error: 'access_denied' });
    expect((await pending).error).toBeUndefined();
    expect((await notice(t, run, 2)).t).toBe('done');
  });

  it('another Google account on Google’s screen (google_account_mismatch): the screen says so', async () => {
    const b = emailBrowser();
    b.backend.googleMatch = () => apiError(400, 'google_account_mismatch');
    const { t, run, pending } = await followLogin(b);
    await answer(t, run, 0, { accessToken: 'ya29.other' });
    expect(await notice(t, run, 2)).toEqual({ t: 'email_consent', reason: 'account_mismatch', loginHint: SUB });
    await answer(t, run, 2, { error: 'email_cancelled' });
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'google_account_mismatch' } });
  });

  it('G-L2: the popup couldn’t store its next leg (storage_unavailable in slot 1): the login ends with storage_unavailable', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(G)).toString('hex'));
    const { t, run, pending } = await followLogin(b);
    await answer(t, run, 0, { error: 'storage_unavailable' });
    expect((await pending).error?.code).toBe('storage_unavailable');
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('G-M3: a 429 or 503 from google-match is retried after its retry-after (or a backoff), then answers', async () => {
    for (const first of [() => busy(429, '1'), () => busy(503)]) {
      const b = emailBrowser();
      let n = 0;
      b.backend.googleMatch = () => (++n === 1 ? first() : { decision: 'none', googleHosted: false, linkable: false });
      const t = await tab(b);
      const { reply } = await login(t, g);
      expect(reply.error).toBeUndefined();
      expect(b.backend.matchCalls).toHaveLength(2);
    }
  });

  it('G-M3: a retry-after longer than the login can wait is not retried: a new identity gets email_match_unavailable', async () => {
    const b = emailBrowser();
    b.backend.googleMatch = () => busy(429, '600');
    const t = await tab(b);
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'email_match_unavailable' } });
    expect(b.backend.matchCalls).toHaveLength(1);
  });

  it('M1: the retry-after reaches the vault only because the issuer’s CORS exposes it (hidden, the vault backs off)', async () => {
    const b = emailBrowser();
    let n = 0;
    // Not exposed: the browser hides the 600 s, so the vault retries after its own backoff instead of giving up.
    b.backend.googleMatch = () => (++n === 1 ? busy(429, '600', false) : { decision: 'none', googleHosted: false, linkable: false });
    const t = await tab(b);
    expect((await login(t, g)).reply.error).toBeUndefined();
    expect(b.backend.matchCalls).toHaveLength(2);
  });
});

describe('D137 / D257: a linked login’s recovery (W-L3)', () => {
  type Call = Parameters<Parameters<Browser['backend']['overrides']['set']>[1]>[0];
  /** A Google-hosted case-A login (a linked login) whose /v1/login answers go through `onLogin` (undefined: the fake's). */
  async function linkedLogin(b: Browser, onLogin: (call: Call, n: number) => Response | undefined) {
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    let n = 0;
    b.backend.overrides.set('/v1/login', (call) => onLogin(call, ++n));
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 1, immediate: true });
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: true, linkable: true, emailToken, linkImmediate: true });
    await googleAnswer(t, run);
    return { t, run, reply: await pending };
  }
  const pkHexOf = (run: LoginRun) => Buffer.from(run.params.sessionPublicKey as Uint8Array).toString('hex');

  it('a timeout whose transaction returned the key: the key is taken from the transaction, nothing revoked', async () => {
    const b = emailBrowser();
    const { reply } = await linkedLogin(b, (call, n) => {
      if (n > 1) return undefined;
      const r = b.backend.createSession(call.body as Record<string, unknown>, true);
      if (r.ok) b.backend.txs.set('tx-linked', r.result);
      return apiError(504, 'timeout', { nearTx: 'tx-linked' });
    });
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    expect(b.backend.count('/v1/login')).toBe(1);
    expect(b.backend.count('/v1/sessions/revoke')).toBe(0);
    expect(b.backend.count('/v1/derive')).toBe(0);
  });

  it('a timeout whose transaction has no key: the session is revoked and the login ends (link_restart)', async () => {
    const b = emailBrowser();
    const { reply, run } = await linkedLogin(b, (call) => {
      b.backend.createSession({ ...(call.body as object), linkJwt: undefined } as Record<string, unknown>, false);
      b.backend.txs.set('tx-nokey', 'failure');
      return apiError(504, 'timeout', { nearTx: 'tx-nokey' });
    });
    expect(reply.error).toMatchObject({ code: 'derive_failed', data: { reason: 'link_restart' } });
    expect(b.backend.count('/v1/sessions/revoke')).toBe(1);
    expect(b.backend.sessions.has(pkHexOf(run))).toBe(false);
    expect(b.backend.count('/v1/derive')).toBe(0);
  });

  it('ckd_failed: revoked, never derived on with the plain payload', async () => {
    const b = emailBrowser();
    const { reply, run } = await linkedLogin(b, (call) => {
      b.backend.createSession({ ...(call.body as object), linkJwt: undefined } as Record<string, unknown>, false);
      return apiError(502, 'ckd_failed', { nearTx: 'tx-ckd' });
    });
    expect(reply.error).toMatchObject({ code: 'derive_failed', data: { reason: 'link_restart' } });
    expect(b.backend.count('/v1/sessions/revoke')).toBe(1);
    expect(b.backend.sessions.has(pkHexOf(run))).toBe(false);
    expect(b.backend.count('/v1/derive')).toBe(0);
  });

  it('a network error (the request may have landed): revoked, link_restart', async () => {
    const b = emailBrowser();
    const { reply, run } = await linkedLogin(b, (call) => {
      b.backend.createSession({ ...(call.body as object), linkJwt: undefined } as Record<string, unknown>, false);
      throw new TypeError('Failed to fetch');
    });
    expect(reply.error).toMatchObject({ code: 'derive_failed', data: { reason: 'link_restart' } });
    expect(b.backend.count('/v1/sessions/revoke')).toBe(1);
    expect(b.backend.sessions.has(pkHexOf(run))).toBe(false);
  });

  it('a "not executed" answer is resent once, the same linked body, and the link is made', async () => {
    const b = emailBrowser();
    const { reply, t } = await linkedLogin(b, (_call, n) => (n === 1 ? apiError(503, 'relayer_busy', { nearTx: null }) : undefined));
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    const bodies = b.backend.calls.filter((c) => c.path === '/v1/login').map((c) => JSON.stringify(c.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(await signedLinked(loginBody(t)!)).toBe(true);
    expect(b.backend.count('/v1/sessions/revoke')).toBe(0);
  });

  it('/v1/derive answering identity_linked (a resynced own-path session, D136) ends session_consumed (identity_linked)', async () => {
    const b = new Browser();
    b.backend.overrides.set('/v1/login', (call) => {
      // The session opened (on the identity's own path) but its answer was lost; its one use is left.
      b.backend.createSession(call.body as Record<string, unknown>, false);
      return apiError(409, 'session_exists', { nearTx: null });
    });
    b.backend.overrides.set('/v1/derive', () => apiError(409, 'identity_linked'));
    const t = await tab(b, ENV2);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'session_consumed', data: { reason: 'identity_linked' } });
    expect(b.backend.count('/v1/derive')).toBe(1);
  });
});

describe('D263: a path through another identity, confirmed on two providers', () => {
  /** The attacker's own email wallet: they can sign in with it, so they know its S. */
  const A = { provider: 'email', sub: `e1.${'A'.repeat(43)}` };
  const memberOf = (root: { provider: string; sub: string }) => (method: string, args: Record<string, unknown>) =>
    method === 'get_identity' && args.provider === G.provider && args.sub === G.sub
      ? { key: Buffer.from(ik(G)).toString('hex'), status: 'member', opened: false, root, effective_at_ms: 1, account_epoch: 1 }
      : undefined;
  /** The API's NEAR_RPC is the same provider: /v1/login answers a CKD the attacker built for their own path. */
  const forgedLogin = (b: Browser) =>
    b.backend.overrides.set('/v1/login', (call) => {
      const body = call.body as { pk1: string; expiresAtMs: number; maxUses: number };
      return new Response(JSON.stringify({ result: mpcAnswer(body.pk1, pathOf(A)), session: { scope_id: SCOPE, expires_at_ms: body.expiresAtMs, max_uses: body.maxUses, used: 1 }, nearTx: 'tx9', requestId: 'rq' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

  it('a forged member view on the primary, with a CKD answer for the attacker’s path, is refused before /v1/login', async () => {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(A)).toString('hex'));
    b.backend.viewLies.set(ENV.rpc, memberOf(A));
    forgedLogin(b);
    const t = await tab(b, ENV2);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_disputed' } });
    expect(reply.result).toBeUndefined();
    expect(b.backend.count('/v1/login')).toBe(0);
    // Both providers were asked about the identity, each on its own.
    const asked = b.backend.rpcCalls.filter((c) => c.params.method_name === 'get_identity').map((c) => c.endpoint);
    expect(asked).toContain(ENV.rpc);
    expect(asked).toContain(RPC_FALLBACK);
  });

  it('the forged answer would have passed the pairing check: without the second provider it is never derived either', async () => {
    // No second provider in the env: a member path can't be confirmed, so the login is refused (fail closed), never
    // derived on the own path instead.
    const b = new Browser();
    b.backend.viewLies.set(ENV.rpc, memberOf(A));
    forgedLogin(b);
    const t = await tab(b, ENV);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_unconfirmed' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('an unreachable second provider refuses a member path (fail closed); a real member logs in when both agree', async () => {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    b.backend.link(E, G);
    b.backend.rpcDown.add(RPC_FALLBACK);
    const t = await tab(b, ENV2);
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_unconfirmed' } });
    expect(b.backend.count('/v1/login')).toBe(0);
    b.backend.rpcDown.delete(RPC_FALLBACK);
    const u = await tab(b, ENV2);
    const { reply } = await login(u, g);
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
  });

  it('both providers must show the root as an account root (own, its own key)', async () => {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    b.backend.link(E, G);
    // The second provider agrees about the member but says the root is itself a member somewhere.
    b.backend.viewLies.set(RPC_FALLBACK, (method, args) =>
      method === 'get_identity' && args.provider === E.provider && args.sub === E.sub ? { key: Buffer.from(ik(E)).toString('hex'), status: 'member', opened: true, root: A, effective_at_ms: 1, account_epoch: 1 } : undefined,
    );
    const t = await tab(b, ENV2);
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_disputed' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('a linked login’s target root (case A, the email identity a member of another root) is confirmed too', async () => {
    const b = emailBrowser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    // The primary says the user's email identity is a member of the attacker's account.
    b.backend.viewLies.set(ENV.rpc, (method, args) =>
      method === 'get_identity' && args.provider === E.provider && args.sub === E.sub ? { key: Buffer.from(ik(E)).toString('hex'), status: 'member', opened: true, root: A, effective_at_ms: 1, account_epoch: 1 } : undefined,
    );
    const t = await tab(b);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const emailToken = await linkToken(t, run, { join: 1, immediate: true });
    b.backend.googleMatch = () => ({ decision: 'case_a', googleHosted: true, linkable: true, emailToken, linkImmediate: true });
    await googleAnswer(t, run);
    expect((await pending).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_disputed' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('the own path needs no second provider (only the MPC can answer for it)', async () => {
    const b = new Browser();
    b.backend.rpcDown.add(RPC_FALLBACK);
    const t = await tab(b, ENV2);
    const { reply } = await login(t, g);
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
  });
});

describe('D263: the root this device last opened for an identity', () => {
  it('own → member (a link activated) is taken; member → own (unlinked) is confirmed on both providers first', async () => {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    const t = await tab(b, ENV2);
    expect(((await login(t, g)).reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
    // The link activates: the pin moves from own to the root (both providers confirm the member path).
    b.backend.link(E, G);
    expect(((await login(t, g)).reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    // Unlinked: G is own again. With the second provider down the change can't be confirmed: refused, not derived.
    b.backend.accounts.clear();
    b.backend.rpcDown.add(RPC_FALLBACK);
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_unconfirmed' } });
    // Both providers say own: the change is taken, and the pin follows.
    b.backend.rpcDown.delete(RPC_FALLBACK);
    expect(((await login(t, g)).reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
    b.backend.rpcDown.add(RPC_FALLBACK);
    expect(((await login(t, g)).reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
  });

  it('the pin is stored with the record (survives a reload and a logout), as identity keys only: no sub, no path', async () => {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    b.backend.link(E, G);
    const t = await tab(b, ENV2);
    await login(t, g);
    expect((await t.request('hana_logout')).error).toBeUndefined();
    const store = await openRecordStore(b.idb);
    const key = `pin|${ENV.signer}|app_1|${SCOPE}|${Buffer.from(ik(G)).toString('hex')}`;
    const pin = await store.get(key);
    expect(pin).toEqual({ v: 1, t: 'root-pin', root: Buffer.from(ik(E)).toString('hex') });
    expect(JSON.stringify(pin)).not.toContain(SUB);
    expect(JSON.stringify(pin)).not.toContain(EMAIL_SUB);
    // A new tab (a reload): a primary that now says own is checked against the stored pin.
    b.backend.viewLies.set(ENV.rpc, (method, args) =>
      method === 'get_identity' && args.provider === G.provider && args.sub === G.sub ? { key: Buffer.from(ik(G)).toString('hex'), status: 'own', opened: false, account_epoch: 0 } : undefined,
    );
    const u = await tab(b, ENV2);
    expect((await login(u, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_disputed' } });
  });

  it('a primary that suddenly says own for a linked identity is caught by the pin (the second provider disagrees)', async () => {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    b.backend.link(E, G);
    const t = await tab(b, ENV2);
    expect(((await login(t, g)).reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    b.backend.viewLies.set(ENV.rpc, (method, args) =>
      method === 'get_identity' && args.provider === G.provider && args.sub === G.sub ? { key: Buffer.from(ik(G)).toString('hex'), status: 'own', opened: false, account_epoch: 0 } : undefined,
    );
    expect((await login(t, g)).reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_disputed' } });
  });
});

describe('D263: a link that activates between the read and the transaction (movedPath)', () => {
  /** G's link into E's account activates as /v1/login runs: the vault read G as own, the contract derives E's path. */
  function activateOnLogin(b: Browser) {
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    b.backend.overrides.set('/v1/login', () => {
      if (!b.backend.accountOf(Buffer.from(ik(G)).toString('hex'))) b.backend.link(E, G);
      return undefined;
    });
  }
  const fallbackIdentityReads = (b: Browser) => b.backend.rpcCalls.filter((c) => c.endpoint === RPC_FALLBACK && c.params.method_name === 'get_identity').length;

  it('both providers agree the identity is now a member: the root’s path is taken', async () => {
    const b = new Browser();
    activateOnLogin(b);
    const t = await tab(b, ENV2);
    const { reply } = await login(t, g);
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    expect(b.backend.count('/v1/login')).toBe(1);
    // The moved path was confirmed on the second provider, not taken from the primary's word.
    expect(fallbackIdentityReads(b)).toBeGreaterThan(0);
  });

  it('the second provider disputes it (still own): path_disputed, no key', async () => {
    const b = new Browser();
    activateOnLogin(b);
    b.backend.viewLies.set(RPC_FALLBACK, (method, args) =>
      method === 'get_identity' && args.provider === G.provider && args.sub === G.sub ? { key: Buffer.from(ik(G)).toString('hex'), status: 'own', opened: false, account_epoch: 0 } : undefined,
    );
    const t = await tab(b, ENV2);
    const { reply } = await login(t, g);
    expect(reply.error).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_disputed' } });
    expect(reply.result).toBeUndefined();
    expect(b.backend.count('/v1/login')).toBe(1);
  });
});

describe('D263: a root pin read that never answers (or fails) fails closed', () => {
  /** A record store whose pin reads never answer (a stuck IndexedDB), or fail; other reads work. */
  function stuckPins(b: Browser, how: 'hang' | 'fail' = 'hang') {
    const reads = { n: 0 };
    b.openStore = async () => {
      const store = await openRecordStore(b.idb);
      return {
        ...store,
        get: (key: string) => {
          if (!key.startsWith('pin|')) return store.get(key);
          reads.n += 1;
          return how === 'hang' ? new Promise<never>(() => undefined) : Promise.reject(new Error('blocked'));
        },
      };
    };
    return reads;
  }
  const fallbackIdentityReads = (b: Browser) => b.backend.rpcCalls.filter((c) => c.endpoint === RPC_FALLBACK && c.params.method_name === 'get_identity').length;
  function linkedBrowser() {
    const b = new Browser();
    b.backend.opened.add(Buffer.from(ik(E)).toString('hex'));
    b.backend.link(E, G);
    return b;
  }

  it('a member path: after PIN_READ_TIMEOUT_MS it is confirmed on both providers again (twice the second provider’s reads)', async () => {
    expect(PIN_READ_TIMEOUT_MS).toBe(1_000);
    const plain = linkedBrowser();
    expect(((await login(await tab(plain, ENV2), g)).reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    const b = linkedBrowser();
    const reads = stuckPins(b);
    const { reply } = await login(await tab(b, ENV2), g);
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(E)));
    expect(reads.n).toBe(1);
    expect(fallbackIdentityReads(b)).toBe(2 * fallbackIdentityReads(plain));
  });

  it('a member path whose second confirmation the second provider disputes is refused (path_disputed, no /v1/login)', async () => {
    for (const how of ['hang', 'fail'] as const) {
      const b = linkedBrowser();
      stuckPins(b, how);
      // The second provider answers truly for the path read (G and its root E), then says G is its own.
      let n = 0;
      b.backend.viewLies.set(RPC_FALLBACK, (method, args) =>
        method === 'get_identity' && ++n > 2 && args.provider === G.provider && args.sub === G.sub ? { key: Buffer.from(ik(G)).toString('hex'), status: 'own', opened: false, account_epoch: 0 } : undefined,
      );
      const { reply } = await login(await tab(b, ENV2), g);
      expect(reply.error, how).toMatchObject({ code: 'api_unavailable', data: { reason: 'path_disputed' } });
      expect(b.backend.count('/v1/login'), how).toBe(0);
    }
  });

  it('the identity’s own path carries on without a second provider (the pairing check covers it)', async () => {
    const b = new Browser();
    const reads = stuckPins(b);
    b.backend.rpcDown.add(RPC_FALLBACK);
    const { reply } = await login(await tab(b, ENV2), g);
    expect(reply.error).toBeUndefined();
    expect((reply.result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
    expect(reads.n).toBe(1);
  });
});

describe('a Google login of an app with email still opens the Google path for case C', () => {
  it('derives exactly the Google path’s key', async () => {
    const t = await tab(emailBrowser());
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await deliverToken(t, g, run);
    expect(((await pending).result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
  });
});
