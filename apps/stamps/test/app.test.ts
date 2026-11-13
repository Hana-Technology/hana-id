// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://hana-id-stamps-sandbox-dev.tingtc.workers.dev/"}
// The site's state machine (src/app.ts) against a fake partner client and the fake chain, through the UI module's
// interface: the session (signed out, signing in, signed in), the passport, collecting each stamp from the click, fresh
// once, the public route, polling, notices; and, with the placeholder UI mounted for real, that nothing of another
// chain ever reaches the page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HanaAddresses, HanaConfig, HanaStatus } from '@hana-id/web';
import { BALANCE_WAIT_MS, POLL_MS, type StampsClient, type StampsDeps, startStamps } from '../src/app.ts';
import { STAGES } from '../src/collector.ts';
import { type PassportHandlers, type PassportView, mountPassport } from '../src/ui/index.ts';
import { CONTINUE, LOCKED, OWN_FARE_HELP, SENT_STAGE, UNVIEWABLE_NOTICE } from '../src/view.ts';
import { ADDRESSES, CONFIG, NEAR_ACCOUNT, OTHER_ACCOUNT, STAMPS } from './fixtures.ts';
import { FakeChain, TX_HASH, fakeNear, hanaError } from './fakes.ts';
import { decodeNearDelegateAction, decodeNearTransaction } from '@hana-id/core';

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
    // D807: the slot carries the faucet and Copy whatever notice is up (here the Arrival's success).
    expect(h.last().notice?.text).toContain('Arrival stamped');
    expect(h.stamp('own_fare')).toEqual({ id: 'own_fare', status: 'locked', reason: LOCKED.needsNear, detail: OWN_FARE_HELP.detail, href: CONFIG.near.faucet, hrefLabel: 'Get testnet NEAR ↗', copyAccount: true });
    // Once the success notice is gone, the faucet's link is the notice too.
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

describe('a step that needs the user’s click (D807)', () => {
  /** Holds the next signDelegateAction open until the test settles it. */
  function holdDelegate(h: Harness) {
    let settle!: (e?: unknown) => void;
    h.fake.near.signDelegateAction.mockImplementationOnce(
      (p) =>
        new Promise((resolve, reject) => {
          settle = (e) => (e === undefined ? resolve({ signature: 'x', signedDelegateAction: Buffer.from(p.delegateAction as Uint8Array).toString('base64') }) : reject(e));
        }),
    );
    return (e?: unknown) => settle(e);
  }

  async function arrived() {
    const h = boot({ signedIn: true });
    await flush();
    h.handlers().collect('arrival');
    await flush();
    return h;
  }

  it('Signature: the second approval waits on the launcher: the slot says step 2 with Continue, whose click opens the window; the message is not signed again', async () => {
    const h = await arrived();
    const settle = holdDelegate(h);
    h.handlers().collect('signature');
    await flush();
    expect(h.stamp('signature')).toEqual({ id: 'signature', status: 'working', stage: STAGES.sendProof });
    // The window was gone by the second request: the SDK shows its launcher.
    h.fake.emit('launcher', { visible: true, label: 'Review in Journear Passport', clickable: true });
    expect(h.stamp('signature')).toEqual({ id: 'signature', status: 'continue', stage: CONTINUE.signature, action: 'Continue' });
    expect(h.last().busy).toBe(true);
    h.handlers().collect('signature');
    // The click opens the window for the request already waiting: nothing new is asked or signed.
    expect(h.fake.prepareApproval).toHaveBeenCalledTimes(1);
    expect(h.fake.near.signMessage).toHaveBeenCalledTimes(1);
    expect(h.fake.near.signDelegateAction).toHaveBeenCalledTimes(2); // the Arrival's and this one
    h.fake.emit('launcher', { visible: false, label: '', clickable: false });
    expect(h.stamp('signature')).toEqual({ id: 'signature', status: 'working', stage: STAGES.sendProof });
    settle();
    await flush();
    expect(h.stamp('signature').status).toBe('collected');
  });

  it('Signature: the second approval declined or its window closed: the slot offers step 2 again; Continue sends only that', async () => {
    const h = await arrived();
    h.fake.near.signDelegateAction.mockRejectedValueOnce(hanaError(4001));
    h.handlers().collect('signature');
    await flush();
    expect(h.stamp('signature')).toEqual({ id: 'signature', status: 'continue', stage: CONTINUE.signature, action: 'Continue' });
    expect(h.last().busy).toBeUndefined();
    h.handlers().collect('signature');
    // A user gesture: the second request is made in the click.
    expect(h.fake.near.signDelegateAction).toHaveBeenCalledTimes(3);
    expect(h.fake.near.signMessage).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.stamp('signature').status).toBe('collected');
    expect(h.chain.stamps.passports.get(NEAR_ACCOUNT)?.map((x) => x.stamp)).toEqual(['arrival', 'signature']);
  });

  it('Signature: another failure of step 2 says what went wrong; Try again sends only step 2', async () => {
    const h = await arrived();
    h.fake.near.relay.mockRejectedValueOnce(hanaError('api_unavailable', { status: 503, reason: 'relayer_unavailable' }));
    h.handlers().collect('signature');
    await flush();
    expect(h.stamp('signature').status).toBe('failed');
    h.handlers().collect('signature');
    await flush();
    expect(h.fake.near.signMessage).toHaveBeenCalledTimes(1);
    expect(h.stamp('signature').status).toBe('collected');
  });

  it('any stamp whose window did not open by itself: Continue in the slot opens it (a user gesture)', async () => {
    const h = boot({ signedIn: true });
    await flush();
    const settle = holdDelegate(h);
    h.handlers().collect('arrival');
    await flush();
    h.fake.emit('launcher', { visible: true, label: 'Review in Journear Passport', clickable: true });
    expect(h.stamp('arrival')).toEqual({ id: 'arrival', status: 'continue', stage: CONTINUE.waiting, action: 'Continue' });
    h.fake.prepareApproval.mockClear();
    h.handlers().collect('arrival');
    expect(h.fake.prepareApproval).toHaveBeenCalledTimes(1);
    expect(h.fake.near.signDelegateAction).toHaveBeenCalledTimes(1);
    settle();
    await flush();
    expect(h.stamp('arrival').status).toBe('collected');
  });

  it('Own fare waiting for NEAR: the balance is read every 5 s while visible, so the slot unlocks on the next read after the transfer', async () => {
    const h = await arrived();
    expect(h.stamp('own_fare')).toMatchObject({ status: 'locked', reason: LOCKED.needsNear });
    const balanceReads = () => h.chain.count((c) => c.method === 'query' && c.params.request_type === 'view_account');
    const fast = h.timers.find((x) => x.ms === BALANCE_WAIT_MS && !x.stopped)!;
    const before = balanceReads();
    fast.fn();
    await flush();
    expect(balanceReads()).toBe(before + 1);
    h.chain.balance = String(10n ** 22n);
    fast.fn();
    await flush();
    expect(h.stamp('own_fare')).toEqual({ id: 'own_fare', status: 'available' });
    // Unlocked: the fast read stops (the 15 s poll and the 30 s preparation go on as before).
    const after = balanceReads();
    fast.fn();
    await flush();
    expect(balanceReads()).toBe(after);
  });

  it('back to the tab (focus): the balance at once', async () => {
    const h = await arrived();
    h.chain.balance = String(10n ** 22n);
    t += BALANCE_WAIT_MS;
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(h.stamp('own_fare')).toEqual({ id: 'own_fare', status: 'available' });
  });

  it('Copy (in the slot or beside the account) writes the full 64-hex id, not the shortened one on show', async () => {
    const h = boot({ signedIn: true, realUi: true });
    await flush();
    h.handlers().collect('arrival');
    await flush();
    const copy = h.root.querySelector<HTMLButtonElement>('[data-stamp="own_fare"] [data-action="copy-account"]')!;
    expect(copy).not.toBeNull();
    copy.click();
    await flush();
    expect(h.copied).toEqual([NEAR_ACCOUNT]);
    expect(NEAR_ACCOUNT).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('sign-out forgets the kept message', async () => {
    const h = await arrived();
    h.fake.near.signDelegateAction.mockRejectedValueOnce(hanaError(4001));
    h.handlers().collect('signature');
    await flush();
    expect(h.stamp('signature').status).toBe('continue');
    h.handlers().signOut();
    await flush();
    h.fake.readyWith(ADDRESSES);
    h.fake.emit('statusChanged', 'logged_in');
    await flush();
    expect(h.stamp('signature').status).toBe('available');
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

describe('what reaches a signed request (the site security review)', () => {
  const noSigning = (h: Harness) => {
    expect(h.fake.near.signDelegateAction).not.toHaveBeenCalled();
    expect(h.fake.near.signTransaction).not.toHaveBeenCalled();
    expect(h.fake.near.signMessage).not.toHaveBeenCalled();
    expect(h.fake.near.activate).not.toHaveBeenCalled();
    expect(h.fake.prepareApproval).not.toHaveBeenCalled();
  };

  it("signed in on someone else's passport: collect and interest do nothing (the route guard)", async () => {
    const h = boot({ path: `/p/${OTHER_ACCOUNT}`, signedIn: true, realUi: true });
    await flush();
    expect(h.last()).toMatchObject({ mode: 'public', accountId: OTHER_ACCOUNT });
    // The public page has no collect control; put one where it would be, as a hostile or stale DOM could.
    const fakeButton = Object.assign(document.createElement('button'), { type: 'button' });
    fakeButton.setAttribute('data-action', 'collect');
    const note = document.createElement('textarea');
    note.setAttribute('data-field', 'note');
    h.root.append(fakeButton, note);
    for (const target of [fakeButton, note]) {
      target.dispatchEvent(new Event('pointerover', { bubbles: true }));
      target.dispatchEvent(new Event('focusin', { bubbles: true }));
    }
    for (const id of ['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover'] as const) h.handlers().collect(id, { note: 'hi' });
    await h.tick(5_000);
    noSigning(h);
    expect(h.chain.stamps.calls).toEqual([]);
  });

  it('hostile chain answers and a hostile URL never reach the signed bytes: receiver, method, args, deposit and gas are the configured ones', async () => {
    const hostileNote = '"}],"receiver_id":"evil.testnet","x":"‮';
    const h = boot({
      path: '/p/evil.testnet%2F..%2F%22',
      signedIn: true,
      chain: (c) => {
        c.balance = String(10n ** 24n);
        c.override = (method, args) =>
          method === 'get_passport'
            ? { account_id: args.account_id, stamps: [{ stamp: 'arrival', block_timestamp_ms: 'evil', sponsored: 'yes', note: hostileNote }, { stamp: 'collect', block_timestamp_ms: 1, sponsored: true }] }
            : method === 'recent'
              ? [{ account_id: 'evil.testnet', stamp: 'arrival', block_timestamp_ms: 1, method: 'transfer' }, { account_id: OTHER_ACCOUNT, stamp: 'nope', block_timestamp_ms: 2 }]
              : method === 'totals'
                ? { passports: '1e99', stamps: { receiver_id: 'evil.testnet' } }
                : undefined;
      },
    });
    await flush();
    // The hostile path is not a route: the signed-in user's own passport, with its notice.
    expect(h.last()).toMatchObject({ mode: 'mine', accountId: NEAR_ACCOUNT });
    const note = '  A real note  ';
    for (const id of ['arrival', 'sponsored', 'postcard', 'signature', 'own_fare'] as const) {
      h.handlers().collect(id, id === 'postcard' ? { note } : undefined);
      await flush();
      // A poll between collects: the hostile answers are read again before the next signed request.
      await h.tick(POLL_MS);
    }
    const expected: Record<string, Record<string, unknown>> = {
      arrival: { stamp: 'arrival' },
      sponsored: { stamp: 'sponsored' },
      postcard: { stamp: 'postcard', note: 'A real note' },
    };
    const delegates = h.fake.near.signDelegateAction.mock.calls.map((c) => decodeNearDelegateAction(c[0].delegateAction as Uint8Array));
    expect(delegates.length).toBeGreaterThanOrEqual(4);
    for (const d of delegates) {
      expect([d.senderId, d.receiverId, d.actions.length]).toEqual([NEAR_ACCOUNT, STAMPS, 1]);
      const call = d.actions[0] as { type: string; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
      expect([call.type, call.methodName, call.gas, call.deposit]).toEqual(['functionCall', 'collect', BigInt(CONFIG.near.collectTgas) * 10n ** 12n, 0n]);
      const args = JSON.parse(new TextDecoder().decode(call.args)) as Record<string, unknown>;
      if (args.stamp === 'signature') {
        expect(Object.keys(args).sort()).toEqual(['proof', 'stamp']);
        expect(args.proof).toEqual({ message: `Stamp my passport: ${NEAR_ACCOUNT}`, nonce: expect.any(String), recipient: STAMPS, signature: expect.any(String) });
      } else expect(args).toEqual(expected[args.stamp as string]);
    }
    expect(new Set(delegates.map((d) => JSON.parse(new TextDecoder().decode((d.actions[0] as { args: Uint8Array }).args)).stamp))).toEqual(new Set(['arrival', 'sponsored', 'postcard', 'signature']));
    expect(h.fake.near.signMessage.mock.calls.map((c) => [c[0].message, c[0].recipient, c[0].callbackUrl])).toEqual([[`Stamp my passport: ${NEAR_ACCOUNT}`, STAMPS, undefined]]);
    const txs = h.fake.near.signTransaction.mock.calls.map((c) => decodeNearTransaction(c[0].transaction as Uint8Array));
    expect(txs).toHaveLength(1);
    const tx = txs[0]!;
    expect([tx.signerId, tx.receiverId, tx.actions.length]).toEqual([NEAR_ACCOUNT, STAMPS, 1]);
    const fare = tx.actions[0] as { type: string; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
    expect([fare.type, fare.methodName, fare.gas, fare.deposit]).toEqual(['functionCall', 'collect', BigInt(CONFIG.near.collectTgas) * 10n ** 12n, 0n]);
    expect(JSON.parse(new TextDecoder().decode(fare.args))).toEqual({ stamp: 'own_fare' });
  });

  it('an account id the site cannot route (the SDK should never give one) renders a notice, not a crash', async () => {
    const h = boot({ signedIn: false, realUi: true });
    await flush();
    h.handlers().signIn();
    h.fake.finishLogin!({ ...ADDRESSES, near: 'bob.near' });
    await flush();
    expect(h.last()).toMatchObject({ mode: 'mine', accountId: 'bob.near', notice: { kind: 'error', text: UNVIEWABLE_NOTICE } });
    expect(h.last().shareUrl).toBeUndefined();
    expect(h.root.textContent).toContain(UNVIEWABLE_NOTICE);
  });
});
