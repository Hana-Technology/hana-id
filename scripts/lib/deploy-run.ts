// deploy-contract's body: observe the chain, build the plan, print it, and (only with --yes) execute it.
// Dependencies (RPC, keychain home, .secrets root, output, wasm build, manifest write, clock) are injectable so tests
// can run the whole flow against a stub RPC and a temp directory.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, loadEnv, manifestPath, repoRoot } from '@hana-id/env';
import { type KeyPair, PublicKey } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';
import { CliError, parseCli } from './cli.ts';
import { type ContractConfig, GLOBAL_SCOPE, GOOGLE_PROVIDER, type GovernanceView, normaliseIssuer, tryView } from './contract.ts';
import { councilKeysOnDisk, readCouncilKey } from './council.ts';
import {
  buildDeployPlan,
  clientKey,
  creationPlan,
  type DeployObserved,
  type DeployOptions,
  type DeployStep,
  describeStep,
  ownerCallOf,
  removeConsoleClientArgs,
  type Role,
  ROLES,
  SINK_WAIT_MAX_MS,
  stepSigner,
} from './deploy-plan.ts';
import {
  findLegacyCredential,
  generateKey,
  type LoadedKey,
  loadLegacyCredential,
  poolFileName,
  readKeysUpdater,
  readPoolKeys,
  writeKeysUpdater,
  writePoolKeys,
} from './keys.ts';
import { setManifestStrings } from './manifest-edit.ts';
import { codeHashOf, explorerTx, formatNear, hasFullAccess, NearRpc, nearToYocto, STORAGE_YOCTO_PER_BYTE, TGAS } from './near.ts';
import { ownerRoute, type OwnerTxOptions, sendOwnerCall } from './owner-tx.ts';
import { readPin, readPolicyTemplate, type SputnikPolicy } from './sputnik.ts';

export const DEPLOY_USAGE = `Usage: deploy-contract.ts <env> [--yes] [--relayer-keys 3] [--relayer-allowance 2]
                          [--owner-relayer-keys 1] [--owner-relayer-allowance 0.5]
                          [--upgrade] [--wasm <file>] [--skip-build]
                          [--transfer-owner] [--member <council member>] [--approve-with <council member>]
                          [--known-owner <account,…>]
       deploy-contract.ts <env> --creation-plan [--wasm <reproducible build>] [--updater-public-key <pk>] [--creation-public-key <pk>]
  --yes                       apply the plan (without it, only print it)
  --relayer-keys N            session-pool keys on the relayer (RELAYER_KEYS: logins) (default 3)
  --relayer-allowance         gas allowance per session-pool key, in NEAR (default 2)
  --owner-relayer-keys N      owner-pool keys on the relayer (OWNER_RELAYER_KEYS: /v1/owner-actions) (default 1)
  --owner-relayer-allowance   gas allowance per owner-pool key, in NEAR (default 0.5)
  --upgrade                   change the code of an initialised contract: propose_upgrade(hash) by the owner, and
                              execute_upgrade once governance_delay_ms passed (a v1 contract is refused)
  --wasm <file>               deploy this wasm instead of building
  --skip-build                use the last built wasm (its hash is then known when planning)
  --transfer-owner            hand the contract to the council DAO: propose_owner(DAO), then the DAO's accept_owner
  --member <account>          council member who proposes owner steps (dev envs default: the first member)
  --known-owner <a,b>         former Hana owner accounts a console sink scope may be owned by (e.g. the owner before
                              the council transfer); a sink owned by anyone else is a blocker
  --approve-with <account>    dev envs on testnet only: a second member approves each proposal in the same run
  --creation-plan             print (never send) the mainnet-style signer creation batch for this manifest`;

export const DRY_RUN_LINE = 'Dry run: nothing changed. Re-run with --yes to apply.';
/**
 * Each owner-pool key's allowance by default: the API's hourly `owner_allowance_low` check measures against it
 * (apps/api/src/relayer-config.ts OWNER_POOL_ALLOWANCE_YOCTO; a test keeps the two equal).
 */
export const DEFAULT_OWNER_ALLOWANCE_NEAR = '0.5';

const CONTRACT_DIR = join(repoRoot, 'contracts', 'hana-signer');
const WASM_CANDIDATES = [join(CONTRACT_DIR, 'target', 'near', 'hana_signer.wasm'), join(CONTRACT_DIR, 'target', 'wasm32-unknown-unknown', 'release', 'hana_signer.wasm')];
const GAS_INIT = 100n * TGAS;
const GAS_EXECUTE_UPGRADE = 300n * TGAS;

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
  /** Reads envs/<name>.json (default loadEnv; tests pass a fixture). */
  loadManifest?: (name: string) => Manifest;
  /** Sets string fields of envs/<name>.json (after the DAO accepted ownership). Default: edits the file in place. */
  updateManifest?: (name: string, fields: Record<string, string>) => void;
  now?: () => number;
  /** Waits `ms` (the console sink's quarantine, D238). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The pinned Sputnik DAO code hash (default: contracts/sputnik/pin.json). */
  sputnikCodeHash?: string;
}

export const defaultDeployDeps = (): DeployDeps => ({ rpc: (url) => new NearRpc(url), log: (line) => console.log(line) });

function writeManifestFields(name: string, fields: Record<string, string>): void {
  const file = manifestPath(name);
  writeFileSync(file, setManifestStrings(readFileSync(file, 'utf8'), fields));
}

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
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  ownerTx: OwnerTxOptions;
  updateManifest: (name: string, fields: Record<string, string>) => void;
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
    const cred = role === 'owner' && m.ownerKind === 'sputnik' ? null : findLegacyCredential(m[role], m.network, c.home);
    if (cred) creds[role] = cred;
    credentials[role] = { found: !!cred, publicKey: cred?.publicKey, fullAccessOnChain: !!cred && hasFullAccess(keyLists[role] ?? [], cred.publicKey) };
  }
  const config = accounts.signer.exists ? await tryView<ContractConfig>(rpc, m.signer, 'get_config') : null;
  const governance = config ? await tryView<GovernanceView>(rpc, m.signer, 'get_governance') : null;
  const googleIssuer = config ? normaliseIssuer(await tryView<unknown>(rpc, m.signer, 'get_issuer', { provider: GOOGLE_PROVIDER })) : null;
  const globalScope = config ? await tryView<unknown>(rpc, m.signer, 'get_scope', { scope_id: GLOBAL_SCOPE }) : null;
  const sharedClientScopes: Record<string, string | null> = {};
  if (config) {
    for (const aud of m.sharedGoogleClientIds.filter((id) => !/UNSET/u.test(id))) {
      const scope = await tryView<unknown>(rpc, m.signer, 'scope_for_client', { provider: GOOGLE_PROVIDER, aud });
      sharedClientScopes[aud] = typeof scope === 'string' ? scope : null;
    }
  }
  // The console sink (D238): where each console audience is registered, those scopes' views, and the keys of
  // "global"'s NEAR owners (remove_client from "global" must come from one of them).
  const consoleAudienceScopes: Record<string, string | null> = {};
  const consoleSinkScopes: Record<string, unknown> = {};
  const globalOwnerKeys: Record<string, boolean> = {};
  if (config) {
    for (const [provider, aud] of m.consoleAudiences) {
      const scope = await tryView<unknown>(rpc, m.signer, 'scope_for_client', { provider, aud });
      consoleAudienceScopes[clientKey([provider, aud])] = typeof scope === 'string' ? scope : null;
      if (typeof scope === 'string' && scope !== GLOBAL_SCOPE && !(scope in consoleSinkScopes)) consoleSinkScopes[scope] = await tryView<unknown>(rpc, m.signer, 'get_scope', { scope_id: scope });
    }
    for (const owner of ((globalScope as { owners?: unknown[] } | null)?.owners ?? [])) {
      const account = (owner as { Near?: { account_id?: unknown } } | null)?.Near?.account_id;
      if (typeof account === 'string' && account !== m.owner) globalOwnerKeys[account] = !!findLegacyCredential(account, m.network, c.home);
    }
  }
  const watchdogAccounts: Record<string, boolean> = {};
  for (const w of (m.watchdogs ?? [])) watchdogAccounts[w] = !!(await rpc.account(w));
  let councilDao: DeployObserved['councilDao'] = null;
  const councilKeys: Record<string, boolean> = {};
  if (m.council) {
    const dao = await rpc.account(m.council.dao);
    // Its policy, not only its code: who votes and how many votes each proposal kind needs (D81).
    const policy = dao ? await tryView<SputnikPolicy>(rpc, m.council.dao, 'get_policy') : null;
    councilDao = { exists: !!dao, codeHash: dao?.code_hash ?? '', policy };
    for (const a of m.council.members) {
      councilKeys[a] = m.network === 'testnet' && (councilKeysOnDisk(m) ? !!readCouncilKey(m.name, a, c.secretsRoot) : !!findLegacyCredential(a, m.network, c.home));
    }
  }
  const updater = readKeysUpdater(m.name, c.secretsRoot);
  if (updater && updater.accountId !== m.signer) throw new Error(`.secrets/${m.name}/keys-updater.json is for ${updater.accountId}, not ${m.signer}`);
  const wasm = wasmPath ? readFileSync(wasmPath) : null;
  return {
    creds,
    observed: {
      chainId,
      nowMs: c.now(),
      accounts,
      credentials,
      config,
      governance,
      relayerAccessKeys: keyLists.relayer ?? [],
      signerAccessKeys: keyLists.signer ?? [],
      poolKeysInFile: {
        session: readPoolKeys(m.name, 'session', c.secretsRoot).map((k) => k.getPublicKey().toString()),
        owner: readPoolKeys(m.name, 'owner', c.secretsRoot).map((k) => k.getPublicKey().toString()),
      },
      updaterKeyInFile: updater?.publicKey ?? null,
      googleIssuer,
      globalScope,
      sharedClientScopes,
      consoleAudienceScopes,
      consoleSinkScopes,
      globalOwnerKeys,
      wasmBytes: wasm ? wasm.length : null,
      wasmCodeHash: wasm ? codeHashOf(wasm) : null,
      watchdogAccounts,
      councilDao,
      councilKeys,
    },
  };
}

/**
 * What a step ended as: done, only proposed to the council (the run stops there; re-run after the votes), or waiting for
 * a quarantine longer than one run waits out (the run stops; re-run after it).
 */
type StepOutcome = 'done' | 'proposed' | 'waiting';

interface RunState {
  wasmPath: string | null;
  /** When this run removed a console audience from "global" (its quarantine starts then). */
  removedAt?: number;
}

/** A little past the quarantine's end, for the gap between our clock and the block time. */
const QUARANTINE_MARGIN_MS = 5_000;

async function execute(c: Ctx, step: DeployStep, creds: Partial<Record<Role, LoadedKey>>, state: RunState): Promise<StepOutcome> {
  const { m, rpc, log } = c;
  const role = stepSigner(step);
  const send = async (receiver: string, actions: Parameters<NearRpc['sendTx']>[2]) => {
    if (!role || role === 'owner') throw new Error('No signer for this step');
    const signer = creds[role] ?? loadLegacyCredential(m[role], m.network, c.home);
    const { hash, value } = await rpc.sendTx({ accountId: signer.accountId, keyPair: signer.keyPair }, receiver, actions);
    log(`    tx ${explorerTx(hash)}`);
    return value;
  };
  const owner = async (s: DeployStep, newKey?: string): Promise<StepOutcome> => {
    const call = ownerCallOf(s, newKey);
    if (!call) throw new Error(`${s.kind} is not an owner step`);
    // --member/--approve-with apply to council-routed calls only (in one run the old owner may sign some steps).
    const opts = ownerRoute(m, call.method).kind === 'sputnik' ? c.ownerTx : {};
    const r = await sendOwnerCall(m, call, opts, { rpc, log, home: c.home, secretsRoot: c.secretsRoot, now: c.now });
    return r.kind === 'proposed' ? 'proposed' : 'done';
  };
  const wasm = (): Buffer => {
    const wasmPath = state.wasmPath ?? c.existingWasm();
    if (!wasmPath) throw new Error('No wasm: build it or pass --wasm');
    const code = readFileSync(wasmPath);
    log(`    wasm ${wasmPath} (${code.length} bytes, code_hash ${codeHashOf(code)})`);
    return code;
  };
  const storageCheck = async (code: Buffer) => {
    const account = await rpc.account(m.signer);
    const need = BigInt(code.length) * STORAGE_YOCTO_PER_BYTE;
    if (!account || BigInt(account.amount) < need) {
      throw new Error(`${m.signer} has ${formatNear(BigInt(account?.amount ?? 0))}, needs at least ${formatNear(need)} for ${code.length} bytes of code`);
    }
  };

  switch (step.kind) {
    case 'build':
      state.wasmPath = c.buildWasm(log);
      return 'done';
    case 'deploy': {
      const code = wasm();
      await storageCheck(code);
      await send(m.signer, [actionCreators.deployContract(new Uint8Array(code)), actionCreators.functionCall('new', step.init, GAS_INIT, 0n)]);
      return 'done';
    }
    case 'relayer-keys': {
      const existing = readPoolKeys(m.name, step.pool, c.secretsRoot);
      const fresh: KeyPair[] = Array.from({ length: step.generate }, () => generateKey());
      // Save before adding on chain, so a key that lands on chain is never lost.
      if (fresh.length) writePoolKeys(m.name, step.pool, [...existing, ...fresh], c.secretsRoot);
      const toAdd = [...existing.filter((k) => step.reuse.includes(k.getPublicKey().toString())), ...fresh];
      const access = actionCreators.functionCallAccessKey(m.signer, step.methods, step.allowanceYocto);
      await send(m.relayer, toAdd.map((k) => actionCreators.addKey(k.getPublicKey(), access)));
      for (const k of toAdd) log(`    added ${k.getPublicKey().toString()}`);
      return 'done';
    }
    case 'add-updater-key': {
      let key = readKeysUpdater(m.name, c.secretsRoot)?.keyPair;
      if (!key || !step.reuse) {
        key = generateKey();
        // Saved before the contract adds it, so a key that lands on chain is never lost.
        writeKeysUpdater(m.name, m.signer, key, c.secretsRoot);
      }
      const publicKey = key.getPublicKey().toString();
      const outcome = await owner(step, publicKey);
      log(`    updater key ${publicKey}${outcome === 'done' ? ' added by the contract' : ' (proposed)'}; upload it as the API's KEYS_UPDATER_KEY`);
      return outcome;
    }
    case 'delete-signer-key':
      if (step.via === 'signer') {
        await send(m.signer, [actionCreators.deleteKey(PublicKey.fromString(step.publicKey))]);
        log(`    deleted ${step.publicKey}`);
        return 'done';
      }
      return owner(step);
    case 'execute-upgrade': {
      const code = wasm();
      if (codeHashOf(code) !== step.codeHash) throw new Error(`The wasm's code_hash is ${codeHashOf(code)}, not the proposed ${step.codeHash}`);
      await storageCheck(code);
      // The input is the raw wasm (not JSON): deploy + migrate run in one receipt on the signer.
      await send(m.signer, [actionCreators.functionCall('execute_upgrade', new Uint8Array(code), GAS_EXECUTE_UPGRADE, 0n)]);
      const after = await rpc.account(m.signer);
      if (after?.code_hash !== step.codeHash) throw new Error(`execute_upgrade went through but ${m.signer} runs ${after?.code_hash ?? '(nothing)'}: its migrate failed and the old code stayed. Propose a fixed build.`);
      log(`    ${m.signer} now runs ${step.codeHash}`);
      return 'done';
    }
    case 'propose-upgrade': {
      let codeHash = step.codeHash;
      if (!codeHash) {
        codeHash = codeHashOf(wasm());
        if (codeHash === step.current) {
          log(`    ${m.signer} already runs ${codeHash}: nothing to propose`);
          return 'done';
        }
        const gov = await tryView<GovernanceView>(rpc, m.signer, 'get_governance');
        if (gov?.pending_upgrade?.code_hash === codeHash) {
          log(`    ${codeHash} is already the pending upgrade (executable from ${new Date(gov.pending_upgrade.executable_at_ms).toISOString()}); re-run then with --upgrade --skip-build`);
          return 'done';
        }
      }
      return owner({ ...step, codeHash });
    }
    case 'accept-owner': {
      const outcome = await owner(step);
      if (outcome === 'done') {
        const cfg = await tryView<ContractConfig>(rpc, m.signer, 'get_config');
        if (cfg?.owner !== step.owner) throw new Error(`accept_owner was approved but get_config().owner is ${cfg?.owner ?? '(unreadable)'}`);
        c.updateManifest(m.name, { owner: step.owner, ownerKind: 'sputnik' });
        log(`    ${step.owner} owns ${m.signer}; envs/${m.name}.json now says "owner": "${step.owner}", "ownerKind": "sputnik"`);
      }
      return outcome;
    }
    case 'remove-console-client': {
      if (step.via.kind === 'account') {
        // Another Owner::Near of "global" (the owner when it was registered): its own key from the legacy keychain.
        const key = loadLegacyCredential(step.via.account, m.network, c.home);
        const { hash } = await rpc.sendTx({ accountId: key.accountId, keyPair: key.keyPair }, m.signer, [actionCreators.functionCall('remove_client', removeConsoleClientArgs(step), 100n * TGAS, 0n)]);
        log(`    tx ${explorerTx(hash)}`);
        state.removedAt = c.now();
        return 'done';
      }
      const outcome = await owner(step);
      if (outcome === 'done') state.removedAt = c.now();
      return outcome;
    }
    case 'register-console-sink': {
      if (step.quarantineMs > 0 && state.removedAt !== undefined) {
        const waitMs = state.removedAt + step.quarantineMs + QUARANTINE_MARGIN_MS - c.now();
        if (waitMs > SINK_WAIT_MAX_MS) {
          log(`    the removed console audiences are quarantined until ${new Date(state.removedAt + step.quarantineMs).toISOString()}; re-run deploy-contract ${m.name} after that to register the sink`);
          return 'waiting';
        }
        if (waitMs > 0) {
          log(`    waiting ${Math.ceil(waitMs / 1000)} s for the removed console audiences' quarantine (change_delay_ms) to end`);
          await c.sleep(waitMs);
        }
      }
      const outcome = await owner(step);
      if (outcome === 'done') log('    console sink registered: the console audiences are its only clients');
      return outcome;
    }
    default:
      return owner(step);
  }
}

/** Runs deploy-contract with argv (without node and script path). Returns the exit code. */
export async function deployMain(argv: readonly string[], deps: DeployDeps = defaultDeployDeps()): Promise<number> {
  const { log } = deps;
  const args = parseCli(argv, {
    booleans: ['yes', 'upgrade', 'skip-build', 'transfer-owner', 'creation-plan', 'help'],
    strings: ['relayer-keys', 'relayer-allowance', 'owner-relayer-keys', 'owner-relayer-allowance', 'wasm', 'member', 'approve-with', 'updater-public-key', 'creation-public-key', 'known-owner'],
  });
  if (args.flag('help')) {
    log(DEPLOY_USAGE);
    return 0;
  }
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const existingWasm = deps.existingWasm ?? builtWasm;
  const wasmArg = args.str('wasm');
  if (wasmArg && !existsSync(wasmArg)) throw new CliError(`--wasm ${wasmArg} does not exist`);

  if (args.flag('creation-plan')) {
    if (args.flag('yes')) throw new CliError('--creation-plan only prints; it never sends (drop --yes)');
    const pk = (flag: string) => {
      const v = args.str(flag);
      if (v !== undefined && !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/u.test(v)) throw new CliError(`--${flag} must be an ed25519:… public key`);
      return v ?? null;
    };
    const code = wasmArg ? readFileSync(wasmArg) : null;
    const { problems, lines } = creationPlan(m, { wasm: code ? { codeHash: codeHashOf(code), bytes: code.length } : null, updaterPublicKey: pk('updater-public-key'), creationPublicKey: pk('creation-public-key') });
    if (problems.length) {
      log(`Cannot print the creation batch until these are fixed:\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
      return 1;
    }
    for (const l of lines) log(l);
    return 0;
  }

  const ownerTx: OwnerTxOptions = { member: args.str('member'), approveWith: args.str('approve-with') };
  const c: Ctx = {
    m,
    rpc: deps.rpc(m.rpc),
    log,
    home: deps.home,
    secretsRoot: deps.secretsRoot,
    buildWasm: deps.buildWasm ?? cargoBuildWasm,
    existingWasm,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    ownerTx,
    updateManifest: deps.updateManifest ?? writeManifestFields,
  };
  const allowance = (flag: string, fallback: string): bigint => {
    let yocto: bigint;
    try {
      yocto = nearToYocto(args.str(flag) ?? fallback);
    } catch {
      throw new CliError(`--${flag} must be a NEAR amount such as 0.5`);
    }
    if (yocto <= 0n) throw new CliError(`--${flag} must be more than 0`);
    return yocto;
  };
  const options: DeployOptions = {
    pools: {
      session: { count: args.int('relayer-keys', 3, { min: 1, max: 20 }), allowanceYocto: allowance('relayer-allowance', '2') },
      owner: { count: args.int('owner-relayer-keys', 1, { min: 1, max: 5 }), allowanceYocto: allowance('owner-relayer-allowance', DEFAULT_OWNER_ALLOWANCE_NEAR) },
    },
    upgrade: args.flag('upgrade'),
    skipBuild: args.flag('skip-build') || !!wasmArg,
    transferOwner: args.flag('transfer-owner'),
    ownerTx,
    sputnikCodeHash: deps.sputnikCodeHash ?? readPin().code_hash,
    sputnikPolicy: readPolicyTemplate(),
    knownOwners: (args.str('known-owner') ?? '').split(',').map((a) => a.trim()).filter(Boolean),
  };
  if (options.skipBuild && !wasmArg && !existingWasm()) throw new CliError('--skip-build but no built wasm found');

  log(`Environment ${m.name} (${m.network}, RPC ${m.rpc})`);
  log(`  signer ${m.signer} · relayer ${m.relayer} · owner ${m.owner} (${m.ownerKind === 'sputnik' ? 'council DAO' : 'account'}) · mpc ${m.mpc} (CKD domain ${m.ckdDomainId})\n`);
  const { observed, creds } = await observe(c, wasmArg ?? existingWasm());
  const plan = buildDeployPlan(m, observed, options);

  for (const role of ROLES) {
    const a = observed.accounts[role];
    const cr = observed.credentials[role];
    const key = role === 'owner' && m.ownerKind === 'sputnik' ? 'council DAO (members sign)' : `local key ${cr.found ? `${cr.publicKey}${cr.fullAccessOnChain ? ' (full access)' : ' (NOT a full-access key on chain)'}` : 'not found'}`;
    log(`  ${role.padEnd(7)} ${m[role]}: ${a.exists ? formatNear(a.balanceYocto) : 'MISSING'}; ${key}`);
  }
  if (observed.config) log(`  contract ${observed.governance ? `v${observed.governance.state_version} (governance)` : 'v1 (pre-governance)'}, code ${observed.accounts.signer.codeHash}`);
  if (plan.done.length) log(`\nAlready done:\n${plan.done.map((d) => `  ✓ ${d}`).join('\n')}`);
  if (plan.warnings.length) log(`\nWarnings:\n${plan.warnings.map((w) => `  ! ${w}`).join('\n')}`);
  log(plan.steps.length ? `\nPlan:\n${plan.steps.map((s, i) => `  ${i + 1}. ${describeStep(m, s, ownerTx)}`).join('\n')}` : '\nNothing to do.');
  if (plan.blockers.length) {
    log(`\nCannot deploy until these are fixed:\n${plan.blockers.map((b) => `  ✗ ${b}`).join('\n')}`);
    return 1;
  }
  if (!plan.steps.length) return 0;
  if (!args.flag('yes')) {
    log(`\n${DRY_RUN_LINE}`);
    return 0;
  }

  const state: RunState = { wasmPath: wasmArg ?? null };
  for (const [i, step] of plan.steps.entries()) {
    log(`\n[${i + 1}/${plan.steps.length}] ${describeStep(m, step, ownerTx)}`);
    const outcome = await execute(c, step, creds, state);
    if (outcome === 'proposed') {
      log(`\nStopped: step ${i + 1} waits for council votes. Re-run deploy-contract ${m.name} once it is approved; the plan picks up from there.`);
      return 0;
    }
    if (outcome === 'waiting') {
      log(`\nStopped: step ${i + 1} waits for the quarantine above. Re-run deploy-contract ${m.name} after it; the plan picks up from there.`);
      return 0;
    }
  }
  log(`\nDone. Secrets (if any were generated) are in .secrets/${m.name}/ (0600). Next:
  pnpm --filter @hana-id/scripts run post-google-keys ${m.name}     # Google signing keys → contract (proposed, then confirmed or executed)
  pnpm --filter @hana-id/scripts run fetch-ckd-key ${m.name}        # pin the MPC CKD key in envs/${m.name}.json
  then generate the API config and upload RELAYER_KEYS (${poolFileName('session')}), OWNER_RELAYER_KEYS (${poolFileName('owner')})
  and KEYS_UPDATER_KEY (keys-updater.json) (see README.md).`);
  return 0;
}
