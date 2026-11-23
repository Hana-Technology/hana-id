// D900 (piece 5 of D892): the vault reads a labelled NEAR contract's code hash for the approval window. Only for a NEAR
// request whose receiver a fresh label document describes; from each of the env's two providers on its own, at final
// finality; sent only when both answer the same canonical hash and neither names a global contract; anything else
// (one down, late, in disagreement, a global contract, an unknown account, one provider outside a local env) sends no
// code hash, so the window is plain. Never an error or a blocked request; at most PARTNER_LABELS_WAIT_MS once; kept
// NEAR_CODE_FRESH_MS (failures too).
import { type NearAction, base64Encode, encodeNearTransaction, nearHashString, nearImplicitPublicKey, sha256, toHex, utf8 } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NEAR_CODE_FRESH_MS, PARTNER_LABELS_FRESH_MS, PARTNER_LABELS_WAIT_MS, agreedCodeHash } from '../../src/vault/partner-labels.ts';
import { Browser, ENV, type Google, RPC_FALLBACK, type Tab, answer, google, login, makeConfig, openApproval, readyTab, waitLauncher } from './harness.ts';
import { PASSPHRASE, payment, stellarTx } from './chains.ts';

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

const CLUB = 'club.testnet';
const H = 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn';
const H2 = '9pjHDkQQ5j37cU8kiVcnebh22788f6vAkS5JAY1pSNvA';
const NEAR_DOC = JSON.stringify({
  schema: 'journear-labels/1',
  context: { near: { network: 'testnet', account: CLUB, codeHash: H } },
  display: { formats: { join: { call: { args: {} }, intent: { verb: 'join', object: 'the club' }, sentence: ['verb', 'object'], fields: [] } } },
});
const PAY_DOC = JSON.stringify({
  schema: 'journear-labels/1',
  context: { stellar: { networkPassphrase: PASSPHRASE } },
  metadata: { addressBook: [{ account: 'GBPSHAAJVSUHV6ITCTGS2ACKLXOUVOZUMBN5JCAHZMIEKZWS2IVRP5RS', name: 'Coffee Club till' }] },
  display: { formats: { payment: { call: { memo: 'none' }, intent: { verb: 'pay', object: 'the coffee' }, sentence: ['verb', 'object'], fields: [] } } },
});
let seq = 0;
const delivered = (text: string) => ({ id: `pl_C${++seq}`, changeId: `lc_D${seq}`, version: 'journear-labels/1', sha256: toHex(sha256(utf8(text))), text, effectiveSince: 1, previousEffectiveSince: null });
const BLOCK = sha256(utf8('a testnet block'));
const JOIN: NearAction = { type: 'functionCall', methodName: 'join', args: utf8('{}'), gas: 30_000_000_000_000n, deposit: 0n };

interface S {
  t: Tab;
  near: string;
  stellar: string;
}

async function session(o: { env?: typeof ENV; labels?: unknown[]; live?: boolean } = {}): Promise<S> {
  const browser = new Browser();
  browser.backend.app = { ...browser.backend.app, partnerLabels: o.labels ?? [delivered(NEAR_DOC), delivered(PAY_DOC)] };
  const t = await readyTab(browser, { googleJwk: g.jwk, sdk: '0.4.0', env: o.env ?? { ...ENV, rpcFallback: RPC_FALLBACK }, fakePerf: true, ...(o.live ? { config: makeConfig({ publishableKey: 'pk_live_1111111111111111111111' }) } : {}) });
  tabs.push(t);
  const { reply } = await login(t, g);
  const a = (reply.result as { addresses: { near: string; stellar: string } }).addresses;
  t.browser.backend.nearBlocks.add(nearHashString(BLOCK));
  for (let i = 0; i < 200 && t.browser.backend.calls.filter((c) => c.path === '/v1/app').length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 5));
  return { t, near: a.near, stellar: a.stellar };
}

const codeReads = (s: S) => s.t.browser.backend.rpcCalls.filter((c) => c.method === 'query' && c.params.request_type === 'view_account');

/** The user's own transaction calling `receiver` (the vault checks its block on both providers, D726). */
async function shown(s: S, receiver = CLUB, wait?: () => void, open?: ReturnType<typeof openApproval>) {
  const tx = encodeNearTransaction({ signerId: s.near, publicKey: { type: 'ed25519', bytes: nearImplicitPublicKey(s.near) }, nonce: 9n, receiverId: receiver, blockHash: BLOCK, actions: [JOIN] });
  const before = open ? open.posted.filter((p) => p.message.t === 'hana:approve-request').length : 0;
  const reply = s.t.request('near_signTransaction', { network: 'testnet', transaction: base64Encode(tx) });
  // A popup used in the last 15 s is reused (approvals.ts POPUP_REUSE_MS): the next request goes to it.
  let popup = open;
  if (!popup) {
    await waitLauncher(s.t, 'Review in Journear Passport');
    popup = openApproval(s.t);
  }
  wait?.();
  const m = await popup.next('hana:approve-request', before);
  return { reply, popup, m };
}

describe('the rule both providers must meet (agreedCodeHash)', () => {
  it('the same canonical hash from every provider, no global contract; anything else is none', () => {
    expect(agreedCodeHash([{ codeHash: H, global: false }, { codeHash: H, global: false }])).toBe(H);
    expect(agreedCodeHash([{ codeHash: H, global: false }])).toBe(H);
    for (const answers of [
      [],
      [{ codeHash: H, global: false }, { codeHash: H2, global: false }],
      [{ codeHash: H, global: false }, null],
      [{ codeHash: H, global: true }, { codeHash: H, global: false }],
      [{ codeHash: `${H} `, global: false }, { codeHash: `${H} `, global: false }],
      [{ codeHash: 42, global: false }],
      [{ codeHash: '1'.repeat(33), global: false }],
      [{ codeHash: undefined, global: false }],
    ]) {
      expect(agreedCodeHash(answers), JSON.stringify(answers)).toBeNull();
    }
  });

  it('kept as long as the labels themselves (10 s)', () => {
    expect(NEAR_CODE_FRESH_MS).toBe(PARTNER_LABELS_FRESH_MS);
    expect(NEAR_CODE_FRESH_MS).toBe(10_000);
  });
});

describe('the vault’s read', () => {
  it('both agree: the window gets the hash for the receiver, read on each provider at final finality', async () => {
    const s = await session();
    s.t.browser.backend.nearCode.set(CLUB, { codeHash: H });
    const { reply, popup, m } = await shown(s);
    expect(m.partnerLabels).toEqual([NEAR_DOC]);
    expect(m.partnerLabelFacts).toEqual({ near: { account: CLUB, codeHash: H } });
    const reads = codeReads(s);
    expect(reads.map((r) => r.endpoint).sort()).toEqual([ENV.rpc, RPC_FALLBACK].sort());
    for (const r of reads) expect(r.params).toEqual({ request_type: 'view_account', finality: 'final', account_id: CLUB });
    answer(s.t, popup, m, true);
    expect((await reply).error).toBeUndefined();
  });

  it.each([
    ['the providers disagree', (s: S) => s.t.browser.backend.rpcLies.set(RPC_FALLBACK, (b) => (b.params.request_type === 'view_account' ? { result: { code_hash: H2, global_contract_hash: null, global_contract_account_id: null } } : undefined))],
    ['one provider is down', (s: S) => s.t.browser.backend.rpcLies.set(RPC_FALLBACK, (b) => (b.params.request_type === 'view_account' ? { error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR' } } } : undefined))],
    ['a global contract', (s: S) => s.t.browser.backend.nearCode.set(CLUB, { codeHash: H, globalAccount: 'publisher.testnet' })],
    ['an account that doesn’t exist', (s: S) => s.t.browser.backend.nearCode.delete(CLUB)],
  ])('%s: labels but no code hash (the window is plain), never an error', async (_, set) => {
    const s = await session();
    s.t.browser.backend.nearCode.set(CLUB, { codeHash: H });
    set(s);
    const { reply, popup, m } = await shown(s);
    expect(m.partnerLabels).toEqual([NEAR_DOC]);
    expect(m).not.toHaveProperty('partnerLabelFacts');
    answer(s.t, popup, m, true);
    expect((await reply).error).toBeUndefined();
  });

  it('a provider that never answers: the request is shown after PARTNER_LABELS_WAIT_MS, without a code hash', async () => {
    const s = await session();
    s.t.browser.backend.nearCode.set(CLUB, { codeHash: H });
    const { popup, m } = await shown(s, CLUB, () => {
      s.t.browser.backend.rpcHang.add(RPC_FALLBACK);
      // The block check (before the popup) is done; only the code read hangs. The vault's own wait ends it.
      setTimeout(() => s.t.browser.timers.advance(PARTNER_LABELS_WAIT_MS), 20);
    });
    expect(m).not.toHaveProperty('partnerLabelFacts');
    answer(s.t, popup, m, false);
  });

  it('no read for a request to an account no document describes, nor for a Stellar request', async () => {
    const s = await session();
    s.t.browser.backend.nearCode.set('other.testnet', { codeHash: H });
    const near = await shown(s, 'other.testnet');
    // The app's NEAR documents go with every NEAR request (the window decides); no code hash for an undescribed account.
    expect(near.m.partnerLabels).toEqual([NEAR_DOC]);
    expect(near.m).not.toHaveProperty('partnerLabelFacts');
    answer(s.t, near.popup, near.m, false);
    await near.reply;
    const popup = near.popup;
    const reply = s.t.request('stellar_signTransaction', { xdr: stellarTx(s.stellar, [payment()]), networkPassphrase: PASSPHRASE });
    const m = await popup.next('hana:approve-request', 1);
    expect(m).not.toHaveProperty('partnerLabelFacts');
    answer(s.t, popup, m, false);
    await reply;
    expect(codeReads(s)).toHaveLength(0);
  });

  it('kept 10 s: a second request reads nothing; after that it reads again (a code change then reaches the window)', async () => {
    const s = await session();
    s.t.browser.backend.nearCode.set(CLUB, { codeHash: H });
    let r = await shown(s);
    answer(s.t, r.popup, r.m, false);
    await r.reply;
    expect(codeReads(s)).toHaveLength(2);
    s.t.browser.backend.nearCode.set(CLUB, { codeHash: H2 });
    r = await shown(s, CLUB, undefined, r.popup);
    expect(r.m.partnerLabelFacts).toEqual({ near: { account: CLUB, codeHash: H } });
    answer(s.t, r.popup, r.m, false);
    await r.reply;
    expect(codeReads(s)).toHaveLength(2);
    s.t.browser.timers.advance(NEAR_CODE_FRESH_MS);
    r = await shown(s, CLUB, undefined, r.popup);
    expect(r.m.partnerLabelFacts).toEqual({ near: { account: CLUB, codeHash: H2 } });
    expect(codeReads(s)).toHaveLength(4);
    answer(s.t, r.popup, r.m, false);
  });

  it('a failed read is kept too: one wait per 10 s, not one per request', async () => {
    const s = await session();
    s.t.browser.backend.rpcDown.add(RPC_FALLBACK);
    s.t.browser.backend.nearCode.set(CLUB, { codeHash: H });
    // The block check needs both providers too: let it pass on the fallback, then the code read fails there.
    s.t.browser.backend.rpcDown.delete(RPC_FALLBACK);
    s.t.browser.backend.rpcLies.set(RPC_FALLBACK, (b) => (b.params.request_type === 'view_account' ? { error: { name: 'TIMEOUT_ERROR', cause: { name: 'TIMEOUT_ERROR' } } } : undefined));
    let r = await shown(s);
    expect(r.m).not.toHaveProperty('partnerLabelFacts');
    answer(s.t, r.popup, r.m, false);
    await r.reply;
    const after = codeReads(s).length;
    r = await shown(s, CLUB, undefined, r.popup);
    expect(r.m).not.toHaveProperty('partnerLabelFacts');
    expect(codeReads(s)).toHaveLength(after);
    answer(s.t, r.popup, r.m, false);
  });

  it('an env with one provider outside local envs (a live app’s transaction): no read, no code hash', async () => {
    const s = await session({ env: { ...ENV }, live: true });
    s.t.browser.backend.nearCode.set(CLUB, { codeHash: H });
    const { popup, m } = await shown(s);
    expect(m.partnerLabels).toEqual([NEAR_DOC]);
    expect(m).not.toHaveProperty('partnerLabelFacts');
    expect(codeReads(s)).toHaveLength(0);
    answer(s.t, popup, m, false);
  });
});
