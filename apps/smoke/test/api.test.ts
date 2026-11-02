import { describe, expect, it, vi } from 'vitest';
import { ApiError, HanaApi } from '../src/api.ts';

const PK = 'pk_test_1111111111111111111111';

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
}

describe('HanaApi', () => {
  it('GET /v1/app sends the publishable key and parses the config', async () => {
    const f = fakeFetch(200, { scopeId: 's1', signer: 'signer.testnet', google: { clientId: 'c.apps.googleusercontent.com', mode: 'own' }, requestId: 'r1' });
    const api = new HanaApi('https://api.example/', PK, f);
    expect(await api.app()).toEqual({ scopeId: 's1', signer: 'signer.testnet', google: { clientId: 'c.apps.googleusercontent.com', mode: 'own' }, requestId: 'r1' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/app');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('x-hana-key')).toBe(PK);
  });

  it('POSTs camelCase JSON bodies and returns result, nearTx and requestId', async () => {
    const session = { path: 's1#google#1#0', scope_id: 's1', expires_at_ms: 1, max_uses: 5, used: 0 };
    const f = fakeFetch(200, { result: session, nearTx: 'Tx1', requestId: 'r2' });
    const api = new HanaApi('https://api.example', PK, f);
    const body = { jwt: 'a.b.c', sessionPublicKey: [1], expiresAtMs: 1, salt: [2], keyIndex: 0, maxUses: 5, signature: [3] };
    expect(await api.createSession(body)).toEqual({ result: session, nearTx: 'Tx1', requestId: 'r2' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/sessions');
    expect(JSON.parse(init?.body as string)).toEqual(body);
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('routes derive and revoke', async () => {
    const d = fakeFetch(200, { result: { big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' }, nearTx: 'Tx2', requestId: 'r3' });
    await new HanaApi('https://api.example', PK, d).derive({ sessionPublicKey: [], counter: 1, signature: [], pk1: 'p1', pk2: 'p2' });
    expect(d.mock.calls[0]![0]).toBe('https://api.example/v1/derive');
    const r = fakeFetch(200, { result: null, nearTx: 'Tx3', requestId: 'r4' });
    expect(await new HanaApi('https://api.example', PK, r).revoke({ sessionPublicKey: [], counter: 2, signature: [] })).toEqual({ result: null, nearTx: 'Tx3', requestId: 'r4' });
    expect(r.mock.calls[0]![0]).toBe('https://api.example/v1/sessions/revoke');
  });

  it('turns API errors into ApiError with status, code and tx', async () => {
    const f = fakeFetch(422, { error: 'Wrong counter (replayed or out of order)', code: 'contract_rejected', nearTx: 'Tx4', requestId: 'r5' });
    const err = await new HanaApi('https://api.example', PK, f).derive({ sessionPublicKey: [], counter: 1, signature: [], pk1: 'p1', pk2: 'p2' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'contract_rejected', nearTx: 'Tx4', requestId: 'r5' });
  });

  it('reports non-JSON and unexpected responses', async () => {
    await expect(new HanaApi('https://api.example', PK, fakeFetch(502, '<html>bad gateway</html>')).app()).rejects.toMatchObject({ code: 'non_json_response', status: 502 });
    await expect(new HanaApi('https://api.example', PK, fakeFetch(200, { scopeId: 's1' })).app()).rejects.toMatchObject({ code: 'bad_response' });
    await expect(new HanaApi('https://api.example', PK, fakeFetch(200, { result: { big_y: 1 } })).derive({ sessionPublicKey: [], counter: 1, signature: [], pk1: '', pk2: '' })).rejects.toMatchObject({ code: 'bad_response' });
  });
});
