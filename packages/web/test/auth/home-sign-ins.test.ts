// @vitest-environment happy-dom
// Passport Home's "Ways to sign in" (home-sign-ins.ts, D874): the list read from the chain only when asked, kept for
// the sign-in, every state (one sign-in, several, waiting and started links, how each was added, a failed or slow
// read, an answer about someone else), the contract's own rules for who may cancel or remove whom (derived from
// contracts/hana-signer/src/tests/email.rs "Cancel and unlink"), the last sign-in's guard, and the words.
import { RECENT_LINK_MS, identityKeyHex } from '@hana-id/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jargonIn } from '@hana-id/brand/plain-words';
import { dom } from '../../src/auth/dom.ts';
import type { HomeScope } from '../../src/auth/home-api.ts';
import {
  HOME_SIGN_INS_TITLE,
  type HomeSignIns,
  type HomeSignInsWho,
  SIGN_INS_READ_LIMIT_MS,
  SIGN_IN_MAX_MS,
  SIGN_IN_TEXT,
  type SignInRow,
  type SignInViewer,
  mayCancel,
  mayRemove,
  pointerFor,
  pointerSignsIn,
  pointerText,
  rowFacts,
  signInDate,
  signInModel,
  cancelTarget,
  isPlainHttpsOrigin,
  signInSummary,
  startHomeSignIns,
} from '../../src/auth/home-sign-ins.ts';
import type { NearReader } from '../../src/auth/near-rpc.ts';
import { ENV, FakeWindow, pageText, resetDom } from './helpers.ts';

const T0 = 1_800_000_000_000;
const DAY = 24 * 3_600_000;
const S = 'scope1';
const G = { provider: 'google', sub: '104857600000000000001' };
const G2 = { provider: 'google', sub: '104857600000000000002' };
const E = { provider: 'email', sub: `e1.${'A'.repeat(43)}` };
const E2 = { provider: 'email', sub: `e1.${'B'.repeat(43)}` };
/** A third kind (the contract takes any provider an issuer is set up for; Apple is on the roadmap, D124). */
const P = { provider: 'apple', sub: 'p1' };
const ADDRESS = 'pat@mail.example';
const key = (i: { provider: string; sub: string }): string => identityKeyHex(S, i.provider, i.sub);

interface Member {
  who: { provider: string; sub: string };
  effectiveAtMs: number;
  active: boolean;
  auto: boolean;
}
interface Chain {
  opened: Set<string>;
  accounts: { root: { provider: string; sub: string }; members: Member[]; epoch: number }[];
}

/** `get_identity` and `get_account` as links.rs answers them (views count a member past its time as active). */
function views(chain: Chain, scopeId: string, who: { provider: string; sub: string }): { identity: unknown; account: unknown } {
  const k = identityKeyHex(scopeId, who.provider, who.sub);
  const a = chain.accounts.find((x) => key(x.root) === k || x.members.some((m) => key(m.who) === k));
  const m = a?.members.find((x) => key(x.who) === k);
  const identity = m
    ? { key: k, status: m.active ? 'member' : 'pending', opened: chain.opened.has(k), root: a!.root, effective_at_ms: m.effectiveAtMs, account_epoch: a!.epoch }
    : { key: k, status: 'own', opened: chain.opened.has(k), root: null, effective_at_ms: null, account_epoch: a?.epoch ?? 0 };
  const account = a ? { root: a.root, members: a.members.map((x) => ({ key: key(x.who), provider: x.who.provider, effective_at_ms: x.effectiveAtMs, active: x.active, auto: x.auto })), epoch: a.epoch, unlinked: [] } : null;
  return { identity, account };
}

const homeScope = (scopeId = S): HomeScope => ({ scopeId, mine: true, coverage: 'shared', googleClientId: null, supportId: null, addresses: [], apps: [{ appId: 'app_sodax1', name: 'Sodax', status: 'active', environment: 'live', origins: [], logoUrl: null }], appsTotal: 1 });

type Which = 'primary' | 'second';
interface Harness {
  section: HomeSignIns;
  chain: Chain;
  /** What the second provider sees, when it differs (a lying or stale one). */
  chain2: Chain | null;
  /** The env has no second provider. */
  noSecond: boolean;
  who: HomeSignInsWho | null;
  ended: boolean;
  now: number;
  calls: { which: Which; method: string; args: unknown }[];
  /** Replaces a provider's answer (a failing or slow provider). */
  view: ((method: string, args: Record<string, string>, which: Which) => Promise<unknown>) | null;
  /** Ends the read's time limit. */
  late: () => void;
  click(id: string): void;
  idle(): Promise<void>;
  mount(scopeId?: string): void;
}

function start(chain: Chain, who: HomeSignInsWho | null, o: { gesture?: boolean } = {}): Harness {
  const running = new Set<Promise<unknown>>();
  let lateResolve: (() => void)[] = [];
  const h = { chain, chain2: null, noSecond: false, who, ended: false, now: T0, calls: [], view: null } as unknown as Harness;
  const at =
    (which: Which) =>
    async (method: string, args: unknown): Promise<unknown> => {
      h.calls.push({ which, method, args });
      const a = args as Record<string, string>;
      if (h.view) return h.view(method, a, which);
      const v = views(which === 'second' && h.chain2 ? h.chain2 : h.chain, a.scope_id as string, { provider: a.provider as string, sub: a.sub as string });
      return method === 'get_identity' ? v.identity : v.account;
    };
  const near: NearReader = {
    getSession: () => Promise.reject(new Error('not used')),
    txOutcome: () => Promise.reject(new Error('not used')),
    // One provider's word (with its fallback) is never enough for this list (D874 as amended): only `independent`.
    view: () => Promise.reject(new Error('the list must be read on both providers alone')),
    independent: (signer) => {
      expect(signer).toBe(ENV.signer);
      return h.noSecond ? null : { primary: at('primary'), second: at('second') };
    },
  };
  h.section = startHomeSignIns({
    win: new FakeWindow('/home', ''),
    d: dom(document),
    near,
    signer: ENV.signer,
    isGesture: () => o.gesture !== false,
    session: () => h.who,
    ended: () => h.ended,
    track: (p) => {
      running.add(p);
      void p.finally(() => running.delete(p));
    },
    now: () => h.now,
    sleep: () =>
      new Promise<void>((r) => {
        lateResolve.push(r);
      }),
  });
  h.late = () => {
    for (const r of lateResolve) r();
    lateResolve = [];
  };
  h.click = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`No #${id} on the page: ${pageText()}`);
    (el as HTMLElement).click();
  };
  h.idle = async () => {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      if (running.size === 0) return;
    }
    throw new Error('still running');
  };
  h.mount = (scopeId = S) => document.getElementById('app')!.replaceChildren(h.section.appView(homeScope(scopeId)));
  return h;
}

async function shown(h: Harness): Promise<void> {
  h.mount();
  h.click('home-sign-ins-show');
  await h.idle();
}

const rows = (): { kind: string; role: string; you: boolean; text: string }[] =>
  [...document.querySelectorAll('#home-sign-ins-list > li')].map((li) => ({ kind: li.getAttribute('data-kind') ?? '', role: li.getAttribute('data-role') ?? '', you: li.getAttribute('data-you') === 'true', text: li.textContent ?? '' }));
const buttons = (): string[] => [...document.querySelectorAll('#home-sign-ins button')].map((b) => b.textContent ?? '');

const emailOnly = (): Chain => ({ opened: new Set([key(E)]), accounts: [] });
/** A Google wallet with an email that joined it at a sign-in (active since `since`), or is waiting until `since`. */
const googleWithEmail = (since: number, active: boolean, auto = true): Chain => ({ opened: new Set([key(G)]), accounts: [{ root: G, members: [{ who: E, effectiveAtMs: since, active, auto }], epoch: 1 }] });
const asEmail: HomeSignInsWho = { provider: 'email', sub: E.sub, address: ADDRESS };
const asGoogle: HomeSignInsWho = { provider: 'google', sub: G.sub, address: null };

beforeEach(() => resetDom());
afterEach(() => vi.restoreAllMocks());

describe('reading', () => {
  it('reads nothing until the user asks, then get_identity and get_account of this sign-in in this app, side by side', async () => {
    const h = start(emailOnly(), asEmail);
    h.mount();
    await h.idle();
    expect(h.calls).toEqual([]);
    expect(h.section.state).toBe('closed');
    expect(buttons()).toEqual([SIGN_IN_TEXT.show]);
    h.click('home-sign-ins-show');
    expect(document.getElementById('home-sign-ins')?.textContent).toContain(SIGN_IN_TEXT.loading);
    await h.idle();
    const args = { scope_id: S, provider: 'email', sub: E.sub };
    expect(h.calls).toEqual([
      { which: 'primary', method: 'get_identity', args },
      { which: 'primary', method: 'get_account', args },
      { which: 'second', method: 'get_identity', args },
      { which: 'second', method: 'get_account', args },
    ]);
    expect(h.section.state).toBe('ready');
    expect(h.section.reads).toBe(1);
  });

  it('keeps the answer for this sign-in: back on the app later, no read; Show again reads once more; another account starts over', async () => {
    const h = start(emailOnly(), asEmail);
    await shown(h);
    h.section.leaveApp();
    h.mount('other');
    expect(h.section.state).toBe('closed');
    h.section.leaveApp();
    h.mount();
    expect(h.section.state).toBe('ready');
    expect(h.calls).toHaveLength(4);
    h.click('home-sign-ins-again');
    await h.idle();
    expect(h.calls).toHaveLength(8);
    h.section.reset();
    h.mount();
    expect(h.section.state).toBe('closed');
  });

  it('acts only on a real click', async () => {
    const h = start(emailOnly(), asEmail, { gesture: false });
    h.mount();
    h.click('home-sign-ins-show');
    await h.idle();
    expect(h.calls).toEqual([]);
  });

  it('reads nothing once the Home sign-in has ended, and says to sign in again', async () => {
    const h = start(emailOnly(), null);
    h.mount();
    h.click('home-sign-ins-show');
    await h.idle();
    expect(h.calls).toEqual([]);
    expect(h.section.errorCode).toBe('home_signed_out');
    expect(document.getElementById('home-sign-ins-problem')?.textContent).toContain('Sign in to Passport Home again');
  });

  it('a failing read says so plainly, with Try again, and nothing else; Try again reads again', async () => {
    const h = start(emailOnly(), asEmail);
    h.view = () => Promise.reject(new Error('NEAR RPC: get_identity failed'));
    await shown(h);
    expect(h.section.state).toBe('failed');
    expect(h.section.errorCode).toBe('sign_ins_unreadable');
    const problem = document.getElementById('home-sign-ins-problem');
    expect(problem?.getAttribute('role')).toBe('alert');
    expect(problem?.textContent).toContain(SIGN_IN_TEXT.failed);
    expect(problem?.textContent).toContain('Error code (for support): sign_ins_unreadable');
    expect(problem?.textContent).not.toMatch(/NEAR|RPC|get_identity/u);
    expect(rows()).toEqual([]);
    expect(buttons()).toEqual([SIGN_IN_TEXT.retry]);
    h.view = null;
    h.click('home-sign-ins-retry');
    await h.idle();
    expect(h.section.state).toBe('ready');
    expect(rows()).toHaveLength(1);
  });

  it('a read that takes longer than its limit reads as failed (and a late answer changes nothing)', async () => {
    const h = start(emailOnly(), asEmail);
    let answer: ((v: unknown) => void) | null = null;
    h.view = () => new Promise((r) => (answer = r));
    h.mount();
    h.click('home-sign-ins-show');
    await new Promise((r) => setImmediate(r));
    expect(h.section.state).toBe('loading');
    h.late();
    await h.idle();
    expect(h.section.state).toBe('failed');
    (answer as unknown as (v: unknown) => void)?.({});
    await h.idle();
    expect(h.section.state).toBe('failed');
    expect(SIGN_INS_READ_LIMIT_MS).toBe(20_000);
  });

  it('an answer about another identity, or an account without this sign-in in it, reads as failed, never as a list', async () => {
    for (const bad of [
      (m: string, a: Record<string, string>) => (m === 'get_identity' ? views(emailOnly(), S, E2).identity : null),
      (m: string) => (m === 'get_identity' ? views(googleWithEmail(T0, true), S, E).identity : views(googleWithEmail(T0, true), S, G2).account),
      // The identity says it waits; the account says it already opens the wallet.
      (m: string) => (m === 'get_identity' ? views(googleWithEmail(T0, false), S, E).identity : views(googleWithEmail(T0, true), S, E).account),
      // Own, but the account's root is someone else.
      (m: string) => (m === 'get_identity' ? views(emailOnly(), S, E).identity : views(googleWithEmail(T0, true), S, G).account),
      (m: string) => (m === 'get_identity' ? { key: 'nope' } : null),
    ]) {
      resetDom();
      const h = start(emailOnly(), asEmail);
      h.view = async (m, a) => bad(m, a);
      await shown(h);
      expect(h.section.errorCode).toBe('sign_ins_disputed');
      expect(rows()).toEqual([]);
      // Only the second provider's answer is wrong: still no list.
      h.view = async (m, a, w) => (w === 'second' ? bad(m, a) : views(emailOnly(), S, E)[m === 'get_identity' ? 'identity' : 'account']);
      h.click('home-sign-ins-retry');
      await h.idle();
      expect(h.section.state).toBe('failed');
      expect(h.section.errorCode).toBe('sign_ins_disputed');
      expect(rows()).toEqual([]);
    }
  });
});

describe('what it shows', () => {
  it('an email-only wallet: one sign-in, the address in full, signed in now, can’t be removed, nothing to press but Show again', async () => {
    const h = start(emailOnly(), asEmail);
    await shown(h);
    expect(rows()).toEqual([{ kind: 'email', role: 'first', you: true, text: expect.stringContaining(ADDRESS) as unknown as string }]);
    const text = rows()[0]!.text;
    expect(text).toContain(SIGN_IN_TEXT.youBadge);
    expect(text).toContain(SIGN_IN_TEXT.first);
    expect(buttons()).toEqual([SIGN_IN_TEXT.again]);
    expect(document.getElementById('home-sign-ins-shared')).toBeNull();
    expect(document.getElementById('home-sign-ins-read-only')?.textContent).toBe(`${SIGN_IN_TEXT.readOnly} `);
  });

  it('no wallet yet in this app: says so, lists nothing', async () => {
    const h = start({ opened: new Set(), accounts: [] }, asEmail);
    await shown(h);
    expect(document.getElementById('home-sign-ins-none')?.textContent).toBe(SIGN_IN_TEXT.noWallet);
    expect(rows()).toEqual([]);
  });

  it('several: the Google wallet’s own sign-in and an email added to it; the other is named by its kind only, with its date', async () => {
    const since = T0 - 2 * DAY;
    const h = start(googleWithEmail(since, true), asGoogle);
    await shown(h);
    expect(rows().map((r) => [r.kind, r.role, r.you])).toEqual([
      ['google', 'first', true],
      ['email', 'member', false],
    ]);
    expect(rows()[0]!.text).toContain(SIGN_IN_TEXT.yourGoogle);
    expect(rows()[1]!.text).toContain(SIGN_IN_TEXT.otherEmail);
    expect(rows()[1]!.text).toContain('Opens this wallet since');
    expect(rows()[1]!.text).toContain(SIGN_IN_TEXT.autoEmail);
    expect(document.getElementById('home-sign-ins-shared')?.textContent).toBe(SIGN_IN_TEXT.shared);
    expect(document.getElementById('home-sign-ins-read-only')?.textContent).toContain(SIGN_IN_TEXT.privacy);
    // Never a sub, a key or an address of another sign-in.
    const all = document.getElementById('home-sign-ins')?.textContent ?? '';
    for (const secret of [E.sub, G.sub, key(E), key(G)]) expect(all).not.toContain(secret);
  });

  it('a waiting link: the badge, when it starts, and where to cancel it (an amber box), to the wallet’s own sign-in', async () => {
    const h = start(googleWithEmail(T0 + DAY, false), asGoogle);
    await shown(h);
    const waiting = document.querySelector('#home-sign-ins-list > li[data-role="waiting"]');
    expect(waiting?.textContent).toContain(SIGN_IN_TEXT.waitingBadge);
    expect(waiting?.textContent).toContain('Starts opening this wallet on');
    expect(waiting?.querySelector('.home-sign-in-risk.jp-alert-warning')?.textContent).toContain(SIGN_IN_TEXT.cancelAtSignIn);
    expect(buttons()).toEqual([SIGN_IN_TEXT.again]);
    // D897: the section's line, once read, says how many open the wallet and how many wait.
    const line = document.getElementById('home-sign-ins-summary');
    expect(line?.textContent).toBe('1 sign-in opens this wallet. 1 more starts opening it soon. Check it below.');
    // The waiting part in the warning style of its card.
    expect(line?.querySelector('.home-set-attn .ic')).not.toBeNull();
    expect(line?.querySelector('.home-set-attn')?.textContent).toBe('1 more starts opening it soon. Check it below.');
    expect(line?.hasAttribute('data-read')).toBe(true);
  });

  it('the waiting email itself, signed in: its own address, and where it can cancel the link (D864)', async () => {
    const h = start(googleWithEmail(T0 + DAY, false), asEmail);
    await shown(h);
    expect(rows().map((r) => [r.kind, r.role, r.you])).toEqual([
      ['email', 'waiting', true],
      ['google', 'first', false],
    ]);
    expect(rows()[0]!.text).toContain(ADDRESS);
    expect(rows()[0]!.text).toContain(SIGN_IN_TEXT.cancelOwnEmail);
    expect(rows()[1]!.text).toContain(SIGN_IN_TEXT.otherGoogle);
  });

  it('an added email, signed in: where it can remove itself (D865), what happens then, and the money advice', async () => {
    const h = start(googleWithEmail(T0 - 30 * DAY, true), asEmail);
    await shown(h);
    const me = rows()[0]!;
    expect([me.kind, me.role, me.you]).toEqual(['email', 'member', true]);
    expect(me.text).toContain('choose “Remove this email” when asked. After that, it no longer opens this wallet, and signing in with it opens a new, empty wallet.');
    expect(me.text).toContain(SIGN_IN_TEXT.removeOwnMoney);
    expect(me.text).toContain(SIGN_IN_TEXT.removeOwnNotAsked);
  });

  it('the automatic Gmail link: a Google account added automatically to an email wallet says how it usually happens', async () => {
    const chain: Chain = { opened: new Set([key(E)]), accounts: [{ root: E, members: [{ who: G, effectiveAtMs: T0 - DAY, active: true, auto: true }], epoch: 1 }] };
    const h = start(chain, asEmail);
    await shown(h);
    expect(rows()[1]!.text).toContain(SIGN_IN_TEXT.autoGoogle);
    // The email wallet's own sign-in may remove it: in the banner's 7 days, with no deadline named (D875).
    expect(rows()[1]!.text).toContain('Don’t recognise it? Sign in to this app the way you signed in here, and choose “Remove it”. If you’re not sure, remove it.');
    expect(rows()[1]!.text).not.toContain('before');
  });

  it('a link made by hand says so', () => {
    expect(rowFacts({ key: 'k', kind: 'email', role: 'member', you: false, sinceMs: T0, auto: false })).toContain(SIGN_IN_TEXT.byHand);
  });

  it('D875: after the banner’s 7 days the wallet’s own sign-in is told where Remove still is (plain, no amber), and what to do if it isn’t offered', async () => {
    for (const age of [8 * DAY, 365 * DAY]) {
      resetDom();
      const h = start(googleWithEmail(T0 - age, true), asGoogle);
      await shown(h);
      const other = document.querySelector('#home-sign-ins-list > li[data-role="member"]')!;
      expect(other.querySelector('.home-sign-in-risk'), `${age}`).toBeNull();
      const how = [...other.querySelectorAll('.home-sign-in-how p')].map((p) => p.textContent);
      expect(how, `${age}`).toEqual([
        'Don’t recognise it? Sign in to this app the way you signed in here, and choose “Remove it”. If you’re not sure, remove it.',
        'Once you press “Done” in the sign-in window, that browser stops offering to remove it. Not offered? Try signing in in a private window.',
      ]);
      expect(other.textContent).not.toContain('Nothing can remove it');
      expect(other.textContent).not.toContain('before');
      // It sends the user to sign in, so the section says once to sign out of the app first.
      expect(document.getElementById('home-sign-ins-sign-out-first')?.textContent).toBe(SIGN_IN_TEXT.signOutFirst);
    }
  });

  it('D875: an older automatic same-address Google link doesn’t push its removal (D865’s softer words); a hand-made one does', async () => {
    const auto: Chain = { opened: new Set([key(E)]), accounts: [{ root: E, members: [{ who: G, effectiveAtMs: T0 - 30 * DAY, active: true, auto: true }], epoch: 1 }] };
    const h = start(auto, asEmail);
    await shown(h);
    const how = () => [...document.querySelectorAll('#home-sign-ins-list > li[data-role="member"] .home-sign-in-how p')].map((p) => p.textContent);
    expect(how()).toEqual([
      'Don’t recognise this Google account? Sign in to this app the way you signed in here, and choose “Remove it”.',
      'Once you press “Done” in the sign-in window, that browser stops offering to remove it. Not offered? Try signing in in a private window.',
    ]);
    expect(how().join(' ')).not.toContain('If you’re not sure, remove it.');
    resetDom();
    const byHand: Chain = { opened: new Set([key(E)]), accounts: [{ root: E, members: [{ who: G, effectiveAtMs: T0 - 30 * DAY, active: true, auto: false }], epoch: 1 }] };
    await shown(start(byHand, asEmail));
    expect(how()[0]).toBe(SIGN_IN_TEXT.removeAtSignIn);
    // An email added at a sign-in (always a code and "Link and continue": chosen, D865) keeps the firmer words.
    resetDom();
    await shown(start(googleWithEmail(T0 - 30 * DAY, true), asGoogle));
    expect(how()[0]).toBe(SIGN_IN_TEXT.removeAtSignIn);
  });

  it('the notice mail names this section as Home shows it (apps/email-issuer mail.ts)', () => {
    const mail = readFileSync(resolve(process.cwd(), '../../apps/email-issuer/src/mail.ts'), 'utf8');
    expect(mail).toContain(`“${HOME_SIGN_INS_TITLE}” in \${BRAND.home}`);
  });

  it('the signed-in address is text only, and masked once the sign-in ends', async () => {
    const odd = '<img src=x onerror="__pwned=1">@mail.example';
    const h = start(emailOnly(), { ...asEmail, address: odd });
    await shown(h);
    expect(document.querySelector('#home-sign-ins img')).toBeNull();
    expect(rows()[0]!.text).toContain(odd);
    h.ended = true;
    h.section.sessionEnded();
    expect(rows()[0]!.text).not.toContain(odd);
    expect(rows()[0]!.text).toContain('<•••@mail.example');
  });
});

// ---- the contract's rules ----

const viewer = (role: SignInViewer['role'], k = 'v', kind: SignInViewer['kind'] = 'google'): SignInViewer => ({ key: k, role, kind });
const row = (role: SignInRow['role'], k: string, o: Partial<SignInRow> = {}): SignInRow => ({ key: k, kind: 'email', role, you: false, sinceMs: T0, auto: true, ...o });

describe('who may cancel or remove whom (links.rs; tests/email.rs “Cancel and unlink”)', () => {
  it('cancel_link: the root and the waiting identity itself; an active member too; never an outsider or another waiting one; never once started', () => {
    // cancel_link_by_the_root_or_the_pending_identity
    expect(mayCancel(viewer('first', 'g'), row('waiting', 'e'))).toBe(true);
    expect(mayCancel(viewer('waiting', 'e'), row('waiting', 'e'))).toBe(true);
    // links.rs assert_active_in: any active identity of the account
    expect(mayCancel(viewer('member', 'p'), row('waiting', 'e'))).toBe(true);
    // cancel_link_refusals: another pending member can't cancel; once active it is an unlink, not a cancel
    expect(mayCancel(viewer('waiting', 'p'), row('waiting', 'e'))).toBe(false);
    expect(mayCancel(viewer('first', 'g'), row('member', 'e'))).toBe(false);
    expect(mayCancel(viewer('first', 'g'), row('first', 'g'))).toBe(false);
  });

  it('unlink_identity: the root and the member itself; never another member (even waiting), never the root, never a waiting one', () => {
    // unlink_by_the_root_or_the_member_and_never_automatic_again
    expect(mayRemove(viewer('first', 'g'), row('member', 'e'))).toBe(true);
    expect(mayRemove(viewer('member', 'e'), row('member', 'e'))).toBe(true);
    // unlink_refusals
    expect(mayRemove(viewer('waiting', 'p'), row('member', 'e'))).toBe(false);
    expect(mayRemove(viewer('member', 'p'), row('member', 'e'))).toBe(false);
    expect(mayRemove(viewer('first', 'g'), row('first', 'g'))).toBe(false);
    expect(mayRemove(viewer('first', 'g'), row('waiting', 'p'))).toBe(false);
  });

  it('a line never points to a change the contract would refuse, and the wallet’s own sign-in never gets one (the last way in stays)', () => {
    const roles: SignInRow['role'][] = ['first', 'member', 'waiting'];
    for (const vr of roles) {
      for (const rr of roles) {
        for (const same of [true, false]) {
          if (same && vr !== rr) continue;
          for (const kind of ['email', 'google'] as const) {
            for (const sinceMs of [T0 - 8 * DAY, T0 - DAY, T0 + DAY]) {
              const v = viewer(vr, 'v', kind);
              const r = row(rr, same ? 'v' : 'r', { kind, you: same, sinceMs });
              const p = pointerFor(v, r, T0);
              const acts = p !== null && p.kind !== 'not_yours';
              if (rr === 'first') expect(p).toBeNull();
              if (acts) expect(p!.kind.startsWith('cancel') ? mayCancel(v, r) : mayRemove(v, r)).toBe(true);
              if (rr === 'waiting' && mayCancel(v, r)) expect(p?.kind.startsWith('cancel')).toBe(true);
              if (rr === 'member' && mayRemove(v, r)) expect(['remove_own', 'remove_at_sign_in', 'remove_at_sign_in_once']).toContain(p?.kind);
            }
          }
        }
      }
    }
  });

  it('where each allowed change can be made today', () => {
    expect(pointerFor(viewer('waiting', 'e', 'email'), row('waiting', 'e', { kind: 'email', you: true }), T0)).toEqual({ kind: 'cancel_own_email' });
    expect(pointerFor(viewer('waiting', 'g', 'google'), row('waiting', 'g', { kind: 'google', you: true }), T0)).toEqual({ kind: 'cancel_own_none' });
    expect(pointerFor(viewer('first', 'g'), row('waiting', 'e'), T0)).toEqual({ kind: 'cancel_at_sign_in' });
    expect(pointerFor(viewer('member', 'e', 'email'), row('member', 'e', { you: true }), T0)).toEqual({ kind: 'remove_own' });
    expect(pointerFor(viewer('first', 'g'), row('member', 'e', { sinceMs: T0 - DAY }), T0)).toEqual({ kind: 'remove_at_sign_in' });
    // D875: past the 7 days (the sign-in window's own boundary, core relay.ts), still a place to remove it, at any age.
    expect(pointerFor(viewer('first', 'g'), row('member', 'e', { sinceMs: T0 - RECENT_LINK_MS + 1 }), T0)).toMatchObject({ kind: 'remove_at_sign_in' });
    for (const age of [RECENT_LINK_MS, 8 * DAY, 365 * DAY, T0]) expect(pointerFor(viewer('first', 'g'), row('member', 'e', { sinceMs: T0 - age }), T0), `${age}`).toEqual({ kind: 'remove_at_sign_in_once' });
    // Nobody else gains anything from the age: another added sign-in still can't remove it.
    expect(pointerFor(viewer('member', 'p'), row('member', 'e', { sinceMs: T0 - 365 * DAY }), T0)).toEqual({ kind: 'not_yours' });
    expect(pointerFor(viewer('member', 'p'), row('member', 'e'), T0)).toEqual({ kind: 'not_yours' });
    expect(pointerFor(viewer('waiting', 'p'), row('member', 'e'), T0)).toBeNull();
    expect(pointerFor(viewer('waiting', 'p'), row('waiting', 'e'), T0)).toBeNull();
  });

  it('the 7 days are the sign-in window’s own: Home reads the vault’s RECENT_LINK_MS (core relay.ts), not a copy', async () => {
    const vault = await import('../../src/vault/login.ts');
    expect(vault.RECENT_LINK_MS).toBe(RECENT_LINK_MS);
    expect(readFileSync(resolve(process.cwd(), 'src/auth/home-sign-ins.ts'), 'utf8')).not.toMatch(/7 \* 24 \* 3_600_000/u);
  });

  it('three kinds: an added sign-in viewing another added one is told only who can remove it', async () => {
    const chain: Chain = {
      opened: new Set([key(G)]),
      accounts: [
        {
          root: G,
          members: [
            { who: E, effectiveAtMs: T0 - DAY, active: true, auto: true },
            { who: P, effectiveAtMs: T0 - DAY, active: true, auto: false },
          ],
          epoch: 2,
        },
      ],
    };
    const h = start(chain, asEmail);
    await shown(h);
    expect(rows().map((r) => [r.kind, r.role, r.you])).toEqual([
      ['email', 'member', true],
      ['google', 'first', false],
      ['other', 'member', false],
    ]);
    expect(rows()[2]!.text).toContain(SIGN_IN_TEXT.otherKind);
    expect(rows()[2]!.text).toContain(SIGN_IN_TEXT.notYours);
  });
});

describe('both providers (D874 as amended, D263’s independent reads)', () => {
  it('both agree: the list', async () => {
    const h = start(googleWithEmail(T0 - DAY, true), asGoogle);
    h.chain2 = googleWithEmail(T0 - DAY, true);
    await shown(h);
    expect(rows()).toHaveLength(2);
  });

  it('they disagree (the second hides the added email): no list, a failed read that says it couldn’t be confirmed', async () => {
    const h = start(googleWithEmail(T0 - DAY, true), asGoogle);
    h.chain2 = { opened: new Set([key(G)]), accounts: [] };
    await shown(h);
    expect(h.section.state).toBe('failed');
    expect(h.section.errorCode).toBe('sign_ins_disputed');
    expect(rows()).toEqual([]);
    expect(document.getElementById('home-sign-ins-problem')?.textContent).toContain('couldn’t confirm the ways to sign in, so it shows none');
  });

  it('they disagree only on a date or how it was added: still no list', async () => {
    for (const other of [googleWithEmail(T0 - 2 * DAY, true), googleWithEmail(T0 - DAY, true, false), googleWithEmail(T0 - DAY, false)]) {
      resetDom();
      const h = start(googleWithEmail(T0 - DAY, true), asGoogle);
      h.chain2 = other;
      await shown(h);
      expect(h.section.errorCode).toBe('sign_ins_disputed');
    }
  });

  it('one provider down, or no second provider: no list (never one provider’s word)', async () => {
    for (const down of ['primary', 'second'] as const) {
      resetDom();
      const h = start(googleWithEmail(T0 - DAY, true), asGoogle);
      h.view = async (m, a, w) => {
        if (w === down) throw new Error('down');
        return views(h.chain, S, { provider: a.provider as string, sub: a.sub as string })[m === 'get_identity' ? 'identity' : 'account'];
      };
      await shown(h);
      expect(h.section.errorCode).toBe('sign_ins_unreadable');
      expect(rows()).toEqual([]);
    }
    resetDom();
    const h = start(emailOnly(), asEmail);
    h.noSecond = true;
    await shown(h);
    expect(h.section.errorCode).toBe('sign_ins_unreadable');
    expect(h.calls).toEqual([]);
  });

  it('a date the page can’t write (past the year 9999, up to the u64 views’ 8.64e15 and beyond) is a failed read, not kept: Try again reads afresh', async () => {
    for (const bad of [SIGN_IN_MAX_MS + 1, 8.64e15 + 1, Number.MAX_SAFE_INTEGER]) {
      resetDom();
      const h = start(googleWithEmail(bad, true), asGoogle);
      await shown(h);
      expect(h.section.state).toBe('failed');
      expect(h.section.errorCode).toBe('sign_ins_disputed');
      h.chain = googleWithEmail(T0 - DAY, true);
      h.click('home-sign-ins-retry');
      await h.idle();
      expect(h.section.state).toBe('ready');
      expect(rows()).toHaveLength(2);
    }
    expect(SIGN_IN_MAX_MS).toBe(Date.UTC(9999, 11, 31, 23, 59, 59, 999));
    expect(() => signInDate(8.64e15 + 1)).not.toThrow();
  });
});

describe('the contract’s own rules, copied from links.rs (not from the page’s encoding)', () => {
  // links.rs, verbatim lines this table is copied from. If any changes, this test fails: re-derive the table.
  // (Read from the package's directory: vitest runs here, and happy-dom's import.meta.url isn't a file URL.)
  const LINKS_RS = readFileSync(resolve(process.cwd(), '../../contracts/hana-signer/src/links.rs'), 'utf8');
  const LINES = [
    // cancel_link
    'if j != member {\n            self.assert_active_in(&scope_id, &j, &root, now);\n        }',
    'assert!(matches!(self.standing(&member, now), Standing::Pending { .. }), "No such member");',
    // assert_active_in: the root (Own and j == root), an active member of the same root; a pending one refused
    'Standing::Own => assert!(j == root, "Sign-in method is not in this account"),',
    'env::panic_str("Sign-in method link is pending");',
    // unlink_identity
    'if j != root && j != member {',
    'env::panic_str("Only the root or the member itself can unlink");',
    'assert!(member != root, "Cannot unlink the root");',
    'assert!(matches!(self.standing(&member, now), Standing::Member { .. }), "No such member");',
  ];
  it('the lines the table is copied from are still in links.rs', () => {
    for (const l of LINES) expect(LINKS_RS, l).toContain(l);
  });

  type Standing = 'root' | 'active' | 'pending';
  /** cancel_link(j, member): line 1 (j == member skips the check), assert_active_in (root or active member), line 2. */
  const contractCancel = (j: { key: string; standing: Standing }, member: { key: string; standing: Standing }): boolean => {
    if (member.standing !== 'pending') return false; // "No such member" (Standing::Pending only)
    if (j.key === member.key) return true; // `if j != member` skips assert_active_in
    return j.standing === 'root' || j.standing === 'active'; // assert_active_in: Own && j == root, or Member of root; Pending panics
  };
  /** unlink_identity(j, member): `if j != root && j != member` panics; root refused; only Standing::Member. */
  const contractUnlink = (j: { key: string; standing: Standing }, member: { key: string; standing: Standing }): boolean => {
    if (j.standing !== 'root' && j.key !== member.key) return false; // "Only the root or the member itself can unlink"
    if (member.standing === 'root') return false; // "Cannot unlink the root"
    return member.standing === 'active'; // "No such member" unless Standing::Member
  };
  const role = (st: Standing): SignInRow['role'] => (st === 'root' ? 'first' : st === 'active' ? 'member' : 'waiting');

  it('mayCancel and mayRemove agree with the copied rules for every viewer and line', () => {
    const all: Standing[] = ['root', 'active', 'pending'];
    for (const vs of all) {
      for (const ts of all) {
        for (const same of [true, false]) {
          if (same && vs !== ts) continue;
          if (!same && vs === 'root' && ts === 'root') continue; // one root per account
          const j = { key: 'j', standing: vs };
          const m = { key: same ? 'j' : 'm', standing: ts };
          const v: SignInViewer = { key: 'j', role: role(vs), kind: 'email' };
          const r = row(role(ts), m.key, { you: same });
          expect(mayCancel(v, r), `cancel ${vs}→${ts} same=${same}`).toBe(contractCancel(j, m));
          expect(mayRemove(v, r), `remove ${vs}→${ts} same=${same}`).toBe(contractUnlink(j, m));
        }
      }
    }
  });
});

describe('the lines that send the user to sign in (D874 as amended)', () => {
  it('an added sign-in’s own removal: two sentences, the money advice, and what to do when it isn’t asked (an automatic same-address link, or “Don’t ask again on this device”)', () => {
    for (const kind of ['email', 'google'] as const) {
      const lines = pointerText({ kind: 'remove_own' }, row('member', 'e', { kind, you: true })).lines;
      const label = kind === 'email' ? 'Remove this email' : 'Remove this Google account';
      expect(lines[0]).toBe(`To remove it, sign in to this app with it and choose “${label}” when asked. After that, it no longer opens this wallet, and signing in with it opens a new, empty wallet.`);
      for (const sentence of lines[0]!.split(/(?<=\.) /u)) expect(sentence.split(' ').length, sentence).toBeLessThanOrEqual(22);
      expect(lines).toContain(SIGN_IN_TEXT.removeOwnMoney);
      expect(lines).toContain('Not asked? Try signing in in a private window. If this was added automatically because both use the same address, you won’t be asked.');
    }
  });

  it('the automatic Google member (the silent case) gets the same not-asked line', async () => {
    const chain: Chain = { opened: new Set([key(E)]), accounts: [{ root: E, members: [{ who: G, effectiveAtMs: T0 - DAY, active: true, auto: true }], epoch: 1 }] };
    const h = start(chain, asGoogle);
    await shown(h);
    expect(rows()[0]!.text).toContain(SIGN_IN_TEXT.autoGoogle);
    expect(rows()[0]!.text).toContain(SIGN_IN_TEXT.removeOwnNotAsked);
  });

  it('says once to sign out of the app first, only where a line sends the user to sign in', async () => {
    const one = start(emailOnly(), asEmail);
    await shown(one);
    expect(document.getElementById('home-sign-ins-sign-out-first')).toBeNull();
    resetDom();
    const several = start(googleWithEmail(T0 + DAY, false), asGoogle);
    await shown(several);
    expect(document.querySelectorAll('#home-sign-ins-sign-out-first')).toHaveLength(1);
    expect(document.getElementById('home-sign-ins-sign-out-first')?.textContent).toBe(SIGN_IN_TEXT.signOutFirst);
    resetDom();
    const none = start(googleWithEmail(T0 - 8 * DAY, true), asEmail);
    await shown(none);
    // The added email viewing itself: removed from its own sign-in (D865), which also sends the user to sign in.
    expect(document.querySelectorAll('#home-sign-ins-sign-out-first')).toHaveLength(1);
    expect(pointerSignsIn({ kind: 'remove_at_sign_in_once' })).toBe(true);
    expect(pointerSignsIn({ kind: 'not_yours' })).toBe(false);
    expect(pointerSignsIn({ kind: 'cancel_own_email' })).toBe(true);
  });
});

describe('the model', () => {
  it('a wallet whose added sign-ins are all gone is one sign-in again', () => {
    const v = views({ opened: new Set([key(G)]), accounts: [{ root: G, members: [], epoch: 2 }] }, S, G);
    const m = signInModel(S, G, { key: key(G), status: 'own', opened: true, root: null, effectiveAtMs: null, accountEpoch: 2 }, { root: G, members: [], epoch: 2, unlinked: [] });
    expect(v.account).not.toBeNull();
    expect(m.state === 'list' && m.rows.map((r) => [r.role, r.you])).toEqual([['first', true]]);
  });
});

describe('words (D853)', () => {
  it('no banned word in any sentence the section can show', () => {
    const samples: string[] = [...Object.values(SIGN_IN_TEXT)];
    for (const p of [{ kind: 'remove_own' }, { kind: 'remove_at_sign_in' }, { kind: 'remove_at_sign_in_once' }] as const) for (const kind of ['email', 'google'] as const) for (const auto of [true, false]) samples.push(...pointerText(p, row('member', 'e', { kind, auto })).lines);
    samples.push(...rowFacts(row('member', 'e')), ...rowFacts(row('waiting', 'e')));
    for (const s of samples) expect(jargonIn(s), s).toEqual([]);
  });
});

describe('D897: the line of “Ways to sign in”', () => {
  it('says how many open the wallet and how many wait, once read', () => {
    expect(signInSummary(1, 0)).toEqual({ line: '1 sign-in opens this wallet.', waiting: null });
    expect(signInSummary(2, 0)).toEqual({ line: '2 sign-ins open this wallet.', waiting: null });
    expect(signInSummary(1, 1)).toEqual({ line: '1 sign-in opens this wallet.', waiting: '1 more starts opening it soon. Check it below.' });
    expect(signInSummary(3, 2)).toEqual({ line: '3 sign-ins open this wallet.', waiting: '2 more start opening it soon. Check them below.' });
  });
});

describe('D898 option A: “Open {App} to cancel it” on a waiting sign-in', () => {
  type App = HomeScope['apps'][number];
  const app = (name: string, origins: string[], status: App['status'] = 'active'): App => ({ appId: `app_${name.toLowerCase().replace(/[^a-z]/gu, '')}1`, name, status, environment: 'live', origins, logoUrl: null });
  const scopeWith = (apps: App[]): HomeScope => ({ scopeId: S, mine: true, coverage: 'shared', googleClientId: null, supportId: null, addresses: [], apps, appsTotal: apps.length });
  async function showWith(apps: App[]) {
    const h = start(googleWithEmail(T0 + DAY, false), asGoogle);
    document.getElementById('app')!.replaceChildren(h.section.appView(scopeWith(apps)));
    h.click('home-sign-ins-show');
    await h.idle();
    return document.querySelector('#home-sign-ins-list > li[data-role="waiting"] .home-sign-in-risk') as HTMLElement;
  }

  it('opens the first active app’s web address in a new tab, with no opener and no referrer, and says where and what to do', async () => {
    const box = await showWith([app('Sodax', ['https://sodax.example', 'https://www.sodax.example'])]);
    const a = box.querySelector('a.home-sign-in-open') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://sodax.example');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('Open Sodax to cancel it (opens in a new tab)');
    expect(a.querySelector('.sr-only')?.textContent).toBe(' (opens in a new tab)');
    const where = document.getElementById(a.getAttribute('aria-describedby')!);
    expect(where?.textContent).toBe('Opens https://sodax.example in a new tab.');
    expect([...box.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Don’t recognise it? If you’re not sure, cancel it.',
      'Open Sodax to cancel it (opens in a new tab)',
      'Opens https://sodax.example in a new tab.',
      'There, sign in the way you signed in here, and choose “Cancel this link”.',
    ]);
    // Still the amber box, and the section's "sign out first" line.
    expect(box.classList.contains('jp-alert-warning')).toBe(true);
    expect(document.getElementById('home-sign-ins-sign-out-first')).not.toBeNull();
  });

  it('a wallet of several apps: the first active one with an address, and the sentence that it stops it for every app', async () => {
    const box = await showWith([app('Sodax', ['https://sodax.example'], 'suspended'), app('Sodax Earn', []), app('Lumen', ['https://lumen.example'])]);
    const a = box.querySelector('a.home-sign-in-open') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://lumen.example');
    expect(a.textContent).toContain('Open Lumen to cancel it');
    expect(box.textContent).toContain('Cancelling it there stops it for every app that uses this wallet.');
  });

  it('no button where no app is active with a plain https address: today’s sentence', async () => {
    for (const apps of [[app('Sodax', [])], [app('Sodax', ['https://sodax.example'], 'deleted')], [app('Sodax', ['https://sodax.example'], 'suspended')], [app('Sodax', ['http://sodax.example'])], []]) {
      resetDom();
      const box = await showWith(apps);
      expect(box.querySelector('a')).toBeNull();
      expect(box.textContent).toBe(SIGN_IN_TEXT.cancelAtSignIn);
    }
  });

  it('only a plain https origin from Journear’s record: hostile records give no button', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://a@b.example', 'https://a:b@b.example', 'https://b.example/', 'https://b.example/path', 'https://b.example?x=1', 'https://b.example#x', 'http://b.example', 'HTTPS://B.EXAMPLE', ' https://b.example', 'https://b.example ', '', 'https://' + 'a'.repeat(600) + '.example', 42, null]) {
      expect(isPlainHttpsOrigin(bad), String(bad)).toBe(false);
      expect(cancelTarget(scopeWith([app('X', [bad as string])]))).toBeNull();
    }
    for (const good of ['https://b.example', 'https://b.example:8443', 'https://xn--bcher-kva.example', `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example`]) expect(isPlainHttpsOrigin(good), good).toBe(true);
  });

  it('a very long address wraps at its own break points (the origin’s text, never markup)', async () => {
    const long = `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example`;
    const box = await showWith([app('Sodax', [long])]);
    const where = box.querySelector('.home-sign-in-open-where .origin');
    expect(where?.textContent).toBe(long);
    expect(where?.querySelectorAll('wbr').length).toBeGreaterThan(0);
  });

  it('the active member’s and the root’s other lines are unchanged', async () => {
    const box = await showWith([app('Sodax', ['https://sodax.example'])]);
    expect(box).not.toBeNull();
    // Only the waiting row's amber box has the link.
    expect(document.querySelectorAll('a.home-sign-in-open')).toHaveLength(1);
  });
});
