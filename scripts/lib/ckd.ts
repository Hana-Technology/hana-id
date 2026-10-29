// MPC CKD network key lookup, from several independent RPC providers that must all agree (OPER-1, D100).
//
// The pinned key is the root the vault's pairing check trusts: a provider that lied at pin time, and kept lying at
// every login, could hand out keys derived from a master secret it knows. So the key is read at one final block from
// at least MIN_CKD_SOURCES providers (distinct registrable domains: the manifest's `rpc`, `rpcFallback`, any `--rpc`,
// then the well-known list), each must report the env's chain, the same block hash at that height and the same key,
// and the block is recorded beside the key. Public data, safe to print; only RPC hosts are printed or recorded (a
// provider URL can carry an API key).
import { type Manifest, MIN_CKD_SOURCES, manifestPath, siteOf } from '@hana-id/env';
import { readFileSync, writeFileSync } from 'node:fs';
import { CliError, parseCli } from './cli.ts';
import { setManifestObject, setManifestString } from './manifest-edit.ts';
import { NearRpc } from './near.ts';

export interface MpcState {
  Running?: { keyset?: { domains?: { domain_id: number; key?: { Bls12381?: { public_key?: string } } }[] } };
}

/** Picks the domain's BLS12-381 public key out of the MPC `state` view (see legacy/client/mpc.ts ckdNetworkKey). */
export function ckdKeyFromState(state: MpcState, domainId: number): string {
  if (!state.Running) throw new Error(`MPC is not in the Running state (${Object.keys(state).join(', ') || 'unknown'})`);
  const key = state.Running.keyset?.domains?.find((d) => d.domain_id === domainId)?.key?.Bls12381?.public_key;
  if (!key) throw new Error(`The MPC has no BLS12-381 (CKD) key for domain ${domainId}`);
  if (!/^bls12381g2:[1-9A-HJ-NP-Za-km-z]+$/u.test(key)) throw new Error(`Unexpected CKD key format: ${key.slice(0, 120)}`);
  return key;
}

/**
 * Public RPC endpoints of independent providers, per network, used to top the manifest's endpoints up to
 * MIN_CKD_SOURCES providers. Checked live on 2026-10-29 (Lava's NEAR endpoints were discontinued). A mainnet list is
 * added with mainnet support (the manifest network enum is testnet-only today, so the type asks for it then).
 */
export const WELL_KNOWN_RPCS: Readonly<Record<Manifest['network'], readonly string[]>> = {
  testnet: ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'],
};

/** An endpoint's host (what the script prints and records: never the path or query, which may carry an API key). */
export const hostOf = (url: string): string => new URL(url).host;
/** An endpoint's provider: its registrable domain (`rpc.testnet.near.org` → near.org). */
export const providerOf = (url: string): string => siteOf(new URL(url).origin);

/**
 * The endpoints to read from: the manifest's `rpc` and `rpcFallback`, every `extra` (from `--rpc`), then well-known
 * endpoints of providers not yet present until there are MIN_CKD_SOURCES providers. All https. Throws when fewer
 * providers are available.
 */
export function ckdSources(m: Pick<Manifest, 'rpc' | 'rpcFallback' | 'network'>, extra: readonly string[] = [], wellKnown: readonly string[] = WELL_KNOWN_RPCS[m.network]): string[] {
  const urls: string[] = [];
  for (const u of [m.rpc, ...(m.rpcFallback ? [m.rpcFallback] : []), ...extra]) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      throw new CliError('An RPC endpoint is not a URL (the value is not printed: it may carry an API key)');
    }
    if (url.protocol !== 'https:') throw new CliError(`RPC endpoints must be https: ${url.host}`);
    if (!urls.includes(url.href)) urls.push(url.href);
  }
  const providers = new Set(urls.map(providerOf));
  for (const u of wellKnown) {
    if (providers.size >= MIN_CKD_SOURCES) break;
    if (providers.has(providerOf(u))) continue;
    urls.push(new URL(u).href);
    providers.add(providerOf(u));
  }
  if (providers.size < MIN_CKD_SOURCES) {
    throw new CliError(`The CKD key needs ${MIN_CKD_SOURCES} independent RPC providers; only ${providers.size} available (${[...providers].join(', ')}). Pass --rpc <https url> of another provider.`);
  }
  return urls;
}

/** What fetchCkdKey needs from an RPC endpoint (NearRpc). */
export interface CkdRpc {
  readonly url: string;
  call<T>(method: string, params: unknown): Promise<T>;
}

export interface CkdReading {
  key: string;
  blockHeight: number;
  blockHash: string;
  /** Hosts of the endpoints that agreed, in the order read. */
  hosts: string[];
}

interface BlockView {
  header: { height: number; hash: string };
}

export interface ReadOptions {
  /** Attempts per endpoint for the block-at-height reads (a load-balanced node may trail the final head briefly). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs `fn` for each endpoint at once; every one must succeed, and a failure names the endpoint's host only. */
async function each<T>(rpcs: readonly CkdRpc[], what: string, fn: (rpc: CkdRpc) => Promise<T>): Promise<T[]> {
  const results = await Promise.allSettled(rpcs.map(fn));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${hostOf(rpcs[i]!.url)}: ${r.reason instanceof Error ? r.reason.message.slice(0, 300) : 'failed'}`] : []));
  if (failed.length) throw new Error(`Could not read ${what} from every RPC (refusing to pin from fewer):\n  ${failed.join('\n  ')}`);
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(1000);
    }
  }
}

/**
 * Reads the MPC's CKD key for `m.ckdDomainId` from every endpoint at one final block: each reports `m.network`, the
 * lowest final height among them is the block, each must give the same hash for it and the same key in it. Any
 * failure or disagreement throws; nothing is returned unless all agree.
 */
export async function readCkdKeyAgreed(m: Pick<Manifest, 'network' | 'mpc' | 'ckdDomainId'>, rpcs: readonly CkdRpc[], opts: ReadOptions = {}): Promise<CkdReading> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? sleepMs;
  const hosts = rpcs.map((r) => hostOf(r.url));
  const chains = await each(rpcs, 'the chain id', (r) => r.call<{ chain_id: string }>('status', []));
  const wrongChain = chains.flatMap((c, i) => (c.chain_id === m.network ? [] : [`${hosts[i]} reports chain "${c.chain_id}"`]));
  if (wrongChain.length) throw new Error(`Not every RPC is on ${m.network}: ${wrongChain.join('; ')}`);

  const finals = await each(rpcs, 'the final block', (r) => r.call<BlockView>('block', { finality: 'final' }));
  const blockHeight = Math.min(...finals.map((b) => b.header.height));
  const blocks = await each(rpcs, `block ${blockHeight}`, (r) => withRetry(() => r.call<BlockView>('block', { block_id: blockHeight }), attempts, sleep));
  const hashes = new Set(blocks.map((b) => b.header.hash));
  if (hashes.size !== 1) {
    throw new Error(`The RPCs disagree on block ${blockHeight}: ${blocks.map((b, i) => `${hosts[i]} ${b.header.hash}`).join(', ')}. Refusing to pin.`);
  }
  const blockHash = blocks[0]!.header.hash;

  const args = Buffer.from('{}').toString('base64');
  const keys = await each(rpcs, `${m.mpc} state at block ${blockHeight}`, async (r) => {
    const res = await withRetry(() => r.call<{ result: number[] }>('query', { request_type: 'call_function', block_id: blockHeight, account_id: m.mpc, method_name: 'state', args_base64: args }), attempts, sleep);
    return ckdKeyFromState(JSON.parse(Buffer.from(res.result).toString('utf8')) as MpcState, m.ckdDomainId);
  });
  if (new Set(keys).size !== 1) {
    throw new Error(`The RPCs disagree on the CKD key at block ${blockHeight} ${blockHash}:\n  ${keys.map((k, i) => `${hosts[i]}: ${k}`).join('\n  ')}\nRefusing to pin. Find out which provider is wrong before going on.`);
  }
  return { key: keys[0]!, blockHeight, blockHash, hosts };
}

export const FETCH_CKD_KEY_USAGE = `Usage: fetch-ckd-key.ts <env> [--rpc <https url>]... [--dry-run]

Reads the MPC's CKD network key for the manifest's ckdDomainId at one final block from at least ${MIN_CKD_SOURCES} independent RPC
providers (the manifest's rpc and rpcFallback, every --rpc, then well-known public endpoints), refuses unless every
one reports the same block hash and key, and pins the key with that block in envs/<env>.json (ckdNetworkKey,
ckdNetworkKeySource). Compare the key with NEAR's published MPC key material before a mainnet pin.`;

export interface FetchCkdKeyDeps {
  loadManifest: (name: string) => Manifest;
  rpc: (url: string) => CkdRpc;
  readManifest: (name: string) => string;
  writeManifest: (name: string, text: string) => void;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function defaultFetchCkdKeyDeps(loadManifest: (name: string) => Manifest): FetchCkdKeyDeps {
  return {
    loadManifest,
    rpc: (url) => new NearRpc(url),
    readManifest: (name) => readFileSync(manifestPath(name), 'utf8'),
    writeManifest: (name, text) => writeFileSync(manifestPath(name), text),
    log: (line) => console.log(line),
  };
}

/** Runs `fetch-ckd-key <argv>`. */
export async function fetchCkdKey(argv: readonly string[], deps: FetchCkdKeyDeps): Promise<void> {
  const args = parseCli(argv, { multiple: ['rpc'], booleans: ['dry-run', 'help'] });
  if (args.flag('help')) return void deps.log(FETCH_CKD_KEY_USAGE);
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = deps.loadManifest(envName);
  const urls = ckdSources(m, args.list('rpc'));
  deps.log(`Reading ${m.mpc} CKD domain ${m.ckdDomainId} from ${urls.length} RPCs: ${urls.map(hostOf).join(', ')}`);
  const reading = await readCkdKeyAgreed(m, urls.map(deps.rpc), deps.sleep ? { sleep: deps.sleep } : {});
  const source = { blockHeight: reading.blockHeight, blockHash: reading.blockHash, rpcs: reading.hosts };
  deps.log(`All ${reading.hosts.length} agree at final block ${reading.blockHeight} ${reading.blockHash}: ${reading.key}`);

  const sameKey = m.ckdNetworkKey === reading.key;
  if (sameKey && m.ckdNetworkKeySource) return void deps.log(`envs/${m.name}.json already has it (recorded at block ${m.ckdNetworkKeySource.blockHeight}).`);
  if (args.flag('dry-run')) return void deps.log('Dry run: manifest not changed.');
  let text = deps.readManifest(m.name);
  if (!sameKey) text = setManifestString(text, 'ckdNetworkKey', reading.key);
  text = setManifestObject(text, 'ckdNetworkKeySource', source, 'ckdNetworkKey');
  deps.writeManifest(m.name, text);
  if (sameKey) return void deps.log(`envs/${m.name}.json had this key: recorded its source (block ${reading.blockHeight}).`);
  deps.log(`Wrote ckdNetworkKey and its source to envs/${m.name}.json${m.ckdNetworkKey.startsWith('UNSET') ? '' : ` (was ${m.ckdNetworkKey}: the MPC key changed, every pinned client must update)`}.`);
}
