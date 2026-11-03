// The vault's google-match client (src/vault/issuer.ts): a timeout on every call (G-L5), 429 and 503 as MatchBusy with
// the issuer's retry-after (G-M3), the answer's shape checked, and the issuer's error codes kept.
import { ApiError } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import { MATCH_TIMEOUT_MS, MatchBusy, issuerApi, parseGoogleMatch } from '../../src/vault/issuer.ts';

const REQUEST = {
  pk: 'pk_test_1111111111111111111111',
  accessToken: 'ya29.test',
  googleIdToken: 'h.p.s',
  commitment: { scopeId: 's1', sessionPublicKey: [1], expiresAtMs: 1, keyIndex: 0, maxUses: 1, salt: [2] },
  link: true,
};

function fetchAnswering(res: () => Response) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return res();
  }) as typeof fetch;
  return { fetchFn, seen };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('issuerApi.googleMatch', () => {
  it('posts to the issuer’s google-match with no cookies, no referrer and a timeout', async () => {
    const f = fetchAnswering(() => json(200, { decision: 'none', googleHosted: false, linkable: false, requestId: 'r' }));
    expect(await issuerApi('https://issuer.test/anything', f.fetchFn).googleMatch(REQUEST)).toEqual({ decision: 'none', googleHosted: false, linkable: false, emailToken: null, linkImmediate: null, challenge: null });
    const { url, init } = f.seen[0]!;
    expect(url).toBe('https://issuer.test/v1/email/google-match');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(MATCH_TIMEOUT_MS).toBe(30_000);
  });

  it('429 and 503 are MatchBusy with the retry-after (when it is a number of seconds)', async () => {
    for (const [status, header, want] of [
      [429, '7', 7000],
      [503, undefined, null],
      [429, 'Wed, 21 Oct 2015 07:28:00 GMT', null],
    ] as const) {
      const f = fetchAnswering(() => json(status, { error: 'busy', code: 'rate_limited', requestId: 'r' }, header ? { 'retry-after': header } : {}));
      const err = await issuerApi('https://issuer.test', f.fetchFn)
        .googleMatch(REQUEST)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MatchBusy);
      expect((err as MatchBusy).retryAfterMs).toBe(want);
    }
  });

  it('another error keeps the issuer’s code (google_account_mismatch); a malformed answer is bad_response', async () => {
    const mismatch = fetchAnswering(() => json(400, { error: 'x', code: 'google_account_mismatch', requestId: 'r' }));
    const err = await issuerApi('https://issuer.test', mismatch.fetchFn)
      .googleMatch(REQUEST)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('google_account_mismatch');
    expect(() => parseGoogleMatch({ decision: 'case_z', googleHosted: false, linkable: false })).toThrow(ApiError);
  });
});
