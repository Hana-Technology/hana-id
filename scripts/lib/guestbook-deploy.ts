// deploy-guestbook's body (D743): deploys the hackathon demo contract `contracts/hana-guestbook` to the env's
// `near.demoGuestbook` account. Observes the chain, prints the plan, and changes nothing without --yes, like
// deploy-contract. The code is deployed and `new()` called in one transaction (no one can initialise it in between);
// it is never redeployed (the contract has no upgrade path: a new version goes to a new account). `--lock` deletes every
// access key on the account (in the deploy transaction, or on its own once deployed), after which no one can change
// its code or state. The account's full-access key is read from the near CLI legacy keychain and never printed.
// Dependencies are injectable so test/guestbook-deploy.test.ts runs the flow against a stub RPC.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { PublicKey } from '@near-js/crypto';
import { type Action, actionCreators } from '@near-js/transactions';
import { CliError, parseCli } from './cli.ts';
import { findLegacyCredential, loadLegacyCredential } from './keys.ts';
import { type AccessKeyListEntry, codeHashOf, EMPTY_CODE_HASH, explorerTx, formatNear, hasFullAccess, NearRpc, STORAGE_YOCTO_PER_BYTE, TGAS } from './near.ts';

export const GUESTBOOK_USAGE = `Usage: deploy-guestbook.ts <env> [--yes] [--lock] [--wasm <file>] [--skip-build]
  Deploys contracts/hana-guestbook to the env's near.demoGuestbook account (deploy + new() in one transaction).
  --yes          apply the plan (without it, only print it)
  --lock         delete every access key on the account (with the deploy, or on its own once deployed): no one can
                 change the code or the messages afterwards, and the account can never be deleted
  --wasm <file>  deploy this wasm instead of building
  --skip-build   deploy the last built wasm (contracts/hana-guestbook/target/near/hana_guestbook.wasm)`;

export const GUESTBOOK_DRY_RUN_LINE = 'Dry run: nothing changed. Re-run with --yes to apply.';

/**
 * Bytes the contract's state may grow to beyond the code: 50 messages of the largest size (64-byte account id, 200
 * four-byte characters) take 46 250 bytes on chain (the unit test `storage_stops_growing_at_fifty_messages`), plus
 * the contract struct; rounded up.
 */
export const GUESTBOOK_STATE_BYTES = 50_000n;
/** Gas money on top of storage: the deploy transaction burns well under 0.01 NEAR. */
export const GUESTBOOK_GAS_MARGIN_YOCTO = 10n ** 23n; // 0.1 NEAR
export const GUESTBOOK_INIT_GAS = 30n * TGAS;
/** The wasm's size for a dry run's balance check before the build (the 0.1.0 build is 117 850 bytes), rounded up. */
export const GUESTBOOK_WASM_ESTIMATE_BYTES = 125_000;

const CONTRACT_DIR = join(repoRoot, 'contracts', 'hana-guestbook');
const WASM_CANDIDATES = [join(CONTRACT_DIR, 'target', 'near', 'hana_guestbook.wasm'), join(CONTRACT_DIR, 'target', 'wasm32-unknown-unknown', 'release', 'hana_guestbook.wasm')];

export type GuestbookRpc = Pick<NearRpc, 'chainId' | 'account' | 'accessKeys' | 'view' | 'sendTx'>;

export interface GuestbookDeps {
  rpc: (url: string) => GuestbookRpc;
  log: (line: string) => void;
  /** Home directory holding ~/.near-credentials (default: the user's home). */
  home?: string;
  buildWasm?: (log: (line: string) => void) => string;
  existingWasm?: () => string | null;
  loadManifest?: (name: string) => Manifest;
}

export const defaultGuestbookDeps = (): GuestbookDeps => ({ rpc: (url) => new NearRpc(url), log: (line) => console.log(line) });

const cargoEnv = () => ({ ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` });

/** As deploy-contract builds hana-signer: `cargo near build non-reproducible-wasm --no-abi` (plain cargo without cargo-near). */
function cargoBuildWasm(log: (line: string) => void): string {
  const useCargoNear = spawnSync('cargo', ['near', '--version'], { env: cargoEnv(), encoding: 'utf8' }).status === 0;
  const [args, out] = useCargoNear
    ? ([['near', 'build', 'non-reproducible-wasm', '--no-abi'], WASM_CANDIDATES[0]] as const)
    : ([['build', '--target', 'wasm32-unknown-unknown', '--release'], WASM_CANDIDATES[1]] as const);
  log(`  $ cargo ${args.join(' ')}${useCargoNear ? '' : '   (cargo-near not installed; plain cargo build)'}`);
  const r = spawnSync('cargo', [...args], { cwd: CONTRACT_DIR, env: cargoEnv(), stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Wasm build failed (exit ${r.status})`);
  if (!out || !existsSync(out)) throw new Error(`Build finished but ${out} is missing`);
  return out;
}

const builtWasm = (): string | null => WASM_CANDIDATES.find((p) => existsSync(p)) ?? null;

/** What the chain says about the guestbook account. */
export interface GuestbookObserved {
  chainId: string;
  exists: boolean;
  balanceYocto: bigint;
  storageUsage: number;
  codeHash: string;
  keys: AccessKeyListEntry[];
  /** `total_messages()` when the code answers it, else null. */
  totalMessages: number | null;
  credential: { found: boolean; publicKey?: string | undefined; fullAccessOnChain: boolean };
  /** The wasm to deploy, when known before the build. */
  wasm: { bytes: number; codeHash: string } | null;
}

export type GuestbookStep = { kind: 'build' } | { kind: 'deploy'; lock: string[] } | { kind: 'lock'; keys: string[] };

export interface GuestbookPlan {
  steps: GuestbookStep[];
  done: string[];
  blockers: string[];
}

/** Yocto the account needs before the deploy: storage for its current bytes, the code and the state, plus gas money. */
export function guestbookNeedYocto(storageUsage: number, wasmBytes: number): bigint {
  return (BigInt(storageUsage) + BigInt(wasmBytes) + GUESTBOOK_STATE_BYTES) * STORAGE_YOCTO_PER_BYTE + GUESTBOOK_GAS_MARGIN_YOCTO;
}

/** The plan for `account` from what was observed. Pure: the tests drive it through `guestbookMain`. */
export function buildGuestbookPlan(m: Manifest, account: string, o: GuestbookObserved, opts: { lock: boolean; build: boolean }): GuestbookPlan {
  const steps: GuestbookStep[] = [];
  const done: string[] = [];
  const blockers: string[] = [];
  if (o.chainId !== m.network) blockers.push(`RPC ${m.rpc} is on chain "${o.chainId}", the manifest says ${m.network}`);
  if (!o.exists) {
    blockers.push(
      `${account} does not exist. Create it (the faucet funds it):\n` +
        `      near account create-account sponsor-by-faucet-service ${account} autogenerate-new-keypair save-to-legacy-keychain network-config ${m.network} create`,
    );
    return { steps, done, blockers };
  }
  const deployed = o.codeHash !== EMPTY_CODE_HASH;
  const keyIds = o.keys.map((k) => k.public_key);
  if (deployed) {
    if (o.totalMessages === null) {
      blockers.push(`${account} already runs code ${o.codeHash} that is not an initialised guestbook. This tool never redeploys: name a new account in near.demoGuestbook`);
    } else if (o.wasm && o.wasm.codeHash !== o.codeHash) {
      blockers.push(`${account} already runs guestbook code ${o.codeHash}, not ${o.wasm.codeHash}. The guestbook has no upgrade path: deploy a new version to a new account (near.demoGuestbook)`);
    } else {
      done.push(`${account} runs the guestbook (code ${o.codeHash}, ${o.totalMessages} messages so far)`);
    }
  }
  const signs = (!deployed || opts.lock) && keyIds.length > 0;
  if (signs) {
    if (!o.credential.found) blockers.push(`No key for ${account} in the near CLI legacy keychain (~/.near-credentials/${m.network}/${account}.json)`);
    else if (!o.credential.fullAccessOnChain) blockers.push(`The keychain key ${o.credential.publicKey} is not a full-access key of ${account} on chain`);
  }
  if (!deployed) {
    if (!keyIds.length) blockers.push(`${account} has no access keys: nothing can deploy to it. Name a new account in near.demoGuestbook`);
    const bytes = o.wasm?.bytes ?? GUESTBOOK_WASM_ESTIMATE_BYTES;
    const need = guestbookNeedYocto(o.storageUsage, bytes);
    if (o.balanceYocto < need) {
      blockers.push(
        `${account} has ${formatNear(o.balanceYocto)}, needs at least ${formatNear(need)} (storage for ${o.wasm ? '' : 'about '}${bytes} bytes of code and up to ${GUESTBOOK_STATE_BYTES} bytes of messages, plus gas). Send more, e.g.\n` +
          `      near tokens <funded account> send-near ${account} '3 NEAR' network-config ${m.network} sign-with-legacy-keychain send`,
      );
    }
    if (opts.build) steps.push({ kind: 'build' });
    steps.push({ kind: 'deploy', lock: opts.lock ? keyIds : [] });
  } else if (opts.lock) {
    if (keyIds.length) steps.push({ kind: 'lock', keys: keyIds });
    else done.push(`${account} has no access keys (locked)`);
  }
  return { steps, done, blockers };
}

export function describeGuestbookStep(account: string, s: GuestbookStep): string {
  switch (s.kind) {
    case 'build':
      return 'build contracts/hana-guestbook (cargo near build non-reproducible-wasm --no-abi)';
    case 'deploy':
      return `deploy the guestbook to ${account} and call new() in the same transaction${s.lock.length ? `, then delete its ${s.lock.length} access key(s) in that transaction (--lock)` : ''}`;
    case 'lock':
      return `delete every access key of ${account} (${s.keys.join(', ')}): its code and messages can never change again (--lock)`;
  }
}

/** Runs deploy-guestbook with argv (without node and script path). Returns the exit code. */
export async function guestbookMain(argv: readonly string[], deps: GuestbookDeps = defaultGuestbookDeps()): Promise<number> {
  const { log } = deps;
  const args = parseCli(argv, { booleans: ['yes', 'lock', 'skip-build', 'help'], strings: ['wasm'] });
  if (args.flag('help')) {
    log(GUESTBOOK_USAGE);
    return 0;
  }
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const account = m.near?.demoGuestbook;
  if (!account) throw new CliError(`envs/${m.name}.json has no near.demoGuestbook: add the guestbook's account first (docs/operations.md "Hackathon demo guestbook")`);
  const wasmArg = args.str('wasm');
  if (wasmArg && !existsSync(wasmArg)) throw new CliError(`--wasm ${wasmArg} does not exist`);
  const existingWasm = deps.existingWasm ?? builtWasm;
  const skipBuild = args.flag('skip-build') || !!wasmArg;
  const knownWasm = wasmArg ?? (skipBuild ? existingWasm() : null);
  if (skipBuild && !knownWasm) throw new CliError('--skip-build but no built wasm found');

  const rpc = deps.rpc(m.rpc);
  log(`Environment ${m.name} (${m.network}, RPC ${m.rpc})`);
  log(`  guestbook ${account}`);
  const view = await rpc.account(account);
  const keys = view ? await rpc.accessKeys(account) : [];
  const cred = findLegacyCredential(account, m.network, deps.home);
  let totalMessages: number | null = null;
  if (view && view.code_hash !== EMPTY_CODE_HASH) {
    try {
      const total = await rpc.view<unknown>(account, 'total_messages');
      totalMessages = typeof total === 'number' ? total : null;
    } catch {
      totalMessages = null;
    }
  }
  const code = knownWasm ? readFileSync(knownWasm) : null;
  const observed: GuestbookObserved = {
    chainId: await rpc.chainId(),
    exists: !!view,
    balanceYocto: view ? BigInt(view.amount) : 0n,
    storageUsage: view?.storage_usage ?? 0,
    codeHash: view?.code_hash ?? EMPTY_CODE_HASH,
    keys,
    totalMessages,
    credential: { found: !!cred, publicKey: cred?.publicKey, fullAccessOnChain: !!cred && hasFullAccess(keys, cred.publicKey) },
    wasm: code ? { bytes: code.length, codeHash: codeHashOf(code) } : null,
  };
  const plan = buildGuestbookPlan(m, account, observed, { lock: args.flag('lock'), build: !skipBuild });

  if (view) {
    log(`  ${formatNear(observed.balanceYocto)}, ${observed.storageUsage} bytes stored, code ${observed.codeHash === EMPTY_CODE_HASH ? 'none' : observed.codeHash}`);
    log(`  access keys: ${keys.length ? keys.map((k) => `${k.public_key} (${k.access_key.permission === 'FullAccess' ? 'full access' : 'function call'})`).join(', ') : 'none'}`);
    log(`  local key ${cred ? `${cred.publicKey}${observed.credential.fullAccessOnChain ? ' (full access)' : ' (NOT a full-access key on chain)'}` : 'not found'}`);
  }
  if (observed.wasm) log(`  wasm ${knownWasm} (${observed.wasm.bytes} bytes, code_hash ${observed.wasm.codeHash})`);
  if (plan.done.length) log(`\nAlready done:\n${plan.done.map((d) => `  ✓ ${d}`).join('\n')}`);
  log(plan.steps.length ? `\nPlan:\n${plan.steps.map((s, i) => `  ${i + 1}. ${describeGuestbookStep(account, s)}`).join('\n')}` : '\nNothing to do.');
  if (plan.blockers.length) {
    log(`\nCannot deploy until these are fixed:\n${plan.blockers.map((b) => `  ✗ ${b}`).join('\n')}`);
    return 1;
  }
  if (!plan.steps.length) return 0;
  if (!args.flag('yes')) {
    log(`\n${GUESTBOOK_DRY_RUN_LINE}`);
    return 0;
  }

  const signer = () => {
    const k = cred ?? loadLegacyCredential(account, m.network, deps.home);
    return { accountId: k.accountId, keyPair: k.keyPair };
  };
  let wasmPath = knownWasm;
  for (const [i, step] of plan.steps.entries()) {
    log(`\n[${i + 1}/${plan.steps.length}] ${describeGuestbookStep(account, step)}`);
    if (step.kind === 'build') {
      wasmPath = (deps.buildWasm ?? cargoBuildWasm)(log);
      continue;
    }
    if (step.kind === 'deploy') {
      if (!wasmPath) throw new Error('No wasm: build it or pass --wasm');
      const wasm = readFileSync(wasmPath);
      const hash = codeHashOf(wasm);
      log(`    wasm ${wasmPath} (${wasm.length} bytes, code_hash ${hash})`);
      // The balance check again, now that the size is known (a build in this run).
      const now = await rpc.account(account);
      const need = guestbookNeedYocto(now?.storage_usage ?? 0, wasm.length);
      if (!now || BigInt(now.amount) < need) throw new Error(`${account} has ${formatNear(BigInt(now?.amount ?? 0))}, needs at least ${formatNear(need)}: fund it and re-run`);
      const actions: Action[] = [actionCreators.deployContract(new Uint8Array(wasm)), actionCreators.functionCall('new', {}, GUESTBOOK_INIT_GAS, 0n), ...step.lock.map((pk) => actionCreators.deleteKey(PublicKey.fromString(pk)))];
      const { hash: tx } = await rpc.sendTx(signer(), account, actions);
      log(`    tx ${explorerTx(tx)}`);
      const after = await rpc.account(account);
      if (after?.code_hash !== hash) throw new Error(`Deployed ${hash} but ${account} runs ${after?.code_hash ?? '(nothing)'}: stop and find out why`);
      const total = await rpc.view<unknown>(account, 'total_messages');
      if (total !== 0) throw new Error(`${account} answers total_messages = ${JSON.stringify(total)} right after new(); expected 0`);
      log(`    ${account} runs ${hash}; total_messages() = 0`);
      continue;
    }
    const { hash: tx } = await rpc.sendTx(signer(), account, step.keys.map((pk) => actionCreators.deleteKey(PublicKey.fromString(pk))));
    log(`    tx ${explorerTx(tx)}`);
    const left = await rpc.accessKeys(account);
    if (left.length) throw new Error(`${account} still has ${left.length} access key(s) after the lock: ${left.map((k) => k.public_key).join(', ')}`);
    log(`    ${account} has no access keys`);
  }
  const locked = plan.steps.some((s) => (s.kind === 'deploy' && s.lock.length > 0) || s.kind === 'lock');
  log(
    locked
      ? `\nDone. ${account} has no access keys: its code and messages are final. Delete the now useless key file in ~/.near-credentials/${m.network}/.`
      : `\nDone. ${account} still has its full-access key (in ~/.near-credentials/${m.network}/): whoever holds it can replace the code and every message.\n` +
          `Once the demo works, lock it:  corepack pnpm --filter @hana-id/scripts run deploy-guestbook ${m.name} --lock --yes`,
  );
  return 0;
}
