// The derive/revoke pre-check: requests the contract would certainly refuse (replayed counter, use limit reached,
// counter past the limit) are rejected off-chain; anything that might succeed is still relayed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { heldCounters, sessionUseRejection } from '../src/session-use.ts';
import { type SessionView, TtlCache } from '../src/views.ts';
import { type Chain, appHeaders, call, chain, deriveBody, newSessionKey, revokeBody, seedApp, seedPlan, uid } from './helpers.ts';
afterEach(() => vi.restoreAllMocks());

const HOUR = 3_600_000;

describe('sessionUseRejection (the contract’s use_session / revoke_session rules)', () => {
  const now = 1_000_000;
  const session = (used: number, maxUses = 3): SessionView => ({ path: 's1#google#1#0', scope_id: 's1', expires_at_ms: now + HOUR, max_uses: maxUses, used });
  const code = (s: SessionView | null, method: 'derive_key' | 'revoke_session', counter: number, at = now): string | null =>
    sessionUseRejection(s, 's1', method, counter, at)?.code ?? null;

  it('passes counter = used + 1 and any counter ahead of it up to the last usable one', () => {
    expect(code(session(0), 'derive_key', 1)).toBeNull();
    expect(code(session(1), 'derive_key', 2)).toBeNull();
    // Ahead of used + 1: may succeed if the requests before it land first.
    expect(code(session(0), 'derive_key', 3)).toBeNull();
    expect(code(session(0), 'revoke_session', 1)).toBeNull();
    expect(code(session(0), 'revoke_session', 4)).toBeNull();
  });

  it('refuses a used counter (replay), with the next counter', () => {
    for (const method of ['derive_key', 'revoke_session'] as const) {
      expect(sessionUseRejection(session(2), 's1', method, 2, now)).toEqual({ status: 409, code: 'counter_used', error: expect.any(String), nextCounter: 3 });
      expect(code(session(2), method, 1)).toBe('counter_used');
    }
  });

  it('refuses derive_key once used = max_uses, but revoke_session still takes max_uses + 1', () => {
    expect(sessionUseRejection(session(3), 's1', 'derive_key', 4, now)).toEqual({ status: 409, code: 'session_exhausted', error: expect.any(String) });
    // The limit comes first, as in the contract: a replay of an exhausted session is reported as exhausted.
    expect(code(session(3), 'derive_key', 3)).toBe('session_exhausted');
    expect(code(session(3), 'revoke_session', 4)).toBeNull();
    expect(code(session(3), 'revoke_session', 3)).toBe('counter_used');
  });

  it('refuses a counter no later request can reach (past max_uses, or max_uses + 1 for revoke)', () => {
    expect(sessionUseRejection(session(0), 's1', 'derive_key', 4, now)).toEqual({ status: 409, code: 'counter_out_of_range', error: expect.any(String), nextCounter: 1 });
    expect(code(session(0), 'revoke_session', 5)).toBe('counter_out_of_range');
  });

  it('refuses a missing, foreign or expired session first', () => {
    expect(code(null, 'derive_key', 1)).toBe('unknown_session');
    expect(sessionUseRejection({ ...session(0), scope_id: 's2' }, 's1', 'derive_key', 1, now)?.code).toBe('scope_mismatch');
    expect(code(session(0), 'derive_key', 1, now + HOUR)).toBe('unknown_session');
    expect(code(session(0), 'revoke_session', 1, now + HOUR)).toBe('unknown_session');
  });
});

describe('TtlCache.update', () => {
  it('replaces an unexpired value and keeps its expiry; no-op when missing or expired', () => {
    const cache = new TtlCache<number>(10_000);
    cache.set('a', 1, 0);
    cache.update('a', (v) => v + 1, 9_000);
    expect(cache.get('a', 9_000)).toBe(2);
    expect(cache.get('a', 10_000)).toBeUndefined();
    cache.update('missing', () => 5, 0);
    expect(cache.get('missing', 0)).toBeUndefined();
    cache.set('b', 1, 0);
    cache.update('b', () => 7, 10_000);
    expect(cache.get('b', 0)).toBe(1);
  });
});

describe('POST /v1/derive and /v1/sessions/revoke: counter and use-limit pre-check', () => {
  async function setup(maxUses = 10) {
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 1000);
    const app = await seedApp({ plan });
    const near = chain({});
    const spk = newSessionKey();
    near.sessions.set(JSON.stringify(spk), { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: Date.now() + HOUR, max_uses: maxUses, used: 0 });
    const derive = async (counter: number, extra: Record<string, unknown> = {}) => call('/v1/derive', { headers: appHeaders(app), body: await deriveBody(spk, { counter, ...extra }) });
    const revoke = async (counter: number) => call('/v1/sessions/revoke', { headers: appHeaders(app), body: await revokeBody(spk, { counter }) });
    return { app, near, spk, derive, revoke };
  }
  const sessionViews = (near: Chain): number => near.viewCalls.filter((v) => v.method === 'get_session').length;
  const sentCounters = (near: Chain, method = 'derive_key'): unknown[] => near.sent.filter((t) => t.method === method).map((t) => t.args.counter);
  async function expectRejected(res: Response, status: number, code: string, nextCounter?: number): Promise<void> {
    expect(res.status).toBe(status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(code);
    expect(body.nextCounter).toBe(nextCounter);
  }

  it('rejects a replayed derive (409 counter_used) without relaying it, confirming on a fresh read', async () => {
    const { near, derive } = await setup();
    expect((await derive(1)).status).toBe(200);
    expect(sessionViews(near)).toBe(1);
    // The cache counted our own derive, so the replay is caught; it is re-read from chain before being refused.
    await expectRejected(await derive(1), 409, 'counter_used', 2);
    expect(sessionViews(near)).toBe(2);
    expect(sentCounters(near)).toEqual([1]);
    // The next counter still goes through.
    expect((await derive(2)).status).toBe(200);
    expect(sentCounters(near)).toEqual([1, 2]);
    expect(heldCounters()).toBe(0);
  });

  it('counts our own derives in the cached session without new reads, so a replay of any is caught', async () => {
    const { near, derive } = await setup();
    for (const counter of [1, 2, 3]) expect((await derive(counter)).status).toBe(200);
    expect(sessionViews(near)).toBe(1);
    await expectRejected(await derive(2), 409, 'counter_used', 4);
    expect(sentCounters(near)).toEqual([1, 2, 3]);
  });

  it('rejects derives once the use limit is reached (409 session_exhausted); revoke still works', async () => {
    const { near, derive, revoke } = await setup(2);
    expect((await derive(1)).status).toBe(200);
    expect((await derive(2)).status).toBe(200);
    await expectRejected(await derive(3), 409, 'session_exhausted');
    await expectRejected(await derive(2), 409, 'session_exhausted');
    expect(sentCounters(near)).toEqual([1, 2]);
    // revoke_session has no use limit: counter max_uses + 1 is relayed and succeeds.
    await expectRejected(await revoke(2), 409, 'counter_used', 3);
    expect((await revoke(3)).status).toBe(200);
    expect(near.sent.map((t) => t.method)).toEqual(['derive_key', 'derive_key', 'revoke_session']);
  });

  it('rejects a counter past the use limit (409 counter_out_of_range) but relays one merely ahead of used + 1', async () => {
    const { near, derive, revoke } = await setup(3);
    await expectRejected(await derive(4), 409, 'counter_out_of_range', 1);
    await expectRejected(await revoke(5), 409, 'counter_out_of_range', 1);
    expect(near.sent).toHaveLength(0);
    // Counter 3 with used 0 could succeed if 1 and 2 landed first: relayed (and here refused on chain).
    const ahead = await derive(3);
    expect(ahead.status).toBe(422);
    expect(sentCounters(near)).toEqual([3]);
  });

  it('rejects a replayed revoke (409 counter_used)', async () => {
    const { near, derive, revoke } = await setup();
    expect((await derive(1)).status).toBe(200);
    expect((await derive(2)).status).toBe(200);
    await expectRejected(await revoke(2), 409, 'counter_used', 3);
    expect(near.sent.map((t) => t.method)).toEqual(['derive_key', 'derive_key']);
  });

  it('relays a request whose counter another isolate advanced the session to (the cache is behind)', async () => {
    const { near, spk, derive } = await setup();
    expect((await derive(1)).status).toBe(200);
    // Derives 2 and 3 went through another isolate: this one's cache still says used 1.
    const key = JSON.stringify(spk);
    near.sessions.set(key, { ...near.sessions.get(key)!, used: 3 });
    expect((await derive(4)).status).toBe(200);
    // And a replay of one of theirs is caught on the fresh read.
    await expectRejected(await derive(3), 409, 'counter_used', 5);
    expect(sentCounters(near)).toEqual([1, 4]);
  });

  it('keeps a higher cached use count when the node read is behind our own derive', async () => {
    const { near, spk, derive } = await setup();
    expect((await derive(1)).status).toBe(200);
    // A lagging node still answers used 0 for the same session.
    const behind = near.views.get_session!;
    near.views.get_session = (a) => {
      const s = behind(a) as Record<string, unknown> | null;
      return s && JSON.stringify(a.session_public_key) === JSON.stringify(spk) ? { ...s, used: 0 } : s;
    };
    await expectRejected(await derive(1), 409, 'counter_used', 2);
    expect(sentCounters(near)).toEqual([1]);
  });

  it('never rejects on the cache alone: a session replaced after expiry is read fresh and relayed', async () => {
    const { app, near, spk, derive } = await setup();
    const at = (ms: number): void => {
      vi.spyOn(Date, 'now').mockReturnValue(ms);
    };
    const t0 = Date.now();
    const key = JSON.stringify(spk);
    near.sessions.set(key, { path: `${app.scope}#google#1#0`, scope_id: app.scope, expires_at_ms: t0 + 5_000, max_uses: 10, used: 0 });
    at(t0);
    expect((await derive(1)).status).toBe(200);
    // The session expired and the key opened a new one (used 0) through another isolate, within the 10 s cache.
    at(t0 + 6_000);
    near.sessions.set(key, { path: `${app.scope}#google#1#1`, scope_id: app.scope, expires_at_ms: t0 + HOUR, max_uses: 10, used: 0 });
    // The cache alone would say "expired" (and "counter 1 used"): the fresh read shows the new session.
    expect((await derive(1)).status).toBe(200);
    expect(sentCounters(near)).toEqual([1, 1]);
  });

  it('counting our own derive keeps the cache entry’s expiry, so a revocation elsewhere is seen ≤ 10 s after the read', async () => {
    const { near, spk, derive } = await setup();
    const at = (ms: number): void => {
      vi.spyOn(Date, 'now').mockReturnValue(ms);
    };
    const t0 = Date.now();
    at(t0);
    expect((await derive(1)).status).toBe(200);
    at(t0 + 9_000);
    expect((await derive(2)).status).toBe(200);
    expect(sessionViews(near)).toBe(1);
    const key = JSON.stringify(spk);
    near.sessions.set(key, { ...near.sessions.get(key)!, revoked: true });
    at(t0 + 10_500);
    await expectRejected(await derive(3), 404, 'unknown_session');
    expect(sentCounters(near)).toEqual([1, 2]);
  });

  it('drops a cached session the fresh read no longer finds (revoked elsewhere)', async () => {
    const { near, spk, derive } = await setup();
    expect((await derive(1)).status).toBe(200);
    const key = JSON.stringify(spk);
    near.sessions.set(key, { ...near.sessions.get(key)!, revoked: true });
    await expectRejected(await derive(1), 404, 'unknown_session');
    // Not served from the cache any more: the next request reads the chain again.
    const views = sessionViews(near);
    await expectRejected(await derive(2), 404, 'unknown_session');
    expect(sessionViews(near)).toBe(views + 1);
    expect(sentCounters(near)).toEqual([1]);
  });

  it('after a failed relay, reads the session from chain again for the next request', async () => {
    const { near, spk, derive } = await setup();
    expect((await derive(1)).status).toBe(200);
    // Revoked elsewhere: the cache doesn't know, so counter 2 is relayed and fails on chain...
    const key = JSON.stringify(spk);
    near.sessions.set(key, { ...near.sessions.get(key)!, revoked: true });
    expect((await derive(2)).status).toBe(422);
    // ...and the next request is judged on a fresh read, not relayed.
    await expectRejected(await derive(3), 404, 'unknown_session');
    expect(sentCounters(near)).toEqual([1, 2]);
  });

  it('fails with 502 near_unavailable when the confirming read fails', async () => {
    const { near, derive } = await setup();
    expect((await derive(1)).status).toBe(200);
    delete near.views.get_session;
    await expectRejected(await derive(1), 502, 'near_unavailable');
    expect(sentCounters(near)).toEqual([1]);
    expect(heldCounters()).toBe(0);
  });

  it('holds a second request for the same counter until the first is done, then judges it on the outcome', async () => {
    const { near, derive } = await setup();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    near.onSendTx = async () => {
      await gate;
      return undefined;
    };
    // Same counter, other BLS keys (a client retry or a racing copy): at most one can succeed on chain.
    const first = derive(1);
    await vi.waitFor(() => expect(heldCounters()).toBe(1));
    const second = derive(1, { pk1: 'bls12381g1:other' });
    await new Promise((r) => setTimeout(r, 20));
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    await expectRejected(b, 409, 'counter_used', 2);
    expect(sentCounters(near)).toEqual([1]);
    expect(heldCounters()).toBe(0);
  });

  it('relays the held request when the first one failed', async () => {
    const { near, derive } = await setup();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    near.onSendTx = async () => {
      await gate;
      return undefined;
    };
    const succeed = near.contract.derive_key!;
    let calls = 0;
    // The first attempt fails without using the session (e.g. out of gas before use_session).
    near.contract.derive_key = (a, tx) => (++calls === 1 ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Exceeded the prepaid gas.' } } } } } : succeed(a, tx));
    const first = derive(1);
    await vi.waitFor(() => expect(heldCounters()).toBe(1));
    const second = derive(1);
    await new Promise((r) => setTimeout(r, 20));
    open();
    expect((await first).status).toBe(422);
    expect((await second).status).toBe(200);
    expect(sentCounters(near)).toEqual([1, 1]);
  });

  it('does not hold requests for other counters', async () => {
    const { near, derive } = await setup();
    let sawTwo!: () => void;
    const two = new Promise<void>((resolve) => (sawTwo = resolve));
    near.onSendTx = async (tx) => {
      if (tx.args.counter === 2) sawTwo();
      else await two;
      return undefined;
    };
    // Counter 2 is relayed while 1 is still in flight (it lands first here, so it fails on chain and 1 succeeds).
    const [a, b] = await Promise.all([derive(1), derive(2)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(422);
    expect(sentCounters(near)).toEqual([2, 1]);
    expect(heldCounters()).toBe(0);
  });
});
