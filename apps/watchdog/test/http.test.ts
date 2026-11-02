// Size-capped body reads (H1, M1): a huge or endless body fails as a fetch failure, whatever its headers say.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BodyTooLarge, readCapped, readJsonCapped } from '../src/http.ts';
import { fetchEmailJwks, fetchGoogleJwks, fetchIdentityDocument } from '../src/index.ts';
import { Rpc, RpcError } from '../src/near.ts';

const endless = () => new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(64 * 1024).fill(32)) });

afterEach(() => vi.restoreAllMocks());

describe('readCapped', () => {
  it('reads a body within the limit', async () => {
    expect(await readCapped(new Response('hello'), 5)).toBe('hello');
    expect(await readJsonCapped(Response.json({ a: 1 }), 100)).toEqual({ a: 1 });
    expect(await readCapped(new Response(null), 5)).toBe('');
  });

  it('refuses by Content-Length before reading, and by counting when the header is missing or lies', async () => {
    await expect(readCapped(new Response('x'.repeat(10), { headers: { 'content-length': '10' } }), 5)).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(readCapped(new Response(endless()), 1024 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(readCapped(new Response(endless(), { headers: { 'content-length': '10' } }), 1024)).rejects.toBeInstanceOf(BodyTooLarge);
  });
});

describe('every third-party read is capped', () => {
  it("Google's and Hana's JWKS fail on an endless body", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(endless()));
    await expect(fetchGoogleJwks()).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(fetchEmailJwks('https://api.test/v1/email/jwks.json')).rejects.toBeInstanceOf(BodyTooLarge);
    // An oversized 200 from Hana's identity endpoints is a finding (critical at once), not a fetch failure (D210).
    expect(await fetchIdentityDocument('https://api.test/v1/identity/jwks.json')).toEqual({ kind: 'too_large' });
    expect(await fetchIdentityDocument('https://api.test/v1/identity/.well-known/openid-configuration')).toEqual({ kind: 'too_large' });
  });

  it("Hana's identity documents: no cache, no redirect followed, only a 200 is a body, other statuses throw", async () => {
    const seen: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      const url = String(input);
      if (url.endsWith('/jwks.json')) return new Response('{"keys":[]}');
      if (url.endsWith('/moved')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/jwks.json' } });
      if (url.endsWith('/empty')) return new Response('', { status: 204 });
      return new Response('down', { status: 503 });
    });
    expect(await fetchIdentityDocument('https://api.test/v1/identity/jwks.json')).toEqual({ kind: 'body', text: '{"keys":[]}' });
    expect(await fetchIdentityDocument('https://api.test/moved')).toEqual({ kind: 'redirect', status: 302, location: 'https://evil.example/jwks.json' });
    await expect(fetchIdentityDocument('https://api.test/empty')).rejects.toThrow(/HTTP 204/u);
    await expect(fetchIdentityDocument('https://api.test/v1/identity/.well-known/openid-configuration')).rejects.toThrow(/HTTP 503/u);
    expect(seen.every((i) => i.cache === 'no-store' && i.redirect === 'manual' && i.signal instanceof AbortSignal)).toBe(true);
  });

  it('a NEAR RPC answer over the cap is a transient RPC error (the fallback is tried)', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(endless());
    });
    const err = await new Rpc(['https://a.invalid', 'https://b.invalid']).call('status', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).transient).toBe(true);
    expect(urls).toEqual(['https://a.invalid', 'https://b.invalid']);
  });
});
