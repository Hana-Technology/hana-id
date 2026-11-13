// The stamps SITE's own code against the real stamps contract on a real node (D796, D800): apps/stamps' collector
// (`createCollector`: its reads, nonces, delegate actions, NEP-413 proof and own-fare transaction), the SDK's own
// `HanaNear` (its relay and activate calls and how it turns the API's refusals into errors), the API's relay code
// (decoder, policy with the manifest's gas cap, signature check, the relay transaction, `relayAnswerBody`), and the
// site's parsers and plain-words mapping, over the deployed wasm on near-sandbox. Only two things are stood in for:
// the vault's approval window (the test signs with the vault's own core signers after the vault's own request
// validation, `parsePortRequest`) and the HTTP hop to the API (the fake fetch calls the relay's code directly).
//
// The second test holds the e2e stack's contract model (apps/e2e/src/server/stamps-contract.ts) against the wasm: the
// same calls, relayed and direct, from an implicit and a named account, must give the same panics and the same
// passport, so the mocked contract the browser e2e runs against can't drift from the real one unnoticed.
//
// Needs the near-sandbox binary and the stamps wasm, as stamps.test.ts. Typechecked by tsconfig.site.json (DOM and
// Node, as the site and the SDK need; no Worker types).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROTOCOL_VERSION, base64Decode, base64Encode, encodeNep413Message, parsePortRequest } from '@hana-id/core';
import { signNearDelegateAction, signNearTransaction, signNep413Message } from '@hana-id/core/near';
import { actionCreators } from '@near-js/transactions';
import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HanaNear, type NearHost } from '../../../packages/web/src/client/near.ts';
import { DESERIALIZE_PANIC, StampsContract } from '../../e2e/src/server/stamps-contract.ts';
import { type CollectorClient, createCollector, newRpc } from '../../stamps/src/collector.ts';
import type { StampsConfig } from '../../stamps/src/config.ts';
import { errorInfo, plainMessage, relayTransaction } from '../../stamps/src/messages.ts';
import { CONTRACT_ERRORS, STAMP_IDS, isImplicitAccount, parsePassport, parseRecent, parseTotals } from '../../stamps/src/stamps.ts';
import { decodeSignedDelegate, nearPublicKeyString, policyRefusal, verifyDelegateSignature } from '../src/near/delegate.ts';
import { failedExecutor, failureText } from '../src/near/outcome.ts';
import { type RelayOutcome, relayAnswerBody } from '../src/near/relay-answer.ts';
import { implicitAccountKey } from '../src/near/relay-chain.ts';
import { nearRelayVar, parseNearRelayConfig } from '../src/near/relay-config.ts';
import type { FinalOutcome } from '../src/near/rpc.ts';
import { accessKeyNonce, assertSuccess, createAccount, finalBlock, implicitAccount, NEAR, relayTx, type Sandbox, sandboxBinary, send, signDelegate, type Signer, stampsWasm, startSandbox, TGAS, type User } from './sandbox.ts';

const bin = sandboxBinary();
const wasm = stampsWasm();
if ((!bin || !wasm) && process.env.HANA_SANDBOX_REQUIRED === '1') throw new Error(`${bin ? 'the stamps wasm' : 'the near-sandbox binary'} not found (run the contract and Rust sandbox tests first)`);

/** sandbox-dev's relay cap, from the manifest the site's build reads (the collector attaches exactly this). */
const MANIFEST = JSON.parse(readFileSync(new URL('../../../envs/sandbox-dev.json', import.meta.url), 'utf8')) as { near: { relay: { maxGasTgas: number } } };
const CAP_TGAS = MANIFEST.near.relay.maxGasTgas;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** The relayer key's result for a settled relay transaction (relayer-key.ts: a failure is 422 contract_rejected). */
function relayResult(out: FinalOutcome): RelayOutcome {
  const nearTx = (out as { transaction?: { hash?: string } }).transaction?.hash ?? '';
  const error = failureText(out);
  return error ? { ok: false, status: 422, code: 'contract_rejected', error, executor: failedExecutor(out), nearTx } : { ok: true, nearTx };
}

/** The panic message of a failed outcome (what follows NEAR's "Smart contract panicked: "), or null for success. */
function panicOf(out: FinalOutcome): string | null {
  const text = failureText(out);
  return text === null ? null : text.replace(/^Smart contract panicked: /u, '');
}

describe.skipIf(!bin || !wasm)('the stamps site against the real contract on near-sandbox (D796, D800)', () => {
  let sb: Sandbox;
  let relayer: Signer;
  let stamps: Signer;
  let relayConfig: NonNullable<ReturnType<typeof parseNearRelayConfig>>;

  beforeAll(async () => {
    sb = await startSandbox(bin!);
    relayer = await createAccount(sb, 'relayer', 50n * NEAR);
    stamps = await createAccount(sb, 'stamps', 5n * NEAR, wasm!);
    assertSuccess(await send(sb.rpc, stamps, stamps.accountId, [actionCreators.functionCall('new', {}, 30n * TGAS, 0n)]), 'new()');
    relayConfig = parseNearRelayConfig(nearRelayVar({ account: relayer.accountId, receivers: [stamps.accountId], maxGasTgas: CAP_TGAS }))!;
  }, 120_000);
  afterAll(() => sb?.stop());

  /** The API's /v1/near/activate and /v1/near/relay past their gates, on the relay's own code, answering as the API. */
  async function api(url: string, init: RequestInit): Promise<Response> {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    if (path === '/v1/near/activate') {
      const accountId = body.accountId!;
      const before = await implicitAccountKey(sb.rpc, accountId);
      if (before.kind === 'key') return json(200, { created: false, accountId, accessKeyNonce: before.nonce.toString(), blockHeight: Number(before.height) });
      const out = await relayTx(sb, relayer, accountId, { kind: 'activate', amount: 0n });
      const result = relayResult(out);
      if (!result.ok) {
        const a = relayAnswerBody(result, accountId);
        return json(a.status, a.body, a.headers);
      }
      const after = await implicitAccountKey(sb.rpc, accountId);
      return json(200, { created: true, accountId, accessKeyNonce: after.kind === 'key' ? after.nonce.toString() : null, blockHeight: after.kind === 'key' ? Number(after.height) : null, transactionHash: result.nearTx, nearTx: result.nearTx });
    }
    if (path === '/v1/near/relay') {
      const signed = base64Decode(body.signedDelegateAction!);
      const d = decodeSignedDelegate(signed);
      if (!d.ok) return json(400, { error: 'Not a signed delegate action', code: 'bad_delegate' });
      const refusal = policyRefusal(d.value, { receivers: relayConfig.receivers, maxGas: relayConfig.maxGas });
      if (refusal) return json(403, { error: 'refused', code: refusal.code });
      if (!(await verifyDelegateSignature(d.value))) return json(400, { error: 'bad signature', code: 'bad_delegate_signature' });
      const a = relayAnswerBody(relayResult(await relayTx(sb, relayer, d.value.senderId, { kind: 'delegate', signedDelegate: signed })), d.value.senderId);
      return json(a.status, a.body, a.headers);
    }
    return json(404, { code: 'not_found' });
  }

  /** The vault for one user once they approved: its request validation, then its own core signer with their key. */
  function vault(accountId: string, seed: Uint8Array): NearHost['request'] {
    return (async (method: string, params: unknown) => {
      const req = parsePortRequest({ v: PROTOCOL_VERSION, id: '1', method, params });
      if (!req) throw new Error(`the vault refuses ${method}`);
      const p = req.params as Record<string, string>;
      if (method === 'near_signDelegateAction') return signNearDelegateAction(seed, base64Decode(p.delegateAction!));
      if (method === 'near_signTransaction') return signNearTransaction(seed, base64Decode(p.transaction!));
      if (method === 'near_signMessage') {
        const signed = signNep413Message(seed, encodeNep413Message({ message: p.message!, nonce: base64Decode(p.nonce!), recipient: p.recipient!, callbackUrl: p.callbackUrl ?? null }));
        expect(signed.accountId).toBe(accountId);
        return signed;
      }
      throw new Error(`unexpected ${method}`);
    }) as NearHost['request'];
  }

  /** Fast-forwards the node until its final block time reaches `targetMs`. */
  async function advanceTo(targetMs: number): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const b = await sb.rpc.call<{ header: { timestamp_nanosec: string } }>('block', { finality: 'final' }, 8_000);
      const now = Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
      if (now >= targetMs) return;
      await sb.rpc.call('sandbox_fast_forward', { delta_height: Math.min(500, Math.max(5, Math.ceil((targetMs - now) / 1000))) }, 60_000);
    }
    throw new Error('the sandbox clock did not advance');
  }

  it("the site's collector, the SDK and the relay collect all six stamps; the site's parsers and messages read the real answers", async () => {
    const seed = new Uint8Array(randomBytes(32));
    const accountId = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    const config: StampsConfig = {
      environment: 'sandbox-dev',
      publishableKey: 'pk_test_sandbox',
      vaultOrigin: 'https://vault.test.invalid',
      apiUrl: 'https://api.test.invalid',
      near: { rpcUrl: sb.rpcUrl, rpcFallbackUrl: null, stamps: stamps.accountId, collectTgas: CAP_TGAS, explorer: null, faucet: null },
    };
    const host: NearHost = { nearAccountId: () => accountId, request: vault(accountId, seed), apiUrl: config.apiUrl, publishableKey: config.publishableKey, fetch: api as NearHost['fetch'] };
    const client = { near: new HanaNear(host), prepareApproval: () => ({ cancel: () => {} }) } as unknown as CollectorClient;
    const rpc = newRpc(config, (url, init) => fetch(url, init));
    const collector = createCollector({ config, client, rpc, clock: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: (n) => new Uint8Array(randomBytes(n)) });
    const stages: string[] = [];
    const collect = (stamp: (typeof STAMP_IDS)[number], note?: string) => collector.collect({ accountId, stamp, ...(note !== undefined ? { note } : {}) }, (s) => stages.push(s));
    const refusal = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => {
          throw new Error('expected a refusal');
        },
        (err: unknown) => err,
      );
      return { e, info: errorInfo(e), words: plainMessage(e, 'collect') };
    };

    // Arrival: the account doesn't exist yet; the collector activates it (the relay's zero transfer), then relays.
    const arrival = await collect('arrival');
    expect(arrival).toMatchObject({ status: 'done', created: true });
    for (const stamp of ['sponsored', 'signature'] as const) expect(await collect(stamp), stamp).toMatchObject({ status: 'done', created: false });
    const postcard = await collect('postcard', '  Greetings from near-sandbox 🌸 \u0085');
    expect(postcard).toMatchObject({ status: 'done', note: 'Greetings from near-sandbox 🌸' });

    // A refusal of a relayed stamp: the relay's 422 contract_rejected, through the SDK, in the site's words.
    const again = await refusal(collect('arrival'));
    expect(again.info.reason).toBe('contract_rejected');
    expect(again.info.message).toContain('ERR_ALREADY');
    expect(relayTransaction(again.e)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/u);
    expect(again.words).toBe(CONTRACT_ERRORS.ERR_ALREADY);
    const soon = await refusal(collect('layover'));
    expect(soon.words).toBe(CONTRACT_ERRORS.ERR_TOO_SOON);

    // Own fare: refused by the page while the account holds nothing; once funded, the user's own transaction (send_tx).
    expect((await refusal(collect('own_fare'))).info.code).toBe('near_not_enough_balance');
    assertSuccess(await send(sb.rpc, sb.root, accountId, [actionCreators.transfer(NEAR)]), 'fund the user');
    // The page reads at finality `final` (a block or two behind), and again on its 30 s timer: here, until it shows.
    await expect.poll(async () => (await collector.refresh(accountId)).balance, { timeout: 20_000, interval: 500 }).toBe(NEAR);
    expect(await collect('own_fare')).toMatchObject({ status: 'done' });
    // NEAR's own failure of a direct transaction carries the panic the site maps (once the key's new nonce is final).
    await new Promise((r) => setTimeout(r, 3000));
    await collector.refresh(accountId);
    const fareAgain = await refusal(collect('own_fare'));
    expect(fareAgain.info.code).toBe('stamps_contract_refused');
    expect(fareAgain.words).toBe(CONTRACT_ERRORS.ERR_ALREADY);

    // Layover after 120 s of block time (the page re-reads the block on its timer; here, explicitly).
    const raw = (await rpc.view(stamps.accountId, 'get_passport', { account_id: accountId })) as { stamps: { stamp: string; block_timestamp_ms: number }[] };
    await advanceTo(raw.stamps[0]!.block_timestamp_ms + 120_000);
    await collector.refresh(accountId);
    expect(await collect('layover')).toMatchObject({ status: 'done' });
    expect(stages).toContain('Sending it through Journear’s relayer, which pays the fee…');

    // The real answers: stamps in the order collected, `note` only on the postcard, `sponsored` on every stamp.
    const value = (await rpc.view(stamps.accountId, 'get_passport', { account_id: accountId })) as { account_id: string; stamps: Record<string, unknown>[] };
    expect(value.stamps.map((s) => s.stamp)).toEqual(['arrival', 'sponsored', 'signature', 'postcard', 'own_fare', 'layover']);
    expect(value.stamps.filter((s) => 'note' in s).map((s) => s.stamp)).toEqual(['postcard']);
    const passport = parsePassport(value, accountId);
    expect(passport?.stamps.map((s) => [s.stamp, s.sponsored])).toEqual([
      ['arrival', true],
      ['sponsored', true],
      ['own_fare', false],
      ['signature', true],
      ['postcard', true],
      ['layover', true],
    ]);
    expect(passport?.stamps.find((s) => s.stamp === 'postcard')?.note).toBe('Greetings from near-sandbox 🌸');
    const recent = parseRecent([await rpc.view(stamps.accountId, 'recent', { from_index: 0, limit: 50 }), await rpc.view(stamps.accountId, 'recent', { from_index: 50, limit: 50 })], isImplicitAccount);
    expect(recent.map((r) => r.stamp)).toEqual(['layover', 'own_fare', 'postcard', 'signature', 'sponsored', 'arrival']);
    expect(recent.every((r) => r.accountId === accountId)).toBe(true);
    expect(parseTotals(await rpc.view(stamps.accountId, 'totals', {}))).toEqual({ passports: 1, stamps: 6 });
    // The relayed stamps cost the user nothing: what it holds is the 1 NEAR less own_fare's fee.
    expect(await collector.refresh(accountId).then((p) => p.balance < NEAR && p.balance > NEAR - 10n ** 22n)).toBe(true);
  }, 240_000);

  it("the e2e stack's contract model answers every call as the wasm does", async () => {
    const model = new StampsContract(stamps.accountId);
    // An implicit account with its own NEAR (direct calls) that can also relay, and a named account.
    const user: User = implicitAccount();
    assertSuccess(await send(sb.rpc, sb.root, user.accountId, [actionCreators.transfer(NEAR)]), 'fund the implicit account');
    const named = await createAccount(sb, 'named', NEAR);
    const call = async (who: Signer, via: 'direct' | 'relay', args: Record<string, unknown>): Promise<void> => {
      const action = actionCreators.functionCall('collect', args, BigInt(CAP_TGAS) * TGAS, 0n);
      let out: FinalOutcome;
      if (via === 'direct') out = await send(sb.rpc, who, stamps.accountId, [action]);
      else {
        const u = who as User;
        const nonce = (await accessKeyNonce(sb.rpc, u.accountId, nearPublicKeyString(u.publicKey.data))) + 1n;
        const b = await finalBlock(sb.rpc);
        out = await relayTx(sb, relayer, u.accountId, { kind: 'delegate', signedDelegate: signDelegate(u, stamps.accountId, [action], nonce, BigInt(b.height + 100)) });
      }
      const real = panicOf(out);
      const mocked = model.collect(who.accountId, via === 'relay', args);
      const what = `${who.accountId.slice(0, 8)} ${via} ${JSON.stringify(args)}`;
      // near-sdk's deserialisation panic may say more after the model's sentence.
      if (mocked === DESERIALIZE_PANIC) expect(real, what).toMatch(/^Failed to deserialize input from JSON\./u);
      else expect(real, what).toBe(mocked);
    };
    const proof = { message: `Stamp my passport: ${user.accountId}`, nonce: base64Encode(new Uint8Array(32)), recipient: stamps.accountId, signature: base64Encode(new Uint8Array(64)) };
    const steps: [Signer, 'direct' | 'relay', Record<string, unknown>][] = [
      [user, 'direct', { stamp: 'nope' }],
      [user, 'direct', { stamp: 5 }],
      [user, 'direct', { stamp: 'sponsored' }],
      [user, 'direct', { stamp: 'postcard' }],
      [user, 'direct', { stamp: 'signature' }],
      [user, 'direct', { stamp: 'arrival', note: 'hi' }],
      [user, 'direct', { stamp: 'arrival', proof }],
      [user, 'direct', { stamp: 'arrival', note: null }],
      [user, 'direct', { stamp: 'arrival' }],
      [user, 'relay', { stamp: 'sponsored', proof: { message: 'x' } }],
      [user, 'direct', { stamp: 'sponsored' }],
      [user, 'relay', { stamp: 'own_fare' }],
      [user, 'relay', { stamp: 'sponsored' }],
      [user, 'relay', { stamp: 'sponsored' }],
      [user, 'direct', { stamp: 'postcard' }],
      [user, 'direct', { stamp: 'postcard', note: ' \u0085 ' }],
      [user, 'direct', { stamp: 'postcard', note: 'x'.repeat(141) }],
      [user, 'direct', { stamp: 'signature' }],
      [user, 'direct', { stamp: 'signature', proof }],
      [user, 'direct', { stamp: 'signature', note: 'hi' }],
      [user, 'direct', { stamp: 'layover' }],
      [user, 'direct', { stamp: 'own_fare' }],
      // Invisible, control and bidi characters are stored as given (the page neutralises them).
      [user, 'direct', { stamp: 'postcard', note: `﻿​‮\u0000${'​'.repeat(130)}` }],
      [user, 'direct', { stamp: 'postcard', note: 'again' }],
      [named, 'direct', { stamp: 'signature' }],
      [named, 'direct', { stamp: 'arrival' }],
      [named, 'direct', { stamp: 'signature' }],
      [named, 'direct', { stamp: 'signature', proof }],
      [named, 'direct', { stamp: 'own_fare' }],
    ];
    for (const [who, via, args] of steps) await call(who, via, args);
    for (const who of [user, named]) {
      const real = (await sb.rpc.view(stamps.accountId, 'get_passport', { account_id: who.accountId })) as { stamps: Record<string, unknown>[] };
      const mocked = model.view('get_passport', { account_id: who.accountId }) as { stamps: Record<string, unknown>[] };
      const shape = (list: Record<string, unknown>[]) => list.map(({ block_timestamp_ms: _t, ...rest }) => rest);
      expect(shape(real.stamps)).toEqual(shape(mocked.stamps));
    }
    expect(await sb.rpc.view(stamps.accountId, 'catalog', {})).toEqual(model.view('catalog', {}));
  }, 240_000);
});
