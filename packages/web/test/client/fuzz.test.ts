// @vitest-environment happy-dom
// Fuzz (docs/batch-b-spec.md Tests → Other, "the port protocol"): random EIP-1193, Stellar and raw calls with junk
// params never make the client send a port message the vault's parser drops (which would hang the call), never send
// anything but the port protocol, and every call settles, with a ProviderRpcError (numeric code) on the EIP-1193 side.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HanaError, ProviderRpcError } from '../../src/client/errors.ts';
import { EVM, LOGGED_IN, STELLAR, type Setup, flush, rpcFetch, setup } from './harness.ts';

let s: Setup;
afterEach(() => {
  s?.client.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: unknown[] = [
  undefined,
  null,
  0,
  -1,
  1.5,
  '',
  'x',
  '0x',
  '0x1',
  '0xzz',
  EVM,
  EVM.toLowerCase(),
  STELLAR,
  'AAAA',
  '{"a":1}',
  [],
  [1],
  {},
  { to: EVM },
  { to: EVM, value: '0x1' },
  { chainId: '0x1' },
  { type: '0x1' },
  new Uint8Array(0),
  new Uint8Array(32),
  new Uint8Array(5000),
  'a'.repeat(300_000),
  { xdr: 'AAAA' },
];
const EVM_METHODS = ['eth_accounts', 'eth_chainId', 'eth_sendTransaction', 'eth_signTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'eth_sign', 'eth_call', 'nope'];

describe('fuzz', () => {
  it('random calls: no dropped port message, all settle, EIP-1193 errors are numeric', async () => {
    const rand = prng(20261028);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const rpc = rpcFetch({ eth_getTransactionCount: '0x0', eth_estimateGas: '0x5208', eth_getBlockByNumber: { baseFeePerGas: '0x1' }, eth_maxPriorityFeePerGas: '0x1', eth_sendRawTransaction: `0x${'00'.repeat(32)}`, eth_call: '0x' });
    s = setup({ config: { evm: { chains: [{ id: 1, rpcUrl: 'https://rpc.test' }], defaultChainId: 1 }, stellar: { networkPassphrase: 'Test SDF Network ; September 2015' } }, fetch: rpc });
    await s.vault.connect(LOGGED_IN);
    // The vault rejects every request it gets (the point is what reaches it, and that callers hear back).
    for (const m of ['eth_accounts', 'eth_signTransaction', 'personal_sign', 'eth_signTypedData_v4', 'stellar_signTransaction', 'stellar_signAuthEntry', 'stellar_signMessage', 'hana_signRaw', 'hana_export'] as const) {
      s.vault.handle(m, () => ({ error: { code: 4001, message: 'User rejected' } }));
    }

    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 400; i++) {
      const kind = rand();
      if (kind < 0.5) {
        const params = rand() < 0.3 ? pick(JUNK) : [pick(JUNK), pick(JUNK)].slice(0, Math.floor(rand() * 3));
        calls.push(
          s.client.ethereum.request({ method: pick(EVM_METHODS), params: params as never }).then(
            () => 'ok',
            (e: unknown) => {
              expect(e).toBeInstanceOf(ProviderRpcError);
              expect(Number.isInteger((e as ProviderRpcError).code)).toBe(true);
              return 'err';
            },
          ),
        );
      } else {
        const fn: () => Promise<unknown> = pick<() => Promise<unknown>>([
          () => s.client.stellar.signTransaction(pick(JUNK) as never, { networkPassphrase: pick(['Test SDF Network ; September 2015', pick(JUNK)]) as never }),
          () => s.client.stellar.signAuthEntry(pick(JUNK) as never),
          () => s.client.stellar.signMessage(pick(JUNK) as never, { address: pick([undefined, STELLAR, pick(JUNK)]) as never }),
          () => s.client.signRaw({ chain: pick(['stellar', 'evm', 'x']), bytes: pick(JUNK), digest: pick(JUNK) } as never),
          () => s.client.exportKey(pick(['stellar', 'evm', pick(JUNK)]) as never),
        ]);
        calls.push(
          Promise.resolve()
            .then(fn)
            .then(
              () => 'ok',
              (e: unknown) => {
                expect(e).toBeInstanceOf(HanaError);
                return 'err';
              },
            ),
        );
      }
    }
    await flush();
    const results = await Promise.all(calls);
    expect(results).toHaveLength(400);
    expect(s.vault.invalid).toEqual([]);
    expect(s.vault.requests.length).toBeGreaterThan(20); // the fuzz reaches the vault, not only client-side refusals
    expect(s.vault.requests.every((r) => r.raw.v === 1 && typeof r.raw.id === 'string')).toBe(true);
  });
});
