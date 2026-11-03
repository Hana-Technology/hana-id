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
import {
  Browser,
  EMAIL_ENV,
  EMAIL_SUB,
  ENV,
  type EmailIssuer,
  type Google,
  type LoginRun,
  SCOPE,
  SUB,
  type Tab,
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

async function tab(browser: Browser, env = EMAIL_ENV): Promise<Tab> {
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
    const t = await tab(b, ENV);
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
    b.backend.googleMatch = null;
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
    expect((await t.request('hana_account')).result).toEqual({
      methods: [
        { provider: 'google', status: 'active', effectiveAtMs: null, root: true },
        { provider: 'email', status: 'pending', effectiveAtMs: 1_800_090_000_000, root: false },
      ],
    });
    expect(linkEvents(t)).toContainEqual({ provider: 'email', status: 'pending', effectiveAtMs: 1_800_090_000_000 });
    b.backend.accounts.clear();
    await t.request('hana_account');
    expect(linkEvents(t)).toContainEqual({ provider: 'email', status: 'removed', effectiveAtMs: null });
    expect(JSON.stringify((await t.request('hana_account')).result)).not.toContain(SUB);
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

describe('a Google login of an app with email still opens the Google path for case C', () => {
  it('derives exactly the Google path’s key', async () => {
    const t = await tab(emailBrowser());
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await deliverToken(t, g, run);
    expect(((await pending).result as { addresses: unknown }).addresses).toEqual(addressesOf(pathOf(G)));
  });
});
