// @vitest-environment happy-dom
// hana.near and hana.addresses.near (D720–D729): the account from the vault's addresses (absent from an older vault),
// the near_* port requests (bytes or base64 in, NEP-461's prefix taken off a delegate action), the NEAR export guard,
// and hana.near.relay against a mocked POST /v1/near/relay.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEP366_SIGNING_PREFIX, base64Encode, concatBytes, nearImplicitPublicKey, nearPublicKeyString, u32le } from '@hana-id/core';
import { HanaError } from '../../src/client/errors.ts';
import { stripDelegatePrefix } from '../../src/client/near.ts';
import { EVM, LOGGED_IN, PK, STELLAR, type Setup, flush, setup } from './harness.ts';

const NEAR = 'ab'.repeat(32);
const NEAR_IN: typeof LOGGED_IN = { ...LOGGED_IN, addresses: { stellar: STELLAR, evm: EVM, near: NEAR } };
const SIG = base64Encode(new Uint8Array(64).fill(1));
const API = 'https://api.hana.test';

let s: Setup;
afterEach(() => {
  s?.client.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function rejection(p: Promise<unknown>): Promise<HanaError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HanaError);
  return e as HanaError;
}

describe('hana.addresses.near and hana.near.accountId', () => {
  it('come from the vault’s addresses', async () => {
    s = setup();
    await s.vault.connect(NEAR_IN);
    expect(s.client.addresses).toEqual({ stellar: STELLAR, evm: EVM, near: NEAR });
    expect(s.client.near.accountId).toBe(NEAR);
    expect(s.client.near.publicKey).toBe(nearPublicKeyString(nearImplicitPublicKey(NEAR)));
  });

  it('are absent with a vault that predates NEAR, and NEAR requests are refused before sending (4100)', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    expect(s.client.addresses).toEqual({ stellar: STELLAR, evm: EVM });
    expect(s.client.near.accountId).toBeNull();
    expect(s.client.near.publicKey).toBeNull();
    expect((await rejection(s.client.near.signTransaction({ network: 'testnet', transaction: new Uint8Array(8) }))).code).toBe(4100);
    expect((await rejection(s.client.near.signMessage({ message: 'm', recipient: 'r', nonce: new Uint8Array(32) }))).code).toBe(4100);
    expect((await rejection(s.client.exportKey('near'))).code).toBe(4100);
    expect(s.vault.requests.filter((r) => r.method.startsWith('near_') || r.method === 'hana_export')).toEqual([]);
  });

  it('accountsChanged reports a change of the NEAR account alone', async () => {
    s = setup();
    await s.vault.connect(NEAR_IN);
    const seen: unknown[] = [];
    s.client.on('accountsChanged', (a) => seen.push(a));
    s.vault.emit('accountsChanged', { addresses: { stellar: STELLAR, evm: EVM, near: 'cd'.repeat(32) } });
    await flush();
    expect(seen).toEqual([{ stellar: STELLAR, evm: EVM, near: 'cd'.repeat(32) }]);
  });
});

describe('hana.near signing', () => {
  it('signTransaction sends base64 (from bytes or base64) and the network', async () => {
    s = setup();
    await s.vault.connect(NEAR_IN);
    const result = { signature: SIG, signedTransaction: base64Encode(new Uint8Array(80)), hash: '11111111111111111111111111111111' };
    s.vault.handle('near_signTransaction', () => ({ result }));
    await expect(s.client.near.signTransaction({ network: 'testnet', transaction: Uint8Array.of(1, 2, 3) })).resolves.toEqual(result);
    expect(s.vault.last('near_signTransaction').params).toEqual({ network: 'testnet', transaction: 'AQID' });
    await s.client.near.signTransaction({ network: 'testnet', transaction: 'AQID' });
    expect(s.vault.last('near_signTransaction').params).toEqual({ network: 'testnet', transaction: 'AQID' });
  });

  it('refuses bad shapes with -32602 before sending', async () => {
    s = setup();
    await s.vault.connect(NEAR_IN);
    expect((await rejection(s.client.near.signTransaction({ network: 'betanet' as never, transaction: 'AQID' }))).code).toBe(-32602);
    expect((await rejection(s.client.near.signTransaction({ network: 'testnet', transaction: 'not base64!' }))).code).toBe(-32602);
    expect((await rejection(s.client.near.signMessage({ message: 'm', recipient: 'r', nonce: new Uint8Array(31) }))).code).toBe(-32602);
    expect(s.vault.requests.filter((r) => r.method.startsWith('near_'))).toEqual([]);
  });

  it('signDelegateAction takes NEP-461’s prefix off (encodeDelegateAction’s output)', async () => {
    s = setup();
    await s.vault.connect(NEAR_IN);
    s.vault.handle('near_signDelegateAction', () => ({ result: { signature: SIG, signedDelegateAction: base64Encode(new Uint8Array(90)) } }));
    const plain = Uint8Array.of(2, 0, 0, 0, 97, 98);
    await s.client.near.signDelegateAction({ network: 'testnet', delegateAction: concatBytes(u32le(NEP366_SIGNING_PREFIX), plain) });
    expect(s.vault.last('near_signDelegateAction').params).toEqual({ network: 'testnet', delegateAction: base64Encode(plain) });
    await s.client.near.signDelegateAction({ network: 'testnet', delegateAction: plain });
    expect(s.vault.last('near_signDelegateAction').params).toEqual({ network: 'testnet', delegateAction: base64Encode(plain) });
    expect(stripDelegatePrefix(plain)).toEqual(plain);
  });

  it('signMessage sends NEP-413’s fields with the nonce as base64', async () => {
    s = setup();
    await s.vault.connect(NEAR_IN);
    s.vault.handle('near_signMessage', () => ({ result: { accountId: NEAR, publicKey: nearPublicKeyString(nearImplicitPublicKey(NEAR)), signature: SIG } }));
    await s.client.near.signMessage({ message: 'Sign in', recipient: 'guestbook.example', nonce: new Uint8Array(32).fill(2), callbackUrl: 'https://g.example/cb' });
    expect(s.vault.last('near_signMessage').params).toEqual({ message: 'Sign in', recipient: 'guestbook.example', nonce: base64Encode(new Uint8Array(32).fill(2)), callbackUrl: 'https://g.example/cb' });
  });

  it('exportKey(near) goes to the vault when it has a NEAR account', async () => {
    s = setup();
    await s.vault.connect(NEAR_IN);
    s.vault.handle('hana_export', () => ({ result: null }));
    await expect(s.client.exportKey('near')).resolves.toBeNull();
    expect(s.vault.last('hana_export').params).toEqual({ chain: 'near' });
  });
});

describe('hana.near.relay', () => {
  const SDA = base64Encode(new Uint8Array(100).fill(3));

  it('POSTs {network, signedDelegateAction} to /v1/near/relay with the publishable key, and reads the answer', async () => {
    s = setup({ apiUrl: API, fetch: async () => new Response(JSON.stringify({ transactionHash: '11111111111111111111111111111111', status: 'executed' }), { status: 200 }) });
    await s.vault.connect(NEAR_IN);
    await expect(s.client.near.relay({ network: 'testnet', signedDelegateAction: SDA })).resolves.toEqual({ transactionHash: '11111111111111111111111111111111', status: 'executed' });
    const [url, init] = s.fetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${API}/v1/near/relay`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-hana-key': PK });
    expect(JSON.parse(init.body as string)).toEqual({ network: 'testnet', signedDelegateAction: SDA });
  });

  it('takes bytes too', async () => {
    s = setup({ apiUrl: API, fetch: async () => new Response(JSON.stringify({ transactionHash: '11111111111111111111111111111111', status: 'ok' })) });
    await s.client.near.relay({ network: 'testnet', signedDelegateAction: new Uint8Array(100).fill(3) });
    expect(JSON.parse((s.fetch.mock.calls.at(-1) as [string, RequestInit])[1].body as string).signedDelegateAction).toBe(SDA);
  });

  it.each([
    [429, { code: 'rate_limited', error: 'slow down' }, 'rate_limited'],
    [403, { code: 'origin_not_allowed', error: 'no' }, 'origin_not_allowed'],
    [400, { code: 'bad_request', error: 'bad', requestId: 'rq1' }, 4100],
    [502, { code: 'relay_failed', error: 'down' }, 'api_unavailable'],
  ] as const)('HTTP %i %j → %s', async (status, body, code) => {
    s = setup({ apiUrl: API, fetch: async () => new Response(JSON.stringify(body), { status }) });
    const e = await rejection(s.client.near.relay({ network: 'testnet', signedDelegateAction: SDA }));
    expect(e.code).toBe(code);
    expect(e.data).toMatchObject({ status, reason: body.code });
  });

  it('a network failure, an unreadable answer, mainnet and a build without the API URL', async () => {
    s = setup({ apiUrl: API, fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    expect((await rejection(s.client.near.relay({ network: 'testnet', signedDelegateAction: SDA }))).code).toBe('api_unavailable');
    s.client.destroy();
    s = setup({ apiUrl: API, fetch: async () => new Response(JSON.stringify({ transactionHash: 'x', status: 'ok' })) });
    expect((await rejection(s.client.near.relay({ network: 'testnet', signedDelegateAction: SDA }))).code).toBe('api_unavailable');
    expect((await rejection(s.client.near.relay({ network: 'mainnet' as never, signedDelegateAction: SDA }))).code).toBe(-32602);
    s.client.destroy();
    s = setup();
    expect((await rejection(s.client.near.relay({ network: 'testnet', signedDelegateAction: SDA }))).code).toBe('api_unavailable');
  });
});

describe('hana.near.activate', () => {
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("POSTs the user's own account to /v1/near/activate with the publishable key, and reads { created }", async () => {
    s = setup({ apiUrl: API, fetch: answer({ created: true }) });
    await s.vault.connect(NEAR_IN);
    await expect(s.client.near.activate()).resolves.toEqual({ created: true });
    const [url, init] = s.fetch.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${API}/v1/near/activate`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-hana-key': PK });
    expect(JSON.parse(init.body as string)).toEqual({ accountId: NEAR });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('an account that exists already: { created: false }; extra fields are dropped', async () => {
    s = setup({ apiUrl: API, fetch: answer({ created: false, extra: '<b>' }) });
    await s.vault.connect(NEAR_IN);
    await expect(s.client.near.activate()).resolves.toEqual({ created: false });
  });

  it('refuses before any call while logged out or with a vault that has no NEAR account (4100)', async () => {
    s = setup({ apiUrl: API, fetch: answer({ created: true }) });
    expect((await rejection(s.client.near.activate())).code).toBe(4100);
    await s.vault.connect(LOGGED_IN);
    expect((await rejection(s.client.near.activate())).code).toBe(4100);
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [429, { code: 'rate_limited', error: 'slow down' }, 'rate_limited'],
    [403, { code: 'app_suspended', error: 'no' }, 'app_suspended'],
    [400, { code: 'account_invalid', error: 'bad', requestId: 'rq1' }, 4100],
    [503, { code: 'relayer_unavailable', error: 'down' }, 'api_unavailable'],
  ] as const)('HTTP %i %j → %s, with the API code as data.reason', async (status, body, code) => {
    s = setup({ apiUrl: API, fetch: answer(body, status) });
    await s.vault.connect(NEAR_IN);
    const e = await rejection(s.client.near.activate());
    expect(e.code).toBe(code);
    expect(e.data).toMatchObject({ status, reason: body.code });
  });

  it('a network failure, an unreadable answer and a build without the API URL are api_unavailable', async () => {
    s = setup({ apiUrl: API, fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await s.vault.connect(NEAR_IN);
    expect((await rejection(s.client.near.activate())).code).toBe('api_unavailable');
    s.client.destroy();
    for (const bad of [{ created: 'yes' }, {}, [true], null]) {
      s = setup({ apiUrl: API, fetch: answer(bad) });
      await s.vault.connect(NEAR_IN);
      expect((await rejection(s.client.near.activate())).code, JSON.stringify(bad)).toBe('api_unavailable');
      s.client.destroy();
    }
    s = setup();
    await s.vault.connect(NEAR_IN);
    expect((await rejection(s.client.near.activate())).code).toBe('api_unavailable');
  });

  it('gives up after NEAR_RELAY_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      s = setup({
        apiUrl: API,
        fetch: (_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      });
      await s.vault.connect(NEAR_IN);
      const p = rejection(s.client.near.activate());
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await p).code).toBe('api_unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the timeout armed while the body is read (headers sent, then a stall)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      s = setup({
        apiUrl: API,
        fetch: async (_url: string, init?: RequestInit) =>
          ({ ok: true, status: 200, json: () => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))) }) as unknown as Response,
      });
      await s.vault.connect(NEAR_IN);
      const p = rejection(s.client.near.activate());
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await p).code).toBe('api_unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('409 near_account_unrecorded (the account not in the wallet directory yet) is 4100 with that reason', async () => {
    s = setup({ apiUrl: API, fetch: answer({ code: 'near_account_unrecorded', error: 'not yet' }, 409) });
    await s.vault.connect(NEAR_IN);
    const e = await rejection(s.client.near.activate());
    expect(e.code).toBe(4100);
    expect(e.data).toMatchObject({ status: 409, reason: 'near_account_unrecorded' });
  });
});
