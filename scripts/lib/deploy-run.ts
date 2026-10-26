// deploy-contract's body: observe the chain, build the plan, print it, and (only with --yes) execute it.
// Dependencies (RPC, keychain home, .secrets root, output, wasm build) are injectable so tests can run the whole flow
// against a stub RPC and a temp directory.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import type { KeyPair } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';
import { CliError, parseCli } from './cli.ts';
import { type ContractConfig, GLOBAL_SCOPE, GOOGLE_PROVIDER, normaliseIssuer, tryView } from './contract.ts';
import { buildDeployPlan, type DeployObserved, type DeployStep, describeStep, type Role, ROLES, stepSigner } from './deploy-plan.ts';
import {
  findLegacyCredential,
  generateKey,
  type LoadedKey,
  loadLegacyCredential,
  readKeysUpdater,
  readRelayerKeys,
  writeKeysUpdater,
  writeRelayerKeys,
} from './keys.ts';
import { explorerTx, formatNear, functionCallKeysFor, hasFullAccess, NearRpc, nearToYocto, otherAccessKeys, STORAGE_YOCTO_PER_BYTE, TGAS } from './near.ts';

export const DEPLOY_USAGE = `Usage: deploy-contract.ts <env> [--yes] [--relayer-keys 3] [--relayer-allowance 2] [--updater-allowance 1]
                          [--upgrade] [--wasm <file>] [--skip-build]
  --yes                 apply the plan (without it, only print it)
  --relayer-keys N      function-call keys to keep on the relayer account (default 3)
  --relayer-allowance   gas allowance per relayer key, in NEAR (default 2)
  --updater-allowance   gas allowance of the keys-updater key, in NEAR (default 1)
  --upgrade             redeploy the code to an already-initialised contract (no init call)
  --wasm <file>         deploy this wasm instead of building
  --skip-build          use the last built wasm`;

export const DRY_RUN_LINE = 'Dry run: nothing changed. Re-run with --yes to apply.';

const CONTRACT_DIR = join(repoRoot, 'contracts', 'hana-signer');
const WASM_CANDIDATES = [join(CONTRACT_DIR, 'target', 'near', 'hana_signer.wasm'), join(CONTRACT_DIR, 'target', 'wasm32-unknown-unknown', 'release', 'hana_signer.wasm')];
const GAS_INIT = 100n * TGAS;
const GAS_CALL = 100n * TGAS;

/** The RPC calls the deploy uses. */
export type DeployRpc = Pick<NearRpc, 'chainId' | 'account' | 'accessKeys' | 'view' | 'sendTx'>;

export interface DeployDeps {
  rpc: (url: string) => DeployRpc;
  log: (line: string) => void;
  /** Home directory holding ~/.near-credentials (default: the user's home). */
  home?: string;
  /** Directory holding .secrets/ (default: the repo root). */
  secretsRoot?: string;
  buildWasm?: (log: (line: string) => void) => string;
  existingWasm?: () => string | null;
}

export const defaultDeployDeps = (): DeployDeps => ({ rpc: (url) => new NearRpc(url), log: (line) => console.log(line) });

const cargoEnv = () => ({ ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` });

function hasCargoNear(): boolean {
  const r = spawnSync('cargo', ['near', '--version'], { env: cargoEnv(), encoding: 'utf8' });
  return r.status === 0;
}

function cargoBuildWasm(log: (line: string) => void): string {
  const useCargoNear = hasCargoNear();
  const [cmd, args, out] = useCargoNear
    ? (['cargo', ['near', 'build', 'non-reproducible-wasm', '--no-abi'], WASM_CANDIDATES[0]] as const)
    : (['cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'], WASM_CANDIDATES[1]] as const);
  log(`  $ ${cmd} ${args.join(' ')}${useCargoNear ? '' : '   (cargo-near not installed; plain cargo build)'}`);
  const r = spawnSync(cmd, [...args], { cwd: CONTRACT_DIR, env: cargoEnv(), stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Wasm build failed (exit ${r.status})`);
  if (!out || !existsSync(out)) throw new Error(`Build finished but ${out} is missing`);
  return out;
}

function builtWasm(): string | null {
  return WASM_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

interface Ctx {
  m: Manifest;
  rpc: DeployRpc;
  log: (line: string) => void;
  home: string | undefined;
  secretsRoot: string | undefined;
  buildWasm: (log: (line: string) => void) => string;
  existingWasm: () => string | null;
}

async function observe(c: Ctx, wasmPath: string | null): Promise<{ observed: DeployObserved; creds: Partial<Record<Role, LoadedKey>> }> {
  const { m, rpc } = c;
  const chainId = await rpc.chainId();
  const accounts = {} as DeployObserved['accounts'];
  const credentials = {} as DeployObserved['credentials'];
  const creds: Partial<Record<Role, LoadedKey>> = {};
  const keyLists: Partial<Record<Role, Awaited<ReturnType<NearRpc['accessKeys']>>>> = {};
  for (const role of ROLES) {
    const view = await rpc.account(m[role]);
    accounts[role] = { exists: !!view, balanceYocto: view ? BigInt(view.amount) : 0n, codeHash: view?.code_hash ?? '' };
    keyLists[role] = view ? await rpc.accessKeys(m[role]) : [];
    const cred = findLegacyCredential(m[role], m.network, c.home);
    if (cred) creds[role] = cred;
    credentials[role] = { found: !!cred, publicKey: cred?.publicKey, fullAccessOnChain: !!cred && hasFullAccess(keyLists[role] ?? [], cred.publicKey) };
  }
  const config = accounts.signer.exists ? await tryView<ContractConfig>(rpc, m.signer, 'get_config') : null;
  const googleIssuer = config ? normaliseIssuer(await tryView<unknown>(rpc, m.signer, 'get_issuer', { provider: GOOGLE_PROVIDER })) : null;
  const globalScope = config ? await tryView<unknown>(rpc, m.signer, 'get_scope', { scope_id: GLOBAL_SCOPE }) : null;
  const updater = readKeysUpdater(m.name, c.secretsRoot);
  if (updater && updater.accountId !== m.signer) throw new Error(`.secrets/${m.name}/keys-updater.json is for ${updater.accountId}, not ${m.signer}`);
  return {
    creds,
    observed: {
      chainId,
      accounts,
      credentials,
      config,
      relayerKeysOnChain: functionCallKeysFor(keyLists.relayer ?? [], m.signer),
      relayerKeysElsewhere: otherAccessKeys(keyLists.relayer ?? [], m.signer),
      relayerKeysInFile: readRelayerKeys(m.name, c.secretsRoot).map((k) => k.getPublicKey().toString()),
      signerFunctionKeysOnChain: functionCallKeysFor(keyLists.signer ?? [], m.signer),
      updaterKeyInFile: updater?.publicKey ?? null,
      googleIssuer,
      globalScope,
      wasmBytes: wasmPath ? readFileSync(wasmPath).length : null,
    },
  };
}

async function execute(c: Ctx, step: DeployStep, creds: Partial<Record<Role, LoadedKey>>, state: { wasmPath: string | null }): Promise<void> {
  const { m, rpc, log } = c;
  const role = stepSigner(step);
  const signer = role ? (creds[role] ?? loadLegacyCredential(m[role], m.network, c.home)) : null;
  const send = async (receiver: string, actions: Parameters<NearRpc['sendTx']>[2]) => {
    if (!signer) throw new Error('No signer for this step');
    const { hash, value } = await rpc.sendTx({ accountId: signer.accountId, keyPair: signer.keyPair }, receiver, actions);
    log(`    tx ${explorerTx(hash)}`);
    return value;
  };
  const call = (method: string, args: object) => send(m.signer, [actionCreators.functionCall(method, args, GAS_CALL, 0n)]);

  switch (step.kind) {
    case 'build':
      state.wasmPath = c.buildWasm(log);
      return;
    case 'deploy': {
      const wasmPath = state.wasmPath ?? c.existingWasm();
      if (!wasmPath) throw new Error('No wasm to deploy: build it or pass --wasm');
      const code = readFileSync(wasmPath);
      const account = await rpc.account(m.signer);
      const need = BigInt(code.length) * STORAGE_YOCTO_PER_BYTE;
      if (!account || BigInt(account.amount) < need) {
        throw new Error(`${m.signer} has ${formatNear(BigInt(account?.amount ?? 0))}, needs at least ${formatNear(need)} for ${code.length} bytes of code`);
      }
      log(`    wasm ${wasmPath} (${code.length} bytes)`);
      const actions = [actionCreators.deployContract(new Uint8Array(code))];
      if (step.init) actions.push(actionCreators.functionCall('new', step.init, GAS_INIT, 0n));
      await send(m.signer, actions);
      return;
    }
    case 'relayer-keys': {
      const existing = readRelayerKeys(m.name, c.secretsRoot);
      const fresh: KeyPair[] = Array.from({ length: step.generate }, () => generateKey());
      // Save before adding on chain, so a key that lands on chain is never lost.
      if (fresh.length) writeRelayerKeys(m.name, [...existing, ...fresh], c.secretsRoot);
      const toAdd = [...existing.filter((k) => step.reuse.includes(k.getPublicKey().toString())), ...fresh];
      const access = actionCreators.functionCallAccessKey(m.signer, step.methods, step.allowanceYocto);
      await send(m.relayer, toAdd.map((k) => actionCreators.addKey(k.getPublicKey(), access)));
      for (const k of toAdd) log(`    added ${k.getPublicKey().toString()}`);
      return;
    }
    case 'updater-key': {
      let key = readKeysUpdater(m.name, c.secretsRoot)?.keyPair;
      if (!key || !step.reuse) {
        key = generateKey();
        writeKeysUpdater(m.name, m.signer, key, c.secretsRoot);
      }
      const access = actionCreators.functionCallAccessKey(m.signer, step.methods, step.allowanceYocto);
      await send(m.signer, [actionCreators.addKey(key.getPublicKey(), access)]);
      log(`    added ${key.getPublicKey().toString()}`);
      return;
    }
    case 'set-issuer':
      await call('set_issuer', { provider: step.provider, iss_values: step.iss_values });
      return;
    case 'set-sponsors':
      await call('set_sponsors', { sponsors: step.sponsors });
      return;
    case 'set-console-audiences':
      await call('set_console_audiences', { audiences: step.audiences });
      return;
    case 'register-global': {
      const value = await call('admin_register_scope', { owners: step.owners, clients: step.clients, scope_id: GLOBAL_SCOPE });
      log(`    scope ${JSON.stringify(value)}`);
      return;
    }
  }
}

/** Runs deploy-contract with argv (without node and script path). Returns the exit code. */
export async function deployMain(argv: readonly string[], deps: DeployDeps = defaultDeployDeps()): Promise<number> {
  const { log } = deps;
  const args = parseCli(argv, {
    booleans: ['yes', 'upgrade', 'skip-build', 'help'],
    strings: ['relayer-keys', 'relayer-allowance', 'updater-allowance', 'wasm'],
  });
  if (args.flag('help')) {
    log(DEPLOY_USAGE);
    return 0;
  }
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = loadEnv(envName);
  const existingWasm = deps.existingWasm ?? builtWasm;
  const c: Ctx = { m, rpc: deps.rpc(m.rpc), log, home: deps.home, secretsRoot: deps.secretsRoot, buildWasm: deps.buildWasm ?? cargoBuildWasm, existingWasm };

  const wasmArg = args.str('wasm');
  if (wasmArg && !existsSync(wasmArg)) throw new CliError(`--wasm ${wasmArg} does not exist`);
  const options = {
    relayerKeyCount: args.int('relayer-keys', 3, { min: 1, max: 20 }),
    relayerAllowanceYocto: nearToYocto(args.str('relayer-allowance') ?? '2'),
    updaterAllowanceYocto: nearToYocto(args.str('updater-allowance') ?? '1'),
    upgrade: args.flag('upgrade'),
    skipBuild: args.flag('skip-build') || !!wasmArg,
  };
  if (options.skipBuild && !wasmArg && !existingWasm()) throw new CliError('--skip-build but no built wasm found');

  log(`Environment ${m.name} (${m.network}, RPC ${m.rpc})`);
  log(`  signer ${m.signer} · relayer ${m.relayer} · owner ${m.owner} · mpc ${m.mpc} (CKD domain ${m.ckdDomainId})\n`);
  const { observed, creds } = await observe(c, wasmArg ?? existingWasm());
  const plan = buildDeployPlan(m, observed, options);

  for (const role of ROLES) {
    const a = observed.accounts[role];
    const cr = observed.credentials[role];
    log(`  ${role.padEnd(7)} ${m[role]}: ${a.exists ? formatNear(a.balanceYocto) : 'MISSING'}; local key ${cr.found ? `${cr.publicKey}${cr.fullAccessOnChain ? ' (full access)' : ' (NOT a full-access key on chain)'}` : 'not found'}`);
  }
  if (plan.done.length) log(`\nAlready done:\n${plan.done.map((d) => `  ✓ ${d}`).join('\n')}`);
  if (plan.warnings.length) log(`\nWarnings:\n${plan.warnings.map((w) => `  ! ${w}`).join('\n')}`);
  log(plan.steps.length ? `\nPlan:\n${plan.steps.map((s, i) => `  ${i + 1}. ${describeStep(m, s)}`).join('\n')}` : '\nNothing to do.');
  if (plan.blockers.length) {
    log(`\nCannot deploy until these are fixed:\n${plan.blockers.map((b) => `  ✗ ${b}`).join('\n')}`);
    return 1;
  }
  if (!plan.steps.length) return 0;
  if (!args.flag('yes')) {
    log(`\n${DRY_RUN_LINE}`);
    return 0;
  }

  const state = { wasmPath: wasmArg ?? null };
  for (const [i, step] of plan.steps.entries()) {
    log(`\n[${i + 1}/${plan.steps.length}] ${describeStep(m, step)}`);
    await execute(c, step, creds, state);
  }
  log(`\nDone. Secrets (if any were generated) are in .secrets/${m.name}/ (0600). Next:
  pnpm --filter @hana-id/scripts run post-google-keys ${m.name}     # Google signing keys → contract
  pnpm --filter @hana-id/scripts run fetch-ckd-key ${m.name}        # pin the MPC CKD key in envs/${m.name}.json
  then generate the API config and upload RELAYER_KEYS / KEYS_UPDATER_KEY (see README.md).`);
  return 0;
}
