// @vitest-environment happy-dom
// /login in batch 8b: the follow-up key stored with the relay key (and the email context, for the follow-up mode,
// whichever method the user picks), the Google request unchanged under second_request and the access token's first
// under token_first (the default, D270), and a link task's first
// sign-in (`hana.linkAccount`): Google with the vault's nonce, or the email step over `link_new`.
import { relayIdFor, sessionNonce } from '@hana-id/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { readEmailContext } from '../../src/auth/email-storage.ts';
import type { GoogleEmailFlow } from '../../src/auth/google.ts';
import { EMAIL_PATH, startLoginPage } from '../../src/auth/login-page.ts';
import { LOGIN_ENTRY_PREFIX } from '../../src/auth/login-storage.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, asWindow, remoteWindow, resetDom } from './helpers.ts';

const ISSUER = 'https://issuer.hana-email.test';
const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: ISSUER, emailIss: `${ISSUER}/v1/email` });
const VAULT_FRAME = `hana-vault-${'cd'.repeat(16)}`;
const NOW = 1_800_000_000_000;

beforeEach(() => resetDom());

function params(over: Record<string, unknown> = {}) {
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const base = { signer: ENV.signer, scopeId: 's1', sessionPublicKey, expiresAtMs: 1_900_000_000_000, keyIndex: 0, maxUses: 1, salt };
  return {
    v: 1,
    t: 'hana:auth-params',
    pk: PK,
    appName: 'Partner App',
    parentOrigin: PARTNER,
    scopeId: 's1',
    signer: ENV.signer,
    clientId: CLIENT_ID,
    mode: 'shared',
    sessionPublicKey,
    expiresAtMs: base.expiresAtMs,
    salt,
    keyIndex: 0,
    maxUses: 1,
    nonce: sessionNonce(base),
    relayId: relayIdFor(crypto.getRandomValues(new Uint8Array(32))),
    relayKey: crypto.getRandomValues(new Uint8Array(32)),
    ...over,
  };
}

function setup(flow?: GoogleEmailFlow) {
  const win = new FakeWindow('/login', `?v=${VAULT_FRAME}`);
  const opener = remoteWindow();
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  const page = startLoginPage({ win, env: EMAIL_ENV, now: () => NOW, ...(flow ? { googleEmailFlow: flow } : {}) });
  return { win, vault, page };
}

describe('/login with the follow-up channel (batch 8b)', () => {
  it('stores the follow-up key with the relay key, and the email context for the follow-up mode; second_request: Google’s request stays openid-only', async () => {
    const s = setup('second_request');
    const followKey = crypto.getRandomValues(new Uint8Array(32));
    const p = params({ methods: ['google', 'email'], method: 'google', followKey: Uint8Array.from(followKey) });
    s.win.message(p, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + p.relayId)!);
    expect(entry.f).toBe(Buffer.from(followKey).toString('base64url'));
    expect(entry.c).toBe(CLIENT_ID);
    expect(readEmailContext(s.win.sessionStorage, p.relayId, NOW)?.context).toMatchObject({ appName: 'Partner App', clientId: CLIENT_ID });
    const url = new URL(s.win.location.assigned[0]!);
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('response_type')).toBe('id_token');
    // The message's copy of the follow-up key is zeroed once stored.
    expect((p as unknown as { followKey: Uint8Array }).followKey.every((b) => b === 0)).toBe(true);
  });

  it('the default flow (token_first, D270): the same follow-up key and email context; the access token’s request first, the nonce kept for the ID request', async () => {
    const s = setup();
    const followKey = crypto.getRandomValues(new Uint8Array(32));
    const p = params({ methods: ['google', 'email'], method: 'google', followKey: Uint8Array.from(followKey) });
    s.win.message(p, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + p.relayId)!);
    expect(entry).toMatchObject({ f: Buffer.from(followKey).toString('base64url'), c: CLIENT_ID, tf: 1, n: p.nonce });
    expect(readEmailContext(s.win.sessionStorage, p.relayId, NOW)?.context).toMatchObject({ appName: 'Partner App', clientId: CLIENT_ID });
    const url = new URL(s.win.location.assigned[0]!);
    expect([url.searchParams.get('response_type'), url.searchParams.get('scope'), url.searchParams.get('nonce'), url.searchParams.get('state')]).toEqual(['token', 'openid email', null, p.relayId]);
    expect((p as unknown as { followKey: Uint8Array }).followKey.every((b) => b === 0)).toBe(true);
  });

  it('a link task with Google: the vault’s nonce, the task marked on the entry', async () => {
    const s = setup();
    const nonce = 'L'.repeat(43);
    const p = params({ methods: ['google', 'email'], followKey: crypto.getRandomValues(new Uint8Array(32)), task: { kind: 'link', provider: 'google', prove: { method: 'google', nonce, loginHint: null } } });
    s.win.message(p, ENV.vaultOrigin, s.vault);
    await s.page.done;
    const url = new URL(s.win.location.assigned[0]!);
    expect(url.searchParams.get('nonce')).toBe(nonce);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + p.relayId)!).task).toBe(1);
  });

  it('a link task with email: the email step over the vault’s link_new commitment', async () => {
    const s = setup();
    const commitment = { scopeId: 's1', rootIk: 'a'.repeat(64), epoch: 0, salt: [1, 2] };
    const p = params({ methods: ['google', 'email'], followKey: crypto.getRandomValues(new Uint8Array(32)), task: { kind: 'link', provider: 'email', prove: { method: 'email', purpose: 'link_new', commitment } } });
    s.win.message(p, ENV.vaultOrigin, s.vault);
    await s.page.done;
    expect(s.win.location.assigned).toEqual([`${EMAIL_PATH}#${p.relayId}`]);
    expect(readEmailContext(s.win.sessionStorage, p.relayId, NOW)?.context.proof).toEqual({ purpose: 'link_new', commitment });
  });
});
