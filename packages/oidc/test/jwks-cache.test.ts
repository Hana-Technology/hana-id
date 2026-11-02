// JwksCache's fetch limits and TTL options (the Google defaults are covered through verifyIdToken in id-token.test.ts,
// the Access settings in access.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { FETCH_TIMEOUT_MS, JwksUnavailableError, MAX_BODY_BYTES } from '../src/index.ts';
import { JwksCache } from '../src/jwks-cache.ts';
import { FakeJwks, type RsaSigner, rsaSigner } from './helpers.ts';

const T0 = 1_800_000_000_000;
const URL_ = 'https://issuer.test/jwks';

let signer: RsaSigner;
beforeAll(async () => {
  signer = await rsaSigner('k1');
});

describe('JwksCache', () => {
  it('defaults: an 8 s timeout and a 64 KiB body cap', () => {
    expect(FETCH_TIMEOUT_MS).toBe(8_000);
    expect(MAX_BODY_BYTES).toBe(65_536);
  });

  it('every fetch carries an abort signal, and a hung endpoint fails closed after timeoutMs', async () => {
    const jwks = new FakeJwks([signer.jwk]);
    jwks.hang = true;
    const cache = new JwksCache(URL_, { fetch: jwks.fetch, timeoutMs: 20 });
    await expect(cache.key('k1', T0)).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(jwks.inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(jwks.inits[0]?.headers).toEqual({ accept: 'application/json' });
  });

  it('refuses a body over maxBodyBytes, declared or streamed, and accepts one at the cap', async () => {
    const body = JSON.stringify({ keys: [signer.jwk] });
    const at = (maxBodyBytes: number, padded: string): Promise<unknown> => {
      const jwks = new FakeJwks();
      jwks.body = padded;
      return new JwksCache(URL_, { fetch: jwks.fetch, maxBodyBytes }).key('k1', T0);
    };
    const size = new TextEncoder().encode(body).byteLength;
    expect(await at(size, body)).toEqual(signer.jwk);
    await expect(at(size - 1, body)).rejects.toThrow('JWKS response too large');
    // A streamed body (no Content-Length) is cut off at the cap.
    const streamed: typeof fetch = () =>
      Promise.resolve(new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(' '.repeat(100) + body)), c.close()) })));
    await expect(new JwksCache(URL_, { fetch: streamed, maxBodyBytes: 100 }).key('k1', T0)).rejects.toThrow('JWKS response too large');
    expect(await new JwksCache(URL_, { fetch: streamed, maxBodyBytes: 100 + size }).key('k1', T0)).toEqual(signer.jwk);
    // A Content-Length over the cap is refused unread.
    const declared: typeof fetch = () => Promise.resolve(new Response(body, { headers: { 'content-length': String(10 * MAX_BODY_BYTES) } }));
    await expect(new JwksCache(URL_, { fetch: declared }).key('k1', T0)).rejects.toThrow('JWKS response too large');
  });

  it('TTL: max-age clamped to [minTtlMs, maxTtlMs]; no-cache and no-store mean 0 only with respectNoCache', async () => {
    const fetchesFor = async (cacheControl: string | undefined, later: number, opts: { minTtlMs?: number; maxTtlMs?: number; respectNoCache?: boolean }): Promise<number> => {
      const jwks = new FakeJwks([signer.jwk]);
      jwks.cacheControl = cacheControl;
      const cache = new JwksCache(URL_, { fetch: jwks.fetch, ...opts });
      await cache.key('k1', T0);
      await cache.key('k1', T0 + later);
      return jwks.fetches;
    };
    const access = { minTtlMs: 0, maxTtlMs: 600_000, respectNoCache: true };
    expect(await fetchesFor('max-age=0', 1, access)).toBe(2);
    expect(await fetchesFor('no-cache', 1, access)).toBe(2);
    expect(await fetchesFor('private, no-store', 1, access)).toBe(2);
    expect(await fetchesFor('max-age=60, no-cache', 1, access)).toBe(2);
    expect(await fetchesFor('max-age=60', 59_000, access)).toBe(1);
    expect(await fetchesFor('max-age=60', 61_000, access)).toBe(2);
    expect(await fetchesFor('max-age=86400', 599_000, access)).toBe(1);
    expect(await fetchesFor('max-age=86400', 601_000, access)).toBe(2);
    expect(await fetchesFor(undefined, 599_000, access)).toBe(1);
    expect(await fetchesFor(undefined, 601_000, access)).toBe(2);
    // Google's defaults: a 5-minute floor, no-cache ignored (1 h without a max-age).
    expect(await fetchesFor('max-age=0', 299_000, {})).toBe(1);
    expect(await fetchesFor('no-cache', 3_599_000, {})).toBe(1);
    expect(await fetchesFor('no-cache', 3_601_000, {})).toBe(2);
  });
});
