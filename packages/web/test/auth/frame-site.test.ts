// @vitest-environment happy-dom
// P11 (D934): when the page asking for the wallet sits inside another page (a network's widget on a partner's site),
// Journear's windows keep the page asking as their subject, exactly as before ("Signing in to {App} at {widget}",
// "From {App}" and its address, the consent sentence), and add one neutral line under it, from what the vault checked
// (core protocol.ts FrameSite): "Shown inside a page at {top}." where the browser named the top-level page, else "Shown
// inside another page. Check your browser's address bar shows a site you trust." The top-level page is never the
// subject, nor in the "at" slot: an app can list any site, so a listed site proves nothing about who runs the app.
// Without the field, every window is exactly the older one.
import { type FrameSite, evmTxSigningPayload, newRequestId, parseEvmTxRequest, parseWindowMessage, relayIdFor, sessionNonce } from '@hana-id/core';
import { policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApprovePage } from '../../src/auth/approve-page.ts';
import { FRAME_TEXT, askerBox, dom, frameNote } from '../../src/auth/dom.ts';
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
const INSIDE = `Shown inside a page at ${PAGE}.`;
const INSIDE_UNKNOWN = 'Shown inside another page. Check your browser’s address bar shows a site you trust.';

beforeEach(() => {
  resetDom();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim();

describe('the words (dom.ts frameNote, askerBox)', () => {
  it('a neutral line in plain words, the address a text node', () => {
    const d = dom(document);
    expect(text(frameNote(d, ON))).toBe(INSIDE);
    expect(text(frameNote(d, UNKNOWN))).toBe(INSIDE_UNKNOWN);
    expect(FRAME_TEXT.insideAt).toBe('Shown inside a page at ');
    // Never a headline about where the person is, nor anything that reads as the site vouching for the app.
    expect(JSON.stringify(FRAME_TEXT)).not.toMatch(/You’re on|You're on|on behalf|by /u);
  });
  it('the box: one paragraph as before when not framed; framed, the same paragraph (the page asking in the "at" slot), then the note', () => {
    const d = dom(document);
    const plain = askerBox(d, ['Signing in to ', d.h('strong', {}, 'Coffee Club')], WIDGET);
    expect(plain.tagName).toBe('P');
    expect(plain.className).toBe('asker');
    expect(text(plain)).toBe(`Signing in to Coffee Club at ${WIDGET}`);
    for (const [f, note] of [
      [ON, INSIDE],
      [UNKNOWN, INSIDE_UNKNOWN],
    ] as const) {
      const box = askerBox(d, ['Signing in to ', d.h('strong', {}, 'Coffee Club')], WIDGET, f);
      expect(box.className).toBe('asker asker-framed');
      expect([...box.children].map(text)).toEqual([`Signing in to Coffee Club at ${WIDGET}`, note]);
    }
  });
  it('an address with markup in it stays text (the vault sends only origins anyway)', () => {
    expect(frameNote(dom(document), { top: 'https://<img src=x>.example' }).querySelector('img')).toBeNull();
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
    for (const f of [ON, UNKNOWN]) expect(parseWindowMessage(authParams({ frame: f }), ['hana:auth-params'])).not.toBeNull();
    for (const bad of [{ top: WIDGET }, { top: null, expected: PAGE }, { top: PAGE, expected: PAGE }, { top: 'not an origin' }, { top: PAGE, extra: 1 }, 'coffeeclub.example', true]) {
      expect(parseWindowMessage(authParams({ frame: bad }), ['hana:auth-params']), JSON.stringify(bad)).toBeNull();
    }
  });

  it('the chooser: the page asking stays in the "at" slot, the note under it; the email step gets it in its context', async () => {
    const s = loginSetup();
    const params = authParams({ methods: ['google', 'email'], frame: ON });
    s.win.message(params, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('choosing');
    expect([...document.querySelector('.asker-framed')!.children].map(text)).toEqual([`Signing in to Coffee Club at ${WIDGET}`, INSIDE]);
    expect(pageText()).not.toContain(`Coffee Club at ${PAGE}`);
    (document.getElementById('continue-email') as HTMLButtonElement).click();
    expect(readEmailContext(s.win.sessionStorage, params.relayId, NOW)!.context.frame).toEqual(ON);
  });

  it('the browser didn’t say: the same line, then the check, on the way to Google too', async () => {
    const s = loginSetup();
    s.win.message(authParams({ frame: UNKNOWN }), ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    expect([...document.querySelector('.asker-framed')!.children].map(text)).toEqual([`Signing in to Coffee Club at ${WIDGET}`, INSIDE_UNKNOWN]);
  });

  it('not framed: exactly the older box', async () => {
    const s = loginSetup();
    s.win.message(authParams({ methods: ['google', 'email'] }), ENV.vaultOrigin, s.vault);
    await s.page.done;
    expect(document.querySelector('.asker-framed')).toBeNull();
    expect(text(document.querySelector('p.asker'))).toBe(`Signing in to Coffee Club at ${WIDGET}`);
    expect(pageText()).not.toContain('Shown inside');
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
    expect([...document.querySelector('.asker-framed')!.children].map(text)).toEqual([`Signing in to Coffee Club at ${WIDGET}`, INSIDE]);
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
      expect(parseWindowMessage(m({ frame: UNKNOWN }), [t])).not.toBeNull();
      expect(parseWindowMessage(m({ frame: { top: WIDGET } }), [t])).toBeNull();
      expect(parseWindowMessage(m({ frame: { top: null, expected: PAGE } }), [t])).toBeNull();
    }
  });

  it('a request: "From {App}" and the page asking’s address as before, then the note', () => {
    send(evmRequest({ frame: ON }));
    expect(box()).toEqual(['From Coffee Club', WIDGET, INSIDE]);
  });

  it('a request where the browser didn’t say: the note with the check', () => {
    send(evmRequest({ frame: UNKNOWN }));
    expect(box()).toEqual(['From Coffee Club', WIDGET, INSIDE_UNKNOWN]);
  });

  it('the consent screen: the box with the note; its sentence still names the page asking, never the page around it', () => {
    send(consentRequest({ frame: ON }));
    expect(box()).toEqual(['From Coffee Club', WIDGET, INSIDE]);
    expect(pageText()).toContain(`Coffee Club at ${WIDGET} wants Journear to approve some requests`);
    expect(pageText()).not.toContain(`Coffee Club at ${PAGE}`);
  });

  it('not framed: the box is the older one (the app, then its address)', () => {
    send(evmRequest());
    expect(box()).toEqual(['From Coffee Club', WIDGET]);
    expect(pageText()).not.toContain('Shown inside');
  });
});
