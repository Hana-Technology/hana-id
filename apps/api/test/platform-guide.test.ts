// The network's guide (docs/platform-guide.md, piece P8) against the real platform API. The guide quotes
// examples/platform-signer/platform-client.ts exactly; that client's signer and caller go through the real verifier and
// routes (src/platform/request.ts, routes.ts, ops.ts): a key from a PEM, the credential, a whole partner's life (create
// with web addresses, a retry answered as a replay, list, read, propose, a stale version, cancel, suspend and resume,
// publishable keys, remove), a lost first attempt retried with a fresh signature and the same Idempotency-Key, and the
// self-revoke while the switch is off. The guide's test vector is the independent generator's (console-core
// test/platform-request-vectors.json): its message is the client's, the client's signature with the vector key verifies,
// and the client's DER conversion gives the vectors' raw signatures. Its numbers are the code's.
import { PLATFORM_BODY_MAX, PLATFORM_CLOCK_SKEW_MS, PLATFORM_OPS_LIMITS, PLATFORM_REQUEST_LIMITS, jwkThumbprint } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import vectors from '../../../packages/console-core/test/platform-request-vectors.json' with { type: 'json' };
import guide from '../../../docs/platform-guide.md?raw';
import sample from '../../../examples/platform-signer/platform-client.ts?raw';
import { type PlatformConfig, callPlatform, derToRaw, importPrivateKeyPem, newIdempotencyKey, platformMessage, signHeaders } from '../../../examples/platform-signer/platform-client.ts';
import { PLATFORM_LIMITS } from '../src/platform/request.ts';
import { PLATFORM_ROUTES } from '../src/platform/routes.ts';
import { deliver, freshIp, freshNow, keyRow, seedKey, switchOff } from './platform-helpers.ts';
import { orgApp } from './rpc-helpers.ts';

const HOUR = 3_600_000;
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** The guide's ```ts block that follows its marker line. */
function guideBlock(marker: string): string {
  const at = guide.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const m = /```ts\n([\s\S]*?)```/u.exec(guide.slice(at));
  if (!m?.[1]) throw new Error(`no ts block after ${marker}`);
  return m[1];
}

/** A fresh P-256 key pair as a network makes it: the private key as a PKCS #8 PEM, the public point. */
async function pemPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer);
  const lines = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/gu)!.join('\n');
  const pem = ['-----BEGIN PRIVATE', ' KEY-----\n', lines, '\n-----END PRIVATE', ' KEY-----\n'].join('');
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return { pem, publicRaw, thumbprint: await jwkThumbprint(jwk.x!, jwk.y!) };
}

/** A network: an org with a test scope marked as a shared wallet, a key in force for it, and the client's config. */
async function network() {
  const site = await orgApp();
  await env.DB.prepare('UPDATE scopes SET app_user_ids = 1 WHERE scope_id = ?1').bind(site.scope).run();
  const pair = await pemPair();
  const privateKey = await importPrivateKeyPem(pair.pem);
  const k = await seedKey({ org: site, pair: { privateKey, publicRaw: pair.publicRaw, thumbprint: pair.thumbprint } });
  const clock = { now: freshNow() };
  const ip = freshIp();
  const sent: Request[] = [];
  let dropNext = 0;
  let stallNext = 0;
  const cfg: PlatformConfig = {
    apiBase: 'https://api.test',
    envName: env.ENV_NAME,
    signerAccount: env.SIGNER_ACCOUNT,
    keyId: k.id,
    privateKey,
    now: () => clock.now,
    fetch: async (url, init) => {
      const req = new Request(url as string, init);
      req.headers.set('cf-connecting-ip', ip);
      sent.push(req.clone());
      // Two seconds pass on the way (the org's hot-DB bucket refills as it would between real calls).
      clock.now += 2000;
      const res = await deliver(req, clock.now);
      // A lost answer: the request reached the API, the answer never came back.
      if (dropNext > 0) {
        dropNext--;
        throw new TypeError('fetch failed');
      }
      // A stalled answer: the status and headers arrive, the body never ends (until the attempt's signal fires).
      if (stallNext > 0) {
        stallNext--;
        const signal = init?.signal;
        if (!signal) throw new Error('the client sent no signal');
        const stalled = new ReadableStream<Uint8Array>({
          start(c) {
            signal.addEventListener('abort', () => c.error(signal.reason));
          },
        });
        return new Response(stalled, { status: res.status, headers: res.headers });
      }
      return res;
    },
  };
  return { k, site, cfg, clock, sent, dropAnswers: (n: number) => (dropNext = n), stallAnswers: (n: number) => (stallNext = n) };
}

describe('docs/platform-guide.md', () => {
  it('quotes the reference client exactly', () => {
    expect(guideBlock('<a id="reference-client"></a>')).toBe(sample);
  });

  it('the client signs what the real verifier accepts: a key from a PEM, the credential, the request id', async () => {
    const n = await network();
    const r = await callPlatform(n.cfg, { method: 'GET', path: '/v1/platform/credential' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ keyId: n.k.id, orgId: n.k.org, scopes: [n.k.scope], limits: { requestsPerMinute: PLATFORM_REQUEST_LIMITS.perKeyPerMinute, requestsPerDay: PLATFORM_REQUEST_LIMITS.perKeyPerDay } });
    expect(r.requestId).toBeTruthy();
    expect(r.requestId).toBe(r.body.requestId);
    // Each attempt is signed afresh: two calls, two nonces.
    await callPlatform(n.cfg, { method: 'GET', path: '/v1/platform/credential' });
    expect(new Set(n.sent.map((q) => q.headers.get('journear-nonce'))).size).toBe(2);
  });

  it('a partner’s life through the client: create, replay, list, read, propose, a stale version, cancel, suspend, keys, remove', async () => {
    const n = await network();
    const idem = newIdempotencyKey();
    const createReq = { method: 'POST' as const, path: '/v1/platform/apps', body: { scopeId: n.k.scope, name: 'Partner A Swaps', origins: ['https://swap.partner-a.example', 'https://widget.network.example'] }, idempotencyKey: idem };
    const created = await callPlatform(n.cfg, createReq);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.app as { id: string; originsVersion: number; userIds: string; origins: { origin: string; state: string; activeFrom: number | null; changeId: string }[]; keys: { id: string; key: string }[] };
    expect(app.userIds).toBe('app');
    expect(app.origins.map((o) => [o.origin, o.state, o.activeFrom])).toEqual([
      ['https://swap.partner-a.example', 'waiting_announcement', null],
      ['https://widget.network.example', 'waiting_announcement', null],
    ]);
    expect(created.body.publishableKey).toMatch(/^pk_test_/u);
    expect((created.body.changes as unknown[]).length).toBe(2);

    // The same operation again (same key, same body): the first result, nothing written twice.
    const again = await callPlatform(n.cfg, createReq);
    expect([again.status, again.body.replayed, (again.body.app as { id: string }).id]).toEqual([200, true, app.id]);
    // The same key for another body: idempotency_conflict.
    const other = await callPlatform(n.cfg, { ...createReq, body: { ...createReq.body, name: 'Partner A Other' } });
    expect([other.status, other.body.code], JSON.stringify(other.body)).toEqual([409, 'idempotency_conflict']);

    const list = await callPlatform(n.cfg, { method: 'GET', path: `/v1/platform/apps?scopeId=${n.k.scope}` });
    expect(list.status).toBe(200);
    expect((list.body.apps as { id: string }[]).map((a) => a.id)).toEqual([app.id]);
    const read = await callPlatform(n.cfg, { method: 'GET', path: `/v1/platform/apps/${app.id}` });
    expect((read.body.app as { originsVersion: number }).originsVersion).toBe(app.originsVersion);

    const added = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/origins`, body: { add: ['https://www.partner-a.example'], expectedVersion: app.originsVersion }, idempotencyKey: newIdempotencyKey() });
    expect(added.status, JSON.stringify(added.body)).toBe(202);
    const version = added.body.version as number;
    const change = (added.body.changes as { changeId: string; origin: string }[])[0]!;
    const stale = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/origins`, body: { add: ['https://shop.partner-a.example'], expectedVersion: app.originsVersion }, idempotencyKey: newIdempotencyKey() });
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);

    const cancelled = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/changes/${change.changeId}/cancel`, body: {}, idempotencyKey: newIdempotencyKey() });
    expect([cancelled.status, (cancelled.body.change as { status: string }).status]).toEqual([200, 'cancelled']);

    const suspended = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/suspend`, body: { suspended: true }, idempotencyKey: newIdempotencyKey() });
    expect([suspended.status, suspended.body.suspended]).toEqual([200, { byJournear: false, byOrganisation: false, byYou: true, youCanResume: true }]);
    const resumed = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/suspend`, body: { suspended: false }, idempotencyKey: newIdempotencyKey() });
    expect([resumed.status, (resumed.body.suspended as { byYou: boolean }).byYou]).toEqual([200, false]);

    const key = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/keys`, body: {}, idempotencyKey: newIdempotencyKey() });
    expect(key.status).toBe(201);
    const first = app.keys[0]!;
    const revoked = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/keys/${first.id}/revoke`, body: {}, idempotencyKey: newIdempotencyKey() });
    expect([revoked.status, revoked.body.warning]).toEqual([200, undefined]);

    const removed = await callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/origins/remove`, body: { remove: ['https://swap.partner-a.example'], expectedVersion: (await currentVersion(n.cfg, app.id)) }, idempotencyKey: newIdempotencyKey() });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.version).toBeGreaterThan(version);
    // A write without an Idempotency-Key is refused by the client before anything is sent.
    await expect(callPlatform(n.cfg, { method: 'POST', path: `/v1/platform/apps/${app.id}/keys`, body: {} })).rejects.toThrow(/Idempotency-Key/u);
  });

  it('a lost answer: the client signs again (a new nonce) with the same Idempotency-Key, and the app is created once', async () => {
    const n = await network();
    n.dropAnswers(1);
    const r = await callPlatform(n.cfg, { method: 'POST', path: '/v1/platform/apps', body: { scopeId: n.k.scope, name: 'Partner B Swaps' }, idempotencyKey: newIdempotencyKey() });
    expect([r.status, r.body.replayed]).toEqual([200, true]);
    expect(n.sent).toHaveLength(2);
    expect(n.sent[0]!.headers.get('journear-nonce')).not.toBe(n.sent[1]!.headers.get('journear-nonce'));
    expect(n.sent[0]!.headers.get('idempotency-key')).toBe(n.sent[1]!.headers.get('idempotency-key'));
    const apps = await env.DB.prepare("SELECT COUNT(*) AS c FROM apps WHERE org_id = ?1 AND created_by_kind = 'platform'").bind(n.k.org).first<{ c: number }>();
    expect(apps!.c).toBe(1);
  });

  it('a stalled answer: the attempt times out inside the body’s read, counts as no answer, and the retry is the replay', async () => {
    const n = await network();
    n.stallAnswers(1);
    const r = await callPlatform(n.cfg, { method: 'POST', path: '/v1/platform/apps', body: { scopeId: n.k.scope, name: 'Partner C Swaps' }, idempotencyKey: newIdempotencyKey() }, { timeoutMs: 300 });
    expect([r.status, r.body.replayed]).toEqual([200, true]);
    expect(n.sent).toHaveLength(2);
    expect(n.sent[0]!.headers.get('journear-nonce')).not.toBe(n.sent[1]!.headers.get('journear-nonce'));
    // With one attempt only, the timeout is the caller's error.
    n.stallAnswers(1);
    await expect(callPlatform(n.cfg, { method: 'GET', path: '/v1/platform/credential' }, { timeoutMs: 300, attempts: 1 })).rejects.toThrow();
  });

  it('refuses a bad attempts, timeout or base URL before sending anything, and drops a trailing slash from the base', async () => {
    const n = await network();
    const get = { method: 'GET' as const, path: '/v1/platform/credential' };
    for (const attempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(callPlatform(n.cfg, get, { attempts }), String(attempts)).rejects.toThrow(/attempts/u);
    }
    for (const timeoutMs of [0, -5, Number.NaN]) await expect(callPlatform(n.cfg, get, { timeoutMs }), String(timeoutMs)).rejects.toThrow(/timeoutMs/u);
    for (const apiBase of ['api.test', 'ftp://api.test', 'https://api.test/v1?x=1', '']) {
      await expect(callPlatform({ ...n.cfg, apiBase }, get), apiBase).rejects.toThrow(/base URL/u);
    }
    expect(n.sent).toHaveLength(0);
    const r = await callPlatform({ ...n.cfg, apiBase: 'https://api.test//' }, get);
    expect(r.status).toBe(200);
    expect(n.sent[0]!.url).toBe('https://api.test/v1/platform/credential');
  });

  it('the switch off: every call is 403 platform_off but the key can still stop itself', async () => {
    const n = await network();
    await switchOff(n.k.org);
    const get = await callPlatform(n.cfg, { method: 'GET', path: '/v1/platform/credential' });
    expect([get.status, get.body.code]).toEqual([403, 'platform_off']);
    const stop = await callPlatform(n.cfg, { method: 'POST', path: '/v1/platform/credential/revoke', body: { reason: 'Rotating keys' } });
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(await keyRow(n.k.id)).toMatchObject({ status: 'revoked', revoked_by_kind: 'platform' });
    // Afterwards: the one identical 401.
    const after = await callPlatform(n.cfg, { method: 'GET', path: '/v1/platform/credential' });
    expect([after.status, after.body.code]).toEqual([401, 'unauthenticated']);
  });

  it('the test vector it quotes: the generator’s message, the client’s signature with the vector key verifies, DER converted', async () => {
    // The vector key's private half: the 32 bytes of SHA-256 over the guide's fixed text (published test material).
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('journear platform request vectors: test key 1')));
    expect(guide).toContain('`journear platform request vectors: test key 1`');
    const jwk = vectors.key.jwk;
    const privateKey = await crypto.subtle.importKey('jwk', { ...jwk, d: Buffer.from(d).toString('base64url') }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', pub)) as ArrayBuffer);
    const k = await seedKey({ id: vectors.key.keyId, pair: { privateKey, publicRaw, thumbprint: vectors.key.thumbprint }, activeFrom: vectors.timestampMs - HOUR });

    for (const c of vectors.cases) {
      const h = c.headers as Record<string, string>;
      const msg = platformMessage({ ...c.signedFor, method: c.method, path: c.path, keyId: h['Journear-Key-Id']!, timestamp: h['Journear-Timestamp']!, nonce: h['Journear-Nonce']!, idempotencyKey: h['Idempotency-Key'] ?? '', bodySha256Hex: c.bodySha256 });
      expect(msg, c.name).toBe(c.message);
      expect(hexOf(derToRaw(Buffer.from(c.signatureDerHex, 'hex'))), c.name).toBe(c.signatureRawHex);
    }
    // The case the guide prints, in full.
    const shown = vectors.cases.find((c) => c.name === 'post_idempotency')!;
    for (const s of [`\`\`\`\n${shown.message}\n\`\`\``, shown.headers['Journear-Signature'], shown.signatureDerHex, shown.bodySha256, shown.headers['Journear-Nonce'], vectors.key.jwk.x, vectors.key.jwk.y, vectors.key.thumbprint, vectors.key.keyId]) {
      expect(guide, s).toContain(s);
    }

    // The client's own signature over the GET vector's inputs (its nonce, its time) verifies with the real verifier.
    const get = vectors.cases.find((c) => c.name === 'get')!;
    const headers = await signHeaders(
      { envName: env.ENV_NAME, signerAccount: env.SIGNER_ACCOUNT, keyId: k.id, privateKey },
      { method: 'GET', path: get.path, body: new Uint8Array(0), timestampMs: vectors.timestampMs, nonce: get.headers['Journear-Nonce'] },
    );
    const req = new Request(`https://api.test${get.path}`, { method: 'GET', headers: { ...headers, 'cf-connecting-ip': freshIp() } });
    const res = await deliver(req, vectors.timestampMs + 1000);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('states the numbers the code holds', () => {
    const L = PLATFORM_REQUEST_LIMITS;
    expect([L.perKeyPerMinute, L.perKeyPerDay, L.failuresPerIpPerMinute, L.breaker.perOrgPerHour, L.breaker.globalPerHour, L.breaker.floorPerOrgPerHour]).toEqual([60, 2000, 30, 10, 30, 5]);
    expect([L.killReservePerKeyPerMinute, L.killReservePerKeyPerDay]).toEqual([10, 100]);
    // "13 off switches a minute, 4 at once": the org's own slice over the costliest off switch.
    const costliest = Math.max(...PLATFORM_ROUTES.filter((r) => r.killSwitch || r.flags).map((r) => r.cost));
    expect(Math.floor((60 * PLATFORM_LIMITS.killSlice.ratePerS) / costliest)).toBe(13);
    expect(Math.floor(PLATFORM_LIMITS.killSlice.burst / costliest)).toBe(4);
    expect([PLATFORM_CLOCK_SKEW_MS, PLATFORM_BODY_MAX]).toEqual([60_000, 16 * 1024]);
    const O = PLATFORM_OPS_LIMITS;
    expect([O.creationsPerHour, O.proposalsPerHour, O.waitingPerOrg, O.keyCreationsPerHour, O.keyCreationsPerDay, O.listPage, O.suspensionsPerHour, O.keyRevokesPerHour]).toEqual([2, 20, 30, 20, 50, 50, 60, 20]);
    for (const s of [
      '60 requests a minute and 2,000 a UTC day',
      '30 failed requests a minute',
      '±60 seconds',
      '16 KiB',
      '2 an hour and 5 a UTC day',
      '20 an hour and 30 a UTC day',
      'at most 30 web addresses waiting',
      '10 apps',
      '20 an hour and 50 a UTC day',
      '10 an hour per organisation and 30 an hour across every organisation; your first 5 in any hour always pass',
      '10 more a minute and 100 more a UTC day, for off switches only',
      '| Suspending an app | 60 an hour per organisation, counting only those that changed something',
      '| Revoking a publishable key | 20 an hour per organisation, counting only those that changed something',
      '`platform:key:kill:minute`, `platform:key:kill:day`',
      '`platform:suspensions:hour`',
      '`platform:key-revokes:hour`',
      'your organisation gets 13 off switches a minute (4 at once)',
      'no other organisation can use, whatever others do',
    ]) {
      expect(guide, s).toContain(s);
    }
  });
});

/** The app's current `originsVersion`, read through the client. */
async function currentVersion(cfg: PlatformConfig, appId: string): Promise<number> {
  const r = await callPlatform(cfg, { method: 'GET', path: `/v1/platform/apps/${appId}` });
  return (r.body.app as { originsVersion: number }).originsVersion;
}
