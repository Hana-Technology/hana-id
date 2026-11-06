// The vault's side of email sharing (D411, D419–D424; vault/email-share.ts, vault.ts): the sealed address kept with the
// session and sent with every mint, hana_requestEmailSharing's sheet in the partner-opened window, the `at_login` sheet
// in the login popup, the emailSharingChanged event (SDK 0.3.0 and later only), and the approval popup's revoke.
import { emailConsentPayload, encryptRelayPayload, followSlot, identityMessage, type RelayPayload } from '@hana-id/core';
import { ed25519 } from '@noble/curves/ed25519';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SHARE_HELLO_MS, ShareSheet, consentProof } from '../../src/vault/email-share.ts';
import type { WindowMessageEvent } from '../../src/vault/runtime.ts';
import {
  APP_ID,
  Browser,
  EMAIL_ENV,
  ENV,
  FakeWindow,
  type Google,
  PARTNER,
  type Tab,
  TestTimers,
  apiError,
  google,
  login,
  popupHello,
  readyTab,
  tokenClaims,
  waitLauncher,
  emailClaims,
  emailIssuer,
  enableEmail,
  deliverToken,
} from './harness.ts';

const SEALED = `se1.${'A'.repeat(60)}`;
const STATE = '/v1/identity/email-consent/state';
const DECIDE = '/v1/identity/email-consent';
const REVOKE = '/v1/identity/email-consent/revoke';

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

const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify({ ...body, requestId: 'rq' }), { status, headers: { 'content-type': 'application/json' } });

async function tab(browser = new Browser(), o: Parameters<typeof readyTab>[1] = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, sdk: '0.3.0', ...o });
  tabs.push(t);
  return t;
}

type Internals = { session: { sealedEmail: string | null; emailState: string | null } | null };
const session = (t: Tab) => (t.vault as unknown as Internals).session!;

/** A logged-in tab whose session has a sealed address, and the consent endpoints answering as `state` says. */
async function loggedIn(o: { setting?: string; state?: string; sealed?: string | null; sdk?: string } = {}) {
  const t = await tab(new Browser(), o.sdk ? { sdk: o.sdk } : {});
  await login(t, g);
  if (o.sealed !== null) session(t).sealedEmail = o.sealed ?? SEALED;
  const b = t.browser.backend;
  b.overrides.set(STATE, () => json(200, { setting: o.setting ?? 'on_request', state: o.state ?? 'not_asked' }));
  b.overrides.set(DECIDE, (c) => json(200, { state: (c.body as { decision: string }).decision }));
  b.overrides.set(REVOKE, () => json(200, { state: 'declined', revoked: 1 }));
  return t;
}

const sheetWindow = (t: Tab) => new FakeWindow(`${ENV.authOrigin}/share-email?from=partner&v=x`, 'hana-share-x', '', t.parent);
const say = (t: Tab, w: FakeWindow, data: Record<string, unknown>) => t.dispatch({ data: { v: 1, ...data }, origin: ENV.authOrigin, source: w });

/** Sends the sheet's hello until the vault's request arrives (the vault reads the state first). */
async function helloUntilRequest(t: Tab, w: FakeWindow): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  while (!w.posted.some((p) => p.message.t === 'hana:email-share-request' || p.message.t === 'hana:email-share-close')) {
    if (Date.now() > deadline) throw new Error('no request');
    say(t, w, { t: 'hana:email-share-hello' });
    await new Promise((r) => setTimeout(r, 10));
  }
  return w.posted.find((p) => p.message.t === 'hana:email-share-request' || p.message.t === 'hana:email-share-close')!.message;
}

describe('the sealed address', () => {
  it('goes with every mint once the session has one (covered by the session proof), never otherwise', async () => {
    const t = await tab();
    await login(t, g);
    expect((await t.request('hana_identityToken')).error).toBeUndefined();
    const first = t.browser.backend.calls.filter((c) => c.path === '/v1/identity/token')[0]!.body as Record<string, unknown>;
    expect('sealedEmail' in first).toBe(false);
    session(t).sealedEmail = SEALED;
    (t.vault as unknown as { identity: unknown }).identity = null;
    expect((await t.request('hana_identityToken')).error).toBeUndefined();
    const second = t.browser.backend.calls.filter((c) => c.path === '/v1/identity/token')[1]!.body as Record<string, unknown>;
    expect(second.sealedEmail).toBe(SEALED);
  });

  it('a mint’s emailStatus tells the vault the state (the approval popup’s Stop sharing reads it)', async () => {
    const t = await tab();
    await login(t, g);
    t.browser.backend.identityEmailStatus = 'included';
    expect((await t.request('hana_identityToken')).error).toBeUndefined();
    expect(session(t).emailState).toBe('granted');
  });
});

describe('where the session’s sealed address comes from (D419)', () => {
  it('an email login: beside the email token in the relay (a malformed one is dropped); kept in the record', async () => {
    const issuer = await emailIssuer();
    for (const [sent, kept] of [[SEALED, SEALED], ['not a blob', null]] as const) {
      const b = new Browser();
      enableEmail(b.backend, issuer);
      const t = await tab(b, { env: EMAIL_ENV });
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      const token = await issuer.token(emailClaims(run.params, {}, b.timers.now));
      if (kept) await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token, sealedEmail: sent } as RelayPayload);
      else await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token });
      expect((await pending).error).toBeUndefined();
      expect(session(t).sealedEmail).toBe(kept);
    }
  });

  it('a Google login of an app with email: google-match’s answer', async () => {
    const issuer = await emailIssuer();
    const b = new Browser();
    enableEmail(b.backend, issuer);
    b.backend.googleMatch = () => ({ decision: 'none', googleHosted: true, linkable: true, sealedEmail: SEALED });
    const t = await tab(b, { env: EMAIL_ENV, options: { googleEmailFlow: 'second_request' } });
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    await deliverToken(t, g, run);
    expect((await pending).error).toBeUndefined();
    expect(session(t).sealedEmail).toBe(SEALED);
  });
});

describe('hana_requestEmailSharing', () => {
  it('logged out: 4100, nothing asked', async () => {
    const t = await tab();
    expect((await t.request('hana_requestEmailSharing')).error?.code).toBe(4100);
    expect(t.browser.backend.count(STATE)).toBe(0);
  });

  it('the app’s setting off, no address, the API down: email_sharing_unavailable with its reason, and a waiting sheet is closed', async () => {
    for (const [o, reason] of [
      [{ setting: 'off' }, 'off'],
      [{ sealed: null, state: 'unavailable' }, 'no_address'],
    ] as const) {
      const t = await loggedIn(o);
      const w = sheetWindow(t);
      const r = await t.request('hana_requestEmailSharing');
      expect(r.error?.code).toBe('email_sharing_unavailable');
      expect((r.error?.data as { reason: string }).reason).toBe(reason);
      // The window the SDK opened says hello late (it loads while the vault asks the API): it is told to close.
      say(t, w, { t: 'hana:email-share-hello' });
      await w.next('hana:email-share-close');
    }
    const t = await loggedIn();
    t.browser.backend.overrides.set(STATE, () => apiError(503, 'config_unavailable'));
    const r = await t.request('hana_requestEmailSharing');
    expect((r.error?.data as { reason: string }).reason).toBe('unavailable');
  });

  it('shows the sheet in the window the partner opened, records "Share email", tells an SDK of 0.3.0 and drops the cached token', async () => {
    const t = await loggedIn();
    expect((await t.request('hana_identityToken')).error).toBeUndefined();
    const reply = t.request('hana_requestEmailSharing');
    const w = sheetWindow(t);
    const req = await helloUntilRequest(t, w);
    expect(req).toMatchObject({ t: 'hana:email-share-request', pk: 'pk_test_1111111111111111111111', parentOrigin: PARTNER, state: 'not_asked', sealedEmail: SEALED, ownGoogleClient: false });
    // The preview proof: the session key's signature over the `preview` payload for this sealed address.
    const proof = req.proof as { sessionPublicKey: Uint8Array; issuedAtMs: number; nonce: Uint8Array; signature: Uint8Array };
    const msg = identityMessage({ signer: ENV.signer, appId: APP_ID, sessionPublicKey: proof.sessionPublicKey, issuedAtMs: proof.issuedAtMs, nonce: proof.nonce, payload: emailConsentPayload({ action: 'preview', parentOrigin: PARTNER, sealedEmail: SEALED }) });
    expect(ed25519.verify(proof.signature, msg, proof.sessionPublicKey)).toBe(true);
    say(t, w, { t: 'hana:email-share-answer', answer: 'granted' });
    expect((await reply).result).toEqual({ state: 'granted' });
    expect(await w.next('hana:email-share-done')).toMatchObject({ state: 'granted' });
    const decide = t.browser.backend.calls.find((c) => c.path === DECIDE)!.body as Record<string, unknown>;
    expect(decide).toMatchObject({ decision: 'granted', sealedEmail: SEALED });
    expect(await t.waitEvent('emailSharingChanged')).toEqual({ state: 'granted' });
    expect(session(t).emailState).toBe('granted');
    expect((t.vault as unknown as { identity: unknown }).identity).toBeNull();
    // Not identityTokenChanged(null): that would say the user logged out.
    expect(t.events.filter((e) => e.event === 'identityTokenChanged').map((e) => (e.data as { identityToken: unknown }).identityToken)).not.toContain(null);
  });

  it('"Not now" records declined; a shared address offers Stop sharing (revoke); Done changes nothing; a closed window is dismissed', async () => {
    const t = await loggedIn();
    let reply = t.request('hana_requestEmailSharing');
    let w = sheetWindow(t);
    await helloUntilRequest(t, w);
    say(t, w, { t: 'hana:email-share-answer', answer: 'declined' });
    expect((await reply).result).toEqual({ state: 'declined' });

    t.browser.backend.overrides.set(STATE, () => json(200, { setting: 'on_request', state: 'granted' }));
    reply = t.request('hana_requestEmailSharing');
    w = sheetWindow(t);
    expect(await helloUntilRequest(t, w)).toMatchObject({ state: 'granted' });
    say(t, w, { t: 'hana:email-share-answer', answer: 'revoke' });
    expect((await reply).result).toEqual({ state: 'declined' });
    expect(t.browser.backend.count(REVOKE)).toBe(1);

    reply = t.request('hana_requestEmailSharing');
    w = sheetWindow(t);
    await helloUntilRequest(t, w);
    say(t, w, { t: 'hana:email-share-answer', answer: 'keep' });
    expect((await reply).result).toEqual({ state: 'granted' });
    expect(t.browser.backend.count(DECIDE)).toBe(1);

    reply = t.request('hana_requestEmailSharing');
    w = sheetWindow(t);
    await helloUntilRequest(t, w);
    w.closed = true;
    expect((await reply).result).toEqual({ state: 'dismissed' });
    expect(t.browser.backend.count(DECIDE)).toBe(1);
  });

  it('answers only the window the partner page opened, on the auth origin; the answer only from that window', async () => {
    const t = await loggedIn();
    const reply = t.request('hana_requestEmailSharing');
    const stranger = new FakeWindow('https://evil.test', 'x', '', new FakeWindow());
    say(t, stranger, { t: 'hana:email-share-hello' });
    const wrongOrigin = sheetWindow(t);
    t.dispatch({ data: { v: 1, t: 'hana:email-share-hello' }, origin: 'https://evil.test', source: wrongOrigin });
    const w = sheetWindow(t);
    await helloUntilRequest(t, w);
    expect(stranger.posted).toEqual([]);
    expect(wrongOrigin.posted).toEqual([]);
    say(t, stranger, { t: 'hana:email-share-answer', answer: 'granted' });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.browser.backend.count(DECIDE)).toBe(0);
    say(t, w, { t: 'hana:email-share-answer', answer: 'declined' });
    expect((await reply).result).toEqual({ state: 'declined' });
  });

  it('an SDK before 0.3.0 gets no emailSharingChanged (its validators refuse unknown events)', async () => {
    const t = await loggedIn({ sdk: '0.2.0' });
    const reply = t.request('hana_requestEmailSharing');
    const w = sheetWindow(t);
    await helloUntilRequest(t, w);
    say(t, w, { t: 'hana:email-share-answer', answer: 'granted' });
    expect((await reply).result).toEqual({ state: 'granted' });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.events.some((e) => e.event === 'emailSharingChanged')).toBe(false);
  });
});

describe('the approval popup’s account line (D423)', () => {
  it('carries emailShared while the session’s address is shared, and its Stop sharing revokes every address', async () => {
    const t = await loggedIn();
    const plain = t.request('stellar_signMessage', { message: 'one' });
    await waitLauncher(t, 'Review in Hana');
    t.launcher.click();
    const popup = t.opened.at(-1)!;
    t.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: popup });
    const first = await popup.next('hana:approve-request');
    expect(first).not.toHaveProperty('emailShared');
    t.dispatch({ data: { v: 1, t: 'hana:approve-bye' }, origin: ENV.authOrigin, source: popup });
    void plain;
    session(t).emailState = 'granted';
    void t.request('stellar_signMessage', { message: 'two' });
    await waitLauncher(t, 'Review in Hana');
    t.launcher.click();
    const again = t.opened.at(-1)!;
    t.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: again });
    expect(await again.next('hana:approve-request')).toMatchObject({ emailShared: true });
    t.dispatch({ data: { v: 1, t: 'hana:email-revoke' }, origin: ENV.authOrigin, source: again });
    expect(await again.next('hana:email-revoked')).toEqual({ v: 1, t: 'hana:email-revoked', ok: true });
    expect(t.browser.backend.count(REVOKE)).toBe(1);
    expect(session(t).emailState).toBe('declined');
    expect(await t.waitEvent('emailSharingChanged')).toEqual({ state: 'declined' });
    // Another window's revoke is ignored.
    t.dispatch({ data: { v: 1, t: 'hana:email-revoke' }, origin: ENV.authOrigin, source: new FakeWindow() });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.browser.backend.count(REVOKE)).toBe(1);
  });
});

describe('at_login (D411 point 2)', () => {
  const ACCESS = 'ya29.share-test';

  async function atLogin(o: { state?: string; sealed?: string | null } = {}) {
    const b = new Browser();
    b.backend.app = { ...b.backend.app, identityEmail: 'at_login' };
    b.backend.googleRecord = () => ({ accepted: true, ...(o.sealed === null ? {} : { sealedEmail: o.sealed ?? SEALED }) });
    b.backend.overrides.set(STATE, () => json(200, { setting: 'at_login', state: o.state ?? 'not_asked' }));
    b.backend.overrides.set(DECIDE, (c) => json(200, { state: (c.body as { decision: string }).decision }));
    const t = await tab(b, { env: EMAIL_ENV, options: { googleEmailFlow: 'token_first' } });
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    expect(run.params.emailShare).toBe(true);
    const relayKey = run.params.relayKey as Uint8Array;
    const { id } = followSlot(run.params.followKey as Uint8Array, 1);
    b.backend.writeRelayRaw(id, await encryptRelayPayload(relayKey, id, { accessToken: ACCESS }));
    const token = await g.token(tokenClaims(run.params, {}, b.timers.now));
    await b.backend.writeRelay(run.params.relayId as string, relayKey, { idToken: token, access: 'follow' } as RelayPayload);
    return { t, pending, popup: run.popup };
  }

  it('the login popup ends on the sheet before the login answers; "Share email" is recorded first', async () => {
    const { t, pending, popup } = await atLogin();
    const req = await helloUntilRequest(t, popup);
    expect(req).toMatchObject({ state: 'not_asked', sealedEmail: SEALED });
    let answered = false;
    void pending.then(() => (answered = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(answered).toBe(false);
    say(t, popup, { t: 'hana:email-share-answer', answer: 'granted' });
    const reply = await pending;
    expect(reply.error).toBeUndefined();
    expect(t.browser.backend.count(DECIDE)).toBe(1);
    expect(session(t)).toMatchObject({ sealedEmail: SEALED, emailState: 'granted' });
  });

  it('already answered (or no address): the popup is told to close and the login goes on; another window’s hello is ignored', async () => {
    const { t, pending, popup } = await atLogin({ state: 'declined' });
    say(t, sheetWindow(t), { t: 'hana:email-share-hello' });
    expect(await helloUntilRequest(t, popup)).toMatchObject({ t: 'hana:email-share-close' });
    expect((await pending).error).toBeUndefined();
    expect(t.browser.backend.count(DECIDE)).toBe(0);

    const again = await atLogin({ sealed: null });
    expect((await again.pending).error).toBeUndefined();
    expect(again.t.browser.backend.count(STATE)).toBe(0);
  });

  it('a closed popup never holds the login: it finishes without a decision', async () => {
    const { t, pending, popup } = await atLogin();
    await helloUntilRequest(t, popup);
    popup.closed = true;
    expect((await pending).error).toBeUndefined();
    expect(t.browser.backend.count(DECIDE)).toBe(0);
  });
});

describe('ShareSheet (email-share.ts)', () => {
  const deps = (record = async (a: string) => (a === 'granted' ? 'granted' : 'declined') as 'granted' | 'declined') => ({
    authOrigin: ENV.authOrigin,
    parentWindow: null,
    timers: new TestTimers(),
    clock: { now: () => 1_800_000_000_000 } as never,
    record,
  });
  const ev = (source: unknown, data: Record<string, unknown>, origin = ENV.authOrigin): WindowMessageEvent => ({ data: { v: 1, ...data }, origin, source, ports: [] }) as unknown as WindowMessageEvent;
  const request = (signer = { signer: ENV.signer, appId: APP_ID, parentOrigin: PARTNER, sessionPublicKey: new Uint8Array(32), privateKey: null as unknown as CryptoKey }) => ({
    pk: 'pk_test_1111111111111111111111',
    appName: 'Partner',
    parentOrigin: PARTNER,
    logoUrl: null,
    ownGoogleClient: true,
    state: 'not_asked' as const,
    sealedEmail: SEALED,
    previewProof: async () => ({ sessionPublicKey: Array.from(signer.sessionPublicKey), issuedAtMs: 1, nonce: Array(16).fill(1), signature: Array(64).fill(2) }),
  });

  it('dismiss answers a late hello with close; a sheet with no window never accepts one', async () => {
    const w = new FakeWindow();
    const s = new ShareSheet(deps(), w);
    s.dismiss();
    expect(s.handleMessage(ev(w, { t: 'hana:email-share-hello' }))).toBe(true);
    await w.next('hana:email-share-close');
    const none = new ShareSheet(deps(), null);
    expect(none.handleMessage(ev(w, { t: 'hana:email-share-hello' }))).toBe(false);
    expect(SHARE_HELLO_MS).toBe(20_000);
  });

  it('a failed record tells the window `failed`', async () => {
    const w = new FakeWindow();
    const s = new ShareSheet(deps(async () => Promise.reject(new Error('down'))), w);
    const out = s.run(request());
    s.handleMessage(ev(w, { t: 'hana:email-share-hello' }));
    await w.next('hana:email-share-request');
    s.handleMessage(ev(w, { t: 'hana:email-share-answer', answer: 'granted' }));
    expect(await out).toBe('failed');
    expect(await w.next('hana:email-share-done')).toMatchObject({ state: 'failed' });
  });

  it('consentProof signs the action’s payload with the session key', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const pk = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const p = await consentProof({ signer: ENV.signer, appId: APP_ID, parentOrigin: PARTNER, sessionPublicKey: pk, privateKey: kp.privateKey }, 'revoke', null, 1234);
    const msg = identityMessage({ signer: ENV.signer, appId: APP_ID, sessionPublicKey: pk, issuedAtMs: 1234, nonce: Uint8Array.from(p.nonce), payload: emailConsentPayload({ action: 'revoke', parentOrigin: PARTNER }) });
    expect(ed25519.verify(Uint8Array.from(p.signature), msg, pk)).toBe(true);
  });
});
