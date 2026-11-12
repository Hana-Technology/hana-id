// The hosted demo's NEAR card against the real relay routes (D750–D754): the exact bytes the page builds
// (apps/demo/src/near.ts: addMessageDelegate, delegateNonce, GUESTBOOK_GAS) and the exact requests the SDK sends for
// them (packages/web/src/client/near.ts: hana.near.activate and hana.near.relay, through their own fetch), through
// POST /v1/near/activate and /v1/near/relay with the fake NEAR RPC. The demo's Playwright test mocks these two routes
// at the network layer (the e2e stack has no relay account), so this is what keeps the page and the API from drifting.
import { ed25519 } from '@noble/curves/ed25519';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hex } from '../src/bytes.ts';
import { defaultNearAccountLookup, forgetHead, nearDirectory } from '../src/near/relay.ts';
import { ORIGIN, call } from './helpers.ts';
import { vaultSetup } from './vault-helpers.ts';

// Browser code, loaded by a computed specifier so this package's typecheck (Workers types, no DOM) doesn't check it;
// the shapes used here are written out below, and the demo's and the SDK's own typechecks check the real ones.
const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path.startsWith('.') ? new URL(path, import.meta.url).pathname : path);
type Delegate = { accountId: string; guestbook: string; text: string; nonce: bigint; blockHeight: bigint };
const demo = (await load('../../demo/src/near.ts')) as {
  DELEGATE_TTL_BLOCKS: bigint;
  GUESTBOOK_GAS: bigint;
  addMessageDelegate(p: Delegate): Uint8Array;
  delegateNonce(p: { keyNonce: bigint; blockHeight: bigint }): bigint;
};
const core = (await load('@hana-id/core')) as { signNearDelegateAction(seed: Uint8Array, delegate: Uint8Array): { signedDelegateAction: string } };
type NearClient = {
  activate(): Promise<{ created: boolean; accountId: string; accessKeyNonce?: string | null; blockHeight?: number }>;
  relay(p: { network: 'testnet'; signedDelegateAction: string }): Promise<{ transactionHash: string; status: string }>;
};
const { HanaNear } = (await load('../../../packages/web/src/client/near.ts')) as { HanaNear: new (host: unknown) => NearClient };
const { DELEGATE_TTL_BLOCKS, GUESTBOOK_GAS, addMessageDelegate, delegateNonce } = demo;
const { signNearDelegateAction } = core;

const GUESTBOOK = 'guestbook.test.near';
const RELAY_ACCOUNT = 'near-relay.test.near';
const API = 'https://api.test';

/** sandbox-dev's relay config as far as the demo is concerned: the guestbook the one receiver, 10 Tgas a delegate. */
const SANDBOX_DEV_RELAY = { NEAR_RELAY: JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], maxGasTgas: 10 }) };

const known = new Set<string>();
beforeEach(() => {
  forgetHead();
  nearDirectory.lookup = async (_db, q) => (known.has(`${q.scopeId}#${q.accountId}`) ? { userId: 'hu_demo' } : null);
});
afterEach(() => {
  nearDirectory.lookup = defaultNearAccountLookup;
  known.clear();
});

/** The SDK's NEAR client for a signed-in user of `app`, its fetch going to the Worker as a browser on ORIGIN would. */
function sdk(app: { key: string }, accountId: string) {
  const sent: { path: string; body: unknown }[] = [];
  const near = new HanaNear({
    nearAccountId: () => accountId,
    request: () => Promise.reject(new Error('no vault here')),
    apiUrl: API,
    publishableKey: app.key,
    fetch: async (url: string, init?: RequestInit) => {
      const path = String(url).slice(API.length);
      sent.push({ path, body: JSON.parse(String(init?.body)) });
      return call(path, { method: 'POST', headers: { ...(init?.headers as Record<string, string>), origin: ORIGIN }, rawBody: String(init?.body), env: SANDBOX_DEV_RELAY });
    },
  });
  return { near, sent };
}

describe("the demo's guestbook write through the real routes", () => {
  it('activate, then the delegate the page builds and the SDK relays: accepted under sandbox-dev’s 10 Tgas cap', async () => {
    const { app, near: chain } = await vaultSetup();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const accountId = hex(ed25519.getPublicKey(seed));
    known.add(`${app.scope}#${accountId}`);
    chain.missingAccounts.add(accountId);
    const { near, sent } = sdk(app, accountId);

    const a = await near.activate();
    expect(a).toMatchObject({ created: true, accountId });
    expect(sent.at(-1)).toEqual({ path: '/v1/near/activate', body: { accountId } });
    expect(typeof a.accessKeyNonce).toBe('string');
    expect(a.blockHeight).toBeGreaterThan(0);

    // The card's nonce and expiry from activate's answer, then the page's bytes, signed as the vault signs them.
    const nonce = delegateNonce({ keyNonce: BigInt(a.accessKeyNonce!), blockHeight: BigInt(a.blockHeight!) });
    const delegate = addMessageDelegate({ accountId, guestbook: GUESTBOOK, text: 'gm from the demo page', nonce, blockHeight: BigInt(a.blockHeight!) });
    const { signedDelegateAction } = signNearDelegateAction(seed, delegate);
    const r = await near.relay({ network: 'testnet', signedDelegateAction });
    expect(r.status).toBe('executed');
    expect(sent.at(-1)).toEqual({ path: '/v1/near/relay', body: { network: 'testnet', signedDelegateAction } });
    const tx = chain.nearSent.at(-1)!;
    expect([tx.hash, tx.signerId, tx.receiverId, tx.kind]).toEqual([r.transactionHash, RELAY_ACCOUNT, accountId, 'delegate']);
    expect(tx.delegate).toEqual({ senderId: accountId, receiverId: GUESTBOOK, nonce, maxBlockHeight: BigInt(a.blockHeight!) + DELEGATE_TTL_BLOCKS, methods: ['add_message'] });
    expect(GUESTBOOK_GAS).toBe(10n * 10n ** 12n);

    // The same signed request again: the relay's nonce floor refuses it, and the SDK hands the card the reason.
    await expect(near.relay({ network: 'testnet', signedDelegateAction })).rejects.toMatchObject({ code: 4100, data: { status: 409, reason: 'delegate_nonce_used' } });
  });

  it('before the vault has recorded the account: 409 near_account_unrecorded, as the card retries on', async () => {
    const { app } = await vaultSetup();
    const accountId = hex(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))));
    const { near } = sdk(app, accountId);
    await expect(near.activate()).rejects.toMatchObject({ code: 4100, data: { status: 409, reason: 'near_account_unrecorded' } });
  });

  it("refuses the page's delegate on an env whose cap is below the page's gas", async () => {
    const { app } = await vaultSetup();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const accountId = hex(ed25519.getPublicKey(seed));
    known.add(`${app.scope}#${accountId}`);
    const delegate = addMessageDelegate({ accountId, guestbook: GUESTBOOK, text: 'gm', nonce: 900_000_001n, blockHeight: 1000n });
    const { signedDelegateAction } = signNearDelegateAction(seed, delegate);
    const res = await call('/v1/near/relay', {
      headers: { 'x-hana-key': app.key, origin: ORIGIN },
      body: { network: 'testnet', signedDelegateAction },
      env: { NEAR_RELAY: JSON.stringify({ account: RELAY_ACCOUNT, receivers: [GUESTBOOK], maxGasTgas: 5 }) },
    });
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([403, 'gas_too_high']);
    expect(env.NETWORK).toBe('testnet');
  });
});
