// check-reviewed-near and the reviewed NEAR rebuild (D885), against stub RPC answers and a stub cargo: every reviewed
// contract locked, on the recorded code, no global contract, both endpoints agreeing; anything else a failure (a key,
// another hash, a global contract, endpoints that disagree, one down or missing, another chain, another account). The
// rebuild matches the recorded hashes, says so when they differ, and skips (passing) without the recorded tools.
import { describe, expect, it } from 'vitest';
import { type Manifest, loadEnv } from '@hana-id/env';
import { REVIEWED_NEAR_DEPLOYS } from '@hana-id/core';
import { checkReviewedNear, checkReviewedNearMain, endpointLabel } from '../lib/reviewed-near-check.ts';
import { type Runner, recordedHashes, reviewedNearRebuild } from '../lib/reviewed-near-rebuild.ts';

const env = loadEnv('sandbox-dev');
const STAMPS = env.near!.demoStamps!;
const BOOK = env.near!.demoGuestbook!;
const RECORD = REVIEWED_NEAR_DEPLOYS['sandbox-dev']!;
const NOW = () => new Date('2026-11-19T12:00:00.000Z');

type Answer = { chain?: string; codeHash?: Record<string, string>; keys?: Record<string, number>; global?: Record<string, { global_contract_hash?: string; global_contract_account_id?: string }>; down?: boolean };

/** A stub NEAR RPC per endpoint host: `status`, `view_account` and `view_access_key_list`, as nearcore answers them. */
function chain(per: Record<string, Answer>): { fetch: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    const a = per[host] ?? {};
    const body = JSON.parse(String(init?.body)) as { method: string; params: { request_type?: string; account_id?: string } };
    seen.push(`${host} ${body.method} ${body.params.request_type ?? ''}`.trim());
    if (init?.method !== 'POST') throw new Error('only POST');
    if (a.down) throw new TypeError('fetch failed');
    const block = { block_height: 230_000_000, block_hash: `Block${host.replace(/[^A-Za-z]/gu, '').slice(0, 8)}` };
    if (body.method === 'status') return Response.json({ jsonrpc: '2.0', id: 1, result: { chain_id: a.chain ?? 'testnet' } });
    const account = body.params.account_id!;
    const contract = account === STAMPS ? 'stamps' : account === BOOK ? 'guestbook' : null;
    if (contract === null) return Response.json({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
    if (body.params.request_type === 'view_account') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: { amount: '1', locked: '0', storage_usage: 1, code_hash: a.codeHash?.[contract] ?? RECORD[contract]!.codeHash, ...(a.global?.[contract] ?? {}), ...block } });
    }
    const n = a.keys?.[contract] ?? 0;
    return Response.json({ jsonrpc: '2.0', id: 1, result: { keys: Array.from({ length: n }, (_, i) => ({ public_key: `ed25519:${i}`, access_key: { nonce: 1, permission: 'FullAccess' } })), ...block } });
  }) as typeof fetch;
  return { fetch: fetchFn, seen };
}

const PRIMARY = endpointLabel(env.rpc);
const FALLBACK = endpointLabel(env.rpcFallback!);
const run = (per: Record<string, Answer>, m: Manifest = env) => checkReviewedNear(m, { fetch: chain(per).fetch, now: NOW });

describe('check-reviewed-near', () => {
  it('both contracts locked on the recorded code, on both endpoints: no failure; the time and every read’s block printed', async () => {
    const stub = chain({});
    const r = await checkReviewedNear(env, { fetch: stub.fetch, now: NOW });
    expect(r.failures).toEqual([]);
    expect(r.lines[0]).toBe('  near-reviewed  checked at 2026-11-19T12:00:00.000Z');
    for (const host of [PRIMARY, FALLBACK]) {
      expect(r.lines.join('\n')).toContain(`${STAMPS} via ${host}: code_hash ${RECORD.stamps!.codeHash} (block 230000000 `);
      expect(r.lines.join('\n')).toContain(`${BOOK} via ${host}: code_hash ${RECORD.guestbook!.codeHash}`);
    }
    expect(r.lines.join('\n')).toContain('0 access keys');
    expect(r.lines.join('\n')).toContain('no global contract');
    // Read-only: status, view_account and view_access_key_list only, on both endpoints.
    expect(new Set(stub.seen.map((s) => s.split(' ').slice(1).join(' ')))).toEqual(new Set(['status', 'query view_account', 'query view_access_key_list']));
    expect(new Set(stub.seen.map((s) => s.split(' ')[0]))).toEqual(new Set([PRIMARY, FALLBACK]));
  });

  it('a key present, another code hash, a global contract: each a failure, on the endpoint that says so', async () => {
    expect((await run({ [PRIMARY]: { keys: { stamps: 1 } }, [FALLBACK]: { keys: { stamps: 1 } } })).failures).toEqual([`near-reviewed stamps: ${STAMPS} has 1 access key on ${PRIMARY}: it is not locked, so its code can change`, `near-reviewed stamps: ${STAMPS} has 1 access key on ${FALLBACK}: it is not locked, so its code can change`]);
    const other = 'Hash1111111111111111111111111111111111111111';
    expect((await run({ [PRIMARY]: { codeHash: { guestbook: other } }, [FALLBACK]: { codeHash: { guestbook: other } } })).failures).toEqual([
      `near-reviewed guestbook: ${BOOK} runs code ${other} on ${PRIMARY}, the record says ${RECORD.guestbook!.codeHash}`,
      `near-reviewed guestbook: ${BOOK} runs code ${other} on ${FALLBACK}, the record says ${RECORD.guestbook!.codeHash}`,
    ]);
    const global = { stamps: { global_contract_account_id: 'shared.testnet' } };
    const g = await run({ [PRIMARY]: { global }, [FALLBACK]: { global } });
    expect(g.failures).toContain(`near-reviewed stamps: ${STAMPS} uses a global contract (account shared.testnet) on ${PRIMARY}`);
    expect((await run({ [PRIMARY]: { global: { guestbook: { global_contract_hash: 'GlobalHash' } } }, [FALLBACK]: { global: { guestbook: { global_contract_hash: 'GlobalHash' } } } })).failures).toContain(`near-reviewed guestbook: ${BOOK} uses a global contract (hash GlobalHash) on ${PRIMARY}`);
  });

  it('the two endpoints disagree, one is down, or is on another chain: a failure', async () => {
    const split = await run({ [FALLBACK]: { keys: { guestbook: 2 } } });
    expect(split.failures).toContain(`near-reviewed guestbook: the two endpoints disagree about ${BOOK}`);
    const down = await run({ [FALLBACK]: { down: true } });
    expect(down.failures).toEqual([`near-reviewed stamps: ${FALLBACK} status: fetch failed`, `near-reviewed guestbook: ${FALLBACK} status: fetch failed`]);
    const mainnet = await run({ [PRIMARY]: { chain: 'mainnet' } });
    expect(mainnet.failures[0]).toBe(`near-reviewed stamps: ${PRIMARY} is on chain "mainnet", the manifest says testnet`);
  });

  it('an env with one endpoint, another account than the one checked, or a record without its manifest field: a failure', async () => {
    const { rpcFallback: _f, ...one } = env;
    expect((await run({}, one as Manifest)).failures[0]).toBe('near-reviewed: envs/sandbox-dev.json has no rpcFallback: the check needs two independent endpoints');
    const moved = { ...env, near: { ...env.near!, demoStamps: 'hana-id-stamps-dev2.testnet' } } as Manifest;
    expect((await run({}, moved)).failures).toEqual(['near-reviewed stamps: near.demoStamps hana-id-stamps-dev2.testnet is not the account the record was checked against']);
    const missing = { ...env, near: { ...env.near!, demoGuestbook: undefined } } as Manifest;
    expect((await run({}, missing)).failures).toEqual(['near-reviewed guestbook: envs/sandbox-dev.json has no near.demoGuestbook, but core records a reviewed deploy for it']);
  });

  it('an env with no record checks nothing; the CLI exits 1 on any failure and prints each', async () => {
    expect(await run({}, { ...env, name: 'sandbox-other' } as Manifest)).toEqual({ lines: ['  near-reviewed  sandbox-other has no reviewed NEAR contract recorded: nothing to check'], failures: [] });
    const lines: string[] = [];
    expect(await checkReviewedNearMain(['sandbox-dev'], { fetch: chain({}).fetch, log: (l) => lines.push(l), now: NOW })).toBe(0);
    expect(lines.at(-1)).toBe("OK: sandbox-dev's reviewed NEAR contracts are locked and run the reviewed code on both endpoints");
    const bad: string[] = [];
    expect(await checkReviewedNearMain(['sandbox-dev'], { fetch: chain({ [PRIMARY]: { keys: { stamps: 1 } } }).fetch, log: (l) => bad.push(l), now: NOW })).toBe(1);
    expect(bad.filter((l) => l.startsWith('FAIL '))).toHaveLength(2);
  });
});

describe('reviewed NEAR rebuild', () => {
  const runner = (o: { cargoNear?: string | null; rust?: string | null; status?: number }): Runner => (cmd, args) => {
    if (cmd === 'cargo' && args[0] === 'near' && args[1] === '--version') return o.cargoNear === null ? { status: 127, stdout: '' } : { status: 0, stdout: `cargo-near-near ${o.cargoNear ?? '0.22.0'}` };
    if (cmd === 'rustc') return o.rust === null ? { status: 1, stdout: '' } : { status: 0, stdout: `rustc ${o.rust ?? '1.85.1'} (4eb161250 2025-03-15)` };
    return { status: o.status ?? 0, stdout: '' };
  };
  const wasmFor = (hashes: Record<string, string>) => (path: string) => {
    const name = path.includes('hana_stamps') ? 'stamps' : 'guestbook';
    return new TextEncoder().encode(hashes[name] ?? name);
  };

  it('matches every recorded hash, or names the env whose record differs', async () => {
    const { codeHashOf } = await import('../lib/near.ts');
    const ok: string[] = [];
    const recorded = (w: Uint8Array) => (new TextDecoder().decode(w) === 'stamps' ? RECORD.stamps!.codeHash : RECORD.guestbook!.codeHash);
    expect(reviewedNearRebuild({ run: runner({}), log: (l) => ok.push(l), readWasm: wasmFor({}), codeHash: recorded })).toBe(0);
    expect(ok).toContain("  stamps: matches sandbox-dev's recorded deploy");
    expect(ok).toContain("  guestbook: matches sandbox-dev's recorded deploy");
    expect(ok.at(-1)).toBe('OK: reviewed NEAR rebuild');
    const lines: string[] = [];
    const code = reviewedNearRebuild({ run: runner({}), log: (l) => lines.push(l), readWasm: wasmFor({}) });
    // The stub wasm isn't the contract: both differ from the records, each said with the env.
    expect(code).toBe(1);
    expect(lines).toContain(`FAIL stamps: sandbox-dev's recorded deploy is ${RECORD.stamps!.codeHash}, this checkout builds ${codeHashOf(new TextEncoder().encode('stamps'))}`);
    expect(recordedHashes('stamps')).toEqual([{ env: 'sandbox-dev', codeHash: RECORD.stamps!.codeHash }]);
  });

  it('skips, passing and saying why, without cargo-near, with another cargo-near, or without the Rust toolchain', () => {
    const say = (o: Parameters<typeof runner>[0]) => {
      const lines: string[] = [];
      return { code: reviewedNearRebuild({ run: runner(o), log: (l) => lines.push(l), readWasm: () => null }), lines };
    };
    expect(say({ cargoNear: null })).toEqual({ code: 0, lines: ['SKIP reviewed NEAR rebuild: cargo-near is not installed (want 0.22.0: `cargo install cargo-near --version 0.22.0 --locked`)'] });
    expect(say({ cargoNear: '0.23.0' }).lines[0]).toBe('SKIP reviewed NEAR rebuild: cargo-near 0.23.0 is installed, the records were built with 0.22.0; another version may build other bytes');
    const noRust = say({ rust: null });
    expect(noRust.code).toBe(0);
    expect(noRust.lines.filter((l) => l.startsWith('SKIP'))).toHaveLength(2);
  });

  it('a failed build is a failure', () => {
    const lines: string[] = [];
    expect(reviewedNearRebuild({ run: runner({ status: 101 }), log: (l) => lines.push(l), readWasm: () => null })).toBe(1);
    expect(lines).toContain('FAIL stamps: the build failed (exit 101)');
  });
});
