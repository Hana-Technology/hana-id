// The NEAR card's logic (src/near.ts): the guestbook's text rule as the contract counts it, the hostile list made safe,
// the borsh bytes (decoded back with the vault's own codec), and the reads from the env's NEAR RPC with its fallback.
import { describe, expect, it, vi } from 'vitest';
import { base64Encode, decodeNearDelegateAction, decodeNearTransaction, fromUtf8, nearImplicitPublicKey, utf8 } from '@hana-id/core';
import { base58 } from '@scure/base';
import {
  DELEGATE_TTL_BLOCKS,
  GUESTBOOK_GAS,
  GUESTBOOK_LIST_LIMIT,
  NearRpc,
  addMessageDelegate,
  addMessageTransaction,
  checkGuestbookText,
  delegateNonce,
  displayText,
  formatNear,
  parseMessages,
  scalarCount,
  shortAccount,
  transactionNonce,
  trimLikeRust,
} from '../src/near.ts';
import { NEAR_ACCOUNT } from './fixtures.ts';

const BOOK = 'hana-id-guestbook-dev1.testnet';

describe('the guestbook text rule (contracts/hana-guestbook)', () => {
  it('trims as Rust does (Unicode White_Space) and counts Unicode scalar values', () => {
    expect(checkGuestbookText('  gm  ')).toEqual({ ok: true, text: 'gm', chars: 2 });
    // U+0085 (NEL) is White_Space for Rust, not for JavaScript's trim; U+FEFF the other way round.
    expect(trimLikeRust('\u0085gm　')).toBe('gm');
    expect(trimLikeRust('﻿gm')).toBe('﻿gm');
    expect(checkGuestbookText('🌸'.repeat(200))).toEqual({ ok: true, text: '🌸'.repeat(200), chars: 200 });
    expect('🌸'.repeat(200).length).toBe(400);
    // A decomposed é is two scalar values, a composed one is one.
    expect(scalarCount('é')).toBe(2);
    expect(scalarCount('é')).toBe(1);
  });

  it('refuses what the contract refuses: empty after trimming, over 200 characters, and a lone surrogate', () => {
    expect(checkGuestbookText('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkGuestbookText(' \n\t  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkGuestbookText('a'.repeat(201))).toEqual({ ok: false, reason: 'too_long', chars: 201 });
    expect(checkGuestbookText(`  ${'a'.repeat(200)}  `)).toMatchObject({ ok: true, chars: 200 });
    expect(checkGuestbookText('gm \uD83D')).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('showing hostile guestbook entries', () => {
  it('neutralises bidi overrides, zero-width and control characters, keeps emoji sequences, and bounds the length', () => {
    expect(displayText('abc‮evil‬')).toBe('abc�evil�');
    expect(displayText('a​b⁦c⁩')).toBe('a�b�c�');
    expect(displayText('line1\nline2\r\tx')).toBe('line1 line2  x');
    expect(displayText('bell\u0007 del\u007F nul\u0000 sep ')).toBe('bell� del� nul� sep�');
    expect(displayText('👩‍💻 and ❤️‍🔥')).toBe('👩‍💻 and ❤️‍🔥');
    expect(displayText('a‍b')).toBe('a�b');
    expect(displayText('private')).toBe('�private');
    expect(displayText('x'.repeat(250))).toBe(`${'x'.repeat(200)}…`);
    expect(displayText('🌸'.repeat(200))).toBe('🌸'.repeat(200));
    // Markup stays literal text: the page puts it in a text node.
    expect(displayText('<img src=x onerror=alert(1)> https://evil.example')).toBe('<img src=x onerror=alert(1)> https://evil.example');
  });

  it('shortens account ids', () => {
    expect(shortAccount(NEAR_ACCOUNT)).toBe(`${NEAR_ACCOUNT.slice(0, 6)}…${NEAR_ACCOUNT.slice(-6)}`);
    expect(shortAccount('alice.testnet')).toBe('alice.testnet');
    expect(shortAccount('a-very-long-sub-account.of-someone.testnet')).toBe('a-very-long-…ne.testnet');
  });

  it('parses get_messages strictly: drops malformed entries and hostile ids, bounds the list, newest first', () => {
    const good = (index: number, extra: Record<string, unknown> = {}) => ({ index, account_id: NEAR_ACCOUNT, text: `m${index}`, block_timestamp_ms: 1_762_851_234_567, ...extra });
    const list = parseMessages([
      good(1),
      good(3),
      good(2, { account_id: 'bob.testnet' }),
      good(4, { account_id: '<script>.testnet' }),
      good(5, { account_id: 'Alice.testnet' }),
      good(6, { text: 42 }),
      good(7, { text: 'x'.repeat(801) }),
      good(8, { index: -1 }),
      good(9, { block_timestamp_ms: '1' }),
      null,
      'str',
      [good(10)],
    ]);
    expect(list.map((m) => [m.index, m.accountId])).toEqual([
      [3, NEAR_ACCOUNT],
      [2, 'bob.testnet'],
      [1, NEAR_ACCOUNT],
    ]);
    expect(parseMessages({ not: 'an array' })).toEqual([]);
    expect(parseMessages(Array.from({ length: 60 }, (_, i) => good(i)))).toHaveLength(GUESTBOOK_LIST_LIMIT);
  });

  it('formats yoctoNEAR', () => {
    expect(formatNear(0n)).toBe('0');
    expect(formatNear(10n ** 24n)).toBe('1');
    expect(formatNear(12n * 10n ** 23n + 34n * 10n ** 20n)).toBe('1.2034');
    expect(formatNear(10n ** 20n)).toBe('0.0001');
    expect(formatNear(1n)).toBe('0');
  });
});

describe('the bytes the user signs (decoded with the vault’s codec)', () => {
  const key = { type: 'ed25519', bytes: nearImplicitPublicKey(NEAR_ACCOUNT) };
  const call = (text: string) => [{ type: 'functionCall', methodName: 'add_message', args: utf8(JSON.stringify({ text })), gas: GUESTBOOK_GAS, deposit: 0n }];

  it('a delegate action: the user calls add_message on the guestbook with 30 Tgas, no deposit, expiring a few hundred blocks ahead', () => {
    const bytes = addMessageDelegate({ accountId: NEAR_ACCOUNT, guestbook: BOOK, text: 'gm "quoted" ‮', nonce: 1_000_001n, blockHeight: 200_000_000n });
    const d = decodeNearDelegateAction(bytes);
    expect(d).toEqual({ senderId: NEAR_ACCOUNT, receiverId: BOOK, actions: call('gm "quoted" ‮'), nonce: 1_000_001n, maxBlockHeight: 200_000_000n + DELEGATE_TTL_BLOCKS, publicKey: key });
    expect(GUESTBOOK_GAS).toBe(30n * 10n ** 12n);
    expect(DELEGATE_TTL_BLOCKS).toBeGreaterThanOrEqual(300n);
    // The relayer refuses more than its head + 1000 (and the vault more than + 10,000).
    expect(DELEGATE_TTL_BLOCKS).toBeLessThanOrEqual(1000n);
    expect(JSON.parse(fromUtf8((d.actions[0] as { args: Uint8Array }).args))).toEqual({ text: 'gm "quoted" ‮' });
  });

  it('a transaction: the same call, from the user, under the given block hash', () => {
    const hash = base58.encode(new Uint8Array(32).fill(7));
    const t = decodeNearTransaction(addMessageTransaction({ accountId: NEAR_ACCOUNT, guestbook: BOOK, text: 'gm', nonce: 5n, blockHash: hash }));
    expect(t).toEqual({ signerId: NEAR_ACCOUNT, publicKey: key, nonce: 5n, receiverId: BOOK, blockHash: new Uint8Array(32).fill(7), actions: call('gm') });
  });
});

describe('nonces', () => {
  const H = 200_000_000n;
  const M = 1_000_000n;

  it("a delegate action's: above the key's and the last signed, within (height − 10,000) × 10^6 .. height × 10^6", () => {
    // A key created recently: its nonce + 1.
    expect(delegateNonce({ keyNonce: (H - 5n) * M, blockHeight: H })).toBe((H - 5n) * M + 1n);
    // An old key (or one far below the window): the window's floor.
    expect(delegateNonce({ keyNonce: 1000n, blockHeight: H })).toBe((H - 10_000n) * M + 1n);
    // Above what this page signed before the next read.
    expect(delegateNonce({ keyNonce: (H - 5n) * M, blockHeight: H, lastSigned: (H - 5n) * M + 3n })).toBe((H - 5n) * M + 4n);
    expect(delegateNonce({ keyNonce: 1000n, blockHeight: H, lastSigned: (H - 10_000n) * M + 1n })).toBe((H - 10_000n) * M + 2n);
    // Never at or past height × 10^6.
    expect(() => delegateNonce({ keyNonce: H * M - 1n, blockHeight: H })).toThrow();
  });

  it("a transaction's: the key's nonce + 1 (1 for a key not on chain), or above the last signed", () => {
    expect(transactionNonce({ keyNonce: 41n })).toBe(42n);
    expect(transactionNonce({ keyNonce: null })).toBe(1n);
    expect(transactionNonce({ keyNonce: 41n, lastSigned: 50n })).toBe(51n);
  });
});

describe('NearRpc', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'hana-demo', result }), { status: 200 });
  const rpcError = (name: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'hana-demo', error: { name: 'HANDLER_ERROR', cause: { name }, code: -32000, message: name } }), { status: 200 });

  it('reads the access key at final finality, from the fallback when the first RPC fails', async () => {
    const fetch = vi.fn(async (url: string, _init: RequestInit) => (url === 'https://a.test' ? new Response('down', { status: 502 }) : ok({ nonce: 7, block_height: 100, block_hash: 'h1', permission: 'FullAccess' })));
    const rpc = new NearRpc(['https://a.test', 'https://b.test'], fetch);
    await expect(rpc.accessKey(NEAR_ACCOUNT, 'ed25519:K')).resolves.toEqual({ nonce: 7n, blockHeight: 100n, blockHash: 'h1' });
    expect(fetch.mock.calls.map(([u]) => u)).toEqual(['https://a.test', 'https://b.test']);
    const init = fetch.mock.calls[1]![1];
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(init.body as string)).toMatchObject({ method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: NEAR_ACCOUNT, public_key: 'ed25519:K' } });
  });

  it('a missing account or key is null (not activated), a missing account has balance 0', async () => {
    const rpc = new NearRpc(['https://a.test'], async () => rpcError('UNKNOWN_ACCOUNT'));
    await expect(rpc.accessKey(NEAR_ACCOUNT, 'ed25519:K')).resolves.toBeNull();
    await expect(rpc.balance(NEAR_ACCOUNT)).resolves.toBe(0n);
    await expect(new NearRpc(['https://a.test'], async () => rpcError('UNKNOWN_ACCESS_KEY')).accessKey(NEAR_ACCOUNT, 'ed25519:K')).resolves.toBeNull();
    await expect(new NearRpc(['https://a.test'], async () => ok({ amount: '1500000000000000000000000' })).balance(NEAR_ACCOUNT)).resolves.toBe(15n * 10n ** 23n);
  });

  it('fails with near_page_rpc_failed when no endpoint answers usefully', async () => {
    const rpc = new NearRpc(['https://a.test', 'https://b.test'], async (url) => (url === 'https://a.test' ? Promise.reject(new TypeError('Failed to fetch')) : ok({ unexpected: true })));
    await expect(rpc.finalBlock()).rejects.toMatchObject({ code: 'near_page_rpc_failed' });
    await expect(rpc.accessKey(NEAR_ACCOUNT, 'ed25519:K')).rejects.toMatchObject({ code: 'near_page_rpc_failed' });
  });

  it('gives up on an endpoint after its timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const rpc = new NearRpc(['https://a.test'], (_u, init) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))), 5000);
      const p = rpc.finalBlock().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await p).toMatchObject({ code: 'near_page_rpc_failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the final block, and a view call’s JSON (only valid UTF-8 JSON)', async () => {
    const bytes = (v: unknown) => Array.from(utf8(JSON.stringify(v)));
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { method: string; params: Record<string, unknown> };
      if (body.method === 'block') return ok({ header: { height: 123, hash: 'bh' } });
      return ok({ result: bytes([{ index: 0 }]), logs: [] });
    });
    const rpc = new NearRpc(['https://a.test'], fetch);
    await expect(rpc.finalBlock()).resolves.toEqual({ height: 123n, hash: 'bh' });
    await expect(rpc.view(BOOK, 'get_messages', { limit: 20 })).resolves.toEqual([{ index: 0 }]);
    const params = (JSON.parse(fetch.mock.calls[1]![1].body as string) as { params: Record<string, string> }).params;
    expect(params).toMatchObject({ request_type: 'call_function', account_id: BOOK, method_name: 'get_messages', args_base64: base64Encode(utf8('{"limit":20}')) });
    await expect(new NearRpc(['https://a.test'], async () => ok({ result: [0xff, 0xfe] })).view(BOOK, 'get_messages', {})).rejects.toMatchObject({ code: 'near_page_rpc_failed' });
    await expect(new NearRpc(['https://a.test'], async () => ok({ result: [300] })).view(BOOK, 'get_messages', {})).rejects.toMatchObject({ code: 'near_page_rpc_failed' });
  });

  it('sends a signed transaction and reports a failure', async () => {
    await expect(new NearRpc(['https://a.test'], async () => ok({ status: { SuccessValue: '' } })).sendTx('AAAA')).resolves.toBeUndefined();
    await expect(new NearRpc(['https://a.test'], async () => ok({ status: { Failure: {} } })).sendTx('AAAA')).rejects.toMatchObject({ code: 'near_send_failed' });
    await expect(new NearRpc(['https://a.test'], async () => rpcError('NotEnoughBalance')).sendTx('AAAA')).rejects.toMatchObject({ code: 'near_send_failed' });
  });
});
