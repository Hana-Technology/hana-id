// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://hana-id-stamps-sandbox-dev.tingtc.workers.dev/"}
// The site's state machine (src/app.ts) against a fake partner client and the fake chain, through the UI module's
// interface: the session (signed out, signing in, signed in), the passport, collecting each stamp from the click, fresh
// once, the public route, polling, notices; and, with the placeholder UI mounted for real, that nothing of another
// chain ever reaches the page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HanaAddresses, HanaConfig, HanaStatus } from '@hana-id/web';
import { POLL_MS, type StampsClient, type StampsDeps, startStamps } from '../src/app.ts';
import { STAGES } from '../src/collector.ts';
import { type PassportHandlers, type PassportView, mountPassport } from '../src/ui/index.ts';
import { LOCKED, SENT_STAGE } from '../src/view.ts';
import { ADDRESSES, CONFIG, NEAR_ACCOUNT, OTHER_ACCOUNT, STAMPS } from './fixtures.ts';
import { FakeChain, TX_HASH, fakeNear, hanaError } from './fakes.ts';

type Listener = (...args: unknown[]) => void;

class FakeClient {
  status: HanaStatus = 'unlocking';
  addresses: HanaAddresses | null = null;
  vaultOrigin = CONFIG.vaultOrigin;
  readonly ready: Promise<void>;
  resolveReady!: () => void;
  readonly listeners = new Map<string, Listener[]>();
  finishLogin: ((r: HanaAddresses | Error) => void) | null = null;
  readonly loginCalls: unknown[] = [];
  readonly logout = vi.fn(async () => {
    this.addresses = null;
    this.status = 'logged_out';
    this.emit('statusChanged', 'logged_out');
  });
  readonly near: ReturnType<typeof fakeNear>;
  readonly ticket = { cancel: vi.fn() };
  readonly prepareApproval = vi.fn(() => this.ticket);

  constructor(
    readonly config: HanaConfig,
    chain: FakeChain,
  ) {
    this.near = fakeNear(() => this.addresses?.near ?? null, chain);
    this.ready = new Promise((res) => {
      this.resolveReady = res;
    });
  }

  on(event: string, l: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  readyWith(addresses: HanaAddresses | null): void {
    this.status = addresses ? 'logged_in' : 'logged_out';
    this.addresses = addresses;
    this.resolveReady();
  }

  login(options?: unknown): Promise<HanaAddresses> {
    this.loginCalls.push(options);
    this.status = 'logging_in';
    this.emit('statusChanged', 'logging_in');
    return new Promise((resolve, reject) => {
      this.finishLogin = (r) => {
        if (r instanceof Error) {
          this.status = 'logged_out';
          this.emit('statusChanged', 'logged_out');
          reject(r);
          return;
        }
        this.addresses = r;
        this.status = 'logged_in';
        this.emit('accountsChanged', r);
        this.emit('statusChanged', 'logged_in');
        resolve(r);
      };
    });
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  fake: FakeClient;
  chain: FakeChain;
  views: PassportView[];
  last: () => PassportView;
  handlers: () => PassportHandlers;
  tick: (ms: number) => Promise<void>;
  timers: { fn: () => void; ms: number; stopped: boolean }[];
  pushed: string[];
  copied: string[];
  root: HTMLElement;
  configs: HanaConfig[];
  stamp: (id: string) => PassportView['stamps'][number];
}

let t = 1_800_000_000_000;

function boot(o: { path?: string; signedIn?: boolean; realUi?: boolean; chain?: (c: FakeChain) => void } = {}): Harness {
  t = 1_800_000_000_000;
  const chain = new FakeChain(STAMPS, () => t);
  o.chain?.(chain);
  const views: PassportView[] = [];
  let handlers: PassportHandlers | null = null;
  const timers: Harness['timers'] = [];
  const pushed: string[] = [];
  const copied: string[] = [];
  const configs: HanaConfig[] = [];
  let fake!: FakeClient;
  const root = Object.assign(document.createElement('main'), { id: 'passport' });
  document.body.replaceChildren(root);
  const location = { pathname: o.path ?? '/', origin: 'https://hana-id-stamps-sandbox-dev.tingtc.workers.dev' };
  const deps: StampsDeps = {
    config: CONFIG,
    createClient: (config) => {
      configs.push(config);
      fake = new FakeClient(config, chain);
      return fake as unknown as StampsClient;
    },
    mount: (r, h) => {
      handlers = h;
      const real = o.realUi ? mountPassport(r, h) : null;
      return {
        update: (v) => {
          views.push(structuredClone(v));
          real?.update(v);
        },
        destroy: () => real?.destroy(),
      };
    },
    root,
    location,
    history: {
      pushState: (_d, _u, url) => {
        pushed.push(url);
        location.pathname = url;
      },
    },
    fetch: chain.fetch,
    clock: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: (n) => new Uint8Array(n).fill(5),
    copy: async (text) => {
      copied.push(text);
    },
    every: (fn, ms) => {
      const timer = { fn, ms, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    visible: () => true,
  };
  startStamps(deps);
  if (o.signedIn !== undefined) fake.readyWith(o.signedIn ? ADDRESSES : null);
  return {
    fake,
    chain,
    views,
    last: () => views[views.length - 1]!,
    handlers: () => handlers!,
    async tick(ms) {
      t += ms;
      for (const timer of timers) if (!timer.stopped && ms >= timer.ms) timer.fn();
      await flush();
    },
    timers,
    pushed,
    copied,
    root,
    configs,
    stamp(id) {
      return this.last().stamps.find((s) => s.id === id)!;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('the session', () => {
  it('creates the client for the env and app only (NEAR only: no EVM or Stellar config)', async () => {
    const h = boot({ signedIn: false });
    expect(h.configs).toEqual([{ publishableKey: CONFIG.publishableKey, environment: CONFIG.environment }]);
  });

  it('cover while signed out (busy while the vault unlocks), sign in from the click, then the passport', async () => {
    const h = boot();
    expect(h.last().mode).toBe('cover');
    expect(h.last().busy).toBe(true);
    h.fake.readyWith(null);
    await flush();
    expect(h.last()).toMatchObject({ mode: 'cover' });
    expect(h.last().busy).toBeUndefined();
    expect(h.last().stamps.every((s) => s.status === 'locked' && s.reason === LOCKED.signIn)).toBe(true);
    h.handlers().signIn();
    // Synchronous in the click, with no method: Journear Passport's window offers email and Google.
    expect(h.fake.loginCalls).toEqual([undefined]);
    expect(h.last().busy).toBe(true);
    h.fake.finishLogin!(ADDRESSES);
    await flush();
    expect(h.last()).toMatchObject({ mode: 'mine', accountId: NEAR_ACCOUNT, explorerUrl: `https://testnet.nearblocks.io/address/${NEAR_ACCOUNT}`, shareUrl: `https://hana-id-stamps-sandbox-dev.tingtc.workers.dev/p/${NEAR_ACCOUNT}`, balanceNear: '0' });
    expect(h.stamp('arrival')).toEqual({ id: 'arrival', status: 'available' });
  });

  it('a cancelled sign-in is a plain notice', async () => {
    const h = boot({ signedIn: false });
    await flush();
    h.handlers().signIn();
    h.fake.finishLogin!(hanaError('login_cancelled'));
    await flush();
    expect(h.last().notice).toEqual({ kind: 'error', text: 'Sign-in cancelled.' });
    expect(h.last().mode).toBe('cover');
  });

  it('the launcher’s hint while a popup was blocked, gone with the launcher', async () => {
    const h = boot({ signedIn: false });
    await flush();
    h.fake.emit('launcher', { visible: true, label: 'Sign in with Journear Passport', clickable: true });
    expect(h.last().notice?.text).toBe('Click “Sign in with Journear Passport” on the Journear Passport button at the bottom right of the page to continue.');
    h.fake.emit('launcher', { visible: false, label: '', clickable: false });
    expect(h.last().notice).toBeUndefined();
  });

  it('sign out returns to the cover; a signed_out disconnect is an info notice', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.handlers().signOut();
    await flush();
    expect(h.last().mode).toBe('cover');
    expect(h.last().notice?.text).toMatch(/^Signed out/u);
    const h2 = boot({ signedIn: true });
    await flush();
    h2.fake.status = 'logged_out';
    h2.fake.addresses = null;
    h2.fake.emit('disconnect', { code: 4900, reason: 'signed_out' });
    expect(h2.last().mode).toBe('cover');
    expect(h2.last().notice).toEqual({ kind: 'info', text: 'You were signed out on this device (from Passport Home, another tab or another device). Sign in again.' });
  });
});

describe('collecting', () => {
  it('Arrival from the click: the window opens in the click, working stages, then collected and fresh exactly once', async () => {
    const h = boot({ signedIn: true, chain: (c) => (c.key = null) });
    await flush();
    h.handlers().collect('arrival');
    // Not prepared (the account doesn't exist yet): prepareApproval in the click.
    expect(h.fake.prepareApproval).toHaveBeenCalledTimes(1);
    expect(h.stamp('arrival').status).toBe('working');
    expect(h.last().busy).toBe(true);
    await flush();
    const freshViews = h.views.filter((v) => v.stamps.some((s) => s.status === 'collected' && s.fresh));
    expect(freshViews).toHaveLength(1);
    expect(h.stamp('arrival')).toMatchObject({ status: 'collected', sponsored: true });
    expect((h.stamp('arrival') as { fresh?: boolean }).fresh).toBeUndefined();
    expect(h.last().notice).toEqual({ kind: 'info', text: 'Arrival stamped on NEAR testnet. Your NEAR account was created for it. You paid no gas.', href: `https://testnet.nearblocks.io/txns/${TX_HASH}`, hrefLabel: 'View the transaction' });
    expect(h.stamp('sponsored')).toEqual({ id: 'sponsored', status: 'available' });
    expect(h.chain.stamps.passports.get(NEAR_ACCOUNT)?.map((s) => s.stamp)).toEqual(['arrival']);
  });

  it('interest (pointer or focus on a collect button) prepares, so the click signs synchronously', async () => {
    const h = boot({ signedIn: true, realUi: true, chain: (c) => (c.key = null) });
    await flush();
    const button = h.root.querySelector('[data-stamp="arrival"] [data-action="collect"]') as HTMLButtonElement;
    button.dispatchEvent(new Event('pointerover', { bubbles: true }));
    await flush();
    expect(h.fake.near.activate).toHaveBeenCalledTimes(1);
    (h.root.querySelector('[data-stamp="arrival"] [data-action="collect"]') as HTMLButtonElement).click();
    expect(h.fake.near.signDelegateAction).toHaveBeenCalledTimes(1);
    expect(h.fake.prepareApproval).not.toHaveBeenCalled();
    await flush();
    expect(h.root.querySelector('[data-stamp="arrival"]')?.getAttribute('data-status')).toBe('collected');
  });

  it('every relayed stamp, the signature and the postcard; one collect at a time', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.handlers().collect('arrival');
    h.handlers().collect('sponsored'); // ignored: one at a time
    await flush();
    h.handlers().collect('sponsored');
    await flush();
    h.handlers().collect('postcard', { note: '  hello from the e2e  ' });
    await flush();
    h.handlers().collect('signature');
    expect(h.fake.near.signMessage).toHaveBeenCalledTimes(1);
    await flush();
    const p = h.chain.stamps.passports.get(NEAR_ACCOUNT)!;
    expect(p.map((s) => s.stamp)).toEqual(['arrival', 'sponsored', 'postcard', 'signature']);
    expect(p.find((s) => s.stamp === 'postcard')?.note).toBe('hello from the e2e');
    expect(h.stamp('postcard')).toMatchObject({ status: 'collected', note: 'hello from the e2e' });
    expect(h.stamp('signature')).toMatchObject({ status: 'collected' });
  });

  it('a postcard without a note fails in place, before any approval', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.handlers().collect('arrival');
    await flush();
    h.handlers().collect('postcard', { note: '   ' });
    expect(h.stamp('postcard')).toEqual({ id: 'postcard', status: 'failed', message: 'Write a note first (1 to 140 characters).' });
    expect(h.fake.near.signDelegateAction).toHaveBeenCalledTimes(1);
  });

  it('a declined approval: failed with plain words, and collectable again', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.fake.near.signDelegateAction.mockRejectedValueOnce(hanaError(4001));
    h.handlers().collect('arrival');
    await flush();
    expect(h.stamp('arrival')).toEqual({ id: 'arrival', status: 'failed', message: 'Declined in the Journear Passport window: nothing was signed, no stamp was collected.' });
    h.handlers().collect('arrival');
    await flush();
    expect(h.stamp('arrival').status).toBe('collected');
  });

  it('a relay timeout with the transaction sent: still confirming, with the link, until the chain shows it', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.fake.near.relay.mockRejectedValueOnce(hanaError('api_unavailable', { status: 504, reason: 'timeout', transactionHash: TX_HASH }));
    h.handlers().collect('arrival');
    await flush();
    expect(h.stamp('arrival')).toEqual({ id: 'arrival', status: 'working', stage: SENT_STAGE });
    expect(h.last().notice).toEqual({ kind: 'info', text: 'Arrival: sent, still confirming on NEAR testnet.', href: `https://testnet.nearblocks.io/txns/${TX_HASH}`, hrefLabel: 'View the transaction' });
    // It landed: the next poll shows it.
    h.chain.stamps.collect(NEAR_ACCOUNT, true, { stamp: 'arrival' });
    await h.tick(POLL_MS);
    expect(h.stamp('arrival').status).toBe('collected');
  });

  it('Own fare: locked with the faucet until the balance covers the fee, then the user’s own transaction', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.handlers().collect('arrival');
    await flush();
    expect(h.stamp('own_fare')).toEqual({ id: 'own_fare', status: 'locked', reason: LOCKED.needsNear });
    // Once the success notice is gone, the faucet's link is the notice.
    h.handlers().refresh();
    await flush();
    expect(h.last().notice).toMatchObject({ kind: 'info', href: CONFIG.near.faucet, hrefLabel: 'Get testnet NEAR' });
    h.chain.balance = String(2n * 10n ** 24n);
    await h.tick(POLL_MS);
    expect(h.last().balanceNear).toBe('2');
    expect(h.stamp('own_fare')).toEqual({ id: 'own_fare', status: 'available' });
    h.handlers().collect('own_fare');
    expect(h.fake.near.signTransaction).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.stamp('own_fare')).toMatchObject({ status: 'collected', sponsored: false });
    expect(h.last().notice?.text).toBe('Own fare stamped on NEAR testnet. Your NEAR paid the fee.');
  });

  it('the Layover counts down from the Arrival’s block time, every second, then opens', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.handlers().collect('arrival');
    await flush();
    expect(h.stamp('layover')).toMatchObject({ status: 'locked', reason: 'In 2 min 3 s' });
    const second = h.timers.find((x) => x.ms === 1000 && !x.stopped)!;
    t += 60_000;
    second.fn();
    expect(h.stamp('layover')).toMatchObject({ status: 'locked', reason: 'In 1 min 3 s' });
    t += 63_000;
    second.fn();
    expect(h.stamp('layover')).toEqual({ id: 'layover', status: 'available' });
    expect(second.stopped).toBe(true);
    h.handlers().collect('layover');
    await flush();
    expect(h.stamp('layover').status).toBe('collected');
  });

  it('the stages a collect shows', async () => {
    const h = boot({ signedIn: true });
    await flush();
    h.handlers().collect('arrival');
    await flush();
    const stages = h.views.flatMap((v) => v.stamps.filter((s) => s.id === 'arrival' && s.status === 'working').map((s) => (s as { stage: string }).stage));
    expect(stages).toContain(STAGES.approving);
    expect(stages).toContain(STAGES.relaying);
  });
});

describe('the public passport and the recent stamps', () => {
  it('/p/<id>: read-only from the chain, with recent stamps linking to passports and the totals', async () => {
    const h = boot({ path: `/p/${OTHER_ACCOUNT}`, signedIn: false });
    await flush();
    h.chain.stamps.collect(OTHER_ACCOUNT, true, { stamp: 'arrival' });
    h.chain.stamps.collect(OTHER_ACCOUNT, true, { stamp: 'postcard', note: 'Bonjour \u202Eevil' });
    await h.tick(POLL_MS);
    expect(h.last()).toMatchObject({ mode: 'public', accountId: OTHER_ACCOUNT, totals: { passports: 1, stamps: 2 } });
    expect(h.stamp('arrival')).toMatchObject({ status: 'collected', txUrl: `https://testnet.nearblocks.io/address/${OTHER_ACCOUNT}` });
    expect(h.stamp('postcard')).toMatchObject({ status: 'collected', note: 'Bonjour �evil' });
    expect(h.stamp('sponsored')).toEqual({ id: 'sponsored', status: 'locked', reason: LOCKED.notCollected });
    // Newest first.
    expect(h.last().recent.map((r) => [r.stamp, r.href])).toEqual([
      ['postcard', `/p/${OTHER_ACCOUNT}`],
      ['arrival', `/p/${OTHER_ACCOUNT}`],
    ]);
    // Collect does nothing on someone else's passport.
    h.handlers().collect('sponsored');
    expect(h.fake.near.signDelegateAction).not.toHaveBeenCalled();
  });

  it('signing in from a public passport goes to your own', async () => {
    const h = boot({ path: `/p/${OTHER_ACCOUNT}`, signedIn: false });
    await flush();
    h.handlers().signIn();
    h.fake.finishLogin!(ADDRESSES);
    await flush();
    expect(h.pushed).toEqual(['/']);
    expect(h.last()).toMatchObject({ mode: 'mine', accountId: NEAR_ACCOUNT });
  });

  it('a failed read is said when nothing was shown, and Refresh says it again', async () => {
    const h = boot({ path: `/p/${OTHER_ACCOUNT}`, signedIn: false, chain: (c) => (c.down = true) });
    await flush();
    expect(h.last().notice?.text).toMatch(/couldn’t read NEAR testnet/u);
    h.chain.down = false;
    h.handlers().refresh();
    await flush();
    expect(h.last().notice).toBeUndefined();
  });

  it('copy account copies the shown account', async () => {
    const h = boot({ path: `/p/${OTHER_ACCOUNT}`, signedIn: false });
    await flush();
    h.handlers().copyAccount();
    await flush();
    expect(h.copied).toEqual([OTHER_ACCOUNT]);
  });

  it('hostile RPC answers never break the page or show raw', async () => {
    const h = boot({ path: `/p/${OTHER_ACCOUNT}`, signedIn: false, realUi: true });
    await flush();
    h.chain.override = (method) =>
      method === 'get_passport'
        ? { account_id: OTHER_ACCOUNT, stamps: [{ stamp: 'postcard', block_timestamp_ms: 1, sponsored: true, note: '<b onmouseover=alert(1)>hi</b>\u202E' }, { stamp: 'x', block_timestamp_ms: 'y' }] }
        : method === 'recent'
          ? [{ account_id: '0x8ba1f109551bd432803012645ac136ddd64dba72', stamp: 'arrival', block_timestamp_ms: 1 }, { account_id: 'bad id', stamp: 'arrival', block_timestamp_ms: 1 }, { account_id: 'alice.testnet', stamp: 'arrival', block_timestamp_ms: 2 }, { account_id: OTHER_ACCOUNT, stamp: 'arrival', block_timestamp_ms: 3 }]
          : { passports: 'many', stamps: 1 };
    await h.tick(POLL_MS);
    // Implicit accounts only: a named account (anyone can make one, with any name) never reaches the feed.
    expect(h.last().recent.map((r) => r.accountId)).toEqual([OTHER_ACCOUNT]);
    // Unreadable totals keep the last good ones.
    expect(h.last().totals).toEqual({ passports: 0, stamps: 0 });
    expect(h.root.querySelector('[onmouseover]')).toBeNull();
    expect(h.root.textContent).toContain('<b onmouseover=alert(1)>hi</b>�');
  });
});

describe('guards', () => {
  it('nothing of another chain on the page: no Stellar or EVM address, no Stellar/EVM/Ethereum word', async () => {
    const h = boot({ signedIn: true, realUi: true });
    await flush();
    h.handlers().collect('arrival');
    await flush();
    const text = `${document.body.textContent} ${[...document.body.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value)).join(' ')}`;
    expect(text).toContain(NEAR_ACCOUNT);
    expect(text).not.toContain(ADDRESSES.stellar);
    expect(text.toLowerCase()).not.toContain(ADDRESSES.evm.toLowerCase());
    expect(text).not.toMatch(/\bG[A-Z2-7]{55}\b|\b0x[0-9a-fA-F]{40}\b/u);
    expect(text).not.toMatch(/stellar|\bevm\b|ethereum|sepolia/iu);
    expect(text).not.toMatch(/\bHana\b/u);
    for (const v of h.views) expect(JSON.stringify(v)).not.toMatch(/stellar|\bevm\b|G[A-Z2-7]{55}|0x[0-9a-fA-F]{40}/iu);
  });

  it('the UI keeps the data-* hooks of UI-CONTRACT.md, and a click on them reaches the site', async () => {
    const h = boot({ signedIn: false, realUi: true });
    await flush();
    expect(h.root.querySelector('[data-mode="cover"]')).not.toBeNull();
    (h.root.querySelector('[data-action="sign-in"]') as HTMLButtonElement).click();
    expect(h.fake.loginCalls).toHaveLength(1);
    h.fake.finishLogin!(ADDRESSES);
    await flush();
    expect(h.root.querySelector('[data-mode="mine"]')).not.toBeNull();
    expect(h.root.querySelectorAll('[data-stamp][data-status]')).toHaveLength(6);
    expect(h.root.querySelector('[data-role="share"]')?.getAttribute('href')).toBe(`https://hana-id-stamps-sandbox-dev.tingtc.workers.dev/p/${NEAR_ACCOUNT}`);
    expect(h.root.querySelector('[data-role="explorer"]')?.getAttribute('href')).toBe(`https://testnet.nearblocks.io/address/${NEAR_ACCOUNT}`);
    expect(h.root.querySelector('[data-action="sign-out"]')).not.toBeNull();
    (h.root.querySelector('[data-stamp="arrival"] [data-action="collect"]') as HTMLButtonElement).click();
    expect(h.fake.near.signDelegateAction.mock.calls.length + h.fake.prepareApproval.mock.calls.length).toBe(1);
    await flush();
    expect(h.root.querySelector('[data-stamp="arrival"]')?.getAttribute('data-status')).toBe('collected');
    const notice = h.root.querySelector('[data-role="notice"]')!;
    expect(notice.hasAttribute('hidden')).toBe(false);
    expect(notice.getAttribute('data-kind')).toBe('info');
    expect(notice.textContent).toContain('Arrival stamped');
    const note = h.root.querySelector('[data-stamp="postcard"] [data-field="note"]') as HTMLInputElement;
    note.value = '  hi from the hooks  ';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    (h.root.querySelector('[data-stamp="postcard"] [data-action="collect"]') as HTMLButtonElement).click();
    await flush();
    expect(h.chain.stamps.passports.get(NEAR_ACCOUNT)?.find((s) => s.stamp === 'postcard')?.note).toBe('hi from the hooks');
    await h.tick(POLL_MS);
    expect(h.root.querySelector(`[data-role="recent-item"][data-kind="arrival"] a`)?.getAttribute('href')).toBe(`https://hana-id-stamps-sandbox-dev.tingtc.workers.dev/p/${NEAR_ACCOUNT}`);
  });
});
