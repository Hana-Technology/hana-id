// @vitest-environment happy-dom
// Passport Home's own "Cancel this link" (home-link-cancel.ts in home-sign-ins.ts, D902, D898 option B): which rows offer
// it and which keep option A or the sentence; the confirmation and Go back; the child in the click and its parameters
// (the nonce over the fresh root, member and epoch); the fresh read and the route on NEAR before Google; every check of
// Google's answer before anything is sent; the one request and every outcome (Link cancelled, Nothing changed by group,
// It may not have been cancelled with Show again); the line and the row without a reload; leaving and signing out.
import { ApiError, type RelayPayload, type RelayReadResponse, encryptRelayPayload, fromHex, identityKeyHex, linkChangeNonce, parseWindowMessage } from '@hana-id/core';
import { jargonIn } from '@hana-id/brand/plain-words';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerClock } from '../../src/auth/clock.ts';
import { dom } from '../../src/auth/dom.ts';
import type { HomeConfig, HomeIdentity, HomeLinkCancelBody, HomeScope } from '../../src/auth/home-api.ts';
import { CANCEL_TEXT, cancelButtonName, cancelConfirmText, cancelDoneText, cancelOutcome, nothingLines } from '../../src/auth/home-link-cancel.ts';
import { HOME_CANCEL_SIGN_IN_TITLE } from '../../src/auth/login-page.ts';
import { type HomeSignIns, type HomeSignInsWho, SIGN_IN_TEXT, startHomeSignIns } from '../../src/auth/home-sign-ins.ts';
import type { NearReader } from '../../src/auth/near-rpc.ts';
import { CLIENT_ID, ENV, FakeWindow, type RemoteWindow, type TokenSigner, pageText, remoteWindow, resetDom, tokenSigner } from './helpers.ts';

const T0 = 1_800_000_000_000;
const S = 'scope1';
const G = { provider: 'google', sub: '104857600000000000001' };
const G2 = { provider: 'google', sub: '104857600000000000002' };
const E = { provider: 'email', sub: `e1.${'A'.repeat(43)}` };
const key = (i: { provider: string; sub: string }): string => identityKeyHex(S, i.provider, i.sub);
const asGoogle: HomeSignInsWho = { provider: 'google', sub: G.sub, address: null };
const asEmail: HomeSignInsWho = { provider: 'email', sub: E.sub, address: 'pat@mail.example' };

interface Member {
  who: { provider: string; sub: string };
  effectiveAtMs: number;
  active: boolean;
}
interface Chain {
  opened: Set<string>;
  accounts: { root: { provider: string; sub: string }; members: Member[]; epoch: number }[];
}

function views(chain: Chain, scopeId: string, who: { provider: string; sub: string }): { identity: unknown; account: unknown } {
  const k = identityKeyHex(scopeId, who.provider, who.sub);
  const a = chain.accounts.find((x) => identityKeyHex(scopeId, x.root.provider, x.root.sub) === k || x.members.some((m) => identityKeyHex(scopeId, m.who.provider, m.who.sub) === k));
  const m = a?.members.find((x) => identityKeyHex(scopeId, x.who.provider, x.who.sub) === k);
  const identity = m
    ? { key: k, status: m.active ? 'member' : 'pending', opened: chain.opened.has(k), root: a!.root, effective_at_ms: m.effectiveAtMs, account_epoch: a!.epoch }
    : { key: k, status: 'own', opened: chain.opened.has(k), root: null, effective_at_ms: null, account_epoch: a?.epoch ?? 0 };
  const account = a ? { root: a.root, members: a.members.map((x) => ({ key: identityKeyHex(scopeId, x.who.provider, x.who.sub), provider: x.who.provider, effective_at_ms: x.effectiveAtMs, active: x.active, auto: true })), epoch: a.epoch, unlinked: [] } : null;
  return { identity, account };
}

/** A Google wallet (root G) with the email E waiting to join it, at `epoch`. */
const waiting = (epoch = 4): Chain => ({ opened: new Set([key(G)]), accounts: [{ root: G, members: [{ who: E, effectiveAtMs: T0 + 3_600_000, active: false }], epoch }] });

const scopeOf = (o: Partial<HomeScope> = {}): HomeScope => ({ scopeId: S, mine: true, coverage: 'shared', googleClientId: CLIENT_ID, supportId: null, addresses: [], apps: [{ appId: 'app_sodax1', name: 'Sodax', status: 'active', environment: 'live', origins: ['https://sodax.example'], logoUrl: null }], ...o });

interface Opts {
  who?: HomeSignInsWho | null;
  scope?: Partial<HomeScope>;
  /** No cancel deps at all (the section as before D902). */
  noCancel?: boolean;
  signingIn?: boolean;
  registry?: { allowShared?: boolean; shared?: string[]; fail?: boolean };
  gesture?: boolean;
}

interface H {
  section: HomeSignIns;
  chain: Chain;
  /** What the second provider sees when it differs. */
  chain2: Chain | null;
  win: FakeWindow;
  child: RemoteWindow | null;
  calls: { method: string; args: unknown }[];
  sent: { identity: HomeIdentity; body: HomeLinkCancelBody }[];
  /** What `linkCancel` does (resolves by default). */
  reply: () => Promise<{ nearTx: string | null }>;
  signedOut: number;
  identity: HomeIdentity;
  signer: TokenSigner;
  click(id: string): void;
  idle(): Promise<void>;
  mount(): void;
  show(): Promise<void>;
  /** The child's hello, answered: the parameters the page posted. */
  hello(): ReturnType<typeof parseParams>;
  /** Google's answer through the relay, for the nonce the page sent (claims override). */
  google(claims?: Record<string, unknown>, payload?: RelayPayload): Promise<void>;
  /** Presses Cancel this link, then Cancel the link, and waits for the parameters to be ready. */
  start(): Promise<void>;
}

const parseParams = (m: unknown) => parseWindowMessage(m, ['hana:home-cancel-params']);

const fakeIdentity = (): HomeIdentity =>
  ({ publicKey: new Uint8Array(32), salt: new Uint8Array(32), expiresAtMs: T0 + 900_000, nonce: 'n', usable: true, endsAtMs: T0 + 900_000, token: 't', attach() {}, header: async () => 'h', end() {} }) as HomeIdentity;

async function harness(o: Opts = {}): Promise<H> {
  const running = new Set<Promise<unknown>>();
  let relayResolve: ((v: RelayReadResponse) => void) | null = null;
  const signer = await tokenSigner();
  const win = new FakeWindow('/home', '');
  const h = { chain: waiting(), chain2: null, win, child: null, calls: [], sent: [], signedOut: 0, signer, identity: fakeIdentity(), reply: async () => ({ nearTx: 'tx1' }) } as unknown as H;
  const at = (second: boolean) => async (method: string, args: unknown): Promise<unknown> => {
    h.calls.push({ method: `${second ? 'second' : 'primary'}:${method}`, args });
    const a = args as Record<string, string>;
    const v = views(second && h.chain2 ? h.chain2 : h.chain, a.scope_id as string, { provider: a.provider as string, sub: a.sub as string });
    return method === 'get_identity' ? v.identity : v.account;
  };
  const near: NearReader = {
    getSession: () => Promise.reject(new Error('not used')),
    txOutcome: () => Promise.reject(new Error('not used')),
    view: async (_s, method, args) => {
      h.calls.push({ method, args });
      if (o.registry?.fail) throw new Error('rpc down');
      if (method === 'get_scope') return { id: S, allow_shared: o.registry?.allowShared ?? true, clients: [] };
      if (method === 'get_config') return { shared_clients: (o.registry?.shared ?? [CLIENT_ID]).map((c) => ['google', c]) };
      throw new Error(`unexpected view ${method}`);
    },
    independent: () => ({ primary: at(false), second: at(true) }),
  };
  const config: HomeConfig = { serverTimeMs: T0, signer: ENV.signer, sharedGoogleClientId: CLIENT_ID, exitGoogleClientId: null, emailSignIn: false };
  const clock = new ServerClock(() => T0);
  const who = o.who === undefined ? asGoogle : o.who;
  h.section = startHomeSignIns({
    win,
    d: dom(document),
    near,
    signer: ENV.signer,
    isGesture: () => o.gesture !== false,
    session: () => who,
    ended: () => false,
    track: (p) => {
      running.add(p);
      void p.finally(() => running.delete(p));
    },
    now: () => T0,
    ...(o.noCancel
      ? {}
      : {
          cancel: {
            authOrigin: ENV.authOrigin,
            api: {
              linkCancel: async (identity, body) => {
                h.sent.push({ identity, body: structuredClone(body) });
                return h.reply();
              },
            },
            relay: {
              readRelay: () =>
                new Promise<RelayReadResponse>((resolve) => {
                  relayResolve = resolve;
                }),
            },
            jwks: async (kid) => (kid === signer.jwk.kid ? signer.jwk : null),
            clock,
            sleep: async () => {},
            config: () => config,
            signingIn: () => o.signingIn === true,
            onSignedOut: () => void (h.signedOut += 1),
            session: () => (who?.provider === 'google' ? { identity: h.identity, sub: who.sub } : null),
          },
        }),
  });
  // As home-page.ts routes them: the page's messages go to the section.
  win.addEventListener('message', (e) => void h.section.onMessage(e as MessageEvent));
  h.click = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`No #${id} on the page: ${pageText()}`);
    (el as HTMLElement).click();
  };
  h.idle = async () => {
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setImmediate(r));
      if (running.size === 0) return;
    }
  };
  h.mount = () => document.getElementById('app')!.replaceChildren(h.section.appView(scopeOf(o.scope)));
  h.show = async () => {
    h.mount();
    h.click('home-sign-ins-show');
    await h.idle();
  };
  h.hello = () => {
    win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, h.child);
    return parseParams(h.child!.received.at(-1));
  };
  h.google = async (claims = {}, payload) => {
    const p = parseParams(h.child!.received.at(-1));
    if (!p) throw new Error('no parameters were posted');
    for (let i = 0; i < 100 && relayResolve === null; i++) await new Promise((r) => setImmediate(r));
    if (!relayResolve) throw new Error('no relay read');
    const body: RelayPayload = payload ?? { idToken: await signer.sign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: G.sub, nonce: p.nonce, iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600, ...claims }) };
    // The relay key the child got (a clone: the page zeroes its own copy of the message's).
    const value = await encryptRelayPayload(p.relayKey, p.relayId, body);
    const resolve = relayResolve as (v: RelayReadResponse) => void;
    relayResolve = null;
    resolve({ ...value, serverTimeMs: T0 });
    await h.idle();
  };
  h.start = async () => {
    await h.show();
    h.click('home-sign-in-cancel-open-1');
    h.child = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    win.openResult = h.child;
    h.click('home-sign-in-cancel-go');
    await h.idle();
  };
  return h;
}

const waitingRow = (): HTMLElement => document.querySelector('#home-sign-ins-list > li[data-role="waiting"], #home-sign-ins-list > li[data-role="cancelled"]') as HTMLElement;
const stageOf = (): string | null => document.querySelector('.home-sign-in-cancel')?.getAttribute('data-stage') ?? null;
const panelText = (): string => document.querySelector('.home-sign-in-cancel')?.textContent ?? '';

beforeEach(() => resetDom());
afterEach(() => vi.restoreAllMocks());

describe('which rows offer “Cancel this link” in Home', () => {
  it('a waiting email in a shared-client wallet, viewed by the wallet’s Google sign-in: the lead and a small outlined button that names whose link', async () => {
    const h = await harness();
    await h.show();
    const row = waitingRow();
    const b = document.getElementById('home-sign-in-cancel-open-1') as HTMLButtonElement;
    expect(b.textContent).toBe('Cancel this link');
    expect(b.getAttribute('aria-label')).toBe('Cancel this link for the email address');
    expect(b.className).toBe('jp-btn jp-btn-secondary jp-btn-sm home-sign-in-cancel-open');
    expect([...row.querySelectorAll('.home-sign-in-risk p')].map((p) => p.textContent)).toEqual(['Don’t recognise it? If you’re not sure, cancel it.', 'Cancel this link']);
    // No pointer elsewhere: no app link, no "sign in to this app", no "sign out of it first".
    expect(row.querySelector('a')).toBeNull();
    expect(row.textContent).not.toContain(SIGN_IN_TEXT.cancelAtSignIn);
    expect(document.getElementById('home-sign-ins-sign-out-first')).toBeNull();
    expect(document.getElementById('home-sign-ins-read-only')?.textContent).toContain(SIGN_IN_TEXT.readOnlyCancel);
    expect(document.getElementById('home-sign-ins-waiting-line')?.textContent).toBe('1 more starts opening it soon. Check it below.');
    // Nothing is read or opened by showing it.
    expect(h.win.opened).toEqual([]);
    expect(h.calls.filter((c) => !c.method.includes(':'))).toEqual([]);
  });

  it.each([
    ['an email sign-in views it (B+email isn’t built)', { who: asEmail } as Opts],
    ['the wallet isn’t on the shared client (its own client)', { scope: { coverage: 'hana_client', googleClientId: 'own.apps.googleusercontent.com' } } as Opts],
    ['the wallet’s route is the exit client', { scope: { coverage: 'exit', googleClientId: null } } as Opts],
    ['the page has no cancel at all', { noCancel: true } as Opts],
  ])('not when %s: option A’s link or the sentence, as before', async (_, o) => {
    const h = await harness(o);
    if (o.who === asEmail) h.chain = { opened: new Set([key(E)]), accounts: [{ root: E, members: [{ who: G2, effectiveAtMs: T0 + 3_600_000, active: false }], epoch: 1 }] };
    await h.show();
    expect(document.getElementById('home-sign-in-cancel-open-1')).toBeNull();
    const row = waitingRow();
    expect(row.querySelector('a.home-sign-in-open') ?? row.textContent?.includes(SIGN_IN_TEXT.cancelAtSignIn)).toBeTruthy();
    expect(document.getElementById('home-sign-ins-sign-out-first')).not.toBeNull();
    expect(document.getElementById('home-sign-ins-read-only')?.textContent).toContain(SIGN_IN_TEXT.readOnly);
  });

  it('not for the waiting sign-in itself (only its own pointer), nor for a sign-in nothing can cancel', async () => {
    const h = await harness({ who: { provider: 'google', sub: G2.sub, address: null } });
    h.chain = { opened: new Set([key(E)]), accounts: [{ root: E, members: [{ who: G2, effectiveAtMs: T0 + 3_600_000, active: false }], epoch: 1 }] };
    await h.show();
    expect(document.querySelector('.home-sign-in-cancel-open')).toBeNull();
    expect(pageText()).toContain(SIGN_IN_TEXT.cancelOwnNone);
  });
});

describe('the confirmation', () => {
  it('asks first in D898’s words; Go back changes nothing, opens nothing, sends nothing', async () => {
    const h = await harness();
    await h.show();
    h.click('home-sign-in-cancel-open-1');
    expect(stageOf()).toBe('confirm');
    expect(document.getElementById('home-sign-in-cancel-title')?.textContent).toBe('Cancel this link?');
    expect(panelText()).toContain('The email address will never open this wallet. You can’t undo this: it can only be added again, and then it waits again.');
    expect(panelText()).toContain('Sign in with Google to confirm it’s you');
    expect((document.getElementById('home-sign-in-cancel-go') as HTMLElement).textContent).toBe('Cancel the link');
    expect((document.getElementById('home-sign-in-cancel-go') as HTMLElement).className).toContain('jp-btn-danger');
    h.click('home-sign-in-cancel-back');
    expect(stageOf()).toBeNull();
    expect(document.getElementById('home-sign-in-cancel-open-1')).not.toBeNull();
    expect(h.win.opened).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('a click that isn’t the person’s (no user gesture) starts nothing', async () => {
    const h = await harness({ gesture: false });
    await h.show().catch(() => undefined);
    // "Show ways to sign in" itself is guarded too: nothing was read, so nothing is offered.
    expect(document.getElementById('home-sign-in-cancel-open-1')).toBeNull();
    expect(h.win.opened).toEqual([]);
  });
});

describe('the cancel', () => {
  it('the child in the click; the fresh read and the route on NEAR; the nonce over the fresh root, member and epoch; one request; Link cancelled; the line and the row change without a reload', async () => {
    const h = await harness();
    h.chain = waiting(4);
    await h.show();
    // The page's list was read at epoch 4; the account moved to epoch 5 since (another change): the fresh read wins.
    h.chain = waiting(5);
    h.calls.length = 0;
    h.click('home-sign-in-cancel-open-1');
    h.child = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    h.win.openResult = h.child;
    h.click('home-sign-in-cancel-go');
    expect(h.win.opened).toHaveLength(1);
    expect(h.win.opened[0]?.url).toBe(`${ENV.authOrigin}/login?mode=home`);
    expect(h.win.opened[0]?.target).toMatch(/^hana-home-cancel-[0-9a-f]{32}$/u);
    expect(stageOf()).toBe('signing_in');
    expect(document.getElementById('home-sign-in-cancel-title')?.textContent).toBe(HOME_CANCEL_SIGN_IN_TITLE);
    await h.idle();
    expect(h.calls.map((c) => c.method).sort()).toEqual(['get_config', 'get_scope', 'primary:get_account', 'primary:get_identity', 'second:get_account', 'second:get_identity']);
    // A hello from another origin or window is not answered.
    h.win.message({ v: 1, t: 'hana:auth-hello' }, 'https://evil.example', h.child);
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, remoteWindow());
    expect(h.child?.received).toEqual([]);
    const p = h.hello();
    if (!p) throw new Error('no parameters');
    expect([p.signer, p.clientId, p.scopeId, p.rootKey, p.memberKey, p.epoch]).toEqual([ENV.signer, CLIENT_ID, S, key(G), key(E), 5]);
    expect(p.nonce).toBe(linkChangeNonce(ENV.signer, S, 'cancel', fromHex(key(G)), fromHex(key(E)), 5, p.salt));
    expect(p.salt).toHaveLength(32);
    // Answered once.
    h.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, h.child);
    expect(h.child?.received).toHaveLength(1);
    await h.google();
    expect(h.child?.closed).toBe(true);
    expect(h.sent).toHaveLength(1);
    const sent = h.sent[0]!;
    expect(sent.identity).toBe(h.identity);
    expect(sent.body).toEqual({ jwt: expect.stringMatching(/^ey/u), memberKey: key(E), epoch: 5, salt: Array.from(p.salt), scopeId: S });
    expect(stageOf()).toBe('done');
    expect(document.getElementById('home-sign-in-cancel-title')?.textContent).toBe('Link cancelled');
    expect(document.getElementById('home-sign-in-cancel-what')?.textContent).toBe('The email address won’t open this wallet.');
    expect(panelText()).toContain(CANCEL_TEXT.devices);
    // The line and the row, at once: one sign-in opens it, none waits; the row shows only its name and the result.
    expect(document.getElementById('home-sign-ins-summary')?.textContent).toBe('1 sign-in opens this wallet.');
    expect(document.getElementById('home-sign-ins-waiting-line')).toBeNull();
    expect(waitingRow().getAttribute('data-role')).toBe('cancelled');
    expect(waitingRow().textContent).not.toContain('Waiting');
    h.click('home-sign-in-cancel-close');
    expect(document.querySelectorAll('#home-sign-ins-list > li')).toHaveLength(1);
    expect(document.getElementById('home-sign-ins-shared')).toBeNull();
    expect(document.getElementById('home-sign-ins-read-only')?.textContent).toContain(SIGN_IN_TEXT.readOnly);
    // Nothing more was sent, and nothing went to storage.
    expect(h.sent).toHaveLength(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('a Google answer for another account, another nonce, another client, or with too many details is never sent: Nothing changed', async () => {
    for (const [claims, line] of [
      [{ sub: G2.sub }, CANCEL_TEXT.notYouGoogle],
      [{ nonce: 'X'.repeat(43) }, CANCEL_TEXT.notYou],
      [{ aud: 'other.apps.googleusercontent.com' }, CANCEL_TEXT.notYou],
      [{ email: 'a@example.com' }, CANCEL_TEXT.notYou],
    ] as [Record<string, unknown>, string][]) {
      resetDom();
      const h = await harness();
      await h.start();
      h.hello();
      await h.google(claims);
      expect(stageOf(), JSON.stringify(claims)).toBe('nothing');
      expect(document.getElementById('home-sign-in-cancel-title')?.textContent).toBe('Nothing changed');
      expect(panelText()).toContain(CANCEL_TEXT.stillWaiting);
      expect(panelText()).toContain(line);
      expect(h.sent).toEqual([]);
      // Close: the row is as it was, still waiting, with its button.
      h.click('home-sign-in-cancel-close');
      expect(waitingRow().getAttribute('data-role')).toBe('waiting');
      expect(document.getElementById('home-sign-in-cancel-open-1')).not.toBeNull();
    }
  });

  it('Google’s screen cancelled, a child closed before it connected, a blocked window: Nothing changed, Google didn’t finish', async () => {
    const h = await harness();
    await h.start();
    h.hello();
    await h.google({}, { error: 'access_denied' });
    expect(stageOf()).toBe('nothing');
    expect(panelText()).toContain(CANCEL_TEXT.notChecked);
    expect(panelText()).toContain('Error code (for support): login_cancelled');
    expect(h.sent).toEqual([]);

    resetDom();
    const closed = await harness();
    await closed.start();
    closed.child!.closed = true;
    await vi.waitFor(() => expect(stageOf()).toBe('nothing'), { timeout: 3000 });
    expect(panelText()).toContain('Error code (for support): login_cancelled');
    expect(closed.child?.received).toEqual([]);

    resetDom();
    const blocked = await harness();
    await blocked.show();
    blocked.click('home-sign-in-cancel-open-1');
    blocked.win.openResult = null;
    blocked.click('home-sign-in-cancel-go');
    expect(stageOf()).toBe('nothing');
    expect(panelText()).toContain('Your browser blocked the sign-in window.');
    expect(blocked.sent).toEqual([]);
  });

  it('Go back while Google is open: the child closes, nothing is sent, the row is as it was', async () => {
    const h = await harness();
    await h.start();
    h.hello();
    h.click('home-sign-in-cancel-back');
    expect(h.child?.closed).toBe(true);
    expect(stageOf()).toBeNull();
    expect(document.getElementById('home-sign-in-cancel-open-1')).not.toBeNull();
    expect(h.sent).toEqual([]);
  });

  it.each([
    ['the link took effect meanwhile', (c: Chain) => ({ ...c, accounts: c.accounts.map((a) => ({ ...a, members: a.members.map((m) => ({ ...m, active: true })) })) }), 'sign_ins_changed'],
    ['the link was cancelled elsewhere', (c: Chain) => ({ ...c, accounts: c.accounts.map((a) => ({ ...a, members: [] })) }), 'sign_ins_changed'],
  ])('a fresh read before Google that differs (%s): the child closes with nothing posted; Nothing changed, the ways may have changed', async (_, change, code) => {
    const h = await harness();
    await h.show();
    h.chain = change(h.chain);
    h.click('home-sign-in-cancel-open-1');
    h.child = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    h.win.openResult = h.child;
    h.click('home-sign-in-cancel-go');
    await h.idle();
    expect(stageOf()).toBe('nothing');
    expect(panelText()).toContain(CANCEL_TEXT.changed);
    expect(panelText()).toContain(`Error code (for support): ${code}`);
    expect(h.child?.closed).toBe(true);
    expect(h.child?.received).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it.each([
    ['the providers disagree', { chain2: true } as const, {}, 'sign_ins_disputed'],
    ['shared login is off on NEAR', {}, { registry: { allowShared: false } }, 'not_covered'],
    ['the shared client isn’t in force on NEAR', {}, { registry: { shared: ['other'] } }, 'not_covered'],
    ['NEAR can’t be read', {}, { registry: { fail: true } }, 'near_unreadable'],
  ] as [string, { chain2?: true }, Opts, string][])('stops before Google when %s: Nothing changed, Journear couldn’t do it just now', async (_, how, o, code) => {
    const h = await harness(o);
    await h.show();
    if (how.chain2) h.chain2 = waiting(9);
    h.click('home-sign-in-cancel-open-1');
    h.child = remoteWindow({ location: { pathname: '/login', search: '?mode=home' } as never });
    h.win.openResult = h.child;
    h.click('home-sign-in-cancel-go');
    await h.idle();
    expect(stageOf()).toBe('nothing');
    expect(panelText()).toContain(CANCEL_TEXT.notNow);
    expect(panelText()).toContain(`Error code (for support): ${code}`);
    expect(h.child?.closed).toBe(true);
    expect(h.child?.received).toEqual([]);
  });

  it('Passport Home’s own sign-in window is open: nothing opens, Nothing changed with what to do', async () => {
    const h = await harness({ signingIn: true });
    await h.show();
    h.click('home-sign-in-cancel-open-1');
    h.click('home-sign-in-cancel-go');
    expect(h.win.opened).toEqual([]);
    expect(stageOf()).toBe('nothing');
    expect(panelText()).toContain('Finish signing in to Passport Home in the other window first');
  });

  it.each([
    ['link_refused (the chain’s rules)', new ApiError(422, 'link_refused', 'x', null, null, { reason: 'stale_epoch' }), 'nothing', CANCEL_TEXT.changed],
    ['the contract’s own refusal (reverted)', new ApiError(422, 'contract_rejected', 'x', 'tx', null, { reason: 'no_such_member' }), 'nothing', CANCEL_TEXT.changed],
    ['link_pending', new ApiError(409, 'link_pending', 'x', null, null), 'nothing', CANCEL_TEXT.changed],
    ['the same account check', new ApiError(403, 'home_account_mismatch', 'x', null, null), 'nothing', CANCEL_TEXT.notYou],
    ['a limit', new ApiError(429, 'rate_limited', 'x', null, null), 'nothing', CANCEL_TEXT.notNow],
    ['paused', new ApiError(503, 'paused', 'x', null, null), 'nothing', CANCEL_TEXT.notNow],
    ['a relay that never ran', new ApiError(503, 'relayer_unconfigured', 'x', null, null), 'nothing', CANCEL_TEXT.notNow],
    ['a relay that timed out', new ApiError(504, 'timeout', 'x', 'tx', null), 'unknown', CANCEL_TEXT.unknown],
    ['an unknown contract refusal', new ApiError(400, 'contract_rejected', 'x', 'tx', null), 'unknown', CANCEL_TEXT.unknown],
    ['a request already in flight', new ApiError(409, 'link_in_flight', 'x', null, null), 'unknown', CANCEL_TEXT.unknown],
    ['an answer the page can’t read', new ApiError(502, 'bad_response', 'x', null, null), 'unknown', CANCEL_TEXT.unknown],
    ['no answer at all', new TypeError('Failed to fetch'), 'unknown', CANCEL_TEXT.unknown],
  ] as [string, unknown, string, string][])('the API’s answer %s picks its screen', async (_, err, stage, line) => {
    const h = await harness();
    h.reply = () => Promise.reject(err);
    await h.start();
    h.hello();
    await h.google();
    expect(h.sent).toHaveLength(1);
    expect(stageOf()).toBe(stage);
    expect(panelText()).toContain(line);
    // The row is never dropped when nothing certainly changed.
    expect(waitingRow().getAttribute('data-role')).toBe('waiting');
    expect(document.getElementById('home-sign-ins-waiting-line')).not.toBeNull();
  });

  it('It may not have been cancelled: Show again reads the list on both providers', async () => {
    const h = await harness();
    h.reply = () => Promise.reject(new ApiError(504, 'timeout', 'x', 'tx', null));
    await h.start();
    h.hello();
    await h.google();
    expect(document.getElementById('home-sign-in-cancel-title')?.textContent).toBe('It may not have been cancelled');
    // It was cancelled after all.
    h.chain = { ...h.chain, accounts: h.chain.accounts.map((a) => ({ ...a, members: [] })) };
    h.calls.length = 0;
    h.click('home-sign-in-cancel-again');
    await h.idle();
    expect(h.calls.map((c) => c.method).sort()).toEqual(['primary:get_account', 'primary:get_identity', 'second:get_account', 'second:get_identity']);
    expect(document.querySelectorAll('#home-sign-ins-list > li')).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('Home’s sign-in ended (a 401): Nothing changed, and Home is told so it asks for a new sign-in', async () => {
    const h = await harness();
    h.reply = () => Promise.reject(new ApiError(401, 'home_identity_expired', 'x', null, null));
    await h.start();
    h.hello();
    await h.google();
    expect(stageOf()).toBe('nothing');
    expect(h.signedOut).toBe(1);
    expect(panelText()).toContain('Your sign-in to Passport Home has ended.');
  });

  it('Home signed in again meanwhile (another identity): nothing is sent with the old one', async () => {
    const h = await harness();
    await h.start();
    h.hello();
    h.identity = fakeIdentity();
    await h.google();
    expect(h.sent).toEqual([]);
    expect(stageOf()).toBe('nothing');
  });

  it('leaving the app’s page while Google is open closes the child and sends nothing; signing out drops everything', async () => {
    const h = await harness();
    await h.start();
    h.hello();
    h.section.leaveApp();
    expect(h.child?.closed).toBe(true);
    expect(h.section.cancelStage).toBeNull();
    await h.google().catch(() => undefined);
    expect(h.sent).toEqual([]);

    resetDom();
    const out = await harness();
    await out.start();
    out.section.reset();
    expect(out.child?.closed).toBe(true);
    expect(out.section.cancelStage).toBeNull();
  });
});

describe('the words', () => {
  it('are D898’s for option B, and plain (D853)', () => {
    expect(CANCEL_TEXT.button).toBe('Cancel this link');
    expect(cancelButtonName('google')).toBe('Cancel this link for the Google account');
    expect(cancelConfirmText('google')).toBe('The Google account will never open this wallet. You can’t undo this: it can only be added again, and then it waits again.');
    expect(cancelDoneText('email')).toBe('The email address won’t open this wallet.');
    expect([CANCEL_TEXT.confirmTitle, CANCEL_TEXT.confirmGo, CANCEL_TEXT.back, CANCEL_TEXT.signInTitle, CANCEL_TEXT.doneTitle, CANCEL_TEXT.nothingTitle, CANCEL_TEXT.unknownTitle, CANCEL_TEXT.showAgain, CANCEL_TEXT.close]).toEqual([
      'Cancel this link?',
      'Cancel the link',
      'Go back',
      'Sign in with Google to confirm it’s you',
      'Link cancelled',
      'Nothing changed',
      'It may not have been cancelled',
      'Show again',
      'Close',
    ]);
    expect(HOME_CANCEL_SIGN_IN_TITLE).toBe(CANCEL_TEXT.signInTitle);
    const all = [...Object.values(CANCEL_TEXT), cancelConfirmText('email'), cancelDoneText('google'), SIGN_IN_TEXT.readOnlyCancel, ...(['you', 'changed', 'now', 'check', 'signed_out'] as const).flatMap((g) => nothingLines(g, 'x'))];
    for (const s of all) expect(jargonIn(s), s).toEqual([]);
  });

  it('cancelOutcome is unknown unless the code says nothing was sent or it was reverted', () => {
    expect(cancelOutcome(new Error('x'))).toEqual({ kind: 'unknown', code: 'api_unavailable' });
    expect(cancelOutcome(new ApiError(500, 'internal', 'x', null, null))).toEqual({ kind: 'unknown', code: 'internal' });
    expect(cancelOutcome(new ApiError(422, 'Bad Code', 'x', null, null))).toEqual({ kind: 'unknown', code: 'error' });
    expect(cancelOutcome(new ApiError(401, 'anything', 'x', null, null))).toEqual({ kind: 'nothing', group: 'signed_out', code: 'anything' });
    expect(cancelOutcome(new ApiError(422, 'contract_rejected', 'x', 'tx', null, { reason: 'stale_epoch' }))).toEqual({ kind: 'nothing', group: 'changed', code: 'contract_rejected' });
    expect(cancelOutcome(new ApiError(403, 'not_shared_client', 'x', null, null))).toEqual({ kind: 'nothing', group: 'you', code: 'not_shared_client' });
  });
});
