// NEAR in the vault (D720–D729): the account in the addresses (only for an SDK of 0.4.0 or later, D725), derived again
// at unlock (never stored), near_* signing behind the approval popup, the signer and network checks (D726), the
// delegate-action binding of test apps, and the NEAR key export's context.
import { ed25519 } from '@noble/curves/ed25519';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type NearAction,
  base64Decode,
  base64Encode,
  decodeNearSignedDelegateAction,
  decodeNearSignedTransaction,
  encodeNearDelegateAction,
  encodeNearTransaction,
  nearDelegateActionHash,
  nearHashString,
  nearImplicitPublicKey,
  nearPublicKeyString,
  nearTransactionHash,
  nearTransactionHashString,
  nep413Hash,
  nearDelegateNonce,
  encodeNep413Message,
  sha256,
  utf8,
} from '@hana-id/core';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { NEAR_DELEGATE_MAX_BLOCKS } from '../../src/vault/vault.ts';
import { NEAR_RELAYED_DELEGATE_RULE } from '../../src/vault/signing.ts';
import { APP_ID, Browser, ENV, type Google, RPC_FALLBACK, SCOPE, type Tab, answer, google, login, makeConfig, openApproval, readyTab, waitLauncher } from './harness.ts';

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

const SDK = '0.4.0';
const ENV2 = Object.freeze({ ...ENV, rpcFallback: RPC_FALLBACK });
const LIVE = 'pk_live_1111111111111111111111';
const BLOCK = sha256(utf8('a testnet block'));
const CALL: NearAction = { type: 'functionCall', methodName: 'add_message', args: utf8('{"text":"gm"}'), gas: 30_000_000_000_000n, deposit: 0n };

interface NearSession {
  t: Tab;
  addresses: { stellar: string; evm: string; near: string };
}

async function session(o: Parameters<typeof readyTab>[1] = {}, browser = new Browser()): Promise<NearSession> {
  const t = await readyTab(browser, { googleJwk: g.jwk, sdk: SDK, env: ENV2, ...o });
  tabs.push(t);
  const { reply } = await login(t, g);
  const addresses = (reply.result as { addresses: NearSession['addresses'] }).addresses;
  t.browser.backend.nearBlocks.add(nearHashString(BLOCK));
  return { t, addresses };
}

const key = (id: string) => ({ type: 'ed25519' as const, bytes: nearImplicitPublicKey(id) });

function txBytes(s: NearSession, over: { signer?: string; block?: Uint8Array; actions?: NearAction[] } = {}): Uint8Array {
  const signer = over.signer ?? s.addresses.near;
  return encodeNearTransaction({ signerId: signer, publicKey: key(s.addresses.near), nonce: 9n, receiverId: 'guestbook.testnet', blockHash: Uint8Array.from(over.block ?? BLOCK), actions: over.actions ?? [CALL] });
}

function delegateBytes(s: NearSession, over: { nonce?: bigint; maxBlockHeight?: bigint } = {}): Uint8Array {
  return encodeNearDelegateAction({
    senderId: s.addresses.near,
    receiverId: 'guestbook.testnet',
    actions: [CALL],
    nonce: over.nonce ?? nearDelegateNonce({ keyNonce: 276_000_000_000_000n, blockHeight: s.t.browser.backend.nearHeight }),
    maxBlockHeight: over.maxBlockHeight ?? BigInt(s.t.browser.backend.nearHeight + 600),
    publicKey: key(s.addresses.near),
  });
}

/** Sends a sign request and answers the approval popup; returns the request the popup was shown. */
async function approved(s: NearSession, method: string, params: unknown, approve = true) {
  const reply = s.t.request(method, params);
  await waitLauncher(s.t, 'Review in Hana');
  const popup = openApproval(s.t);
  const m = await popup.next('hana:approve-request');
  answer(s.t, popup, m, approve);
  return { m, reply: await reply };
}

describe('addresses (D725)', () => {
  it('an SDK of 0.4.0 gets near: the implicit account id of the derived key', async () => {
    const s = await session();
    expect(s.addresses.near).toMatch(/^[0-9a-f]{64}$/u);
    const status = (await s.t.request('hana_status')).result as { addresses: Record<string, string> };
    expect(status.addresses).toEqual(s.addresses);
    const changed = s.t.events.filter((e) => e.event === 'accountsChanged').at(-1)!.data as { addresses: Record<string, string> };
    expect(changed.addresses).toEqual(s.addresses);
  });

  it.each(['0.3.1', '0.3.0', '0.0.0'])('an SDK of %s gets exactly {stellar, evm}, as it was built against', async (sdk) => {
    const t = await readyTab(new Browser(), { googleJwk: g.jwk, sdk });
    tabs.push(t);
    const { reply } = await login(t, g);
    expect(Object.keys((reply.result as { addresses: object }).addresses).sort()).toEqual(['evm', 'stellar']);
    expect(Object.keys(((await t.request('hana_status')).result as { addresses: object }).addresses).sort()).toEqual(['evm', 'stellar']);
    for (const e of t.events.filter((x) => x.event === 'accountsChanged' && (x.data as { addresses: unknown }).addresses !== null)) {
      expect(Object.keys((e.data as { addresses: object }).addresses).sort()).toEqual(['evm', 'stellar']);
    }
  });

  it('the record keeps exactly {stellar, evm}; a reload derives NEAR again at unlock', async () => {
    const browser = new Browser();
    const s = await session({}, browser);
    const record = (await (await openRecordStore(browser.idb)).get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) as { addresses: object };
    expect(record.addresses).toEqual({ stellar: s.addresses.stellar, evm: s.addresses.evm });
    const again = await readyTab(browser, { googleJwk: g.jwk, sdk: SDK });
    tabs.push(again);
    expect((await again.ready()).addresses).toEqual(s.addresses);
    // An older SDK in a reloaded tab still gets the two addresses only.
    const old = await readyTab(browser, { googleJwk: g.jwk, sdk: '0.3.1' });
    tabs.push(old);
    expect((await old.ready()).addresses).toEqual({ stellar: s.addresses.stellar, evm: s.addresses.evm });
  });

  it('the wallet record sent to the API names Stellar and EVM only', async () => {
    const s = await session();
    const records = () => s.t.browser.backend.calls.filter((x) => x.path === '/v1/wallets/record');
    for (let i = 0; i < 200 && records().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(records().length).toBeGreaterThan(0);
    for (const c of records()) {
      expect(Object.keys((c.body as { wallets: object }).wallets).sort()).toEqual(['evm', 'stellar']);
    }
  });
});

describe('near_signTransaction', () => {
  it('shows a near_tx request from the NEAR account and signs exactly it', async () => {
    const s = await session();
    const tx = txBytes(s);
    const { m, reply } = await approved(s, 'near_signTransaction', { network: 'testnet', transaction: base64Encode(tx) });
    expect(m).toMatchObject({ kind: 'near_tx', chain: 'near', address: s.addresses.near, context: { nearNetwork: 'testnet' } });
    const r = reply.result as { signature: string; signedTransaction: string; hash: string };
    expect(r.hash).toBe(nearTransactionHashString(tx));
    expect(ed25519.verify(base64Decode(r.signature), nearTransactionHash(tx), nearImplicitPublicKey(s.addresses.near))).toBe(true);
    const signed = decodeNearSignedTransaction(base64Decode(r.signedTransaction));
    expect(signed.transactionLength).toBe(tx.length);
    expect(base64Encode(signed.signature.bytes)).toBe(r.signature);
  });

  it('a rejection signs nothing (4001)', async () => {
    const s = await session();
    expect((await approved(s, 'near_signTransaction', { network: 'testnet', transaction: base64Encode(txBytes(s)) }, false)).reply.error?.code).toBe(4001);
  });

  it('refuses a transaction from another account or key before any popup (4100)', async () => {
    const s = await session();
    const other = encodeNearTransaction({ signerId: s.addresses.near, publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(7) }, nonce: 1n, receiverId: 'x.testnet', blockHash: BLOCK, actions: [] });
    for (const transaction of [txBytes(s, { signer: 'alice.testnet' }), other]) {
      expect((await s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(transaction) })).error).toMatchObject({ code: 4100, message: 'The request names another address' });
    }
    expect((await s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(Uint8Array.of(1, 2, 3)) })).error).toMatchObject({ code: 4100, data: { reason: 'invalid_request' } });
    expect(s.t.launcher.label).toBeNull();
  });

  it('every app: a testnet claim must name a testnet block (fail closed when the RPC is down)', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE }) });
    const unknown = txBytes(s, { block: sha256(utf8('not a testnet block')) });
    expect((await s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(unknown) })).error).toMatchObject({ code: 4100, data: { reason: 'near_block_unknown', chain: 'near' } });
    s.t.browser.backend.rpcDown.add(ENV.rpc);
    s.t.browser.backend.rpcDown.add(RPC_FALLBACK);
    expect((await s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(txBytes(s)) })).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'near_rpc_unavailable' } });
  });

  it('a live app: a mainnet claim with a testnet block is refused; with another block it goes to the popup as the app’s claim', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE }) });
    expect((await s.t.request('near_signTransaction', { network: 'mainnet', transaction: base64Encode(txBytes(s)) })).error).toMatchObject({ code: 4100, data: { reason: 'near_network_mismatch' } });
    const { m, reply } = await approved(s, 'near_signTransaction', { network: 'mainnet', transaction: base64Encode(txBytes(s, { block: sha256(utf8('a mainnet block')) })) });
    expect(m.context).toEqual({ nearNetwork: 'mainnet' });
    expect(reply.error).toBeUndefined();
  });

  it('refuses a transaction that relays a delegate action (its signer pays the delegate’s deposits), before any popup', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE }) });
    const inner = { senderId: 'bob.testnet', receiverId: 'attacker.testnet', actions: [{ type: 'transfer', deposit: 10n ** 27n }] as NearAction[], nonce: 1n, maxBlockHeight: 5n, publicKey: { type: 'ed25519' as const, bytes: new Uint8Array(32).fill(4) } };
    const relaying = txBytes(s, { actions: [{ type: 'delegate', signedDelegate: { delegateAction: inner, signature: { type: 'ed25519', bytes: new Uint8Array(64) } } }] });
    const reply = await s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(relaying) });
    expect(reply.error).toEqual({ code: 4100, message: NEAR_RELAYED_DELEGATE_RULE, data: { reason: 'near_relayed_delegate' } });
    expect(s.t.launcher.label).toBeNull();
  });

  it('a test app: a block only one provider vouches for is refused', async () => {
    const s = await session({ env: ENV2 });
    s.t.browser.backend.rpcLies.set(RPC_FALLBACK, (b) => (b.method === 'block' ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } } : undefined));
    expect((await s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(txBytes(s)) })).error).toMatchObject({ code: 4100, data: { reason: 'near_block_unknown' } });
  });

  it('a test app: NEAR mainnet is refused at once (mainnet_not_allowed), whatever the block', async () => {
    const s = await session();
    expect((await s.t.request('near_signTransaction', { network: 'mainnet', transaction: base64Encode(txBytes(s, { block: sha256(utf8('m')) })) })).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_not_allowed', chain: 'near', network: 'mainnet' } });
  });
});

describe('near_signDelegateAction', () => {
  const withKey = (s: NearSession, nonce = 276_000_000_000_000) => s.t.browser.backend.nearKeys.set(`${s.addresses.near}|${nearPublicKeyString(nearImplicitPublicKey(s.addresses.near))}`, nonce);

  it('signs a delegate action bound to testnet under NEP-461’s prefix; the relayer’s SignedDelegateAction decodes', async () => {
    const s = await session();
    withKey(s);
    const da = delegateBytes(s);
    const { m, reply } = await approved(s, 'near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(da) });
    expect(m).toMatchObject({ kind: 'near_delegate', chain: 'near', address: s.addresses.near, context: { nearNetwork: 'testnet' } });
    const r = reply.result as { signature: string; signedDelegateAction: string };
    expect(ed25519.verify(base64Decode(r.signature), nearDelegateActionHash(da), nearImplicitPublicKey(s.addresses.near))).toBe(true);
    expect(decodeNearSignedDelegateAction(base64Decode(r.signedDelegateAction)).delegateAction.senderId).toBe(s.addresses.near);
  });

  it.each([
    ['the key is not on testnet', null, {}, 'near_key_unknown'],
    ['a used nonce', 276_999_950_000_000, { nonce: 276_999_950_000_000n }, 'near_delegate_nonce_used'],
    ['a nonce from an old height (the key’s nonce + 1, as near-api-js picks)', 276_000_000_000_000, { nonce: 276_000_000_000_001n }, 'near_delegate_nonce_stale'],
    ['a nonce just at the floor', 0, { nonce: (277_000_000n - BigInt(NEAR_DELEGATE_MAX_BLOCKS)) * 1_000_000n }, 'near_delegate_nonce_stale'],
    ['a nonce past height × 10^6', 0, { nonce: 277_000_000_000_000_000n }, 'near_delegate_nonce_too_large'],
    ['an expiry already passed', 0, { maxBlockHeight: 277_000_000n }, 'near_delegate_expiry'],
    ['an expiry too far ahead', 0, { maxBlockHeight: BigInt(277_000_000 + NEAR_DELEGATE_MAX_BLOCKS + 1) }, 'near_delegate_expiry'],
  ] as const)('a test app: refuses %s before any popup', async (_, nonce, over, reason) => {
    const s = await session();
    if (nonce !== null) withKey(s, nonce);
    const reply = await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(delegateBytes(s, over)) });
    expect(reply.error).toMatchObject({ code: 4100, data: { reason, chain: 'near' } });
    expect(s.t.launcher.label).toBeNull();
  });

  it('a test app: refuses when the testnet RPC can’t answer (fail closed), and mainnet at once', async () => {
    const s = await session();
    withKey(s);
    expect((await s.t.request('near_signDelegateAction', { network: 'mainnet', delegateAction: base64Encode(delegateBytes(s)) })).error).toMatchObject({ code: 4100, data: { reason: 'mainnet_not_allowed' } });
    s.t.browser.backend.rpcDown.add(ENV.rpc);
    s.t.browser.backend.rpcDown.add(RPC_FALLBACK);
    expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(delegateBytes(s)) })).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'near_rpc_unavailable' } });
  });

  it('a test app: every provider must agree (one lying provider can’t vouch for a key or a height)', async () => {
    const s = await session({ env: ENV2 });
    withKey(s);
    // The fallback reports a height far ahead: the nonce floor there refuses the action.
    s.t.browser.backend.rpcLies.set(RPC_FALLBACK, (b) => (b.params.request_type === 'view_access_key' ? { result: { nonce: 1, permission: 'FullAccess', block_height: 300_000_000, block_hash: '11111111111111111111111111111111' } } : undefined));
    expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(delegateBytes(s)) })).error).toMatchObject({ code: 4100, data: { reason: 'near_delegate_nonce_stale' } });
    // A fallback that doesn't know the key refuses too; one that doesn't answer fails closed.
    s.t.browser.backend.rpcLies.set(RPC_FALLBACK, (b) => (b.params.request_type === 'view_access_key' ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } } : undefined));
    expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(delegateBytes(s)) })).error).toMatchObject({ code: 4100, data: { reason: 'near_key_unknown' } });
    s.t.browser.backend.rpcLies.delete(RPC_FALLBACK);
    s.t.browser.backend.rpcDown.add(RPC_FALLBACK);
    expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(delegateBytes(s)) })).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'near_rpc_unavailable' } });
  });

  it('a live app’s delegate action needs no testnet key (its network is the app’s claim, shown as such)', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE }) });
    const { reply } = await approved(s, 'near_signDelegateAction', { network: 'mainnet', delegateAction: base64Encode(delegateBytes(s)) });
    expect(reply.error).toBeUndefined();
  });

  it('a test app: only calls and transfers to *.testnet accounts, refused before any RPC read or popup', async () => {
    const s = await session();
    withKey(s);
    const enc = (actions: NearAction[], receiverId = 'hana-id-guestbook-dev1.testnet') =>
      base64Encode(encodeNearDelegateAction({ senderId: s.addresses.near, receiverId, actions, nonce: nearDelegateNonce({ keyNonce: 0, blockHeight: s.t.browser.backend.nearHeight }), maxBlockHeight: BigInt(s.t.browser.backend.nearHeight + 600), publicKey: key(s.addresses.near) }));
    const reads = s.t.browser.backend.rpcCalls.length;
    const addKey: NearAction = { type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(9) }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } };
    expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: enc([CALL, addKey]) })).error).toMatchObject({ code: 4100, data: { reason: 'near_delegate_test_app_action', chain: 'near' } });
    for (const receiver of [s.addresses.near, 'guestbook.near']) {
      expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: enc([CALL], receiver) })).error).toMatchObject({ code: 4100, data: { reason: 'near_delegate_test_app_receiver' } });
    }
    expect(s.t.browser.backend.rpcCalls.length).toBe(reads);
    expect(s.t.launcher.label).toBeNull();
    // The hackathon demo's delegate passes.
    const { reply } = await approved(s, 'near_signDelegateAction', { network: 'testnet', delegateAction: enc([CALL]) });
    expect(reply.error).toBeUndefined();
  });

  it('a live app’s delegate action is not restricted to *.testnet calls', async () => {
    const s = await session({ config: makeConfig({ publishableKey: LIVE }) });
    const addKey: NearAction = { type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(9) }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } };
    const da = encodeNearDelegateAction({ senderId: s.addresses.near, receiverId: s.addresses.near, actions: [addKey], nonce: 1n, maxBlockHeight: 2n, publicKey: key(s.addresses.near) });
    const { reply } = await approved(s, 'near_signDelegateAction', { network: 'mainnet', delegateAction: base64Encode(da) });
    expect(reply.error).toBeUndefined();
  });

  it('a test app in an env with one NEAR provider fails closed (near_rpc_single_provider)', async () => {
    const s = await session({ env: ENV });
    withKey(s);
    expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(delegateBytes(s)) })).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'near_rpc_single_provider' } });
    expect((await s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(txBytes(s)) })).error).toMatchObject({ code: 'api_unavailable', data: { reason: 'near_rpc_single_provider' } });
  });

  it('refuses a delegate action from another sender (4100)', async () => {
    const s = await session();
    const other = encodeNearDelegateAction({ senderId: 'alice.testnet', receiverId: 'x.testnet', actions: [], nonce: 1n, maxBlockHeight: 1n, publicKey: key(s.addresses.near) });
    expect((await s.t.request('near_signDelegateAction', { network: 'testnet', delegateAction: base64Encode(other) })).error).toMatchObject({ code: 4100, message: 'The request names another address' });
  });
});

describe('near_signMessage (NEP-413)', () => {
  it('names no network (as SEP-53 and EIP-191 messages): a test app may sign it; the signature verifies', async () => {
    const s = await session();
    const nonce = base64Encode(new Uint8Array(32).fill(5));
    const { m, reply } = await approved(s, 'near_signMessage', { message: 'Sign in to Guestbook', recipient: 'guestbook.example', nonce });
    expect(m).toMatchObject({ kind: 'near_message', chain: 'near', context: {} });
    const r = reply.result as { accountId: string; publicKey: string; signature: string };
    expect(r.accountId).toBe(s.addresses.near);
    expect(r.publicKey).toBe(nearPublicKeyString(nearImplicitPublicKey(s.addresses.near)));
    const bytes = encodeNep413Message({ message: 'Sign in to Guestbook', nonce: new Uint8Array(32).fill(5), recipient: 'guestbook.example', callbackUrl: null });
    expect(ed25519.verify(base64Decode(r.signature), nep413Hash(bytes), nearImplicitPublicKey(s.addresses.near))).toBe(true);
  });
});

describe('NEAR key export (vault side)', () => {
  it('hana_export {chain: near} hands the export window the NEAR account', async () => {
    const s = await session();
    const reply = s.t.request('hana_export', { chain: 'near' });
    await waitLauncher(s.t, 'Export key in Hana');
    s.t.launcher.click();
    const w = s.t.opened.at(-1)!;
    s.t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w });
    expect(await w.next('hana:export-context')).toMatchObject({ chain: 'near', address: s.addresses.near });
    expect((await reply).result).toBeNull();
  });
});
