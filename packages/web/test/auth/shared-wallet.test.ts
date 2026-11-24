// @vitest-environment happy-dom
// The shared-wallet line (D912): the sign-in window (/login's chooser and its way to Google, /login/email's sign-in
// screens) and the approval window (a request and the consent screen) say "This wallet is also used on N other apps."
// right under who is asking, the same sentence everywhere, with the names behind "See which", only when the vault sent
// other apps. Without them nothing is drawn: the window is exactly the older one. The line never moves a warning: the
// alerts keep their order, after it.
import { OTHER_APPS_NAMES_MAX, type OtherApps, evmTxSigningPayload, newRequestId, parseEvmTxRequest, parseWindowMessage, relayIdFor, sessionNonce } from '@hana-id/core';
import { policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_UNNAMED_APP } from '../../src/auth/app-name.ts';
import { startApprovePage } from '../../src/auth/approve-page.ts';
import { type EmailApi } from '../../src/auth/email-api.ts';
import { startEmailPage } from '../../src/auth/email-page.ts';
import { EMAIL_ENTRY_PREFIX, readEmailContext } from '../../src/auth/email-storage.ts';
import { EMAIL_PATH, startLoginPage } from '../../src/auth/login-page.ts';
import { storeLoginEntry } from '../../src/auth/login-storage.ts';
import { SHARED_WALLET_TEXT, sharedWalletLine } from '../../src/auth/shared-wallet.ts';
import { dom } from '../../src/auth/dom.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { policyJson } from '../../../core/test/policy-fixtures.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, asWindow, flush, pageText, remoteWindow, resetDom, vaultAcks } from './helpers.ts';

const ISSUER = 'https://issuer.hana-email.test';
const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: ISSUER, emailIss: `${ISSUER}/v1/email` });
const VAULT_FRAME = `hana-vault-${'ef'.repeat(16)}`;
const NOW = 1_800_000_000_000;

const TWO: OtherApps = { count: 2, names: ['Stamp Trail', 'Coffee Club'] };
const MANY: OtherApps = { count: 8, names: ['Stamp Trail', 'Coffee Club', 'Kite Pay', 'Orbit Swap', 'Lumen'] };

const line = () => document.getElementById('shared-wallet') as HTMLDetailsElement | null;
const lines = () => document.querySelectorAll('.shared-wallet');

beforeEach(() => {
  resetDom();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the line (shared-wallet.ts)', () => {
  it('the same plain sentence, singular and plural, with the names one tap away', () => {
    expect(SHARED_WALLET_TEXT.line(1)).toBe('This wallet is also used on 1 other app.');
    expect(SHARED_WALLET_TEXT.line(2)).toBe('This wallet is also used on 2 other apps.');
    const d = dom(document);
    const el = sharedWalletLine(d, TWO)!;
    document.getElementById('app')!.append(el);
    expect(el.tagName).toBe('DETAILS');
    expect(el.open).toBe(false);
    expect(el.querySelector('summary')!.textContent).toBe('This wallet is also used on 2 other apps. See which');
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Stamp Trail', 'Coffee Club']);
    expect(el.querySelector('.shared-wallet-note')!.textContent).toBe(SHARED_WALLET_TEXT.note);
    // Journear's note in muted text, never a coloured alert.
    expect(el.querySelector('.jp-alert')).toBeNull();
    expect(el.className).toBe('shared-wallet');
  });

  it('lists at most OTHER_APPS_NAMES_MAX names and counts the rest', () => {
    const el = sharedWalletLine(dom(document), MANY)!;
    expect(el.querySelector('.shared-wallet-line')!.textContent).toBe('This wallet is also used on 8 other apps.');
    const items = [...el.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([...MANY.names, 'and 3 more apps']);
    expect(items.length).toBe(OTHER_APPS_NAMES_MAX + 1);
    expect(sharedWalletLine(dom(document), { count: 6, names: MANY.names })!.querySelector('li.shared-wallet-more')!.textContent).toBe('and 1 more app');
  });

  it('a partner’s name is only ever text: markup stays text, and an unsafe name never reaches the window', () => {
    const el = sharedWalletLine(dom(document), { count: 1, names: ['<img src=x onerror=alert(1)>'] })!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('li')!.textContent).toBe('<img src=x onerror=alert(1)>');
    // The window takes only display-safe names: a bidi override, a control or an invisible character is refused as a
    // whole (the vault replaces such a name by "Unnamed app" before it sends it).
    for (const bad of ['Pay‮gnp.exe', 'Zero​width', 'Tab\there', ' padded ', '']) expect(sharedWalletLine(dom(document), { count: 1, names: [bad] })).toBeNull();
    expect(sharedWalletLine(dom(document), { count: 1, names: [HOME_UNNAMED_APP] })!.querySelector('li')!.textContent).toBe(HOME_UNNAMED_APP);
  });

  it.each([
    ['no field', undefined],
    ['a count of 0', { count: 0, names: [] }],
    ['names that don’t match the count', { count: 3, names: ['A'] }],
    ['an extra key', { count: 1, names: ['A'], origins: ['https://a.example'] }],
    ['not an object', 'Stamp Trail'],
  ])('draws nothing for %s', (_, v) => {
    expect(sharedWalletLine(dom(document), v)).toBeNull();
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

function loginSetup(search = `?v=${VAULT_FRAME}`) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no fetch expected');
    }),
  );
  const win = new FakeWindow('/login', search);
  const opener = remoteWindow({ location: { pathname: search === '?mode=export' ? '/export' : '/' } });
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  vaultAcks(search === '?mode=export' ? opener : vault, win);
  const page = startLoginPage({ win, env: EMAIL_ENV, now: () => NOW });
  return { win, vault, opener, page };
}

describe('the sign-in window (/login)', () => {
  it('the auth-params validator takes the field, and only of its shape', () => {
    expect(parseWindowMessage(authParams({ otherApps: TWO }), ['hana:auth-params'])).not.toBeNull();
    expect(parseWindowMessage(authParams({ otherApps: { count: 0, names: [] } }), ['hana:auth-params'])).toBeNull();
    expect(parseWindowMessage(authParams({ otherApps: { count: 2, names: ['Pay‮gnp'] } }), ['hana:auth-params'])).toBeNull();
  });

  it('the chooser: the line right under who is asking, before the buttons', async () => {
    const s = loginSetup();
    s.win.message(authParams({ methods: ['google', 'email'], otherApps: TWO }), ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('choosing');
    expect(lines()).toHaveLength(1);
    const asker = document.querySelector('p.asker')!;
    expect(asker.nextElementSibling).toBe(line());
    expect(line()!.nextElementSibling!.className).toBe('providers');
    expect(pageText()).toContain('Signing in to Partner App at https://partner.example');
    expect(pageText()).toContain('This wallet is also used on 2 other apps.');
    // "Continue with Google": the line stays on the screen that goes to Google.
    (document.getElementById('continue-google') as HTMLButtonElement).click();
    expect(pageText()).toContain('Continuing to Google…');
    expect(document.querySelector('p.asker')!.nextElementSibling).toBe(line());
  });

  it('the email step gets them in its context; "Continue with email" keeps the line', async () => {
    const s = loginSetup();
    const params = authParams({ methods: ['google', 'email'], otherApps: TWO });
    s.win.message(params, ENV.vaultOrigin, s.vault);
    await s.page.done;
    (document.getElementById('continue-email') as HTMLButtonElement).click();
    expect(s.win.location.assigned).toEqual([`${EMAIL_PATH}#${params.relayId}`]);
    expect(readEmailContext(s.win.sessionStorage, params.relayId, NOW)!.context.otherApps).toEqual(TWO);
  });

  it('a Google-only app on its way to Google shows it too', async () => {
    const s = loginSetup();
    s.win.message(authParams({ otherApps: TWO }), ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    expect(document.querySelector('p.asker')!.nextElementSibling).toBe(line());
  });

  it('an app alone: no line, no new text, the screen as before (who is asking, then the buttons)', async () => {
    const s = loginSetup();
    s.win.message(authParams({ methods: ['google', 'email'] }), ENV.vaultOrigin, s.vault);
    await s.page.done;
    expect(lines()).toHaveLength(0);
    expect(pageText()).not.toContain('also used');
    expect(document.querySelector('p.asker')!.nextElementSibling!.className).toBe('providers');
    expect([...document.querySelector('section.panel')!.children].map((c) => c.tagName + (c.className ? `.${c.className}` : ''))).toEqual(['H1', 'P.asker', 'DIV.providers']);
  });

  it('export mode (the key window’s “Confirm it’s you”): no line, and none handed on', async () => {
    const s = loginSetup('?mode=export');
    const params = authParams({ methods: ['google', 'email'], otherApps: TWO });
    s.win.message(params, ENV.authOrigin, s.opener);
    await s.page.done;
    expect(lines()).toHaveLength(0);
  });
});

// ---- the email step ----

function emailSetup(otherApps?: unknown) {
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
        appName: 'Partner App',
        ...(otherApps === undefined ? {} : { otherApps }),
        parentOrigin: PARTNER,
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
  const issuer = { start: vi.fn(async () => ({ challengeId: 'c'.repeat(43), expiresAtMs: NOW + 600_000, resendAfterMs: NOW + 30_000 })), resend: vi.fn(), verify: vi.fn() };
  const page = startEmailPage({
    win,
    env: EMAIL_ENV,
    issuer: issuer as unknown as EmailApi,
    api: { getApp: vi.fn(), writeRelay: vi.fn(async () => {}), readRelay: vi.fn(), login: vi.fn() } as never,
    tickets: window.localStorage,
    now: () => NOW,
    setTimeout: () => undefined,
    clearTimeout: () => {},
  });
  return { win, page };
}

describe('the sign-in window (/login/email)', () => {
  it('the address step and the code step: the line right under who is asking', async () => {
    const s = emailSetup(TWO);
    await flush();
    expect(s.page.stage).toBe('address');
    expect(document.querySelector('p.asker')!.nextElementSibling).toBe(line());
    expect(line()!.querySelector('.shared-wallet-line')!.textContent).toBe('This wallet is also used on 2 other apps.');
    (document.getElementById('email-address') as HTMLInputElement).value = 'ada@example.com';
    (document.getElementById('email-send') as HTMLButtonElement).closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(s.page.stage).toBe('code');
    expect(document.querySelector('p.asker')!.nextElementSibling).toBe(line());
  });

  it('an app alone: no line on the address step, the screen as before', async () => {
    emailSetup();
    await flush();
    expect(lines()).toHaveLength(0);
    expect(pageText()).not.toContain('also used');
    expect(document.querySelector('p.asker')!.nextElementSibling!.tagName).toBe('FORM');
  });

  it('a stored context with a field it can’t read is refused as a whole, as any other malformed field', async () => {
    emailSetup({ count: 2, names: ['Only one'] });
    await flush();
    expect(lines()).toHaveLength(0);
    expect(pageText()).not.toContain('also used');
  });
});

// ---- the approval window ----

const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0xde0b6b3a7640000', data: '0x' };
const evmRequest = (over: Record<string, unknown> = {}) => ({
  v: 1,
  t: 'hana:approve-request',
  id: newRequestId(),
  appName: 'Partner App',
  parentOrigin: PARTNER,
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
  appName: 'Partner App',
  parentOrigin: PARTNER,
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
  /** The screen's parts in order: tag and first class. */
  const outline = () => [...document.querySelector('section.panel')!.children].map((c) => `${c.tagName.toLowerCase()}${c.classList[0] ? `.${c.classList[0]}` : ''}`);
  /** The alerts in order, by tone. */
  const alerts = () => [...document.querySelectorAll('.jp-alert')].map((a) => [...a.classList].find((c) => c.startsWith('jp-alert-')));

  it('the validators take the field on a request and the consent screen, and only of its shape', () => {
    expect(parseWindowMessage(evmRequest({ otherApps: TWO }), ['hana:approve-request'])).not.toBeNull();
    expect(parseWindowMessage(consentRequest({ otherApps: TWO }), ['hana:consent-request'])).not.toBeNull();
    expect(parseWindowMessage(evmRequest({ otherApps: { count: 1, names: [] } }), ['hana:approve-request'])).toBeNull();
    expect(parseWindowMessage(consentRequest({ otherApps: { count: 7, names: TWO.names } }), ['hana:consent-request'])).toBeNull();
  });

  it('a request: the line with "From {App}", right under the box, before the account line and the summary', () => {
    send(evmRequest({ otherApps: TWO }));
    expect(lines()).toHaveLength(1);
    expect(document.querySelector('header.app')!.nextElementSibling).toBe(line());
    expect(line()!.nextElementSibling!.className).toBe('account');
    // Never inside the box that holds the app's own name and address, nor in the partner's labels.
    expect(document.querySelector('header.app .shared-wallet')).toBeNull();
    expect(document.querySelector('.partner-labels .shared-wallet')).toBeNull();
    expect(pageText()).toContain('From Partner App');
    expect(pageText()).toContain('This wallet is also used on 2 other apps.');
  });

  it('the warnings keep their order and their colours, all after the line', () => {
    const over = { autoApprove: { label: 'Swaps', active: true, reason: 'daily_count_reached' }, testApp: true };
    send(evmRequest(over));
    const without = { outline: outline(), alerts: alerts() };
    resetDom();
    send(evmRequest({ ...over, otherApps: MANY }));
    expect(alerts()).toEqual(without.alerts);
    expect(without.alerts.length).toBeGreaterThan(0);
    // The same screen with one more part, right after the box.
    const withLine = outline();
    expect(withLine.filter((p) => p !== 'details.shared-wallet')).toEqual(without.outline);
    expect(withLine.indexOf('details.shared-wallet')).toBe(withLine.indexOf('header.app') + 1);
    // Every alert comes after the line in the page.
    for (const a of document.querySelectorAll('.jp-alert')) expect(line()!.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the consent screen for automatic approvals: the line under who is asking', () => {
    send(consentRequest({ otherApps: TWO }));
    expect(document.querySelector('header.app')!.nextElementSibling).toBe(line());
    expect(pageText()).toContain('This wallet is also used on 2 other apps.');
  });

  it('an app alone: no line, no new text; the box is followed by the account line as before', () => {
    send(evmRequest());
    expect(lines()).toHaveLength(0);
    expect(pageText()).not.toContain('also used');
    expect(document.querySelector('header.app')!.nextElementSibling!.className).toBe('account');
    resetDom();
    send(consentRequest());
    expect(lines()).toHaveLength(0);
  });

  it('"See which" opens the names without answering anything, and Approve stays the guard’s', () => {
    send(evmRequest({ otherApps: TWO }));
    const summary = line()!.querySelector('summary')!;
    summary.click();
    expect(line()!.open).toBe(true);
    expect(vault.postMessage.mock.calls.map((c) => (c[0] as { t: string }).t).filter((t) => t !== 'hana:approve-hello')).toEqual([]);
    expect(document.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
  });
});
