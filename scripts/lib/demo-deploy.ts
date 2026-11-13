// The hackathon demo contracts' deploy (D743, D796), shared by deploy-guestbook (contracts/hana-guestbook, the env's
// `near.demoGuestbook`) and deploy-stamps (contracts/hana-stamps, `near.demoStamps`); each passes its `DemoContract`.
// Observes the chain, prints the plan, and changes nothing without --yes, like deploy-contract. The code is deployed
// and `new()` called in one transaction (no one can initialise it in between); it is never redeployed (the contracts
// have no upgrade path: a new version goes to a new account). `--lock` deletes every access key on the account (on its own,
// once deployed: never with the deploy), after which no one can change its code or state. The account's
// full-access key is read from the near CLI legacy keychain and never printed. Testnet only: the manifest's network is
// testnet-only, and an RPC on another chain is a blocker. Dependencies are injectable so test/guestbook-deploy.test.ts
// and test/stamps-deploy.test.ts run the flow against a stub RPC.
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

export const DEMO_DRY_RUN_LINE = 'Dry run: nothing changed. Re-run with --yes to apply.';
/** Gas money on top of storage: the deploy transaction burns well under 0.01 NEAR. */
export const DEMO_GAS_MARGIN_YOCTO = 10n ** 23n; // 0.1 NEAR
export const DEMO_INIT_GAS = 30n * TGAS;

/** What differs between the demo contracts. */
export interface DemoContract {
  /** The scripts' command, for the hints it prints (`deploy-guestbook`). */
  command: string;
  /** What the output calls it (`guestbook`, `stamps contract`). */
  name: string;
  /** The crate under contracts/ and its wasm file. */
  crate: string;
  wasmName: string;
  /** The manifest field under `near` naming the account. */
  manifestField: 'demoGuestbook' | 'demoStamps';
  /** The docs/operations.md section the hints point at. */
  docsSection: string;
  /** Bytes of state the balance check reserves beyond the code, and how the plan describes them. */
  stateBytes: bigint;
  stateText: string;
  /** What the account's key can rewrite and what a lock makes final (`messages`, `passports`). */
  stateNoun: string;
  /** The wasm's size for a dry run's balance check before the build, rounded up. */
  wasmEstimateBytes: number;
  /** A view that only this contract, initialised, answers: its argument-free method and how to read the answer. */
  probe: {
    method: string;
    /** A summary for "already done" (`12 messages so far`), or null when the answer isn't this contract's. */
    summary: (answer: unknown) => string | null;
    /** Whether the answer is a freshly initialised contract's, and how the deploy reports it. */
    fresh: (answer: unknown) => boolean;
    freshText: string;
  };
}

export type DemoRpc = Pick<NearRpc, 'chainId' | 'account' | 'accessKeys' | 'view' | 'sendTx'>;

export interface DemoDeps {
  rpc: (url: string) => DemoRpc;
  log: (line: string) => void;
  /** Home directory holding ~/.near-credentials (default: the user's home). */
  home?: string;
  buildWasm?: (log: (line: string) => void) => string;
  existingWasm?: () => string | null;
  loadManifest?: (name: string) => Manifest;
}

export const defaultDemoDeps = (): DemoDeps => ({ rpc: (url) => new NearRpc(url), log: (line) => console.log(line) });

export function demoUsage(c: DemoContract): string {
  return `Usage: ${c.command}.ts <env> [--yes] [--lock] [--wasm <file>] [--skip-build]
  Deploys contracts/${c.crate} to the env's near.${c.manifestField} account (deploy + new() in one transaction).
  --yes          apply the plan (without it, only print it)
  --lock         delete every access key on the account once it runs the contract (never with the deploy): no one can
                 change the code or the ${c.stateNoun} afterwards, and the account can never be deleted
  --wasm <file>  deploy this wasm instead of building
  --skip-build   deploy the last built wasm (contracts/${c.crate}/target/near/${c.wasmName})`;
}

const contractDir = (c: DemoContract) => join(repoRoot, 'contracts', c.crate);
const wasmCandidates = (c: DemoContract) => [join(contractDir(c), 'target', 'near', c.wasmName), join(contractDir(c), 'target', 'wasm32-unknown-unknown', 'release', c.wasmName)];

const cargoEnv = () => ({ ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` });

/** As deploy-contract builds hana-signer: `cargo near build non-reproducible-wasm --no-abi` (plain cargo without cargo-near). */
function cargoBuildWasm(c: DemoContract, log: (line: string) => void): string {
  const [near, plain] = wasmCandidates(c);
  const useCargoNear = spawnSync('cargo', ['near', '--version'], { env: cargoEnv(), encoding: 'utf8' }).status === 0;
  const [args, out] = useCargoNear ? ([['near', 'build', 'non-reproducible-wasm', '--no-abi'], near] as const) : ([['build', '--target', 'wasm32-unknown-unknown', '--release'], plain] as const);
  log(`  $ cargo ${args.join(' ')}${useCargoNear ? '' : '   (cargo-near not installed; plain cargo build)'}`);
  const r = spawnSync('cargo', [...args], { cwd: contractDir(c), env: cargoEnv(), stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Wasm build failed (exit ${r.status})`);
  if (!out || !existsSync(out)) throw new Error(`Build finished but ${out} is missing`);
  return out;
}

const builtWasm = (c: DemoContract) => (): string | null => wasmCandidates(c).find((p) => existsSync(p)) ?? null;

/** What the chain says about the demo contract's account. */
export interface DemoObserved {
  chainId: string;
  exists: boolean;
  balanceYocto: bigint;
  storageUsage: number;
  codeHash: string;
  keys: AccessKeyListEntry[];
  /** The probe's summary when the code answers it as this contract, else null. */
  summary: string | null;
  credential: { found: boolean; publicKey?: string | undefined; fullAccessOnChain: boolean };
  /** The wasm to deploy, when known before the build. */
  wasm: { bytes: number; codeHash: string } | null;
}

export type DemoStep = { kind: 'build' } | { kind: 'deploy'; lock: string[] } | { kind: 'lock'; keys: string[] };

export interface DemoPlan {
  steps: DemoStep[];
  done: string[];
  blockers: string[];
}

/** Yocto the account needs before the deploy: storage for its current bytes, the code and the state, plus gas money. */
export function demoNeedYocto(c: Pick<DemoContract, 'stateBytes'>, storageUsage: number, wasmBytes: number): bigint {
  return (BigInt(storageUsage) + BigInt(wasmBytes) + c.stateBytes) * STORAGE_YOCTO_PER_BYTE + DEMO_GAS_MARGIN_YOCTO;
}

/** The plan for `account` from what was observed. Pure: the tests drive it through `demoMain`. */
export function buildDemoPlan(c: DemoContract, m: Manifest, account: string, o: DemoObserved, opts: { lock: boolean; build: boolean }): DemoPlan {
  const steps: DemoStep[] = [];
  const done: string[] = [];
  const blockers: string[] = [];
  const field = `near.${c.manifestField}`;
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
    if (o.summary === null) {
      blockers.push(`${account} already runs code ${o.codeHash} that is not an initialised ${c.name}. This tool never redeploys: name a new account in ${field}`);
    } else if (o.wasm && o.wasm.codeHash !== o.codeHash) {
      blockers.push(`${account} already runs ${c.name} code ${o.codeHash}, not ${o.wasm.codeHash}. The ${c.name} has no upgrade path: deploy a new version to a new account (${field})`);
    } else {
      done.push(`${account} runs the ${c.name} (code ${o.codeHash}, ${o.summary})`);
    }
  }
  const signs = (!deployed || opts.lock) && keyIds.length > 0;
  if (signs) {
    if (!o.credential.found) blockers.push(`No key for ${account} in the near CLI legacy keychain (~/.near-credentials/${m.network}/${account}.json)`);
    else if (!o.credential.fullAccessOnChain) blockers.push(`The keychain key ${o.credential.publicKey} is not a full-access key of ${account} on chain`);
  }
  if (!deployed) {
    if (!keyIds.length) blockers.push(`${account} has no access keys: nothing can deploy to it. Name a new account in ${field}`);
    const bytes = o.wasm?.bytes ?? c.wasmEstimateBytes;
    const need = demoNeedYocto(c, o.storageUsage, bytes);
    if (o.balanceYocto < need) {
      blockers.push(
        `${account} has ${formatNear(o.balanceYocto)}, needs at least ${formatNear(need)} (storage for ${o.wasm ? '' : 'about '}${bytes} bytes of code and ${c.stateText}, plus gas). Send more, e.g.\n` +
          `      near tokens <funded account> send-near ${account} '3 NEAR' network-config ${m.network} sign-with-legacy-keychain send`,
      );
    }
    // A lock with the first deploy would make a wrong wasm final before anyone checked it (the probe runs after the
    // keys are gone): lock only an account that already runs this contract, as the documented procedure does.
    if (opts.lock) blockers.push(`--lock locks only an account that already runs the ${c.name}: deploy first without --lock, check it, then run ${c.command} ${m.name} --lock --yes`);
    if (opts.build) steps.push({ kind: 'build' });
    steps.push({ kind: 'deploy', lock: [] });
  } else if (opts.lock) {
    if (keyIds.length) steps.push({ kind: 'lock', keys: keyIds });
    else done.push(`${account} has no access keys (locked)`);
  }
  return { steps, done, blockers };
}

export function describeDemoStep(c: DemoContract, account: string, s: DemoStep): string {
  switch (s.kind) {
    case 'build':
      return `build contracts/${c.crate} (cargo near build non-reproducible-wasm --no-abi)`;
    case 'deploy':
      return `deploy the ${c.name} to ${account} and call new() in the same transaction${s.lock.length ? `, then delete its ${s.lock.length} access key(s) in that transaction (--lock)` : ''}`;
    case 'lock':
      return `delete every access key of ${account} (${s.keys.join(', ')}): its code and ${c.stateNoun} can never change again (--lock)`;
  }
}

/** Runs the deploy of `c` with argv (without node and script path). Returns the exit code. */
export async function demoMain(c: DemoContract, argv: readonly string[], deps: DemoDeps = defaultDemoDeps()): Promise<number> {
  const { log } = deps;
  const args = parseCli(argv, { booleans: ['yes', 'lock', 'skip-build', 'help'], strings: ['wasm'] });
  if (args.flag('help')) {
    log(demoUsage(c));
    return 0;
  }
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const account = m.near?.[c.manifestField];
  if (!account) throw new CliError(`envs/${m.name}.json has no near.${c.manifestField}: add the ${c.name}'s account first (docs/operations.md "${c.docsSection}")`);
  const wasmArg = args.str('wasm');
  if (wasmArg && !existsSync(wasmArg)) throw new CliError(`--wasm ${wasmArg} does not exist`);
  const existingWasm = deps.existingWasm ?? builtWasm(c);
  const skipBuild = args.flag('skip-build') || !!wasmArg;
  const knownWasm = wasmArg ?? (skipBuild ? existingWasm() : null);
  if (skipBuild && !knownWasm) throw new CliError('--skip-build but no built wasm found');

  const rpc = deps.rpc(m.rpc);
  log(`Environment ${m.name} (${m.network}, RPC ${m.rpc})`);
  log(`  ${c.name} ${account}`);
  const view = await rpc.account(account);
  const keys = view ? await rpc.accessKeys(account) : [];
  const cred = findLegacyCredential(account, m.network, deps.home);
  let summary: string | null = null;
  if (view && view.code_hash !== EMPTY_CODE_HASH) {
    try {
      summary = c.probe.summary(await rpc.view<unknown>(account, c.probe.method));
    } catch {
      summary = null;
    }
  }
  const code = knownWasm ? readFileSync(knownWasm) : null;
  const observed: DemoObserved = {
    chainId: await rpc.chainId(),
    exists: !!view,
    balanceYocto: view ? BigInt(view.amount) : 0n,
    storageUsage: view?.storage_usage ?? 0,
    codeHash: view?.code_hash ?? EMPTY_CODE_HASH,
    keys,
    summary,
    credential: { found: !!cred, publicKey: cred?.publicKey, fullAccessOnChain: !!cred && hasFullAccess(keys, cred.publicKey) },
    wasm: code ? { bytes: code.length, codeHash: codeHashOf(code) } : null,
  };
  const plan = buildDemoPlan(c, m, account, observed, { lock: args.flag('lock'), build: !skipBuild });

  if (view) {
    log(`  ${formatNear(observed.balanceYocto)}, ${observed.storageUsage} bytes stored, code ${observed.codeHash === EMPTY_CODE_HASH ? 'none' : observed.codeHash}`);
    log(`  access keys: ${keys.length ? keys.map((k) => `${k.public_key} (${k.access_key.permission === 'FullAccess' ? 'full access' : 'function call'})`).join(', ') : 'none'}`);
    log(`  local key ${cred ? `${cred.publicKey}${observed.credential.fullAccessOnChain ? ' (full access)' : ' (NOT a full-access key on chain)'}` : 'not found'}`);
  }
  if (observed.wasm) log(`  wasm ${knownWasm} (${observed.wasm.bytes} bytes, code_hash ${observed.wasm.codeHash})`);
  if (plan.done.length) log(`\nAlready done:\n${plan.done.map((d) => `  ✓ ${d}`).join('\n')}`);
  log(plan.steps.length ? `\nPlan:\n${plan.steps.map((s, i) => `  ${i + 1}. ${describeDemoStep(c, account, s)}`).join('\n')}` : '\nNothing to do.');
  if (plan.blockers.length) {
    log(`\nCannot deploy until these are fixed:\n${plan.blockers.map((b) => `  ✗ ${b}`).join('\n')}`);
    return 1;
  }
  if (!plan.steps.length) return 0;
  if (!args.flag('yes')) {
    log(`\n${DEMO_DRY_RUN_LINE}`);
    return 0;
  }

  const signer = () => {
    const k = cred ?? loadLegacyCredential(account, m.network, deps.home);
    return { accountId: k.accountId, keyPair: k.keyPair };
  };
  let wasmPath = knownWasm;
  for (const [i, step] of plan.steps.entries()) {
    log(`\n[${i + 1}/${plan.steps.length}] ${describeDemoStep(c, account, step)}`);
    if (step.kind === 'build') {
      wasmPath = (deps.buildWasm ?? ((l) => cargoBuildWasm(c, l)))(log);
      continue;
    }
    if (step.kind === 'deploy') {
      if (!wasmPath) throw new Error('No wasm: build it or pass --wasm');
      const wasm = readFileSync(wasmPath);
      const hash = codeHashOf(wasm);
      log(`    wasm ${wasmPath} (${wasm.length} bytes, code_hash ${hash})`);
      // The balance check again, now that the size is known (a build in this run).
      const now = await rpc.account(account);
      const need = demoNeedYocto(c, now?.storage_usage ?? 0, wasm.length);
      if (!now || BigInt(now.amount) < need) throw new Error(`${account} has ${formatNear(BigInt(now?.amount ?? 0))}, needs at least ${formatNear(need)}: fund it and re-run`);
      const actions: Action[] = [actionCreators.deployContract(new Uint8Array(wasm)), actionCreators.functionCall('new', {}, DEMO_INIT_GAS, 0n), ...step.lock.map((pk) => actionCreators.deleteKey(PublicKey.fromString(pk)))];
      const { hash: tx } = await rpc.sendTx(signer(), account, actions);
      log(`    tx ${explorerTx(tx)}`);
      const after = await rpc.account(account);
      if (after?.code_hash !== hash) throw new Error(`Deployed ${hash} but ${account} runs ${after?.code_hash ?? '(nothing)'}: stop and find out why`);
      const answer = await rpc.view<unknown>(account, c.probe.method);
      if (!c.probe.fresh(answer)) throw new Error(`${account} answers ${c.probe.method} = ${JSON.stringify(answer)} right after new(); expected ${c.probe.freshText}`);
      log(`    ${account} runs ${hash}; ${c.probe.method}() = ${c.probe.freshText}`);
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
      ? `\nDone. ${account} has no access keys: its code and ${c.stateNoun} are final. Delete the now useless key file in ~/.near-credentials/${m.network}/.`
      : `\nDone. ${account} still has its full-access key (in ~/.near-credentials/${m.network}/): whoever holds it can replace the code and every ${c.stateNoun.replace(/s$/u, '')}.\n` +
          `Once the demo works, lock it:  corepack pnpm --filter @hana-id/scripts run ${c.command} ${m.name} --lock --yes`,
  );
  return 0;
}
