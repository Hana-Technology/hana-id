import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode, sha256 } from '../src/bytes.ts';
import { RELAY_READS_PER_IP_MINUTE, RELAY_TOMBSTONE_MS, RELAY_TTL_MS, RELAY_WRITES_PER_IP_MINUTE } from '../src/login-relay.ts';
import worker from '../src/index.ts';
import { ORIGIN, call } from './helpers.ts';
import { AUTH, VAULT } from './login-helpers.ts';

afterEach(() => vi.restoreAllMocks());

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** A read key and its relayId, as the vault makes them. */
async function newRelay(): Promise<{ id: string; readKey: string }> {
  const key = random(32);
  return { id: base64UrlEncode(await sha256(key)), readKey: base64UrlEncode(key) };
}

const value = (ctBytes = 64): { iv: string; ct: string } => ({ iv: base64UrlEncode(random(12)), ct: base64UrlEncode(random(ctBytes)) });

const write = (id: string, payload: unknown, origin: string | null = AUTH, ip?: string): Promise<Response> =>
  call(`/v1/login-relay/${id}`, { method: 'POST', headers: { ...(origin ? { origin } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: payload });

const read = (id: string, readKey: string | null, opts: { origin?: string | null; wait?: string; ip?: string } = {}): Promise<Response> => {
  const origin = opts.origin === undefined ? VAULT : opts.origin;
  const query = opts.wait === undefined ? '' : `?wait=${opts.wait}`;
  return call(`/v1/login-relay/${id}${query}`, {
    method: 'GET',
    headers: { ...(origin ? { origin } : {}), ...(readKey ? { 'x-hana-relay-key': readKey } : {}), ...(opts.ip ? { 'cf-connecting-ip': opts.ip } : {}) },
  });
};

const slotOf = (id: string) => env.LOGIN_RELAY.get(env.LOGIN_RELAY.idFromName(id));
const stored = (id: string): Promise<unknown> => runInDurableObject(slotOf(id), (_o, state) => state.storage.kv.get('slot'));

describe('login relay', () => {
  it('writes once and reads once with the read key (410 after, from the tombstone)', async () => {
    const r = await newRelay();
    const v = value();
    const first = await write(r.id, v);
    expect(first.status).toBe(204);
    expect(first.headers.get('access-control-allow-origin')).toBe(AUTH);
    const second = await write(r.id, value());
    expect([second.status, (await body(second)).code]).toEqual([409, 'relay_used']);

    const got = await read(r.id, r.readKey);
    expect(got.status).toBe(200);
    expect(got.headers.get('access-control-allow-origin')).toBe(VAULT);
    const b = await body(got);
    expect(b).toEqual({ iv: v.iv, ct: v.ct, serverTimeMs: expect.any(Number), requestId: expect.any(String) });
    const again = await read(r.id, r.readKey);
    expect([again.status, (await body(again)).code]).toEqual([410, 'relay_gone']);
    expect(await stored(r.id)).toMatchObject({ state: 'consumed' });
    // Still written: a later write can't refill it.
    expect((await write(r.id, value())).status).toBe(409);
  });

  it('without the read key, or with a wrong one: 403, and the slot stays readable', async () => {
    const r = await newRelay();
    const other = await newRelay();
    await write(r.id, value());
    for (const key of [null, other.readKey, r.id, 'x'.repeat(43), `${r.readKey}A`]) {
      const res = await read(r.id, key);
      expect([res.status, (await body(res)).code], String(key)).toEqual([403, 'relay_forbidden']);
    }
    expect((await read(r.id, r.readKey)).status).toBe(200);
  });

  it('an empty slot answers 204 (after `wait`), and a read never creates state', async () => {
    const r = await newRelay();
    expect((await read(r.id, r.readKey)).status).toBe(204);
    const started = Date.now();
    expect((await read(r.id, r.readKey, { wait: '1' })).status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(await stored(r.id)).toBeUndefined();
  });

  it('the long poll returns as soon as the slot is written', async () => {
    const r = await newRelay();
    const v = value();
    const started = Date.now();
    const pending = read(r.id, r.readKey, { wait: '20' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await write(r.id, v)).status).toBe(204);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ iv: v.iv, ct: v.ct });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('two waiting readers: exactly one gets the value', async () => {
    const r = await newRelay();
    const a = read(r.id, r.readKey, { wait: '10' });
    const b = read(r.id, r.readKey, { wait: '10' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await write(r.id, value());
    expect([(await a).status, (await b).status].sort()).toEqual([200, 410]);
  });

  it('120 s after the write the value is gone (tombstone, 410), 120 s later everything is deleted', async () => {
    const r = await newRelay();
    const at = Date.now();
    await write(r.id, value());
    const alarm = await runInDurableObject(slotOf(r.id), (_o, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(at + RELAY_TTL_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + RELAY_TTL_MS);

    expect(await runDurableObjectAlarm(slotOf(r.id))).toBe(true);
    const tomb = (await stored(r.id)) as Record<string, unknown>;
    expect(tomb).toEqual({ state: 'expired', expiredAt: expect.any(Number) });
    expect(JSON.stringify(tomb)).not.toMatch(/"(iv|ct)"/u);
    const next = await runInDurableObject(slotOf(r.id), (_o, state) => state.storage.getAlarm());
    expect(next).toBe((tomb.expiredAt as number) + RELAY_TOMBSTONE_MS);
    const gone = await read(r.id, r.readKey);
    expect([gone.status, (await body(gone)).code]).toEqual([410, 'relay_gone']);
    expect((await write(r.id, value())).status).toBe(409);

    expect(await runDurableObjectAlarm(slotOf(r.id))).toBe(true);
    expect(await stored(r.id)).toBeUndefined();
    expect(await runInDurableObject(slotOf(r.id), (_o, state) => state.storage.getAlarm())).toBeNull();
  });

  it('a value past its TTL is gone even before the alarm runs; a consumed value also expires to a tombstone', async () => {
    const r = await newRelay();
    await write(r.id, value());
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + RELAY_TTL_MS + 1);
    expect((await read(r.id, r.readKey)).status).toBe(410);
    vi.restoreAllMocks();

    const c = await newRelay();
    await write(c.id, value());
    expect((await read(c.id, c.readKey)).status).toBe(200);
    await runDurableObjectAlarm(slotOf(c.id));
    expect(await stored(c.id)).toMatchObject({ state: 'expired' });
  });

  it('only authOrigin writes; only vaultOrigin and authOrigin read', async () => {
    const r = await newRelay();
    for (const origin of [VAULT, ORIGIN, null]) {
      const res = await write(r.id, value(), origin);
      expect([res.status, (await body(res)).code], String(origin)).toEqual([403, 'origin_not_allowed']);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(await stored(r.id)).toBeUndefined();
    await write(r.id, value());
    for (const origin of [ORIGIN, null]) {
      const res = await read(r.id, r.readKey, { origin });
      expect([res.status, (await body(res)).code]).toEqual([403, 'origin_not_allowed']);
    }
    // The export window (authOrigin) reads its own relay.
    expect((await read(r.id, r.readKey, { origin: AUTH })).status).toBe(200);
  });

  it('checks relayId, the body and `wait`', async () => {
    const r = await newRelay();
    for (const id of [r.id.slice(1), `${r.id}A`, `${r.id.slice(1)}=`, `${r.id.slice(1)}/`]) {
      expect((await body(await write(id, value()))).code, id).toBe('bad_relay_id');
      expect((await body(await read(id, r.readKey))).code, id).toBe('bad_relay_id');
    }
    const bad: unknown[] = [
      {},
      { iv: value().iv },
      { ...value(), extra: 1 },
      { iv: base64UrlEncode(random(11)), ct: value().ct },
      { iv: value().iv, ct: base64UrlEncode(random(15)) },
      { iv: value().iv, ct: 'not base64!' },
      { iv: 12, ct: value().ct },
      [value()],
    ];
    for (const payload of bad) {
      const res = await write(r.id, payload);
      expect([res.status, (await body(res)).code], JSON.stringify(payload)).toEqual([400, 'bad_request']);
    }
    const tooBig = await write(r.id, value(8 * 1024));
    expect([tooBig.status, (await body(tooBig)).code]).toEqual([413, 'bad_request']);
    expect(await stored(r.id)).toBeUndefined();
    for (const wait of ['0', '26', '1.5', 'x', '-1', '']) {
      expect((await read(r.id, r.readKey, { wait })).status, wait).toBe(400);
    }
    await write(r.id, value());
    expect((await read(r.id, r.readKey, { wait: '25' })).status).toBe(200);
  });

  it('rate limits per IP: writes 10 per minute, reads 120 per minute', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let i = 0; i <= RELAY_WRITES_PER_IP_MINUTE; i++) statuses.push((await write((await newRelay()).id, value(), AUTH, ip)).status);
    expect(statuses).toEqual([...Array(RELAY_WRITES_PER_IP_MINUTE).fill(204), 429]);
    const r = await newRelay();
    const reads: number[] = [];
    for (let i = 0; i <= RELAY_READS_PER_IP_MINUTE; i++) reads.push((await read(r.id, r.readKey, { ip })).status);
    expect(reads.slice(0, RELAY_READS_PER_IP_MINUTE).every((s) => s === 204)).toBe(true);
    const limited = await read(r.id, r.readKey, { ip });
    expect([limited.status, (await body(limited)).code]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('routing: preflight for the Hana origins only, 405 for other methods', async () => {
    const r = await newRelay();
    for (const origin of [VAULT, AUTH]) {
      const pre = await call(`/v1/login-relay/${r.id}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-hana-relay-key' } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe(origin);
      expect(pre.headers.get('access-control-allow-headers')).toContain('x-hana-relay-key');
    }
    expect((await call(`/v1/login-relay/${r.id}`, { method: 'OPTIONS', headers: { origin: ORIGIN } })).status).toBe(403);
    expect((await call(`/v1/login-relay/${r.id}`, { method: 'PUT', headers: { origin: AUTH }, rawBody: '{}' })).status).toBe(405);
  });

  it('never logs the body, the read key or the relay id', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const r = await newRelay();
    const v = value();
    await write(r.id, v);
    await write(r.id, v);
    await read(r.id, 'A'.repeat(43));
    await read(r.id, r.readKey);
    await read(r.id, r.readKey);
    const all = lines.join('\n');
    expect(lines.filter((l) => l.includes('"endpoint":"/v1/login-relay"'))).toHaveLength(5);
    for (const secret of [v.iv, v.ct, r.readKey, r.id]) expect(all).not.toContain(secret);
  });

  it('an error outside the handler’s own checks (a body stream that fails) is logged without the relay id', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const r = await newRelay();
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`client went away ${r.id}`));
      },
    });
    const request = new Request(`https://api.test/v1/login-relay/${r.id}`, { method: 'POST', headers: { origin: AUTH, 'content-type': 'application/json', 'cf-connecting-ip': '10.9.9.9' }, body: failing });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(await body(res)).toMatchObject({ code: 'internal' });
    const errors = lines.filter((l) => l.includes('"code":"internal"'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"endpoint":"/v1/login-relay"');
    expect(lines.join('\n')).not.toContain(r.id);
  });

  it('503 relay_unavailable when the relay object can’t be reached, for a write and a read', async () => {
    const r = await newRelay();
    const broken = {
      idFromName: (name: string) => env.LOGIN_RELAY.idFromName(name),
      get: () => ({
        write: async () => {
          throw new Error('object unavailable');
        },
        read: async () => {
          throw new Error('object unavailable');
        },
      }),
    } as unknown as typeof env.LOGIN_RELAY;
    const w = await call(`/v1/login-relay/${r.id}`, { method: 'POST', headers: { origin: AUTH }, body: value(), env: { LOGIN_RELAY: broken } });
    expect([w.status, (await body(w)).code]).toEqual([503, 'relay_unavailable']);
    const g = await call(`/v1/login-relay/${r.id}`, { method: 'GET', headers: { origin: VAULT, 'x-hana-relay-key': r.readKey }, env: { LOGIN_RELAY: broken } });
    expect([g.status, (await body(g)).code]).toEqual([503, 'relay_unavailable']);
    // Nothing was written to the real slot.
    expect(await stored(r.id)).toBeUndefined();
  });
});
