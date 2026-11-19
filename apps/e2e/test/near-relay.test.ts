// The shared NEAR relay mock (src/near-relay.ts): what the demo's and the stamps site's specs, and the hand-test
// browser (D880), answer on /v1/near/*. Driven here without a browser or a stack, with the stack's directory and chain
// stood in for.
import { base64Encode, encodeNearDelegateAction, encodeNearSignedDelegateAction, type NearAction } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import { NEAR_RELAY_ROUTE, NEAR_RELAY_SITES, NearRelay, type NearRelayDeps, type NearRelayEvent, RELAY_MAX_GAS, routeNearRelayer } from '../src/near-relay.ts';
import { API_URL, DEMO_ORIGIN, DEMO_PK, E2E_GUESTBOOK, E2E_STAMPS, STAMPS_ORIGIN, STAMPS_PK } from '../src/stack.ts';

const SENDER = 'ab'.repeat(32);
const utf8 = (s: string) => new TextEncoder().encode(s);

function signedDelegate(o: { receiverId: string; actions: NearAction[]; nonce?: bigint }): string {
  const bytes = encodeNearDelegateAction({ senderId: SENDER, receiverId: o.receiverId, actions: o.actions, nonce: o.nonce ?? 7n, maxBlockHeight: 100n, publicKey: { type: 'ed25519', bytes: new Uint8Array(32) } });
  return base64Encode(encodeNearSignedDelegateAction(bytes, { type: 'ed25519', bytes: new Uint8Array(64) }));
}

const call = (methodName: string, args: unknown, o: { gas?: bigint; deposit?: bigint } = {}): NearAction => ({ type: 'functionCall', methodName, args: utf8(JSON.stringify(args)), gas: o.gas ?? 3_000_000_000_000n, deposit: o.deposit ?? 0n });

/** A directory that holds the account once `recordedAfter` calls have asked, and a chain that logs its calls. */
function fakeStack(o: { recordedAfter?: number; panic?: string } = {}): NearRelayDeps & { calls: [string, Record<string, unknown>][] } {
  let asked = 0;
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    async recorded() {
      asked += 1;
      return asked > (o.recordedAfter ?? 0);
    },
    async chain(method, params) {
      calls.push([method, params]);
      if (method === 'e2e_stamps_collect') return { panic: o.panic ?? null };
      return { nonce: 1, blockHeight: 5 };
    },
  };
}

const post = (origin: string | null, key: string | null, path: string, body: unknown) => ({ method: 'POST', url: `${API_URL}${path}`, origin, key, body });

describe('the shared NEAR relay (src/near-relay.ts)', () => {
  it('the demo: activate, then add_message delivered to the guestbook, with the API’s CORS for the demo', async () => {
    const stack = fakeStack();
    const relay = new NearRelay(['demo'], { deps: stack });
    const pre = await relay.answer({ method: 'OPTIONS', url: `${API_URL}/v1/near/activate`, origin: DEMO_ORIGIN, key: null, body: null });
    expect(pre).toMatchObject({ status: 204, headers: NEAR_RELAY_SITES.demo.cors });
    const a = await relay.answer(post(DEMO_ORIGIN, DEMO_PK, '/v1/near/activate', { accountId: SENDER }));
    expect(a?.status).toBe(200);
    expect(a?.headers['access-control-allow-origin']).toBe(DEMO_ORIGIN);
    const r = await relay.answer(post(DEMO_ORIGIN, DEMO_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: E2E_GUESTBOOK, actions: [call('add_message', { text: 'gm' })] }) }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(r!.body)).toEqual({ transactionHash: expect.any(String), status: 'executed' });
    expect(relay.guestbook).toEqual(['gm']);
    expect(stack.calls).toEqual([
      ['e2e_near_activate', { account_id: SENDER }],
      ['e2e_guestbook_add', { account_id: SENDER, text: 'gm', nonce: '7' }],
    ]);
    expect(relay.problems).toEqual([]);
  });

  it('409 near_account_unrecorded (retry-after 2) until the directory holds the account, and for the first `unrecorded` calls (a refusal for either counts)', async () => {
    const relay = new NearRelay(['demo'], { deps: fakeStack({ recordedAfter: 1 }), unrecorded: 2 });
    const body = { accountId: SENDER };
    const first = await relay.answer(post(DEMO_ORIGIN, DEMO_PK, '/v1/near/activate', body));
    expect(first).toMatchObject({ status: 409, headers: { 'retry-after': '2' } });
    expect(JSON.parse(first!.body)).toMatchObject({ code: 'near_account_unrecorded', retryable: true });
    // Recorded now, but one forced refusal is left.
    expect((await relay.answer(post(DEMO_ORIGIN, DEMO_PK, '/v1/near/activate', body)))?.status).toBe(409);
    expect((await relay.answer(post(DEMO_ORIGIN, DEMO_PK, '/v1/near/activate', body)))?.status).toBe(200);
    expect(relay.refused).toEqual(['/v1/near/activate', '/v1/near/activate']);
  });

  it('the stamps site: collect delivered to the stamps contract; a panic is the API’s 422 contract_rejected', async () => {
    const stack = fakeStack({ panic: 'Arrival first' });
    const events: NearRelayEvent[] = [];
    const relay = new NearRelay(['stamps'], { deps: stack, onEvent: (e) => events.push(e) });
    const r = await relay.answer(post(STAMPS_ORIGIN, STAMPS_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: E2E_STAMPS, actions: [call('collect', { stamp: 'sponsored' })] }) }));
    expect(r?.status).toBe(422);
    expect(r?.headers['access-control-expose-headers']).toBe('retry-after');
    expect(JSON.parse(r!.body)).toMatchObject({ code: 'contract_rejected', status: 'failed', executor: E2E_STAMPS, error: 'Smart contract panicked: Arrival first' });
    expect(relay.stamps).toEqual([{ stamp: 'sponsored' }]);
    expect(stack.calls[0]).toEqual(['e2e_stamps_collect', { account_id: SENDER, args: '{"stamp":"sponsored"}', sponsored: true, nonce: '7' }]);
    expect(events.at(-1)).toMatchObject({ kind: 'relayed', site: 'stamps', panic: 'Arrival first' });
  });

  it('refuses what isn’t the site’s own call (400 e2e_relay_mismatch, kept in problems) and never reaches the chain', async () => {
    const stack = fakeStack();
    const relay = new NearRelay(['demo', 'stamps'], { deps: stack });
    const cases = [
      post(DEMO_ORIGIN, STAMPS_PK, '/v1/near/activate', { accountId: SENDER }),
      post(DEMO_ORIGIN, DEMO_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: 'other.testnet', actions: [call('add_message', { text: 'x' })] }) }),
      post(DEMO_ORIGIN, DEMO_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: E2E_GUESTBOOK, actions: [call('delete_all', {})] }) }),
      post(STAMPS_ORIGIN, STAMPS_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: E2E_STAMPS, actions: [call('collect', {}, { deposit: 1n })] }) }),
      post(STAMPS_ORIGIN, STAMPS_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: E2E_STAMPS, actions: [call('collect', {}, { gas: RELAY_MAX_GAS + 1n })] }) }),
      post(STAMPS_ORIGIN, STAMPS_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: E2E_STAMPS, actions: [call('collect', {}), call('collect', {})] }) }),
      post(STAMPS_ORIGIN, STAMPS_PK, '/v1/near/relay', { signedDelegateAction: 'not borsh' }),
      post(STAMPS_ORIGIN, STAMPS_PK, '/v1/near/relay', {}),
    ];
    for (const c of cases) {
      const a = await relay.answer(c);
      expect(a?.status, JSON.stringify(c.body)).toBe(400);
      expect(JSON.parse(a!.body).code).toBe('e2e_relay_mismatch');
    }
    expect(relay.problems).toHaveLength(cases.length);
    expect(stack.calls).toEqual([]);
  });

  it('a request from no site’s origin is left to the stack’s API (null: the route falls through)', async () => {
    const relay = new NearRelay(['demo'], { deps: fakeStack() });
    expect(await relay.answer(post('http://localhost:1', DEMO_PK, '/v1/near/activate', { accountId: SENDER }))).toBeNull();
    expect(await relay.answer(post(STAMPS_ORIGIN, STAMPS_PK, '/v1/near/activate', { accountId: SENDER }))).toBeNull();
    expect(await relay.answer(post(null, DEMO_PK, '/v1/near/activate', { accountId: SENDER }))).toBeNull();
  });

  it('intercept may hold a call or answer in the relay’s place (with the site’s CORS)', async () => {
    const stack = fakeStack();
    const relay = new NearRelay(['demo'], { deps: stack, intercept: async (kind) => (kind === 'relay' ? { status: 403, headers: { 'content-type': 'application/json' }, body: '{"code":"receiver_not_allowed"}' } : undefined) });
    expect((await relay.answer(post(DEMO_ORIGIN, DEMO_PK, '/v1/near/activate', { accountId: SENDER })))?.status).toBe(200);
    const r = await relay.answer(post(DEMO_ORIGIN, DEMO_PK, '/v1/near/relay', { signedDelegateAction: signedDelegate({ receiverId: E2E_GUESTBOOK, actions: [call('add_message', { text: 'no' })] }) }));
    expect(r).toMatchObject({ status: 403, headers: { 'access-control-allow-origin': DEMO_ORIGIN } });
    expect(relay.guestbook).toEqual([]);
  });

  it('routeNearRelayer routes exactly the API’s /v1/near/* on its target', async () => {
    const seen: unknown[] = [];
    await routeNearRelayer({ route: async (url: unknown) => void seen.push(url) } as never, ['demo']);
    expect(seen).toEqual([NEAR_RELAY_ROUTE]);
    expect(NEAR_RELAY_ROUTE).toBe(`${API_URL}/v1/near/*`);
  });
});
