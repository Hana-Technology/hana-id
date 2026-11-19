// check-reviewed-near (D885): the on-chain half of Journear's reviewed NEAR calls. For every contract that core's
// REVIEWED_NEAR_DEPLOYS records for an env, read-only, against BOTH the manifest's NEAR RPC endpoints (`rpc` and
// `rpcFallback`, D263's two-provider rule):
//
//   - the endpoint is on the manifest's network (`status`.chain_id);
//   - the manifest's account is the one the record was checked against (its sha256);
//   - `view_access_key_list` is empty: no key, so nothing can deploy other code or delete the account;
//   - `view_account`.code_hash is the record's, and the account uses no global contract (no `global_contract_hash`,
//     no `global_contract_account_id`);
//   - both endpoints agree on all of it.
//
// It prints the time, and each endpoint's block height and hash for every read: paste the output into D885 and
// docs/operations.md "Reviewed NEAR calls: adding one" ("Last on-chain check"). Any mismatch, disagreement, endpoint
// down or missing is a failure (exit 1): a build carrying these accounts must not ship until it passes. Also run by
// deploy-check's `near-reviewed` group. It holds no secret and prints only public values (account ids, hashes,
// endpoint hosts).
import { createHash } from 'node:crypto';
import { type Manifest, loadEnv } from '@hana-id/env';
import { REVIEWED_NEAR_DEPLOYS, type ReviewedNearContract, type ReviewedNearDeploy } from '@hana-id/core';
import { CliError, parseCli } from './cli.ts';

export const REVIEWED_NEAR_CHECK_TIMEOUT_MS = 10_000;
/** The most read of an answer (an account view or an empty key list is well under 1 KiB). */
export const REVIEWED_NEAR_BODY_LIMIT = 65_536;

const FIELDS: Readonly<Record<ReviewedNearContract, 'demoStamps' | 'demoGuestbook'>> = { stamps: 'demoStamps', guestbook: 'demoGuestbook' };

export interface ReviewedNearCheckResult {
  lines: string[];
  failures: string[];
}

/** What one endpoint answered for one account. */
export interface ReviewedNearRead {
  codeHash: string;
  globalContract: string | null;
  keys: number;
  account: { height: number; hash: string };
  keyList: { height: number; hash: string };
}

/** `https://rpc.example/path?x` → `rpc.example`: what the output names an endpoint by. */
export const endpointLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '(not a URL)';
  }
};

async function rpcCall(fetchFn: typeof fetch, url: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REVIEWED_NEAR_CHECK_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'check-reviewed-near', method, params }), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > REVIEWED_NEAR_BODY_LIMIT) throw new Error('answer too large');
    const body = JSON.parse(text) as { result?: unknown; error?: { name?: string; cause?: { name?: string } } };
    if (body.error) throw new Error(`RPC error ${body.error.cause?.name ?? body.error.name ?? ''}`.trim());
    const result = body.result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('no result');
    if (typeof (result as { error?: unknown }).error === 'string') throw new Error('query error');
    return result as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${endpointLabel(url)} ${method}: ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const block = (r: Record<string, unknown>): { height: number; hash: string } => {
  if (typeof r.block_height !== 'number' || typeof r.block_hash !== 'string') throw new Error('no block height or hash in the answer');
  return { height: r.block_height, hash: r.block_hash };
};

/** One endpoint's view of `account`: its chain, code hash, global contract and keys, each with the block it was read at. */
export async function readReviewedNear(fetchFn: typeof fetch, url: string, network: string, account: string): Promise<ReviewedNearRead> {
  const status = await rpcCall(fetchFn, url, 'status', []);
  if (status.chain_id !== network) throw new Error(`${endpointLabel(url)} is on chain ${JSON.stringify(status.chain_id)}, the manifest says ${network}`);
  const view = await rpcCall(fetchFn, url, 'query', { request_type: 'view_account', finality: 'final', account_id: account });
  const keyList = await rpcCall(fetchFn, url, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: account });
  if (typeof view.code_hash !== 'string') throw new Error(`${endpointLabel(url)}: no code_hash for ${account}`);
  if (!Array.isArray(keyList.keys)) throw new Error(`${endpointLabel(url)}: no key list for ${account}`);
  const globalHash = view.global_contract_hash;
  const globalAccount = view.global_contract_account_id;
  const globalContract = typeof globalHash === 'string' && globalHash !== '' ? `hash ${globalHash}` : typeof globalAccount === 'string' && globalAccount !== '' ? `account ${globalAccount}` : null;
  return { codeHash: view.code_hash, globalContract, keys: keyList.keys.length, account: block(view), keyList: block(keyList) };
}

/** The checks for every reviewed contract recorded for `m`'s env. Never throws for what an endpoint answers. */
export async function checkReviewedNear(m: Manifest, opts: { fetch: typeof fetch; now?: () => Date; deploys?: typeof REVIEWED_NEAR_DEPLOYS }): Promise<ReviewedNearCheckResult> {
  const out: ReviewedNearCheckResult = { lines: [], failures: [] };
  const deploys = opts.deploys ?? REVIEWED_NEAR_DEPLOYS;
  const record = Object.hasOwn(deploys, m.name) ? deploys[m.name] : undefined;
  if (!record || Object.keys(record).length === 0) {
    out.lines.push(`  near-reviewed  ${m.name} has no reviewed NEAR contract recorded: nothing to check`);
    return out;
  }
  out.lines.push(`  near-reviewed  checked at ${(opts.now ?? (() => new Date()))().toISOString()}`);
  const urls = [m.rpc, m.rpcFallback].filter((u): u is string => typeof u === 'string');
  if (urls.length < 2) out.failures.push(`near-reviewed: envs/${m.name}.json has no rpcFallback: the check needs two independent endpoints`);
  for (const [contract, deploy] of Object.entries(record) as [ReviewedNearContract, ReviewedNearDeploy][]) {
    const field = FIELDS[contract];
    const account = m.near?.[field];
    const tag = `near-reviewed ${contract}`;
    if (account === undefined) {
      out.failures.push(`${tag}: envs/${m.name}.json has no near.${field}, but core records a reviewed deploy for it`);
      continue;
    }
    if (createHash('sha256').update(account, 'utf8').digest('hex') !== deploy.accountSha256) {
      out.failures.push(`${tag}: near.${field} ${account} is not the account the record was checked against`);
      continue;
    }
    const reads: ReviewedNearRead[] = [];
    for (const url of urls) {
      try {
        const r = await readReviewedNear(opts.fetch, url, m.network, account);
        reads.push(r);
        out.lines.push(
          `  ${tag}  ${account} via ${endpointLabel(url)}: code_hash ${r.codeHash} (block ${r.account.height} ${r.account.hash}), ${r.keys} access key${r.keys === 1 ? '' : 's'} (block ${r.keyList.height} ${r.keyList.hash}), ${r.globalContract === null ? 'no global contract' : `global contract ${r.globalContract}`}`,
        );
        if (r.keys !== 0) out.failures.push(`${tag}: ${account} has ${r.keys} access key${r.keys === 1 ? '' : 's'} on ${endpointLabel(url)}: it is not locked, so its code can change`);
        if (r.codeHash !== deploy.codeHash) out.failures.push(`${tag}: ${account} runs code ${r.codeHash} on ${endpointLabel(url)}, the record says ${deploy.codeHash}`);
        if (r.globalContract !== null) out.failures.push(`${tag}: ${account} uses a global contract (${r.globalContract}) on ${endpointLabel(url)}`);
      } catch (e) {
        out.failures.push(`${tag}: ${(e as Error).message}`);
      }
    }
    if (reads.length === 2) {
      const [a, b] = reads as [ReviewedNearRead, ReviewedNearRead];
      if (a.codeHash !== b.codeHash || a.keys !== b.keys || a.globalContract !== b.globalContract) out.failures.push(`${tag}: the two endpoints disagree about ${account}`);
    }
  }
  return out;
}

export const CHECK_REVIEWED_NEAR_USAGE = `Usage: check-reviewed-near.ts <env>
  Read-only. For every reviewed NEAR contract core records for <env> (REVIEWED_NEAR_DEPLOYS), on both of the
  manifest's NEAR RPC endpoints: no access key, the recorded code hash, no global contract, both endpoints agreeing.
  Prints the time and each read's block height and hash; exits 1 on any failure.`;

/** check-reviewed-near.ts's body: 0 when every check passes, 1 otherwise. */
export async function checkReviewedNearMain(argv: readonly string[], deps: { fetch?: typeof fetch; log?: (line: string) => void; loadManifest?: (name: string) => Manifest; now?: () => Date } = {}): Promise<number> {
  const args = parseCli(argv, {});
  if (args.positionals.length !== 1) throw new CliError('Name one env');
  const m = (deps.loadManifest ?? loadEnv)(args.positionals[0]!);
  const log = deps.log ?? ((line: string) => console.log(line));
  const r = await checkReviewedNear(m, { fetch: deps.fetch ?? fetch, ...(deps.now ? { now: deps.now } : {}) });
  for (const l of r.lines) log(l);
  for (const f of r.failures) log(`FAIL ${f}`);
  log(r.failures.length === 0 ? `OK: ${m.name}'s reviewed NEAR contracts are locked and run the reviewed code on both endpoints` : `FAILED: ${r.failures.length} problem${r.failures.length === 1 ? '' : 's'}`);
  return r.failures.length === 0 ? 0 : 1;
}
