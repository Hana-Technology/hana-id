// fetch-ckd-key (OPER-1, D100): the CKD network key is pinned only when at least three independent RPC providers
// report the env's chain, the same block hash at one final height and the same key there; the block is recorded.
import { readFileSync } from 'node:fs';
import { type Manifest, loadEnv, manifestPath, manifestSchema } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { type CkdRpc, type FetchCkdKeyDeps, WELL_KNOWN_RPCS, ckdSources, fetchCkdKey, providerOf, readCkdKeyAgreed } from '../lib/ckd.ts';
import { CliError } from '../lib/cli.ts';
import { setManifestObject } from '../lib/manifest-edit.ts';

const KEY = 'bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj';
const OTHER_KEY = 'bls12381g2:3xYz';
const HASH = '9DFC5WU3ihL8xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZ';

/** sandbox-dev's manifest as a fixture (the real file may be re-pinned). */
const base = (): Manifest => {
  const { ckdNetworkKeySource: _s, ...m } = loadEnv('sandbox-dev');
  return m;
};

interface FakeChain {
  chainId?: string;
  finalHeight?: number;
  hashAt?: (h: number) => string;
  key?: string;
  fail?: 'status' | 'block' | 'query';
  /** Block-at-height reads that fail before one succeeds (a node behind). */
  behind?: number;
}

/** A fake RPC endpoint answering status, block and the MPC state query, recording its calls. */
function fakeRpc(url: string, c: FakeChain = {}): CkdRpc & { calls: { method: string; params: unknown }[] } {
  let behind = c.behind ?? 0;
  const calls: { method: string; params: unknown }[] = [];
  return {
    url,
    calls,
    async call<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      if (c.fail && (method === c.fail || (c.fail === 'query' && method === 'query'))) throw new Error('UNKNOWN_BLOCK: DB Not Found Error');
      if (method === 'status') return { chain_id: c.chainId ?? 'testnet' } as T;
      const p = params as Record<string, unknown>;
      if (method === 'block') {
        if (p.finality === 'final') return { header: { height: c.finalHeight ?? 1000, hash: 'head' } } as T;
        if (behind-- > 0) throw new Error('UNKNOWN_BLOCK');
        return { header: { height: p.block_id, hash: (c.hashAt ?? (() => HASH))(p.block_id as number) } } as T;
      }
      if (method === 'query') {
        expect(p).toMatchObject({ request_type: 'call_function', method_name: 'state', account_id: 'v1.signer-prod.testnet' });
        expect(p.finality).toBeUndefined(); // every endpoint reads the same block
        const state = { Running: { keyset: { domains: [{ domain_id: 2, key: { Bls12381: { public_key: c.key ?? KEY } } }] } } };
        return { result: [...Buffer.from(JSON.stringify(state))] } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const URLS = ['https://test.rpc.fastnear.com/', 'https://rpc.testnet.near.org/', 'https://near-testnet.drpc.org/'];
const noSleep = async () => undefined;

describe('ckdSources', () => {
  it('starts from rpc and rpcFallback and tops up with well-known providers to three', () => {
    expect(ckdSources(base())).toEqual(URLS);
    expect(new Set(ckdSources(base()).map(providerOf)).size).toBe(3);
    expect(WELL_KNOWN_RPCS.testnet.every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('adds every --rpc and skips well-known endpoints of providers already present', () => {
    const urls = ckdSources(base(), ['https://near-testnet.drpc.org/?key=secret']);
    expect(urls).toEqual([URLS[0], URLS[1], 'https://near-testnet.drpc.org/?key=secret']);
    const noFallback = { ...base(), rpcFallback: undefined };
    expect(ckdSources(noFallback).map(providerOf)).toEqual(['https://fastnear.com', 'https://near.org', 'https://drpc.org']);
  });

  it('refuses http endpoints and too few providers', () => {
    expect(() => ckdSources(base(), ['http://rpc.example.com'])).toThrow(CliError);
    expect(() => ckdSources(base(), [], [])).toThrow(/needs 3 independent RPC providers; only 2/u);
    expect(() => ckdSources(base(), [], ['https://other.fastnear.com', 'https://rpc2.testnet.near.org'])).toThrow(/only 2/u);
    expect(() => ckdSources(base(), ['not a url'])).toThrow(/not printed/u);
  });
});

describe('readCkdKeyAgreed', () => {
  const m = base();

  it('reads every endpoint at the lowest final height and returns the agreed key and block', async () => {
    const rpcs = [fakeRpc(URLS[0]!, { finalHeight: 1002 }), fakeRpc(URLS[1]!, { finalHeight: 1000 }), fakeRpc(URLS[2]!, { finalHeight: 1005 })];
    const r = await readCkdKeyAgreed(m, rpcs, { sleep: noSleep });
    expect(r).toEqual({ key: KEY, blockHeight: 1000, blockHash: HASH, hosts: ['test.rpc.fastnear.com', 'rpc.testnet.near.org', 'near-testnet.drpc.org'] });
    for (const rpc of rpcs) expect(rpc.calls.find((c) => c.method === 'query')?.params).toMatchObject({ block_id: 1000 });
  });

  it('refuses when one endpoint returns another key', async () => {
    const rpcs = [fakeRpc(URLS[0]!), fakeRpc(URLS[1]!, { key: OTHER_KEY }), fakeRpc(URLS[2]!)];
    await expect(readCkdKeyAgreed(m, rpcs, { sleep: noSleep })).rejects.toThrow(/disagree on the CKD key[\s\S]*rpc\.testnet\.near\.org: bls12381g2:3xYz/u);
  });

  it('refuses when the endpoints disagree on the block hash (a fork or a lying node)', async () => {
    const rpcs = [fakeRpc(URLS[0]!), fakeRpc(URLS[1]!), fakeRpc(URLS[2]!, { hashAt: () => 'Fork1111111111111111111111111111111111111' })];
    await expect(readCkdKeyAgreed(m, rpcs, { sleep: noSleep })).rejects.toThrow(/disagree on block 1000/u);
  });

  it('refuses when an endpoint is on another chain or cannot be read (never pins from fewer)', async () => {
    await expect(readCkdKeyAgreed(m, [fakeRpc(URLS[0]!), fakeRpc(URLS[1]!, { chainId: 'mainnet' }), fakeRpc(URLS[2]!)])).rejects.toThrow(/rpc\.testnet\.near\.org reports chain "mainnet"/u);
    for (const fail of ['status', 'block', 'query'] as const) {
      await expect(readCkdKeyAgreed(m, [fakeRpc(URLS[0]!), fakeRpc(URLS[1]!), fakeRpc(URLS[2]!, { fail })], { sleep: noSleep }), fail).rejects.toThrow(/refusing to pin from fewer[\s\S]*near-testnet\.drpc\.org/u);
    }
  });

  it('retries a block read on a node that trails the final head', async () => {
    const r = await readCkdKeyAgreed(m, [fakeRpc(URLS[0]!), fakeRpc(URLS[1]!, { behind: 2 }), fakeRpc(URLS[2]!)], { sleep: noSleep });
    expect(r.blockHash).toBe(HASH);
    await expect(readCkdKeyAgreed(m, [fakeRpc(URLS[0]!), fakeRpc(URLS[1]!, { behind: 5 }), fakeRpc(URLS[2]!)], { sleep: noSleep, attempts: 3 })).rejects.toThrow(/block 1000/u);
  });
});

describe('fetch-ckd-key', () => {
  const text = readFileSync(manifestPath('sandbox-dev'), 'utf8');
  const fixtureText = (): string => {
    const { ckdNetworkKeySource: _s, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return text.includes('ckdNetworkKeySource') ? `${JSON.stringify(rest, null, 2)}\n` : text;
  };

  function harness(manifest: Manifest, chains: Record<string, FakeChain> = {}, start = fixtureText()) {
    const out: string[] = [];
    const written: string[] = [];
    const deps: FetchCkdKeyDeps = {
      loadManifest: (name) => {
        expect(name).toBe('sandbox-dev');
        return manifest;
      },
      rpc: (url) => fakeRpc(url, chains[new URL(url).host] ?? {}),
      readManifest: () => start,
      writeManifest: (_n, t) => void written.push(t),
      log: (line) => void out.push(line),
      sleep: noSleep,
    };
    return { out, written, deps };
  }

  it('records the block and hosts beside a key it already has, and prints them (hosts only, never URLs)', async () => {
    const h = harness(base());
    await fetchCkdKey(['sandbox-dev', '--rpc', 'https://near-testnet.drpc.org/?key=secret'], h.deps);
    expect(h.out.join('\n')).toContain(`All 3 agree at final block 1000 ${HASH}: ${KEY}`);
    expect(h.out.join('\n')).not.toContain('secret');
    expect(h.written).toHaveLength(1);
    const pinned = manifestSchema.parse(JSON.parse(h.written[0]!));
    expect(pinned.ckdNetworkKey).toBe(KEY);
    expect(pinned.ckdNetworkKeySource).toEqual({ blockHeight: 1000, blockHash: HASH, rpcs: ['test.rpc.fastnear.com', 'rpc.testnet.near.org', 'near-testnet.drpc.org'] });
    expect(h.written[0]).not.toContain('secret');
  });

  it('writes a changed key with its source and says every pinned client must update', async () => {
    const h = harness({ ...base(), ckdNetworkKey: OTHER_KEY }, {}, fixtureText().replace(KEY, OTHER_KEY));
    await fetchCkdKey(['sandbox-dev'], h.deps);
    expect(JSON.parse(h.written[0]!)).toMatchObject({ ckdNetworkKey: KEY, ckdNetworkKeySource: { blockHeight: 1000 } });
    expect(h.out.at(-1)).toContain(`was ${OTHER_KEY}: the MPC key changed`);
  });

  it('changes nothing when the key and a source are already recorded, or on --dry-run', async () => {
    const recorded = harness({ ...base(), ckdNetworkKeySource: { blockHeight: 5, blockHash: HASH, rpcs: ['a.fastnear.com', 'rpc.testnet.near.org', 'near-testnet.drpc.org'] } });
    await fetchCkdKey(['sandbox-dev'], recorded.deps);
    expect(recorded.written).toEqual([]);
    expect(recorded.out.at(-1)).toContain('already has it');
    const dry = harness(base());
    await fetchCkdKey(['sandbox-dev', '--dry-run'], dry.deps);
    expect(dry.written).toEqual([]);
  });

  it('refuses to write on any disagreement', async () => {
    const h = harness({ ...base(), ckdNetworkKey: OTHER_KEY }, { 'near-testnet.drpc.org': { key: OTHER_KEY } });
    await expect(fetchCkdKey(['sandbox-dev'], h.deps)).rejects.toThrow(/disagree/u);
    expect(h.written).toEqual([]);
  });

  it('inserts the source right after ckdNetworkKey and keeps the rest of the file byte-identical', () => {
    const start = fixtureText();
    const source = { blockHeight: 7, blockHash: HASH, rpcs: ['test.rpc.fastnear.com', 'rpc.testnet.near.org', 'near-testnet.drpc.org'] };
    const out = setManifestObject(start, 'ckdNetworkKeySource', source, 'ckdNetworkKey');
    const line = `  "ckdNetworkKeySource": { "blockHeight": 7, "blockHash": "${HASH}", "rpcs": ["test.rpc.fastnear.com", "rpc.testnet.near.org", "near-testnet.drpc.org"] },\n`;
    expect(out.replace(line, '')).toBe(start);
    // Replaced in place the next time.
    const again = setManifestObject(out, 'ckdNetworkKeySource', { ...source, blockHeight: 8 }, 'ckdNetworkKey');
    expect(again.replace(line.replace('"blockHeight": 7', '"blockHeight": 8'), '')).toBe(start);
  });
});
