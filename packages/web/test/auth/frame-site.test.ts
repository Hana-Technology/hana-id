// @vitest-environment happy-dom
// P11 (D934): when the page asking for the wallet sits inside another page (a network's widget on a partner's site),
// Journear's windows say where the person is, from what the vault checked (core protocol.ts FrameSite): the sign-in
// window (/login, and the email step from its stored context), the approval window (a request and the consent
// screen), the email sharing sheet and the export window. "You're on {top}. This uses a widget from {widget}." where
// the browser named the top-level page; where it didn't, the widget's line and a plain "check your address bar" (with
// the one page to expect, when the vault had exactly one). Without the field, every window is exactly the older one.
import { type FrameSite, evmTxSigningPayload, newRequestId, parseEvmTxRequest, parseWindowMessage, relayIdFor, sessionNonce } from '@hana-id/core';
import { policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApprovePage } from '../../src/auth/approve-page.ts';
import { FRAME_TEXT, askerBox, dom, frameLines } from '../../src/auth/dom.ts';
import { type EmailApi } from '../../src/auth/email-api.ts';
import { startEmailPage } from '../../src/auth/email-page.ts';
import { EMAIL_ENTRY_PREFIX, readEmailContext } from '../../src/auth/email-storage.ts';
import { EMAIL_PATH, startLoginPage } from '../../src/auth/login-page.ts';
import { storeLoginEntry } from '../../src/auth/login-storage.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { policyJson } from '../../../core/test/policy-fixtures.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, asWindow, flush, pageText, remoteWindow, resetDom, vaultAcks } from './helpers.ts';

const ISSUER = 'https://issuer.hana-email.test';
const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: ISSUER, emailIss: `${ISSUER}/v1/email` });
const VAULT_FRAME = `hana-vault-${'ef'.repeat(16)}`;
const NOW = 1_800_000_000_000;
// The widget is the vault's parent (PARTNER in these windows); the partner's own page is around it.
const WIDGET = PARTNER;
const PAGE = 'https://coffeeclub.example';
const ON: FrameSite = { top: PAGE };
const UNKNOWN: FrameSite = { top: null };
const EXPECTED: FrameSite = { top: null, expected: PAGE };

beforeEach(() => {
  resetDom();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim();

describe('the words (dom.ts frameLines, askerBox)', () => {
  it('plain words, the addresses as text nodes', () => {
    const d = dom(document);
    expect(frameLines(d, WIDGET, ON).map(text)).toEqual([`You’re on ${PAGE}.`, `This uses a widget from ${WIDGET}.`]);
    expect(frameLines(d, WIDGET, UNKNOWN).map(text)).toEqual([`This uses a widget from ${WIDGET}.`, 'Your browser didn’t say which site you’re on. Check your browser’s address bar shows a site you trust.']);
    expect(frameLines(d, WIDGET, EXPECTED).map(text)).toEqual([`This uses a widget from ${WIDGET}.`, `Your browser didn’t say which site you’re on. It should be ${PAGE}: check your browser’s address bar.`]);
    expect(FRAME_TEXT.youAreOn).toBe('You’re on ');
  });
  it('the box: one paragraph as before when not framed; framed, the site the browser named, or none', () => {
    const d = dom(document);
    const plain = askerBox(d, ['Signing in to ', d.h('strong', {}, 'Coffee Club')], WIDGET);
    expect(plain.tagName).toBe('P');
    expect(plain.className).toBe('asker');
    expect(text(plain)).toBe(`Signing in to Coffee Club at ${WIDGET}`);
    const on = askerBox(d, ['Signing in to ', d.h('strong', {}, 'Coffee Club')], WIDGET, ON);
    expect(on.className).toBe('asker asker-framed');
    expect([...on.children].map(text)).toEqual([`Signing in to Coffee Club at ${PAGE}`, `This uses a widget from ${WIDGET}.`]);
    const unknown = askerBox(d, ['Signing in to ', d.h('strong', {}, 'Coffee Club')], WIDGET, EXPECTED);
    expect([...unknown.children].map(text)).toEqual(['Signing in to Coffee Club.', `This uses a widget from ${WIDGET}.`, `Your browser didn’t say which site you’re on. It should be ${PAGE}: check your browser’s address bar.`]);
  });
  it('an address with markup in it stays text (the vault sends only origins anyway)', () => {
    const d = dom(document);
    const lines = frameLines(d, WIDGET, { top: 'https://<img src=x>.example' });
    expect(lines[0]!.querySelector('img')).toBeNull();
  });
});

// ---- the sign-in window ----

function authParams(over: Record<string, unknown> = {}) {
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const base = { signer: ENV.signer, scopeId: 's1', sessionPublicKey, expiresAtMs: 1_900_000_000_000, keyIndex: 0, maxUses: 1, salt };
  return {
    v: 1,
    t: 'hana:auth-params',
    pk: PK,
    appName: 'Coffee Club',
    parentOrigin: WIDGET,
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

function loginSetup() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no fetch expected');
    }),
  );
  const win = new FakeWindow('/login', `?v=${VAULT_FRAME}`);
  const opener = remoteWindow({ location: { pathname: '/' } });
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  vaultAcks(vault, win);
  const page = startLoginPage({ win, env: EMAIL_ENV, now: () => NOW });
  return { win, vault, page };
}

describe('the sign-in window (/login)', () => {
  it('the validator takes a FrameSite, never one naming the page asking as the top, nor anything else', () => {
    for (const f of [ON, UNKNOWN, EXPECTED]) expect(parseWindowMessage(authParams({ frame: f }), ['hana:auth-params'])).not.toBeNull();
    for (const bad of [{ top: WIDGET }, { top: null, expected: WIDGET }, { top: PAGE, expected: PAGE }, { top: 'not an origin' }, { top: PAGE, extra: 1 }, 'coffeeclub.example', true]) {
      expect(parseWindowMessage(authParams({ frame: bad }), ['hana:auth-params']), JSON.stringify(bad)).toBeNull();
    }
  });

  it('the chooser names the partner’s page and the widget; the email step gets it in its context', async () => {
    const s = loginSetup();
    const params = authParams({ methods: ['google', 'email'], frame: ON });
    s.win.message(params, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('choosing');
    expect([...document.querySelector('.asker-framed')!.children].map(text)).toEqual([`Signing in to Coffee Club at ${PAGE}`, `This uses a widget from ${WIDGET}.`]);
    expect(pageText()).not.toContain(`Coffee Club at ${WIDGET}`);
    (document.getElementById('continue-email') as HTMLButtonElement).click();
    expect(readEmailContext(s.win.sessionStorage, params.relayId, NOW)!.context.frame).toEqual(ON);
  });

  it('the browser didn’t say: no site after the app, the widget’s line and the check, on the way to Google too', async () => {
    const s = loginSetup();
    s.win.message(authParams({ frame: EXPECTED }), ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    expect(pageText()).toContain('Signing in to Coffee Club.');
    expect(pageText()).toContain(`This uses a widget from ${WIDGET}.`);
    expect(pageText()).toContain(`It should be ${PAGE}: check your browser’s address bar.`);
  });

  it('not framed: exactly the older box', async () => {
    const s = loginSetup();
    s.win.message(authParams({ methods: ['google', 'email'] }), ENV.vaultOrigin, s.vault);
    await s.page.done;
    expect(document.querySelector('.asker-framed')).toBeNull();
    expect(text(document.querySelector('p.asker'))).toBe(`Signing in to Coffee Club at ${WIDGET}`);
    expect(pageText()).not.toContain('widget');
  });
});

// ---- the email step ----

function emailSetup(frame?: unknown) {
  const p = authParams();
  const relayId = p.relayId;
  const win = new FakeWindow(EMAIL_PATH, '', `#${relayId}`);
  const opener = remoteWindow();
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  vaultAcks(vault, win);
  storeLoginEntry(win.sessionStorage, relayId, p.relayKey, NOW);
  win.sessionStorage.setItem(
    EMAIL_ENTRY_PREFIX + relayId,
    JSON.stringify({
      v: 1,
      createdAt: NOW,
      c: {
        pk: PK,
        appName: 'Coffee Club',
        parentOrigin: WIDGET,
        ...(frame === undefined ? {} : { frame }),
        scopeId: 's1',
        sessionPublicKey: Buffer.from(p.sessionPublicKey).toString('base64url'),
        expiresAtMs: p.expiresAtMs,
        salt: Buffer.from(p.salt).toString('base64url'),
        keyIndex: 0,
        maxUses: 1,
        nonce: p.nonce,
        clientId: CLIENT_ID,
        methods: ['google', 'email'],
        emailHint: null,
        opener: 'partner',
        vaultFrame: VAULT_FRAME,
        challengeId: null,
      },
    }),
  );
  const issuer = { start: vi.fn(), resend: vi.fn(), verify: vi.fn() };
  return startEmailPage({
    win,
    env: EMAIL_ENV,
    issuer: issuer as unknown as EmailApi,
    api: { getApp: vi.fn(), writeRelay: vi.fn(async () => {}), readRelay: vi.fn(), login: vi.fn() } as never,
    tickets: window.localStorage,
    now: () => NOW,
    setTimeout: () => undefined,
    clearTimeout: () => {},
  });
}

describe('the sign-in window (/login/email)', () => {
  it('the address step says where the page is, from the stored context', async () => {
    const page = emailSetup(ON);
    await flush();
    expect(page.stage).toBe('address');
    expect([...document.querySelector('.asker-framed')!.children].map(text)).toEqual([`Signing in to Coffee Club at ${PAGE}`, `This uses a widget from ${WIDGET}.`]);
  });
  it('a stored frame it can’t read refuses the context as a whole, as any malformed field', async () => {
    const page = emailSetup({ top: WIDGET });
    await flush();
    expect(page.stage).not.toBe('address');
    expect(pageText()).not.toContain(`at ${WIDGET}`);
  });
});

// ---- the approval window ----

const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0xde0b6b3a7640000', data: '0x' };
const evmRequest = (over: Record<string, unknown> = {}) => ({
  v: 1,
  t: 'hana:approve-request',
  id: newRequestId(),
  appName: 'Coffee Club',
  parentOrigin: WIDGET,
  kind: 'evm_tx',
  chain: 'evm',
  address: EVM,
  bytes: evmTxSigningPayload(parseEvmTxRequest(TX)),
  context: { chainId: 11155111 },
  position: 1,
  queued: 1,
  ...over,
});
const POLICY = validateAutoApprovePolicy(policyJson());
if (!POLICY.ok) throw new Error('fixture policy is invalid');
const consentRequest = (over: Record<string, unknown> = {}) => ({
  v: 1,
  t: 'hana:consent-request',
  id: newRequestId(),
  appName: 'Coffee Club',
  parentOrigin: WIDGET,
  policy: JSON.parse(JSON.stringify(POLICY.policy)) as Record<string, unknown>,
  policyId: policyId(POLICY.policy),
  expiresAtMs: NOW + 12 * 3_600_000,
  position: 1,
  queued: 1,
  ...over,
});

describe('the approval window (/approve)', () => {
  let win: FakeWindow;
  let vault: ReturnType<typeof remoteWindow>;
  let page: ReturnType<typeof startApprovePage>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    win = new FakeWindow('/approve');
    vault = remoteWindow();
    win.opener = asWindow(vault);
    page = startApprovePage({ win, env: ENV, isGesture: () => true });
    win.dispatch('focus');
  });
  afterEach(() => page.stop());
  const send = (m: unknown) => win.message(m, ENV.vaultOrigin, vault);
  const box = () => [...document.querySelector('header.app')!.children].map(text);

  it('the validators take the field on a request and the consent screen, and only of its shape', () => {
    for (const [m, t] of [[evmRequest, 'hana:approve-request'], [consentRequest, 'hana:consent-request']] as const) {
      expect(parseWindowMessage(m({ frame: ON }), [t])).not.toBeNull();
      expect(parseWindowMessage(m({ frame: EXPECTED }), [t])).not.toBeNull();
      expect(parseWindowMessage(m({ frame: { top: WIDGET } }), [t])).toBeNull();
      expect(parseWindowMessage(m({ frame: { top: null, expected: 'x' } }), [t])).toBeNull();
    }
  });

  it('a request: "From {App}", then where the person is and the widget, in the box', () => {
    send(evmRequest({ frame: ON }));
    expect(box()).toEqual(['From Coffee Club', `You’re on ${PAGE}.`, `This uses a widget from ${WIDGET}.`]);
  });

  it('a request where the browser didn’t say: the widget and the check', () => {
    send(evmRequest({ frame: UNKNOWN }));
    expect(box()).toEqual(['From Coffee Club', `This uses a widget from ${WIDGET}.`, 'Your browser didn’t say which site you’re on. Check your browser’s address bar shows a site you trust.']);
  });

  it('the consent screen: the box, and its sentence names the partner’s page (or no site when unknown)', () => {
    send(consentRequest({ frame: ON }));
    expect(box()).toEqual(['From Coffee Club', `You’re on ${PAGE}.`, `This uses a widget from ${WIDGET}.`]);
    expect(pageText()).toContain(`Coffee Club at ${PAGE} wants Journear to approve some requests`);
    resetDom();
    send(consentRequest({ frame: UNKNOWN }));
    expect(pageText()).toContain('Coffee Club wants Journear to approve some requests');
  });

  it('not framed: the box is the older one (the app, then its address)', () => {
    send(evmRequest());
    expect(box()).toEqual(['From Coffee Club', WIDGET]);
    expect(pageText()).not.toContain('widget');
  });
});
