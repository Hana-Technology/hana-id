// D927 (docs/partner-platform-spec.md piece P3, A3 "The request", A5, A7, L7): the platform API's request
// authentication and admission. The vectors of the independent generator (packages/console-core/scripts/
// gen-platform-request-vectors.mjs) through the real handler, the high-S one verifying and the DER one refused; every
// refusal in A3's order with its code; the one parsed path; the method, content type, encoding and body rules; a
// replayed nonce; a request signed for another env; a body, path or header changed after signing; the identical 401 for
// every authentication failure; the failure-only per-IP window and a valid key behind a failing IP; the self-revoke
// with the switch off and while frozen; the platform's breaker apart from the console's; each route within its cost;
// the clock bounds; header shapes and sizes before any signature work; a key that stops between two requests; two keys
// of one org; signature malleability; the limiters failing; what is recorded and what is only counted; and that no
// platform request reaches anything beyond its own credential.
import { CONSOLE_ERROR_STATUS, PLATFORM_HEADERS_MAX, PLATFORM_REQUEST_LIMITS, b64url, fromB64url, fromHex, otherSValue, platformRequestMessage, utf8 } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admitMemberCall } from '../src/changes/guard.ts';
import { HotDb } from '../src/changes/db.ts';
import { isLocalTestEnv } from '../src/guarded/config.ts';
import { placedStub } from '../src/placement.ts';
import { DUMMY_KEY, PLATFORM_LIMITS, PLATFORM_WINDOWS, UNAUTHENTICATED_MESSAGE, ipPrefix, isPlatformPath, platformIpSubject } from '../src/platform/request.ts';
import { PLATFORM_ROUTES, platformRequestId } from '../src/platform/routes.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { ConsoleRpc } from '../src/rpc/console.ts';
import vectors from '../../../packages/console-core/test/platform-request-vectors.json' with { type: 'json' };
import { call } from './helpers.ts';
import worker from '../src/index.ts';
import routesSource from '../src/platform/routes.ts?raw';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { type Sent, callsOf, deliver, freeze, freshIp, freshNow, importProblems, keyPair, keyRow, platformProposal, read, seedKey, send, switchOff, switchOn } from './platform-helpers.ts';
import { type DbCount, countingDb, orgApp, rows } from './rpc-helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
afterEach(() => vi.restoreAllMocks());

const limiter = (name: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
/** Fills an IP's window of requests not admitted (as 30 failures would). */
async function failIp(ip: string, now: number) {
  const subject = `v4:${ip}`;
  for (let i = 0; i < PLATFORM_REQUEST_LIMITS.failuresPerIpPerMinute; i++) await limiter(`platform:ip:${subject}`).hit([...PLATFORM_WINDOWS.ip], now);
}
/** Fills a key's own overflow window for one IP subject (as 20 requests naming it from that full IP would). */
async function fillKeyOverflow(keyId: string, subject: string, now: number) {
  for (let i = 0; i < PLATFORM_REQUEST_LIMITS.overflowPerKeyPerMinute; i++) await placedStub(env, env.RATE_LIMITER, `platform:keyfail:${keyId}:${subject}`).hit([...PLATFORM_WINDOWS.overflow], now);
}
const events = (kind: string, org: string) => rows<{ id: string; detail_json: string }>('SELECT id, detail_json FROM security_events WHERE kind = ?1 AND org_id = ?2', kind, org);
const noCors = (headers: [string, string][]) => expect(headers.filter(([k]) => k.startsWith('access-control-'))).toEqual([]);

// ---- the independent vectors ----

describe('the vectors from the independent implementation', () => {
  it('through the real handler: GET verifies, the high-S one verifies, DER and another env are refused, a signed revoke stops the key', async () => {
    const jwk = vectors.key.jwk;
    const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', pub)) as ArrayBuffer);
    expect(Buffer.from(publicRaw).toString('hex')).toBe(vectors.key.publicKeyHex);
    // The vector key, in force an hour before the vectors' timestamp (a confirmation's bare write: any date).
    const k = await seedKey({ id: vectors.key.keyId, pair: { privateKey: undefined as unknown as CryptoKey, publicRaw, thumbprint: vectors.key.thumbprint }, activeFrom: vectors.timestampMs - HOUR });
    const now = vectors.timestampMs + 1000;
    const deliverCase = async (name: string) => {
      const c = vectors.cases.find((x) => x.name === name)!;
      const headers = new Headers(c.headers as Record<string, string>);
      headers.set('cf-connecting-ip', freshIp());
      return read(await deliver(new Request(`https://api.test${c.path}`, { method: c.method, headers, ...(c.method === 'POST' ? { body: c.body } : {}) }), now));
    };
    const get = await deliverCase('get');
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ keyId: k.id, orgId: k.org, scopes: [k.scope], thumbprint: vectors.key.thumbprint });
    const high = vectors.cases.find((c) => c.name === 'high_s')!;
    expect(high.highS).toBe(true);
    expect((await deliverCase('high_s')).status).toBe(200);
    for (const name of ['der', 'other_env_name', 'other_signer_account']) {
      const r = await deliverCase(name);
      expect(r.status, name).toBe(401);
      expect(r.body.code).toBe('unauthenticated');
    }
    // A replay of the GET vector: its nonce is held.
    expect((await deliverCase('get')).status).toBe(409);
    // The POST with an Idempotency-Key stops the key; the other POST then finds no key in force.
    const stop = await deliverCase('post_idempotency');
    expect(stop.status).toBe(200);
    expect(await keyRow(k.id)).toMatchObject({ status: 'revoked', revoked_by_kind: 'platform', revoked_by: k.id });
    expect((await deliverCase('post_body')).status).toBe(401);
  });

  it('the query vector: the API’s message for it is the generator’s and verifies (its route is piece P4’s)', async () => {
    const c = vectors.cases.find((x) => x.name === 'get_query')!;
    const h = c.headers as Record<string, string>;
    const msg = platformRequestMessage({ envName: env.ENV_NAME, signerAccount: env.SIGNER_ACCOUNT, method: 'GET', path: c.path, keyId: h['Journear-Key-Id']!, timestamp: h['Journear-Timestamp']!, nonce: h['Journear-Nonce']!, bodySha256Hex: c.bodySha256 });
    expect(msg).toBe(c.message);
    const pub = await crypto.subtle.importKey('jwk', vectors.key.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(h['Journear-Signature']!) as Uint8Array<ArrayBuffer>, utf8(msg) as Uint8Array<ArrayBuffer>)).toBe(true);
    // The test env's names are the vectors' (so the vectors above verify as this env).
    expect(vectors.env).toEqual({ envName: env.ENV_NAME, signerAccount: env.SIGNER_ACCOUNT });
  });
});

// ---- A3's checks, in order ----

describe('every refusal in A3’s order, with its code', () => {
  it('each check answers before the next one is looked at', async () => {
    const k = await seedKey();
    const now = freshNow();
    const bad = { signature: (s: string) => `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}` };

    // 1. The IP's window full and the key's own overflow full: 429, whatever else is wrong.
    const ip = freshIp();
    await failIp(ip, now);
    await fillKeyOverflow(k.id, `v4:${ip}`, now);
    let r: Omit<Sent, 'request'> = await send(k, { now, ip, method: 'PUT', path: '/v1/platform//x', headers: { origin: 'https://evil.example' } });
    expect([r.status, r.body.code, r.body.limit]).toEqual([429, 'rate_limited', 'platform:ip']);
    expect(Number(r.res.headers.get('retry-after'))).toBeGreaterThan(0);

    // 2. An Origin: 403 browser_refused, no CORS header, before the method or the path.
    r = await send(k, { now, method: 'PUT', path: '/v1/platform//x', headers: { origin: 'https://evil.example' } });
    expect([r.status, r.body.code]).toEqual([403, 'browser_refused']);
    noCors(r.headers);
    // 3. The method, then the path, then the route, then the body rules, then the authentication headers.
    r = await send(k, { now, method: 'PUT', path: '/v1/platform//x' });
    expect([r.status, r.body.code, r.res.headers.get('allow')]).toEqual([405, 'method_not_allowed', 'GET, POST']);
    r = await send(k, { now, path: '/v1/platform//x', headers: { 'journear-nonce': null } });
    expect([r.status, r.body.code]).toEqual([400, 'bad_request']);
    r = await send(k, { now, path: '/v1/platform/nothing', headers: { 'journear-nonce': null } });
    expect([r.status, r.body.code]).toEqual([404, 'not_found']);
    r = await send(k, { now, method: 'POST', path: '/v1/platform/credential', headers: { 'journear-nonce': null } });
    expect([r.status, r.body.code, r.res.headers.get('allow')]).toEqual([405, 'method_not_allowed', 'GET']);
    r = await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', headers: { 'content-type': 'text/plain', 'journear-nonce': null } });
    expect([r.status, r.body.code]).toEqual([400, 'bad_request']);
    // A malformed authentication header and a stale clock: the header first (401).
    r = await send(k, { now, timestampMs: now - 5 * MIN, headers: { 'journear-nonce': 'short' } });
    expect([r.status, r.body.code]).toEqual([401, 'unauthenticated']);
    // 4. A stale clock and a bad signature: the clock first, saying only the time.
    r = await send(k, { now, timestampMs: now - 61_000, ...bad });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: expect.any(String), code: 'stale_request', serverTimeMs: now, requestId: expect.any(String) });
    // 5. A bad signature with the switch off: 401 (the switch is answered only to a valid signature).
    await switchOff(k.org);
    r = await send(k, { now, ...bad });
    expect([r.status, r.body.code]).toEqual([401, 'unauthenticated']);
    // 6. The switch off, then a replayed nonce: platform_off. Then a frozen org: forbidden.
    const first = await send(k, { now, nonce: b64url(new Uint8Array(16).fill(9)) });
    expect([first.status, first.body.code]).toEqual([403, 'platform_off']);
    await switchOn(k.org);
    await freeze(k.org);
    r = await send(k, { now });
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    await switchOn(k.org);
    // 7. The nonce: the first use of that nonce wasn't admitted, so it was never reserved; once used, a replay is 409.
    const ok = await send(k, { now, nonce: b64url(new Uint8Array(16).fill(9)) });
    expect(ok.status).toBe(200);
    r = await read(await deliver(ok.request(), now));
    expect([r.status, r.body.code]).toEqual([409, 'request_replayed']);
    // 8. The key's minute: 60 admitted (600 ms apart, as the org's bucket refills), then 429 with the window's name.
    let t = now;
    for (let i = 1; i < PLATFORM_REQUEST_LIMITS.perKeyPerMinute; i++) expect((await send(k, { now: (t += 600) })).status).toBe(200);
    r = await send(k, { now: (t += 600) });
    expect([r.status, r.body.code, r.body.limit]).toEqual([429, 'rate_limited', 'platform:key:req:minute']);
    expect(r.res.headers.get('retry-after')).toBe(String(r.body.retryAfterS));
    // ... and a replay is still told it is a replay (7 before 8).
    r = await read(await deliver(ok.request(), now + 1000));
    expect(r.body.code).toBe('request_replayed');
  });

  it('a stale clock both ways: 60 s either side is accepted, a millisecond more is not', async () => {
    const k = await seedKey();
    const now = freshNow();
    for (const [skew, status] of [[-60_000, 200], [60_000, 200], [-60_001, 400], [60_001, 400]] as const) {
      const r = await send(k, { now, timestampMs: now + skew });
      expect(r.status, String(skew)).toBe(status);
      if (status === 400) expect(r.body).toMatchObject({ code: 'stale_request', serverTimeMs: now });
    }
  });

  it('a timestamp or a nonce of the wrong shape or size: 401, as any malformed authentication header', async () => {
    const k = await seedKey();
    const now = freshNow();
    const nonce = b64url(new Uint8Array(16).fill(255));
    const badHeaders: Record<string, string>[] = [
      { 'journear-timestamp': String(now).slice(1) },
      { 'journear-timestamp': `${now}0` },
      { 'journear-timestamp': `0${String(now).slice(1)}` },
      { 'journear-timestamp': `${now}.0` },
      { 'journear-nonce': nonce.slice(1) },
      { 'journear-nonce': `${nonce}A` },
      { 'journear-nonce': `${nonce.slice(0, 21)}B` },
      { 'journear-nonce': `${nonce}==` },
      { 'journear-nonce': b64url(new Uint8Array(32)) },
      { 'journear-key-id': 'pkc_short' },
      { 'journear-key-id': 'key_4Rm8Vq2Lz7Wx9Kd' },
      { 'journear-signature': 'A'.repeat(4096) },
    ];
    for (const h of badHeaders) {
      const r = await send(k, { now, headers: h });
      expect([r.status, r.body.code], JSON.stringify(h).slice(0, 80)).toEqual([401, 'unauthenticated']);
    }
    for (const missing of ['journear-key-id', 'journear-timestamp', 'journear-nonce', 'journear-signature']) {
      expect((await send(k, { now, headers: { [missing]: null } })).status, missing).toBe(401);
    }
  });
});

// ---- the path ----

describe('the one parsed path', () => {
  it('refuses an empty segment, an encoded slash or dot, a trailing slash, an empty or malformed query, and a query on a write', async () => {
    const k = await seedKey();
    const now = freshNow();
    for (const path of ['/v1/platform//credential', '/v1/platform/credential/', '/v1/platform/credential%2Frevoke', '/v1/platform%2Fcredential', '/v1/platform/%2E%2E', '/v1/platform/cred%65ntial', '/v1/platform', '/v1/platformcredential', '/v1/platform/credential?', '/v1/platform/credential?a', '/v1/platform/credential?A=1', '/v1/platform/credential?a=1&b=2&c=3&d=4&e=5']) {
      const r = await send(k, { now, path });
      expect([r.status, r.body.code], path).toEqual([400, 'bad_request']);
    }
    const w = await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke?reason=x' });
    expect([w.status, w.body.code]).toEqual([400, 'bad_request']);
    expect((await keyRow(k.id)).status).toBe('active');
  });

  it('`.` and `..` never reach the Worker as such (the URL parser resolves them); a request signed over them fails, and one escaping /v1/platform is another route', async () => {
    // The runtime's own parse (WHATWG URL) resolves dot segments, `%2E` included, before the Worker sees request.url.
    expect(new URL('https://api.test/v1/platform/./credential').pathname).toBe('/v1/platform/credential');
    expect(new URL('https://api.test/v1/platform/%2e/credential').pathname).toBe('/v1/platform/credential');
    expect(new URL('https://api.test/v1/platform/x/../credential').pathname).toBe('/v1/platform/credential');
    expect(new URL('https://api.test/v1/platform/../health').pathname).toBe('/v1/health');
    expect(isPlatformPath('/v1/health')).toBe(false);
    const k = await seedKey();
    const now = freshNow();
    // Signed over the dot path as the client wrote it: the API builds the message from the one parsed path, so it fails.
    for (const path of ['/v1/platform/./credential', '/v1/platform/x/../credential']) {
      const r = await send(k, { now, path });
      expect([r.status, r.body.code], path).toEqual([401, 'unauthenticated']);
    }
    // Resolving to the bare prefix: refused by the path rule.
    expect((await send(k, { now, path: '/v1/platform/x/..' })).status).toBe(400);
    // Through the router: every method and path under the prefix is the platform's to answer (no CORS, no 404 page).
    const res = await call('/v1/platform//credential', { method: 'GET' });
    expect(res.status).toBe(400);
    expect([...res.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });
});

// ---- the method, the content type, the encoding, the body ----

describe('the method, content type, encoding and body', () => {
  it('a PUT, DELETE, PATCH, HEAD or OPTIONS is 405; a non-JSON, encoded or oversized body is 400; a GET has no body', async () => {
    const k = await seedKey();
    const now = freshNow();
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const r = await send(k, { now, method });
      expect(r.status, method).toBe(405);
      if (method !== 'HEAD') expect(r.body.code).toBe('method_not_allowed');
    }
    const revoke = { now, method: 'POST', path: '/v1/platform/credential/revoke' } as const;
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'application/json;charset=utf-8', 'application/json; charset=latin1']) {
      expect((await send(k, { ...revoke, headers: { 'content-type': ct } })).status, ct).toBe(400);
    }
    expect((await send(k, { ...revoke, headers: { 'content-encoding': 'gzip' } })).status).toBe(400);
    expect((await send(k, { ...revoke, body: 'x'.repeat(16 * 1024 + 1) })).status).toBe(400);
    expect((await send(k, { now, headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await send(k, { now, headers: { 'content-encoding': 'identity' } })).status).toBe(400);
    expect((await send(k, { now, headers: { 'idempotency-key': 'abcdefgh' } })).status).toBe(400);
    expect((await send(k, { ...revoke, idempotencyKey: 'short' })).status).toBe(400);
    expect((await keyRow(k.id)).status).toBe('active');
  });

  it('a signed body that isn’t a JSON object is 400 after admission (and recorded); a bad reason too', async () => {
    const k = await seedKey();
    const now = freshNow();
    for (const body of ['not json', '[]', '"x"', 'null', 'ÿ']) {
      const r = await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body });
      expect([r.status, r.body.code], body).toEqual([400, 'bad_request']);
    }
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body: JSON.stringify({ reason: 'a\nb' }) })).status).toBe(400);
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body: JSON.stringify({ other: 1 }) })).status).toBe(400);
    expect((await keyRow(k.id)).status).toBe('active');
    expect((await callsOf(k.id)).map((c) => [c.status, c.code])).toEqual(Array(7).fill([400, 'bad_request']));
  });

  it('an oversized body and oversized headers are refused before any signature work', async () => {
    const k = await seedKey();
    const now = freshNow();
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    // A declared length over the limit: refused without reading.
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', headers: { 'content-length': String(16 * 1024 + 1) } })).status).toBe(400);
    // A streamed body (no length) over the limit: refused once it passes it.
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(1024).fill(32));
        c.close();
      },
    });
    const signed = await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body: '{}' });
    expect(signed.status).toBe(200); // (a first, valid request: the spies below count only the refused ones)
    verify.mockClear();
    importKey.mockClear();
    const req = signed.request();
    const headers = new Headers(req.headers);
    headers.delete('content-length');
    expect((await read(await deliver(new Request(req.url, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit), now))).status).toBe(400);
    // Headers past 16 KiB in all.
    const k2 = await seedKey();
    expect((await send(k2, { now, headers: { 'x-filler': 'a'.repeat(PLATFORM_HEADERS_MAX) } })).status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
    expect(importKey).not.toHaveBeenCalled();
  });
});

// ---- what a signature covers ----

describe('what the signature covers', () => {
  it('another env’s ENV_NAME or SIGNER_ACCOUNT, and a key pair not registered here, are refused', async () => {
    const k = await seedKey();
    const now = freshNow();
    expect((await send(k, { now, envName: 'sandbox-other' })).status).toBe(401);
    expect((await send(k, { now, signerAccount: 'signer.other.near' })).status).toBe(401);
    // The same request verifies when this env is the one it was signed for.
    expect((await send(k, { now, bindings: { ENV_NAME: 'sandbox-other' }, envName: 'sandbox-other' })).status).toBe(200);
    // A key of another env: its thumbprint and id were registered there, not here (each env has its own D1).
    const elsewhere = await keyPair();
    expect((await send({ id: 'pkc_7Hq2Vx9Lm4Rt8Kz', privateKey: elsewhere.privateKey }, { now })).status).toBe(401);
    // This key's id signed with another env's key pair.
    expect((await send(k, { now, signWith: elsewhere.privateKey })).status).toBe(401);
  });

  it('a body, path, query, Idempotency-Key, timestamp or nonce changed after signing is refused, and changes nothing', async () => {
    const k = await seedKey();
    const now = freshNow();
    const revoke = { now, method: 'POST', path: '/v1/platform/credential/revoke' } as const;
    expect((await send(k, { ...revoke, body: '{"reason":"b"}', signedBody: '{"reason":"a"}' })).status).toBe(401);
    expect((await send(k, { ...revoke, body: '{}', signedBody: '{} ' })).status).toBe(401);
    // Signed for the GET's path, sent to the revoke: refused, the key still in force.
    expect((await send(k, { ...revoke, signedPath: '/v1/platform/credential' })).status).toBe(401);
    expect((await send(k, { now, path: '/v1/platform/credential?x=1', signedPath: '/v1/platform/credential' })).status).toBe(401);
    expect((await send(k, { ...revoke, idempotencyKey: 'abcdefgh', headers: { 'idempotency-key': 'abcdefgi' } })).status).toBe(401);
    expect((await send(k, { ...revoke, headers: { 'idempotency-key': 'abcdefgi' } })).status).toBe(401);
    expect((await send(k, { now, headers: { 'journear-timestamp': String(now + 1) } })).status).toBe(401);
    expect((await send(k, { now, headers: { 'journear-nonce': b64url(new Uint8Array(16).fill(3)) } })).status).toBe(401);
    expect((await keyRow(k.id)).status).toBe('active');
    expect(await callsOf(k.id)).toEqual([]);
  });

  it('signature malleability: both S values verify; out-of-range, zero, swapped and DER forms are refused', async () => {
    const k = await seedKey();
    const now = freshNow();
    const flip = (s: string) => b64url(otherSValue(fromB64url(s)));
    expect((await send(k, { now, signature: flip })).status).toBe(200);
    const withS = (s: string, v: bigint) => {
      const raw = fromB64url(s);
      const out = new Uint8Array(64);
      out.set(raw.subarray(0, 32));
      out.set(fromHex(v.toString(16).padStart(64, '0')), 32);
      return b64url(out);
    };
    const zero = b64url(new Uint8Array(64));
    const swapped = (s: string) => {
      const raw = fromB64url(s);
      return b64url(Uint8Array.from([...raw.subarray(32), ...raw.subarray(0, 32)]));
    };
    const der = (s: string) => {
      const raw = fromB64url(s);
      const int = (b: Uint8Array) => {
        let v = [...b];
        while (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) v = v.slice(1);
        if (v[0]! & 0x80) v = [0, ...v];
        return [2, v.length, ...v];
      };
      const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
      return b64url(Uint8Array.from([0x30, body.length, ...body]));
    };
    for (const [name, f] of [['s = n', (s: string) => withS(s, N)], ['s = 0', (s: string) => withS(s, 0n)], ['all zero', () => zero], ['swapped', swapped], ['DER', der], ['padded', (s: string) => `${s}==`], ['standard alphabet', (s: string) => s.replace(/-/gu, '+').replace(/_/gu, '/') + (s.includes('-') || s.includes('_') ? '' : '+')]] as const) {
      const r = await send(k, { now, signature: f });
      expect(r.status, name).toBe(401);
    }
  });
});

// ---- the identical 401 ----

describe('one answer for every authentication failure', () => {
  it('unknown, stopped, expired, not yet in force, not announced, a bad signature, a malformed header: the same status, body and headers byte for byte, the same work', async () => {
    const now = freshNow();
    const live = await seedKey();
    const revoked = await seedKey();
    await env.DB.prepare("UPDATE platform_keys SET status = 'revoked', revoked_at = ?2, revoked_by_kind = 'hana', revoked_by = 'x' WHERE id = ?1").bind(revoked.id, Date.now()).run();
    const expired = await seedKey({ activeFrom: Date.now() - 366 * 24 * HOUR });
    const waiting = await seedKey({ state: 'pending' });
    const registered = await seedKey({ state: 'registered' });
    const stranger = { id: 'pkc_7Hq2Vx9Lm4Rt8Kq', privateKey: (await keyPair()).privateKey };
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const cases: [string, () => Promise<Awaited<ReturnType<typeof send>>>, boolean][] = [
      ['unknown key', () => send(stranger, { now, ray: 'same-ray' }), true],
      ['revoked key', () => send(revoked, { now, ray: 'same-ray' }), true],
      ['expired key', () => send(expired, { now, ray: 'same-ray' }), true],
      ['waiting key', () => send(waiting, { now, ray: 'same-ray' }), true],
      ['not announced', () => send(registered, { now, ray: 'same-ray' }), true],
      ['bad signature', () => send(live, { now, ray: 'same-ray', signWith: stranger.privateKey }), true],
      ['malformed signature', () => send(live, { now, ray: 'same-ray', signature: (s) => s.slice(1) }), false],
      ['missing nonce', () => send(live, { now, ray: 'same-ray', headers: { 'journear-nonce': null } }), false],
    ];
    const answers: { name: string; status: number; text: string; headers: [string, string][] }[] = [];
    for (const [name, f, crypto5] of cases) {
      verify.mockClear();
      importKey.mockClear();
      const r = await f();
      answers.push({ name, status: r.status, text: r.text, headers: r.headers });
      // Check 5's failures do the same work: one key import and one verification each, a known key or not.
      expect([importKey.mock.calls.length, verify.mock.calls.length], name).toEqual(crypto5 ? [1, 1] : [0, 0]);
    }
    for (const a of answers) {
      expect({ ...a, name: '' }, a.name).toEqual({ ...answers[0]!, name: '' });
    }
    expect(answers[0]!.status).toBe(401);
    expect(JSON.parse(answers[0]!.text)).toEqual({ error: UNAUTHENTICATED_MESSAGE, code: 'unauthenticated', requestId: 'same-ray' });
    expect(Object.fromEntries(answers[0]!.headers)).toEqual({ 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Journear-Signature', 'x-request-id': 'same-ray' });
    // Nothing of them is stored; the console's own 401 code is the same word.
    for (const k of [live, revoked, expired, waiting, registered]) expect(await callsOf(k.id)).toEqual([]);
    expect(CONSOLE_ERROR_STATUS.unauthenticated).toBe(401);
  });

  it('ten failed signatures in a minute for a known key raise one `platform_auth_failures` event; an unknown id raises none', async () => {
    const k = await seedKey();
    const now = freshNow();
    const other = (await keyPair()).privateKey;
    for (let i = 0; i < 12; i++) expect((await send(k, { now, signWith: other })).status).toBe(401);
    const ev = await events('platform_auth_failures', k.org);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.detail_json)).toMatchObject({ keyId: k.id, failures: 10 });
    const stranger = { id: 'pkc_7Hq2Vx9Lm4Rt8Kp', privateKey: other };
    for (let i = 0; i < 12; i++) await send(stranger, { now });
    expect(await rows("SELECT id FROM security_events WHERE kind = 'platform_auth_failures' AND detail_json LIKE ?1", `%${stranger.id}%`)).toEqual([]);
  });
});

// ---- the per-IP window (M2) ----

describe('the per-IP window counts only requests not admitted (M2)', () => {
  it('admitted requests never use it; failures fill it; past it only a key id announced here gets in, under its own overflow', async () => {
    const k = await seedKey();
    const now = freshNow();
    const ip = freshIp();
    // 45 admitted requests from one IP (600 ms apart, as the org's bucket refills): the window stays empty.
    for (let i = 0; i < 45; i++) expect((await send(k, { now: now + i * 600, ip })).status).toBe(200);
    // Someone else fails from the same IP until its window is full...
    const stranger = { id: 'pkc_7Hq2Vx9Lm4Rt8Ko', privateKey: (await keyPair()).privateKey };
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.failuresPerIpPerMinute; i++) expect((await send(stranger, { now, ip })).status).toBe(401);
    // ... then a random key id from it gets the one 401 (N4), with no D1 read; the valid key is still admitted, through its own overflow.
    const reads = vi.spyOn(HotDb.prototype, 'first');
    expect((await send(stranger, { now, ip })).body.code).toBe('unauthenticated');
    expect(reads).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) expect((await send(k, { now: now + 30_000 + i * 600, ip })).status, String(i)).toBe(200);
    // Admitted requests give their overflow slot back, so it never fills with them.
    expect(await placedStub(env, env.RATE_LIMITER, `platform:keyfail:${k.id}:v4:${ip}`).hit([...PLATFORM_WINDOWS.overflow], now)).toMatchObject({ ok: true });
    // Another IP is untouched.
    expect((await send(k, { now })).status).toBe(200);
  });

  it('the true residual: an attacker who knows a key id and shares its IP can fill that key’s overflow; the key’s self-revoke still gets in', async () => {
    const k = await seedKey();
    const now = freshNow();
    // Every Worker's cross-zone subrequest arrives as one address (Cloudflare: 2a06:98c0:3600::103), one subject here.
    const ip = '2a06:98c0:3600::103';
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.failuresPerIpPerMinute; i++) await limiter(`platform:ip:v6:2a06:98c0:3600::/48`).hit([...PLATFORM_WINDOWS.ip], now);
    // The attacker names the victim's key id with bad signatures until the key's overflow is full.
    const other = (await keyPair()).privateKey;
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.overflowPerKeyPerMinute; i++) expect((await send(k, { now, ip, signWith: other })).status).toBe(401);
    const get = await send(k, { now, ip });
    expect([get.status, get.body.limit]).toEqual([429, 'platform:ip']);
    // The self-revoke, signed by the key, is still checked (its pre-auth window) and stops the key.
    const stop = await send(k, { now, ip, method: 'POST', path: '/v1/platform/credential/revoke' });
    expect(stop.status).toBe(200);
    expect((await keyRow(k.id)).status).toBe('revoked');
  });

  it('scenario B (the second review, N1): junk, bad signatures naming the key and forged revokes from one IP; the holder’s valid revoke from that IP still stops the key', async () => {
    const k = await seedKey();
    const now = freshNow();
    const ip = freshIp();
    const other = (await keyPair()).privateKey;
    const stranger = { id: 'pkc_7Hq2Vx9Lm4Rt8Kh', privateKey: other };
    for (let i = 0; i < 30; i++) await send(stranger, { now, ip });
    for (let i = 0; i < 20; i++) expect((await send(k, { now, ip, signWith: other })).status).toBe(401);
    for (let i = 0; i < 10; i++) expect((await send(k, { now, ip, method: 'POST', path: '/v1/platform/credential/revoke', signWith: other })).body.limit).toBe('platform:ip');
    // The key's ordinary calls from that IP wait out the minute; its signed revoke doesn't.
    expect((await send(k, { now, ip })).body.limit).toBe('platform:ip');
    expect((await send(k, { now, ip, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
    expect((await keyRow(k.id)).status).toBe('revoked');
  });

  it('scenario B2: the same from the attacker’s own IP spends nothing of another IP’s, even one whose window is full', async () => {
    const k = await seedKey();
    const now = freshNow();
    const attacker = freshIp();
    const victim = freshIp();
    const other = (await keyPair()).privateKey;
    const stranger = { id: 'pkc_7Hq2Vx9Lm4Rt8Kf', privateKey: other };
    for (let i = 0; i < 30; i++) await send(stranger, { now, ip: attacker });
    for (let i = 0; i < 20; i++) await send(k, { now, ip: attacker, signWith: other });
    for (let i = 0; i < 70; i++) await send(k, { now, ip: attacker, method: 'POST', path: '/v1/platform/credential/revoke', signWith: other });
    // The victim's IP is full of someone else's junk too: its key still gets in through its own overflow there.
    await failIp(victim, now);
    expect((await send(k, { now, ip: victim })).status).toBe(200);
    expect((await send(k, { now, ip: victim, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
  });

  it('the pre-auth check’s CPU bound: past 60 failed verifications a minute for one key and subject, more revokes from it are refused unverified (the residual)', async () => {
    const k = await seedKey();
    const now = freshNow();
    const ip = freshIp();
    await failIp(ip, now);
    await fillKeyOverflow(k.id, `v4:${ip}`, now);
    const other = (await keyPair()).privateKey;
    const verify = vi.spyOn(crypto.subtle, 'verify');
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.revokePreauthFailuresPerKeyPerMinute; i++) await send(k, { now, ip, method: 'POST', path: '/v1/platform/credential/revoke', signWith: other });
    verify.mockClear();
    expect((await send(k, { now, ip, method: 'POST', path: '/v1/platform/credential/revoke' })).body.limit).toBe('platform:ip');
    expect(verify).not.toHaveBeenCalled();
    expect((await keyRow(k.id)).status).toBe('active');
    // From any IP whose window isn't full it works at once.
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
  });

  it('a self-revoke verified against a stale list still fails check 5 once the key is stopped in D1', async () => {
    const k = await seedKey();
    const now = freshNow();
    const ip = freshIp();
    await failIp(ip, now);
    await fillKeyOverflow(k.id, `v4:${ip}`, now);
    expect((await send(k, { now, ip })).body.limit).toBe('platform:ip'); // the list is loaded, with the key on it
    await env.DB.prepare("UPDATE platform_keys SET status = 'revoked', revoked_at = ?2, revoked_by_kind = 'hana', revoked_by = 'x' WHERE id = ?1").bind(k.id, Date.now()).run();
    expect((await send(k, { now, ip, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(401);
  });

  it('N4: past a full IP window, an id not on the list gets the same 401 as any authentication failure', async () => {
    const k = await seedKey();
    const now = freshNow();
    const ip = freshIp();
    const other = (await keyPair()).privateKey;
    const normal = await send({ id: 'pkc_7Hq2Vx9Lm4Rt8Ke', privateKey: other }, { now, ray: 'n4-ray' });
    await failIp(ip, now);
    const unknown = await send({ id: 'pkc_7Hq2Vx9Lm4Rt8Ke', privateKey: other }, { now, ip, ray: 'n4-ray' });
    const listedBadSig = await send(k, { now, ip, ray: 'n4-ray', signWith: other });
    for (const r of [unknown, listedBadSig]) expect([r.status, r.text, r.headers]).toEqual([normal.status, normal.text, normal.headers]);
  });

  it('a refusal after a valid signature (switch off, replay) counts as not admitted', async () => {
    const k = await seedKey();
    const now = freshNow();
    const ip = freshIp();
    await switchOff(k.org);
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.failuresPerIpPerMinute; i++) expect((await send(k, { now, ip })).body.code).toBe('platform_off');
    // The window is full: the next goes through the overflow, and the self-revoke still works.
    expect((await send(k, { now, ip, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
  });

  it('the IP prefix recorded is a /24 or a /48', () => {
    expect(ipPrefix('v4:203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('v6:2001:db8:1:2::/64')).toBe('2001:db8:1::/48');
    // The failure window's subject: IPv6 by /48 (F5).
    expect(platformIpSubject('2001:db8:1:2:3:4:5:6')).toBe('v6:2001:db8:1::/48');
    expect(platformIpSubject('2001:db8:1:ffff::1')).toBe('v6:2001:db8:1::/48');
    expect(platformIpSubject('203.0.113.77')).toBe('v4:203.0.113.77');
    expect(ipPrefix('other:unknown')).toBeNull();
  });
});

// ---- the switch, the freeze, the self-revoke (L5) ----

describe('the org’s switch and freeze, and the self-revoke', () => {
  it('the self-revoke works with the switch off: the key stops at once, its waiting web addresses are cancelled, one ledger row names the key', async () => {
    const k = await seedKey();
    const now = freshNow();
    const gc = await platformProposal(k.app.id, k.id, 'https://partner.example', { activeFrom: now + 24 * HOUR });
    await switchOff(k.org);
    expect((await send(k, { now })).body.code).toBe('platform_off');
    const r = await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body: JSON.stringify({ reason: 'Rotating to the standby key' }), idempotencyKey: 'stop-0001' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ revokedAt: now, requestId: expect.any(String) });
    expect(await keyRow(k.id)).toMatchObject({ status: 'revoked', revoked_at: now, revoked_by_kind: 'platform', revoked_by: k.id, revoke_reason: 'Rotating to the standby key' });
    const ledger = await rows<{ kind: string; actor_kind: string; actor_id: string; request_id: string; detail_json: string }>('SELECT kind, actor_kind, actor_id, request_id, detail_json FROM app_changes WHERE org_id = ?1 ORDER BY seq', k.org);
    const rid = await platformRequestId(k.org, 'stop-0001', k.id);
    expect(ledger.map((l) => [l.kind, l.actor_kind, l.actor_id, l.request_id])).toEqual([
      ['platform.key_revoked', 'platform', k.id, rid],
      ['change.cancelled', 'platform', k.id, `${rid}:cancelled`],
    ]);
    expect(JSON.parse(ledger[1]!.detail_json)).toMatchObject({ reason: 'key_revoked', keyId: k.id, changes: [{ changeId: gc, origin: 'https://partner.example' }] });
    expect(await rows('SELECT origin FROM app_origins WHERE change_id = ?1', gc)).toEqual([]);
    // The key is gone: anything signed with it now is the one 401.
    expect((await send(k, { now })).status).toBe(401);
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(401);
    expect((await callsOf(k.id)).map((c) => [c.route, c.status, c.code])).toEqual([['/v1/platform/credential/revoke', 200, null]]);
  });

  it('the self-revoke works while the org is frozen; the credential read doesn’t', async () => {
    const k = await seedKey();
    const now = freshNow();
    await freeze(k.org);
    expect((await send(k, { now })).body).toMatchObject({ code: 'forbidden' });
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
    expect((await keyRow(k.id)).status).toBe('revoked');
  });

  it('an org with no switch row is off', async () => {
    const k = await seedKey({ switchOn: false });
    expect((await send(k, { now: freshNow() })).body.code).toBe('platform_off');
  });

  it('a key that expires, is stopped, or whose org is frozen or switched off between two requests is refused at once', async () => {
    const now = freshNow();
    const expiring = await seedKey();
    const row = await keyRow(expiring.id);
    expect((await send(expiring, { now: (row.expires_at as number) - 1 })).status).toBe(200);
    expect((await send(expiring, { now: row.expires_at as number })).status).toBe(401);

    const stopped = await seedKey();
    expect((await send(stopped, { now })).status).toBe(200);
    const admin = new AdminRpc({ waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext, env);
    expect(await admin.revokePlatformKey({ actor: { kind: 'hana', id: 'access-sub-staff-1', email: 'staff@hana.example' }, requestId: `req_${stopped.id}`, clientIp: '198.51.100.2', orgId: stopped.org, keyId: stopped.id, reason: 'Stopped by staff' })).toMatchObject({ ok: true });
    expect((await send(stopped, { now })).status).toBe(401);

    const frozen = await seedKey();
    expect((await send(frozen, { now })).status).toBe(200);
    await freeze(frozen.org);
    expect((await send(frozen, { now })).body.code).toBe('forbidden');

    const off = await seedKey();
    expect((await send(off, { now })).status).toBe(200);
    await switchOff(off.org);
    expect((await send(off, { now })).body.code).toBe('platform_off');
  });

  it('two keys of one org each work with their own windows and nonces; stopping one leaves the other', async () => {
    const a = await seedKey({ switchOn: false });
    const b = await seedKey({ org: a.app });
    const now = freshNow();
    const nonce = b64url(new Uint8Array(16).fill(7));
    expect((await send(a, { now, nonce })).status).toBe(200);
    // The same nonce under the other key: a nonce is held per key.
    expect((await send(b, { now, nonce })).status).toBe(200);
    expect((await send(a, { now, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
    expect((await send(a, { now })).status).toBe(401);
    expect((await send(b, { now })).body).toMatchObject({ keyId: b.id, orgId: a.org });
  });
});

// ---- the credential view and what is recorded ----

describe('GET /v1/platform/credential and the call log', () => {
  it('answers the key’s own state; records the call (route, status, request id, IP prefix) and last_used_at once an hour', async () => {
    const k = await seedKey();
    const now = freshNow();
    const r = await send(k, { now, ip: '203.0.113.77', ray: 'ray-credential-1' });
    expect(r.status).toBe(200);
    const row = await keyRow(k.id);
    expect(r.body).toEqual({
      keyId: k.id,
      label: 'Backend key',
      orgId: k.org,
      scopes: [k.scope],
      thumbprint: k.thumbprint,
      activeFrom: row.active_from,
      expiresAt: row.expires_at,
      limits: { requestsPerMinute: 60, requestsPerDay: 2000, maxApps: 10, appCreationsPerDay: 5, originProposalsPerDay: 30 },
      requestId: 'ray-credential-1',
    });
    noCors(r.headers);
    expect(row.last_used_at).toBe(now);
    // The same clock hour (freshNow is a second into a minute, so a second later is always the same hour).
    await send(k, { now: now + 1000 });
    expect((await keyRow(k.id)).last_used_at).toBe(now);
    await send(k, { now: now + HOUR });
    expect((await keyRow(k.id)).last_used_at).toBe(now + HOUR);
    const calls = await callsOf(k.id);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ at: now, org_id: k.org, method: 'GET', route: '/v1/platform/credential', status: 200, code: null, request_id: 'ray-credential-1', ip_prefix: '203.0.113.0/24', app_id: null });
  });

  it('a refusal after the signature (switch off, frozen, replay, rate limited) is counted, never stored', async () => {
    const k = await seedKey();
    const now = freshNow();
    const ok = await send(k, { now });
    await read(await deliver(ok.request(), now));
    await switchOff(k.org);
    await send(k, { now });
    await switchOn(k.org);
    await freeze(k.org);
    await send(k, { now });
    expect((await callsOf(k.id)).map((c) => c.status)).toEqual([200]);
  });

  it('a quota refusal writes one `platform_quota` event an hour', async () => {
    const k = await seedKey();
    const now = freshNow();
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.perKeyPerMinute; i++) expect((await send(k, { now: now + i * 600 })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await send(k, { now: now + 40_000 + i })).body.limit).toBe('platform:key:req:minute');
    const ev = await events('platform_quota', k.org);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.detail_json)).toMatchObject({ limit: 'req:minute', keyId: k.id });
  });
});

// ---- the hot-DB budget (L8) ----

describe('each route within its hot-DB cost (L8)', () => {
  it('the declared costs and PLATFORM_DB_LIMITS hold, the failure path of the revoke included', async () => {
    // P4's routes (D929) are measured, each on its own paths, in platform-ops.test.ts "each route within its D1 cost".
    expect(PLATFORM_ROUTES.map((r) => [r.method, r.path, r.cost])).toEqual([
      ['GET', '/v1/platform/credential', 4],
      ['POST', '/v1/platform/credential/revoke', 11],
      ...PLATFORM_ROUTES.slice(2).map((r) => [r.method, r.path, r.cost]),
    ]);
    for (const r of PLATFORM_ROUTES) expect(r.cost, r.path).toBeLessThanOrEqual(12);
    for (const [route, fault] of [[PLATFORM_ROUTES[0]!, undefined], [PLATFORM_ROUTES[1]!, undefined], [PLATFORM_ROUTES[1]!, 1]] as const) {
      const k = await seedKey();
      const count: DbCount = { reads: 0, batches: 0, statements: 0 };
      const r = await send(k, { now: freshNow(), method: route.method, path: route.path, bindings: { DB: countingDb(env.DB, count, fault === undefined ? {} : { faultAt: fault }) } });
      expect(r.status, `${route.path} ${fault ?? ''}`).toBe(fault === undefined ? 200 : 500);
      expect(count.statements, route.path).toBeLessThanOrEqual(route.cost);
      // The call's three reads at most, and the announced keys' list (once every 30 s per isolate; here, after a seed).
      expect(count.reads).toBeLessThanOrEqual(4);
      expect(count.batches).toBeLessThanOrEqual(2);
      if (fault !== undefined) {
        // The failed revoke changed nothing and is recorded as the 500 it answered.
        expect((await keyRow(k.id)).status).toBe('active');
        expect((await callsOf(k.id)).map((c) => [c.status, c.code])).toEqual([[500, 'internal']]);
      }
    }
  });

  it('the budget class refuses a route that would go over it', async () => {
    const db = new HotDb(env.DB, { reads: 3, batches: 2, statements: 12, total: 12 });
    for (let i = 0; i < 3; i++) await db.first({ sql: 'SELECT 1', args: [] });
    await expect(db.first({ sql: 'SELECT 1', args: [] })).rejects.toThrow(/budget/u);
  });

  it('the org’s bucket: a flood of one org’s requests is refused by its own bucket and leaves another org’s alone', async () => {
    const a = await seedKey({ switchOn: false });
    const b = await seedKey({ org: a.app });
    const other = await seedKey();
    const now = freshNow();
    // 40 tokens, 4 a call, 10 kept for kill switches: 7 calls, then the org's bucket says no.
    const results: number[] = [];
    for (let i = 0; i < 7; i++) results.push((await send(i % 2 ? a : b, { now })).status);
    expect(results).toEqual(Array(7).fill(200));
    const refused = await send(a, { now });
    expect([refused.status, refused.body.limit]).toEqual([429, 'platform:budget_org']);
    // The platform as a whole never takes the console's shared bucket below its floor: another org's call a second later.
    expect((await send(other, { now: now + 1000 })).status).toBe(200);
    // The key's minute wasn't charged for the refused ones (unhit), so it isn't what refuses.
    expect(PLATFORM_LIMITS.perOrg).toEqual({ ratePerS: 8, burst: 40, reserve: 10 });
  });
});

// ---- the platform's own breaker (M3) ----

describe('the platform’s destructive-call breaker is its own (M3)', () => {
  const consoleRpcObj = () => placedStub(env, env.RATE_LIMITER, 'console-rpc');
  const platformAdmit = (org: string, now: number) => consoleRpcObj().platformAdmit({ org, cost: 1, breaker: true, killSwitch: true, limits: PLATFORM_LIMITS }, now);

  it('a platform flood fills only the platform’s counters: the console’s breaker and its kill switches are untouched, and the reverse', async () => {
    const now = freshNow();
    const orgs = await Promise.all(Array.from({ length: 4 }, async () => (await orgApp()).org));
    // 10 per org, then refused for that org; 30 across orgs, then refused for all.
    for (let i = 0; i < 10; i++) expect((await platformAdmit(orgs[0]!, now + i)).ok).toBe(true);
    expect(await platformAdmit(orgs[0]!, now + 10)).toMatchObject({ ok: false, limit: 'breaker_org', notify: true });
    for (let i = 0; i < 20; i++) expect((await platformAdmit(orgs[1 + (i % 2)]!, now + 20 + i)).ok).toBe(true);
    expect(await platformAdmit(orgs[3]!, now + 50)).toMatchObject({ ok: false, limit: 'breaker_global' });
    // The console's breaker for the same orgs: every destructive console call still admitted.
    for (const org of orgs) expect(await admitMemberCall(env, { org, cost: 5, killSwitch: true, breaker: true }, now + 60)).toMatchObject({ reserveUsed: expect.any(Number) });
    // And the reverse: the console's breaker full (5 per org) leaves the platform's for a fresh org alone.
    const fresh = (await orgApp()).org;
    const later = now + 30 * MIN;
    for (let i = 0; i < 5; i++) await admitMemberCall(env, { org: fresh, cost: 1, killSwitch: true, breaker: true }, later + i);
    await expect(admitMemberCall(env, { org: fresh, cost: 1, killSwitch: true, breaker: true }, later + 6)).rejects.toMatchObject({ code: 'rate_limited' });
    expect((await platformAdmit(fresh, later + 7)).ok).toBe(false); // the platform's global window is still full from the flood above
    expect((await platformAdmit(fresh, now + 2 * HOUR)).ok).toBe(true); // ... until it slides out, whatever the console's state
  });

  it('a platform call that changed nothing gets its breaker slot back', async () => {
    const org = (await orgApp()).org;
    const now = freshNow() + 3 * HOUR;
    for (let i = 0; i < 10; i++) {
      expect((await platformAdmit(org, now + i)).ok).toBe(true);
      await consoleRpcObj().platformSettle({ org, at: now + i, breaker: true, reserveUsed: 0, limits: PLATFORM_LIMITS }, now + i);
    }
    expect((await platformAdmit(org, now + 20)).ok).toBe(true);
  });
});

// ---- the nonce object ----

describe('the nonce object', () => {
  it('is pinned with the other shared objects (its name ends @<hint>); the per-IP one is not', async () => {
    const k = await seedKey();
    const names: string[] = [];
    const real = env.RATE_LIMITER.idFromName.bind(env.RATE_LIMITER);
    vi.spyOn(env.RATE_LIMITER, 'idFromName').mockImplementation((n: string) => {
      names.push(n);
      return real(n);
    });
    const ip = freshIp();
    expect((await send(k, { now: freshNow(), ip, bindings: { DO_LOCATION_HINT: 'weur' } })).status).toBe(200);
    expect(names).toEqual(expect.arrayContaining([`platform:ip:v4:${ip}`, `platform-nonce:${k.id}@weur`, `platform:key:${k.id}@weur`, 'console-rpc@weur']));
  });

  it('holds a nonce until timestamp + 120 s, and at most 300 fresh nonces a minute for one key', async () => {
    const k = await seedKey();
    const now = freshNow();
    const nonce = b64url(new Uint8Array(16).fill(5));
    expect((await send(k, { now, nonce })).status).toBe(200);
    // Within the clock window it is a replay; past timestamp + 120 s the timestamp itself is stale.
    expect((await send(k, { now: now + 60_000, timestampMs: now, nonce })).body.code).toBe('request_replayed');
    const obj = placedStub(env, env.RATE_LIMITER, `platform-nonce:${k.id}`);
    expect(await obj.reserveNonce(nonce, now + 120_000, [...PLATFORM_WINDOWS.nonce], now + 119_999)).toBe('replayed');
    expect(await obj.reserveNonce(nonce, now + 300_000, [...PLATFORM_WINDOWS.nonce], now + 120_000)).toBe('ok');
    // The size bound.
    const later = now + 10 * MIN;
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.noncesPerKeyPerMinute; i++) expect(await obj.reserveNonce(`n${i}`, later + 120_000, [...PLATFORM_WINDOWS.nonce], later)).toBe('ok');
    expect(await obj.reserveNonce('one-more', later + 120_000, [...PLATFORM_WINDOWS.nonce], later)).toBe('full');
    expect((await send(k, { now: later })).body).toMatchObject({ code: 'rate_limited', limit: 'platform:nonce' });
  });
});

// ---- the limiters failing ----

/** The limiter namespace with objects whose name matches `bad` failing every call. */
function failingLimiter(bad: RegExp): typeof env.RATE_LIMITER {
  const ns = env.RATE_LIMITER;
  const names = new Map<string, string>();
  return {
    idFromName: (n: string) => {
      const id = ns.idFromName(n);
      names.set(id.toString(), n);
      return id;
    },
    get: (id: DurableObjectId, o?: DurableObjectNamespaceGetDurableObjectOptions) => {
      const stub = ns.get(id, o);
      if (!bad.test(names.get(id.toString()) ?? '')) return stub;
      return new Proxy(stub, { get: () => () => Promise.reject(new Error('limiter down')) });
    },
  } as unknown as typeof env.RATE_LIMITER;
}

describe('when a limiter errors: admission fails closed, the self-revoke goes ahead', () => {
  for (const [what, re] of [['the per-IP object', /^platform:ip:/u], ['the nonce object', /^platform-nonce:/u], ['the key’s object', /^platform:key:/u], ['the bucket’s object', /^console-rpc/u]] as const) {
    it(`${what}: 503 for the credential read`, async () => {
      const k = await seedKey();
      const r = await send(k, { now: freshNow(), bindings: { RATE_LIMITER: failingLimiter(re) } });
      expect([r.status, r.body.code]).toEqual([503, 'rate_limiter_unavailable']);
      expect(await callsOf(k.id)).toEqual([]);
    });
  }

  it('every limiter down: the self-revoke still stops the key (a replay of it could only stop the same key)', async () => {
    const k = await seedKey();
    const r = await send(k, { now: freshNow(), method: 'POST', path: '/v1/platform/credential/revoke', bindings: { RATE_LIMITER: failingLimiter(/./u) } });
    expect(r.status).toBe(200);
    expect((await keyRow(k.id)).status).toBe('revoked');
  });
});

// ---- the reach of an authenticated request ----

describe('what an authenticated platform request can reach', () => {
  it('the routes are the key’s two and the app operations’ nine; no route or path registers, accepts, confirms or brings back a key, confirms a web address, or calls any ConsoleRpc or AdminRpc method', async () => {
    expect(PLATFORM_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/platform/credential',
      'POST /v1/platform/credential/revoke',
      'GET /v1/platform/apps',
      'POST /v1/platform/apps',
      'GET /v1/platform/apps/:appId',
      'POST /v1/platform/apps/:appId/origins',
      'POST /v1/platform/apps/:appId/origins/remove',
      'POST /v1/platform/changes/:changeId/cancel',
      'POST /v1/platform/apps/:appId/suspend',
      'POST /v1/platform/apps/:appId/keys',
      'POST /v1/platform/apps/:appId/keys/:keyId/revoke',
    ]);
    // No template names a confirm, an accept, an approval, a registration, an expedite or a waiver (D929).
    for (const r of PLATFORM_ROUTES) expect(r.path, r.path).not.toMatch(/confirm|accept|approv|regist|expedit|waive|unrevoke|policy|settings|label|mainnet/iu);
    const spies = [ConsoleRpc.prototype, AdminRpc.prototype].flatMap((proto) =>
      Object.getOwnPropertyNames(proto)
        .filter((m) => m !== 'constructor' && typeof (proto as unknown as Record<string, unknown>)[m] === 'function')
        .map((m) => vi.spyOn(proto as unknown as Record<string, (...a: unknown[]) => unknown>, m)),
    );
    const methods = [...new Set([ConsoleRpc.prototype, AdminRpc.prototype].flatMap((p) => Object.getOwnPropertyNames(p)).filter((m) => m !== 'constructor'))];
    expect(methods.length).toBeGreaterThan(50);
    const k = await seedKey();
    // A waiting key of the org and a platform web address waiting: nothing must confirm them.
    const waiting = await seedKey({ org: k.app, state: 'pending', switchOn: false });
    await switchOn(k.org);
    const now = freshNow();
    const gc = await platformProposal(k.app.id, k.id, 'https://p.example', { activeFrom: now + 24 * HOUR });
    const before = { waiting: await keyRow(waiting.id), change: await rows('SELECT * FROM guarded_changes WHERE id = ?1', gc) };
    const paths = new Set<string>(['/v1/platform/keys', `/v1/platform/keys/${waiting.id}/confirm`, `/v1/platform/keys/${waiting.id}/accept`, '/v1/platform/keys/register', `/v1/platform/changes/${gc}/confirm`, `/v1/platform/credential/confirm`, '/v1/platform/credential/accept', '/v1/platform/credential/register', '/v1/platform/credential/unrevoke']);
    for (const m of methods) {
      paths.add(`/v1/platform/${m}`);
      paths.add(`/v1/platform/credential/${m}`);
    }
    for (const path of paths) {
      for (const method of ['GET', 'POST']) {
        const r = await send(k, { now, method, path, body: method === 'POST' ? JSON.stringify({ keyId: waiting.id, changeIds: [gc] }) : undefined });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    }
    // The two routes themselves, the revoke last.
    expect((await send(k, { now })).status).toBe(200);
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body: JSON.stringify({ keyId: waiting.id }) })).status).toBe(400);
    expect((await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    // The other key and the web address: exactly as they were, except the address the stopped key proposed, now cancelled.
    expect(await keyRow(waiting.id)).toEqual(before.waiting);
    const change = (await rows<Record<string, unknown>>('SELECT * FROM guarded_changes WHERE id = ?1', gc))[0]!;
    expect(change).toMatchObject({ status: 'cancelled', active_from: (before.change[0] as Record<string, unknown>).active_from });
    expect(await rows("SELECT id FROM platform_keys WHERE confirmed_at IS NOT NULL AND org_id = ?1 AND id != ?2", k.org, k.id)).toEqual([]);
    expect(await rows('SELECT id FROM guarded_changes WHERE app_id = ?1 AND status = ?2', k.app.id, 'active')).toEqual([]);
  });
});

// ---- after PR 156's review ----

describe('F1: the self-revoke skips the limits only when it can stop the key', () => {
  it('invalid self-revokes go through the key’s windows like any call: at most 60 a minute recorded, the rest 429 and not stored', async () => {
    const k = await seedKey();
    const now = freshNow();
    const bodies = ['{"bad":1}', '[]', 'not json', JSON.stringify({ reason: 'x'.repeat(201) })];
    const statuses: number[] = [];
    for (let i = 0; i < 120; i++) statuses.push((await send(k, { now: now + i * 300, method: 'POST', path: '/v1/platform/credential/revoke', body: bodies[i % 4] })).status);
    expect(statuses.filter((x) => x === 400)).toHaveLength(PLATFORM_REQUEST_LIMITS.perKeyPerMinute);
    expect(statuses.filter((x) => x === 429)).toHaveLength(120 - PLATFORM_REQUEST_LIMITS.perKeyPerMinute);
    expect(await callsOf(k.id)).toHaveLength(PLATFORM_REQUEST_LIMITS.perKeyPerMinute);
    expect((await keyRow(k.id)).status).toBe('active');
    // A valid self-revoke still stops it at once, the key's minute full or not.
    expect((await send(k, { now: now + 40_000, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
    expect((await keyRow(k.id)).status).toBe('revoked');
  });

  it('a thief filling the nonce cap can’t hold back the network’s own self-revoke', async () => {
    const k = await seedKey();
    const now = freshNow();
    const obj = placedStub(env, env.RATE_LIMITER, `platform-nonce:${k.id}`);
    for (let i = 0; i < PLATFORM_REQUEST_LIMITS.noncesPerKeyPerMinute; i++) expect(await obj.reserveNonce(`thief${i}`, now + 120_000, [...PLATFORM_WINDOWS.nonce], now)).toBe('ok');
    expect((await send(k, { now })).body.limit).toBe('platform:nonce');
    const stop = await send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke', body: JSON.stringify({ reason: 'Stolen' }) });
    expect(stop.status).toBe(200);
    expect((await keyRow(k.id)).status).toBe('revoked');
    // Its nonce is still single use.
    expect((await read(await deliver(stop.request(), now))).status).toBe(401);
  });

  it('a valid self-revoke that loses a race is charged to the key’s windows; concurrent ones: one stops it, each recorded', async () => {
    const k = await seedKey();
    const now = freshNow();
    const rs = await Promise.all(Array.from({ length: 6 }, () => send(k, { now, method: 'POST', path: '/v1/platform/credential/revoke' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 200)) expect([401, 409]).toContain(r.status);
    expect((await keyRow(k.id)).status).toBe('revoked');
    const lost = rs.filter((r) => r.status === 409).length;
    // The losers that reached the route are charged: the key's minute shows them (60 less what they used).
    const left = await placedStub(env, env.RATE_LIMITER, `platform:key:${k.id}`).hit([{ name: 'req:minute', windowMs: MIN, max: PLATFORM_REQUEST_LIMITS.perKeyPerMinute - lost }], now);
    expect(left.ok).toBe(true);
  });
});

describe('F3: the platform’s own global bucket, and a floor in the console’s', () => {
  it('a platform flood from several orgs leaves an ordinary console call of another org admitted', async () => {
    const now = freshNow();
    const obj = placedStub(env, env.RATE_LIMITER, 'console-rpc');
    const orgs = await Promise.all(Array.from({ length: 6 }, async () => (await orgApp()).org));
    let admitted = 0;
    for (const org of orgs) for (let i = 0; i < 20; i++) if ((await obj.platformAdmit({ org, cost: 3, limits: PLATFORM_LIMITS }, now)).ok) admitted++;
    // The platform as a whole took at most what is above the console's floor (60 − 30 = 30 tokens: 10 calls of 3).
    expect(admitted).toBe(10);
    const third = (await orgApp()).org;
    expect(await admitMemberCall(env, { org: third, cost: 8 }, now)).toMatchObject({ reserveUsed: 0 });
    // A platform kill switch is never refused by the console's bucket (N2), and the console's kill switch still goes through.
    expect((await obj.platformAdmit({ org: orgs[0]!, cost: 3, killSwitch: true, limits: PLATFORM_LIMITS }, now)).ok).toBe(true);
    expect(await admitMemberCall(env, { org: third, cost: 5, killSwitch: true }, now)).toMatchObject({ reserveUsed: expect.any(Number) });
  });

  it('N2: a sustained console flood never holds back a platform kill switch', async () => {
    const now = freshNow();
    const obj = placedStub(env, env.RATE_LIMITER, 'console-rpc');
    const consoleOrgs = await Promise.all(Array.from({ length: 4 }, async () => (await orgApp()).org));
    const network = (await orgApp()).org;
    let admitted = 0;
    for (let t = 0; t < 10; t++) {
      for (const org of consoleOrgs) for (let i = 0; i < 20; i++) await admitMemberCall(env, { org, cost: 1 }, now + t * 1000).catch(() => undefined);
      if ((await obj.platformAdmit({ org: network, cost: 11, killSwitch: true, limits: PLATFORM_LIMITS }, now + t * 1000 + 1)).ok) admitted++;
    }
    expect(admitted).toBe(10);
  });

  it('the platform’s own rate holds across orgs: 10 statements a second over time', async () => {
    const now = freshNow();
    const obj = placedStub(env, env.RATE_LIMITER, 'console-rpc');
    const orgs = await Promise.all(Array.from({ length: 4 }, async () => (await orgApp()).org));
    let admitted = 0;
    // 10 seconds, every org trying 10 calls of cost 3 a second: the platform's bucket (10/s, burst 60, 15 kept) bounds it.
    for (let t = 0; t < 10; t++) for (const org of orgs) for (let i = 0; i < 10; i++) if ((await obj.platformAdmit({ org, cost: 3, limits: PLATFORM_LIMITS }, now + t * 1000)).ok) admitted++;
    expect(admitted * 3).toBeLessThanOrEqual(PLATFORM_LIMITS.platform.burst - PLATFORM_LIMITS.platform.reserve + 10 * PLATFORM_LIMITS.platform.ratePerS);
  });
});

describe('F4: one Idempotency-Key for the self-revoke of both keys of an org', () => {
  it('stops both: the request id names the key', async () => {
    const a = await seedKey({ switchOn: false });
    const b = await seedKey({ org: a.app });
    const now = freshNow();
    expect((await send(a, { now, method: 'POST', path: '/v1/platform/credential/revoke', idempotencyKey: 'revoke-key-0001' })).status).toBe(200);
    expect((await send(b, { now, method: 'POST', path: '/v1/platform/credential/revoke', idempotencyKey: 'revoke-key-0001' })).status).toBe(200);
    expect((await keyRow(a.id)).status).toBe('revoked');
    expect((await keyRow(b.id)).status).toBe('revoked');
    expect(await platformRequestId(a.org, 'revoke-key-0001', a.id)).not.toBe(await platformRequestId(a.org, 'revoke-key-0001', b.id));
    // App writes (piece P4) keep A9's org-wide id: a retry from the org's other key is `conflict`.
    expect(await platformRequestId(a.org, 'op-1')).toBe(await platformRequestId(a.org, 'op-1'));
  });
});

describe('F5: failures of a known key stop calling its object once the minute’s alert fired; unknown ids never reach D1', () => {
  it('after the 10th failure in a minute, more failures make no call to the key’s failure object; its admitted traffic is unaffected', async () => {
    const k = await seedKey();
    const now = freshNow();
    const other = (await keyPair()).privateKey;
    for (let i = 0; i < 10; i++) await send(k, { now, signWith: other });
    const names: string[] = [];
    const real = env.RATE_LIMITER.idFromName.bind(env.RATE_LIMITER);
    vi.spyOn(env.RATE_LIMITER, 'idFromName').mockImplementation((n: string) => {
      names.push(n);
      return real(n);
    });
    for (let i = 0; i < 20; i++) await send(k, { now, signWith: other });
    expect(names.filter((n) => n.startsWith(`platform:keyfail:${k.id}`))).toEqual([]);
    expect((await send(k, { now })).status).toBe(200);
  });

  it('a well-formed key id that isn’t announced here gets the 401 with no D1 read', async () => {
    const now = freshNow();
    const reads = vi.spyOn(HotDb.prototype, 'first');
    const r = await send({ id: 'pkc_7Hq2Vx9Lm4Rt8Kj', privateKey: (await keyPair()).privateKey }, { now });
    expect(r.status).toBe(401);
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('F7: the dummy key, and a signature with a known private key', () => {
  it('the dummy point is hashed to the curve as documented (not a multiple of the generator)', async () => {
    const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
    const pow = (x: bigint, e: bigint) => {
      let r = 1n;
      x %= p;
      while (e > 0n) {
        if (e & 1n) r = (r * x) % p;
        x = (x * x) % p;
        e >>= 1n;
      }
      return r;
    };
    let found: string | null = null;
    for (let i = 0; i < 100 && !found; i++) {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(`journear-platform-v1 dummy verification key ${i}`) as Uint8Array<ArrayBuffer>));
      const x = BigInt(`0x${Buffer.from(h).toString('hex')}`) % p;
      const rhs = (((x * x * x - 3n * x + b) % p) + p) % p;
      let y = pow(rhs, (p + 1n) / 4n);
      if ((y * y) % p !== rhs) continue;
      if (y & 1n) y = p - y;
      found = `04${x.toString(16).padStart(64, '0')}${y.toString(16).padStart(64, '0')}`;
    }
    expect(Buffer.from(DUMMY_KEY).toString('hex')).toBe(found);
  });

  it('a request signed with private key 1 (the generator’s) never authenticates, whatever the key id names', async () => {
    const one = b64url(fromHex(`${'0'.repeat(63)}1`));
    const g = { kty: 'EC', crv: 'P-256', x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY', y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU' };
    const d1 = await crypto.subtle.importKey('jwk', { ...g, d: one }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const now = freshNow();
    const live = await seedKey();
    const waiting = await seedKey({ state: 'pending' });
    for (const [name, k] of [['unknown id', { id: 'pkc_7Hq2Vx9Lm4Rt8Kg', privateKey: d1 }], ['a key in force', { id: live.id, privateKey: d1 }], ['a waiting key', { id: waiting.id, privateKey: d1 }]] as const) {
      expect((await send(k, { now })).status, name).toBe(401);
    }
  });
});

describe('F8: public keys whose private halves are published can’t be registered', () => {
  it('the generator, its double and the vectors’ key are refused outside a local* test env', async () => {
    const app = await orgApp();
    const staff = { actor: { kind: 'hana' as const, id: 'access-sub-staff-1', email: 'staff@hana.example' }, clientIp: '198.51.100.2' };
    const register = (jwk: Record<string, string>, e: Partial<typeof env> = {}) =>
      new AdminRpc(createExecutionContext(), { ...env, ...e } as typeof env).registerPlatformKey({ ...staff, requestId: `req_${Math.random().toString(36).slice(2, 12)}`, orgId: app.org, scopeIds: [app.scope], label: 'Test key', publicKey: JSON.stringify(jwk), reason: 'Thumbprint checked with the network by phone' });
    const g = { kty: 'EC', crv: 'P-256', x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY', y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU' };
    for (const jwk of [g, { kty: 'EC', crv: 'P-256', x: vectors.key.jwk.x, y: vectors.key.jwk.y }]) {
      expect(await register(jwk)).toMatchObject({ ok: false, code: 'bad_request', error: expect.stringMatching(/published/u) });
      expect(await register(jwk, { NETWORK: 'mainnet' })).toMatchObject({ ok: false, code: 'bad_request' });
    }
    // A local* test env may use them (its tests and demos).
    expect(await register(g, { ENV_NAME: 'local-test', NETWORK: 'testnet' })).toMatchObject({ ok: true });
  });
});

describe('F10: through the real router, and what the routes may import', () => {
  it('an OPTIONS with an Origin is 403 with no CORS header; a signed request replayed through index.ts is 409', async () => {
    const k = await seedKey();
    const ctx = createExecutionContext();
    const pre = await worker.fetch!(new Request('https://api.test/v1/platform/credential', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'cf-connecting-ip': freshIp() } }) as never, env as never, ctx);
    expect(pre.status).toBe(403);
    expect([...pre.headers.keys()].filter((h) => h.startsWith('access-control'))).toEqual([]);
    const first = await send(k, {});
    expect(first.status).toBe(200);
    const again = await worker.fetch!(first.request() as never, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(again.status).toBe(409);
  });

  it('the routes import only what reading and stopping the key and the app operations need (a route confirming or accepting anything fails here)', () => {
    expect(importProblems(routesSource, ROUTE_IMPORTS)).toEqual([]);
  });

  it('the allowlist check sees every import form (N6)', () => {
    for (const [form, src] of [
      ['namespace', "import * as rpc from '../rpc/console.ts';"],
      ['default', "import ConsoleRpc from '../rpc/console.ts';"],
      ['a name not allowed', "import { confirmPlatformKey } from './keys.ts';"],
      ['re-export', "export { acceptPlatformKey } from './keys.ts';"],
      ['re-export all', "export * from './keys.ts';"],
      ['side effect', "import '../rpc/admin.ts';"],
      ['dynamic', "const m = await import('./keys.ts');"],
      ['multi-line', "import {\n  revokePlatformKeyNow,\n  confirmPlatformKey,\n} from './keys.ts';"],
      ['a type not allowed', "import type { Answer } from '../rpc/common.ts';"],
    ] as const) {
      expect(importProblems(src, ROUTE_IMPORTS).length, form).toBeGreaterThan(0);
    }
    expect(importProblems("import { revokePlatformKeyNow } from './keys.ts';\nimport type { AuthRow } from './request.ts';", ROUTE_IMPORTS)).toEqual([]);
  });
});

/** What in a module's source breaks the routes' import allowlist (every import and re-export form). */
const ROUTE_IMPORTS: Record<string, string[]> = {
  // P3's (the key itself), and P4's body schemas (D929: each a strict zod object of the route's own fields; data only).
  '@hana-id/console-core': [
    'PLATFORM_REQUEST_LIMITS',
    'PlatformCredentialView',
    'b64url',
    'platformRevokeBody',
    'randomBytes',
    'platformAddOriginsBody',
    'platformCreateAppBody',
    'platformEmptyBody',
    'platformRemoveOriginsBody',
    'platformSuspendBody',
  ],
  '../env.ts': ['Env'],
  '../changes/cas.ts': ['refuse'],
  '../changes/db.ts': ['HotDb'],
  './keys.ts': ['revokePlatformKeyNow'],
  // D929: the app operations, one function per route, and the writer and request id the self-revoke shares with them
  // (moved there from this file). Their own imports are held by platform-ops.test.ts "what the operations may import".
  './ops.ts': [
    'addPlatformOrigins',
    'cancelPlatformChange',
    'createPlatformApp',
    'createPublishableKey',
    'getPlatformApp',
    'listPlatformApps',
    'platformRequestId',
    'platformWriter',
    'removePlatformOrigins',
    'revokePublishableKey',
    'suspendPlatformApp',
  ],
  './request.ts': ['AuthRow'],
};

describe('F11: a failure after the key’s windows counted gives the charge back', () => {
  it('the platform admission failing: 503, and the key’s minute is untouched', async () => {
    const k = await seedKey();
    const now = freshNow();
    const failing = failingLimiter(/^console-rpc/u);
    for (let i = 0; i < 70; i++) expect((await send(k, { now, bindings: { RATE_LIMITER: failing } })).status).toBe(503);
    expect(await placedStub(env, env.RATE_LIMITER, `platform:key:${k.id}`).hit([{ name: 'req:minute', windowMs: MIN, max: 1 }], now)).toMatchObject({ ok: true });
  });

  it('the call log failing: 500, the charge and the last-used marker given back (the next call writes last_used_at)', async () => {
    const k = await seedKey();
    const now = freshNow();
    const count: DbCount = { reads: 0, batches: 0, statements: 0 };
    expect((await send(k, { now, bindings: { DB: countingDb(env.DB, count, { faultAt: 0 }) } })).status).toBe(500);
    expect((await keyRow(k.id)).last_used_at).toBeNull();
    expect((await send(k, { now: now + 1000 })).status).toBe(200);
    expect((await keyRow(k.id)).last_used_at).toBe(now + 1000);
  });
});

describe('the second review', () => {
  it('N3: while the revocation can’t land, valid self-revokes are held to 10 a minute: at most 10 recorded, the key still active', async () => {
    const k = await seedKey();
    const now = freshNow();
    const count: DbCount = { reads: 0, batches: 0, statements: 0 };
    // The revocation's batch (six statements) fails; the call log's (one) lands.
    const db = countingDb(env.DB, count, { faultAt: 1 });
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) statuses.push((await send(k, { now: now + i, method: 'POST', path: '/v1/platform/credential/revoke', bindings: { DB: db } })).status);
    expect(statuses.slice(0, PLATFORM_REQUEST_LIMITS.validRevokesPerKeyPerMinute)).toEqual(Array(PLATFORM_REQUEST_LIMITS.validRevokesPerKeyPerMinute).fill(500));
    expect(statuses.slice(PLATFORM_REQUEST_LIMITS.validRevokesPerKeyPerMinute)).toEqual(Array(15 - PLATFORM_REQUEST_LIMITS.validRevokesPerKeyPerMinute).fill(429));
    expect(await callsOf(k.id)).toHaveLength(PLATFORM_REQUEST_LIMITS.validRevokesPerKeyPerMinute);
    expect((await keyRow(k.id)).status).toBe('active');
    // Once D1 takes the write again, a valid revoke the next minute stops it.
    expect((await send(k, { now: now + MIN, method: 'POST', path: '/v1/platform/credential/revoke' })).status).toBe(200);
  });

  it('N6: a second settle of the same admission refunds nothing', async () => {
    const org = (await orgApp()).org;
    const now = freshNow();
    const obj = placedStub(env, env.RATE_LIMITER, 'console-rpc');
    // Take the platform's bucket down to its reserve (60 → 15, three kill switches of 15 from other orgs), then a kill switch that dips into it.
    for (let i = 0; i < 3; i++) expect(await obj.platformAdmit({ org: (await orgApp()).org, cost: 15, killSwitch: true, limits: PLATFORM_LIMITS }, now)).toMatchObject({ ok: true, reserveUsed: 0 });
    const kill = await obj.platformAdmit({ org, cost: 6, killSwitch: true, limits: PLATFORM_LIMITS }, now);
    expect(kill).toMatchObject({ ok: true, reserveUsed: expect.any(Number) });
    const used = (kill as { reserveUsed: number }).reserveUsed;
    expect(used).toBeGreaterThan(0);
    const settle = () => obj.platformSettle({ org, at: now, breaker: false, reserveUsed: used, limits: PLATFORM_LIMITS }, now);
    await settle();
    await settle();
    // One refund only: the reserve holds exactly what the kill switch took back, so an ordinary call still can't reach it.
    expect(await obj.platformAdmit({ org: (await orgApp()).org, cost: 1, limits: PLATFORM_LIMITS }, now)).toMatchObject({ ok: false, limit: 'budget_platform' });
  });

  it('N6: one local* predicate for the platform minimum and the published-key rule', () => {
    for (const e of [{ ENV_NAME: 'local-test', NETWORK: 'testnet' }, { ENV_NAME: 'local', NETWORK: 'testnet' }]) expect(isLocalTestEnv(e)).toBe(true);
    for (const e of [{ ENV_NAME: 'local-test', NETWORK: 'mainnet' }, { ENV_NAME: 'sandbox-dev', NETWORK: 'testnet' }, { NETWORK: 'testnet' }, { ENV_NAME: 'xlocal', NETWORK: 'testnet' }]) expect(isLocalTestEnv(e)).toBe(false);
  });
});

describe('the review of the second round', () => {
  it('past a full IP window, unlisted ids get the uniform 401 at once: no body read, no D1 read, no verification, the same bytes', async () => {
    const now = freshNow();
    const ip = freshIp();
    const other = (await keyPair()).privateKey;
    const stranger = { id: 'pkc_7Hq2Vx9Lm4Rt8Kc', privateKey: other };
    const normal = await send(stranger, { now, method: 'POST', path: '/v1/platform/credential/revoke', ray: 'r2-ray' });
    await failIp(ip, now);
    // The list is loaded (by the request above); then nothing of the hot DB, the body or the crypto is touched.
    const count: DbCount = { reads: 0, batches: 0, statements: 0 };
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    let pulls = 0;
    for (let i = 0; i < 20; i++) {
      const signed = await send(stranger, { now: now + 1, method: 'POST', path: '/v1/platform/credential/revoke', ip, ray: 'r2-ray' });
      expect([signed.status, signed.text, signed.headers]).toEqual([normal.status, normal.text, normal.headers]);
    }
    verify.mockClear();
    importKey.mockClear();
    for (let i = 0; i < 20; i++) {
      const req = (await send(stranger, { now: now + 2, ip, ray: 'r2-ray' })).request();
      const body = new ReadableStream({
        pull(c) {
          pulls++;
          c.enqueue(utf8('{}'));
          c.close();
        },
      }, { highWaterMark: 0 });
      const headers = new Headers(req.headers);
      headers.set('content-type', 'application/json');
      const r = await read(await deliver(new Request('https://api.test/v1/platform/credential/revoke', { method: 'POST', headers, body, duplex: 'half' } as RequestInit), now + 2, { DB: countingDb(env.DB, count) }));
      expect([r.status, r.text, r.headers]).toEqual([normal.status, normal.text, normal.headers]);
    }
    expect(pulls).toBe(0);
    expect(count).toEqual({ reads: 0, batches: 0, statements: 0 });
    expect(verify).not.toHaveBeenCalled();
    expect(importKey).not.toHaveBeenCalled();
  });

  it('a burst of platform kill switches at their maximum leaves the console’s kill-switch reserve untouched', async () => {
    const now = freshNow();
    const obj = placedStub(env, env.RATE_LIMITER, 'console-rpc');
    const consoleOrg = (await orgApp()).org;
    const consoleOrgs = await Promise.all(Array.from({ length: 6 }, async () => (await orgApp()).org));
    // The console's ordinary calls take its global bucket to its reserve (20 of 60) and are then refused.
    let refused = false;
    for (let i = 0; i < 60 && !refused; i++) await admitMemberCall(env, { org: consoleOrgs[i % 6]!, cost: 1 }, now).catch(() => (refused = true));
    expect(refused).toBe(true);
    // Platform kill switches, as many as they are allowed, from many orgs at once.
    let kills = 0;
    for (let i = 0; i < 40; i++) if ((await obj.platformAdmit({ org: (await orgApp()).org, cost: 6, killSwitch: true, limits: PLATFORM_LIMITS }, now)).ok) kills++;
    expect(kills).toBeGreaterThan(0);
    // The console's reserve is all still there: a console kill switch of 12 (its org's share) goes through, an ordinary call still doesn't.
    await expect(admitMemberCall(env, { org: consoleOrg, cost: 1 }, now)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await admitMemberCall(env, { org: consoleOrg, cost: 12, killSwitch: true }, now)).toMatchObject({ reserveUsed: 12 });
  });
});
