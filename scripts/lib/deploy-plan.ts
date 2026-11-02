// Deploy plan: a pure function from (manifest, what is on chain, options) to the steps deploy-contract.ts will run.
// Re-running after a partial deploy plans only what is still missing.
//
// Governance (docs/governance-spec.md): the contract is upgraded in place (same signer account, so no address
// changes), only through propose_upgrade (owner) → wait governance_delay_ms → execute_upgrade (anyone). A v1
// (pre-governance) contract is refused: its one-off migration (migrate_v1) left the contract with v3 (D154). Owner
// steps go through owner-tx (the owner account, or a council DAO proposal). The signer's keys are checked against
// get_governance().updater_keys: outside allowSignerFullAccessKey envs a full-access key on the signer, and anywhere
// a function-call key the contract didn't install, stops the plan. Before any owner transfer to the council, and on
// every run once it owns the contract, the DAO's code must be the pinned Sputnik wasm and its get_policy the council
// policy (D81: exactly the manifest members, 2 of 3 for every proposal kind). Outside dev envs the two governance
// delays must meet their floors (@hana-id/env governanceDelayProblems).
import { governanceDelayProblems, isDevEnv, type Manifest } from '@hana-id/env';
import {
  type ContractConfig,
  GLOBAL_SCOPE,
  GOOGLE_ISS_VALUES,
  GOOGLE_PROVIDER,
  type GovernanceView,
  type IssuerView,
  OWNER_RELAYER_METHODS,
  type Owner,
  SESSION_RELAYER_METHODS,
  type SharedClientsView,
  samePairs,
  sameSet,
  sharedClientsOf,
  UPDATER_ALLOWANCE_YOCTO,
  UPDATER_METHODS,
  V1_UPDATER_METHODS,
} from './contract.ts';
import { KEY_POOLS, type KeyPool, poolFileName } from './keys.ts';
import { type AccessKeyListEntry, describePermission, EMPTY_CODE_HASH, formatNear, STORAGE_YOCTO_PER_BYTE } from './near.ts';
import { checkOwnerTxOptions, describeOwnerCall, type OwnerCall, ownerRoute, type OwnerTxOptions, proposingMember } from './owner-tx.ts';
import { policyProblems, type SputnikPolicy } from './sputnik.ts';

export type Role = 'signer' | 'relayer' | 'owner';
export const ROLES: readonly Role[] = ['signer', 'relayer', 'owner'];

export interface ObservedAccount {
  exists: boolean;
  balanceYocto: bigint;
  codeHash: string;
}

export interface ObservedCredential {
  /** Found in ~/.near-credentials/<network>/. */
  found: boolean;
  publicKey?: string;
  /** The found key is a full-access key on chain. */
  fullAccessOnChain: boolean;
}

export interface DeployObserved {
  chainId: string;
  /** Block time of the observation (ms), for timelocks. */
  nowMs: number;
  accounts: Record<Role, ObservedAccount>;
  credentials: Record<Role, ObservedCredential>;
  /** get_config result, or null if the signer isn't initialised (or has no code). */
  config: ContractConfig | null;
  /** get_governance result: null on a v1 (pre-governance) contract or an uninitialised one. */
  governance: GovernanceView | null;
  /** Every access key on the relayer account (both pools live here, plus its full-access key). */
  relayerAccessKeys: AccessKeyListEntry[];
  /** Every access key on the signer account (the updater keys live here). */
  signerAccessKeys: AccessKeyListEntry[];
  /** Public keys in .secrets/<env>/relayer-keys.json (session) and owner-relayer-keys.json (owner). */
  poolKeysInFile: Record<KeyPool, string[]>;
  /** Public key in .secrets/<env>/keys-updater.json. */
  updaterKeyInFile: string | null;
  googleIssuer: IssuerView | null;
  /** get_scope("global") result (null if absent). */
  globalScope: unknown;
  /** scope_for_client("google", id) for each manifest shared client ID: a scope id, or null if unregistered. */
  sharedClientScopes: Record<string, string | null>;
  /**
   * scope_for_client(provider, aud) for each manifest console audience, keyed `provider/aud` (clientKey): a scope id,
   * or null if unregistered. Absent (or an audience missing): not read, e.g. no contract yet.
   */
  consoleAudienceScopes?: Record<string, string | null>;
  /** get_scope of each scope other than "global" a console audience is a client of (the sink check). */
  consoleSinkScopes?: Record<string, unknown>;
  /** The Owner::Near accounts of "global" whose key is in ~/.near-credentials (remove_client when the owner moved). */
  globalOwnerKeys?: Record<string, boolean>;
  /** Size of an already-built wasm, if known (for the storage estimate). */
  wasmBytes: number | null;
  /** NEAR code hash (base58 sha256) of that wasm. */
  wasmCodeHash: string | null;
  /** Which manifest watchdog accounts exist on chain. */
  watchdogAccounts: Record<string, boolean>;
  /** The council DAO account (null without a council); `policy` is its get_policy (null if it fails or no DAO). */
  councilDao: { exists: boolean; codeHash: string; policy: SputnikPolicy | null } | null;
  /** Council members whose signing key the scripts can read (dev: .secrets/<env>/council/; else ~/.near-credentials). */
  councilKeys: Record<string, boolean>;
}

export interface PoolOptions {
  /** Keys to keep in the pool. */
  count: number;
  /** Gas allowance per key. */
  allowanceYocto: bigint;
}

export interface DeployOptions {
  /** session = RELAYER_KEYS (logins), owner = OWNER_RELAYER_KEYS (/v1/owner-actions). */
  pools: Record<KeyPool, PoolOptions>;
  /**
   * Change the code of an initialised contract: propose_upgrade(hash), and execute_upgrade once due (a v1 contract
   * is refused, D154).
   */
  upgrade: boolean;
  /** Skip the wasm build and use the existing file (its hash is then known when planning). */
  skipBuild: boolean;
  /** Owner transfer to the council DAO: propose_owner(DAO), then (once due) the DAO's accept_owner. */
  transferOwner: boolean;
  /** Council options for owner steps (--member, --approve-with). */
  ownerTx: OwnerTxOptions;
  /** The pinned Sputnik DAO code hash (contracts/sputnik/pin.json). */
  sputnikCodeHash: string;
  /** The council policy template (default: contracts/sputnik/policy.json, the policy the sandbox DAO test checks). */
  sputnikPolicy?: SputnikPolicy;
}

export interface NewArgs {
  owner: string;
  mpc: string;
  ckd_domain_id: number;
  change_delay_ms: number;
  issuer_key_delay_ms: number;
  governance_delay_ms: number;
  watchdogs: string[];
  updater_keys: string[];
}

export type DeployStep =
  | { kind: 'build' }
  | { kind: 'deploy'; init: NewArgs }
  | { kind: 'relayer-keys'; pool: KeyPool; reuse: string[]; generate: number; methods: string[]; allowanceYocto: bigint }
  /** add_updater_key: the key in keys-updater.json (`reuse`), or a new one generated into it. */
  | { kind: 'add-updater-key'; reuse: string | null }
  /** Deletes a signer key the contract didn't install (the v1 updater key): with the signer's full-access key, or the owner's delete_updater_key. */
  | { kind: 'delete-signer-key'; publicKey: string; why: string; via: 'signer' | 'owner' }
  | { kind: 'add-watchdog'; accountId: string }
  | { kind: 'set-delay'; which: 'issuer_key' | 'governance'; ms: number }
  | { kind: 'set-issuer'; provider: string; iss_values: string[] }
  | { kind: 'set-sponsors'; sponsors: string[] }
  | { kind: 'set-console-audiences'; audiences: [string, string][] }
  | { kind: 'set-shared-clients'; clients: [string, string][]; added: [string, string][]; removed: [string, string][] }
  | { kind: 'register-global'; owners: Owner[]; clients: [string, string][]; allowShared: boolean }
  /** The console sink (D238): a console audience out of "global", by the owner or another Owner::Near of it. */
  | { kind: 'remove-console-client'; provider: string; aud: string; via: { kind: 'owner' } | { kind: 'account'; account: string } }
  /** The sink scope itself; `quarantineMs` > 0 when this run removes its clients from "global" first. */
  | { kind: 'register-console-sink'; owners: Owner[]; clients: [string, string][]; quarantineMs: number }
  /** propose_upgrade of the wasm's hash (null: the hash of the wasm this run builds). */
  | { kind: 'propose-upgrade'; codeHash: string | null; replaces: string | null; current: string }
  | { kind: 'execute-upgrade'; codeHash: string }
  | { kind: 'propose-owner'; owner: string }
  | { kind: 'accept-owner'; owner: string };

export interface DeployPlan {
  /** Problems that stop the deploy (nothing runs while any exist). */
  blockers: string[];
  warnings: string[];
  steps: DeployStep[];
  /** Things already in place. */
  done: string[];
}

/** Which full-access key (or owner route) each step signs with. execute-upgrade is open to anyone: the relayer pays. */
export function stepSigner(step: DeployStep): Role | null {
  switch (step.kind) {
    case 'build':
      return null;
    case 'deploy':
      return 'signer';
    case 'delete-signer-key':
      return step.via === 'signer' ? 'signer' : 'owner';
    case 'relayer-keys':
    case 'execute-upgrade':
      return 'relayer';
    case 'remove-console-client':
      // Another Owner::Near of "global" signs with its own key (deploy-run); its key was checked when planning.
      return step.via.kind === 'owner' ? 'owner' : null;
    default:
      return 'owner';
  }
}

/** The owner call a step makes (null for non-owner steps). A generated updater key shows as `<new key>`. */
export function ownerCallOf(s: DeployStep, newKey = '<new key in keys-updater.json>'): OwnerCall | null {
  switch (s.kind) {
    case 'add-updater-key':
      return { method: 'add_updater_key', args: { public_key: s.reuse ?? newKey } };
    case 'delete-signer-key':
      return s.via === 'owner' ? { method: 'delete_updater_key', args: { public_key: s.publicKey } } : null;
    case 'add-watchdog':
      return { method: 'add_watchdog', args: { account_id: s.accountId } };
    case 'set-delay':
      return s.which === 'issuer_key' ? { method: 'set_issuer_key_delay_ms', args: { issuer_key_delay_ms: s.ms } } : { method: 'set_governance_delay_ms', args: { governance_delay_ms: s.ms } };
    case 'set-issuer':
      return { method: 'set_issuer', args: { provider: s.provider, iss_values: s.iss_values } };
    case 'set-sponsors':
      return { method: 'set_sponsors', args: { sponsors: s.sponsors } };
    case 'set-console-audiences':
      return { method: 'set_console_audiences', args: { audiences: s.audiences } };
    case 'set-shared-clients':
      return { method: 'set_shared_clients', args: { clients: s.clients } };
    case 'register-global':
      return { method: 'admin_register_scope', args: registerGlobalArgs(s) };
    case 'register-console-sink':
      return { method: 'admin_register_scope', args: registerSinkArgs(s) };
    case 'remove-console-client':
      return s.via.kind === 'owner' ? { method: 'remove_client', args: removeConsoleClientArgs(s) } : null;
    case 'propose-upgrade':
      return { method: 'propose_upgrade', args: { code_hash: s.codeHash ?? '<hash of the built wasm>' } };
    case 'propose-owner':
      return { method: 'propose_owner', args: { owner: s.owner } };
    case 'accept-owner':
      return { method: 'accept_owner', args: {} };
    default:
      return null;
  }
}

const isPlaceholder = (s: string) => /UNSET/u.test(s);

export const POOL_METHODS: Record<KeyPool, readonly string[]> = { session: SESSION_RELAYER_METHODS, owner: OWNER_RELAYER_METHODS };

export type KeyStatus = { kind: 'absent' } | { kind: 'ok' } | { kind: 'mismatch'; reason: string };

/**
 * Compares the access key `publicKey` on chain with the intended function-call permission (receiver + exact method
 * set + bounded allowance). A full-access key, another receiver, other methods, an empty method list (= any method),
 * an unlimited allowance (null) or an allowance above `maxAllowanceYocto` is a mismatch. An allowance below the
 * maximum is fine: NEAR lowers it as the key spends gas.
 */
export function checkFunctionKey(
  keys: readonly AccessKeyListEntry[],
  publicKey: string,
  receiverId: string,
  methods: readonly string[],
  maxAllowanceYocto: bigint,
): KeyStatus {
  const entry = keys.find((k) => k.public_key === publicKey);
  if (!entry) return { kind: 'absent' };
  const p = entry.access_key.permission;
  if (p === 'FullAccess') return { kind: 'mismatch', reason: 'is a full-access key' };
  const fc = p.FunctionCall;
  if (fc.receiver_id !== receiverId) return { kind: 'mismatch', reason: `is ${describePermission(p)}, not for ${receiverId}` };
  if (fc.method_names.length === 0) return { kind: 'mismatch', reason: `may call ANY method on ${receiverId} (empty method list)` };
  if (!sameSet(fc.method_names, methods)) return { kind: 'mismatch', reason: `has methods ${fc.method_names.join(', ')}; expected ${methods.join(', ')}` };
  if (fc.allowance === null || fc.allowance === undefined) return { kind: 'mismatch', reason: `has an unlimited allowance; expected at most ${formatNear(maxAllowanceYocto)}` };
  let allowance: bigint;
  try {
    allowance = BigInt(fc.allowance);
  } catch {
    return { kind: 'mismatch', reason: `has an unreadable allowance (${fc.allowance})` };
  }
  if (allowance > maxAllowanceYocto) return { kind: 'mismatch', reason: `has an allowance of ${formatNear(allowance)}; expected at most ${formatNear(maxAllowanceYocto)}` };
  return { kind: 'ok' };
}

/** Function-call keys for `receiverId` on an account that are not in `known`. */
function strayFunctionKeys(keys: readonly AccessKeyListEntry[], receiverId: string, known: ReadonlySet<string>): AccessKeyListEntry[] {
  return keys.filter((k) => !known.has(k.public_key) && typeof k.access_key.permission === 'object' && k.access_key.permission.FunctionCall.receiver_id === receiverId);
}

const strayMethods = (k: AccessKeyListEntry): string[] => (typeof k.access_key.permission === 'object' ? k.access_key.permission.FunctionCall.method_names : []);

const pairText = (pairs: readonly (readonly [string, string])[]) => pairs.map(([p, a]) => `${p}/${a}`).join(', ');

const deleteKeyCmd = (account: string, key: string) => `near account delete-keys ${account} public-keys ${key} network-config testnet sign-with-legacy-keychain send`;

const iso = (ms: number) => new Date(ms).toISOString();

/** The v1 updater key deploy-contract added by hand: receiver the signer, exactly set_issuer_key + remove_issuer_key. */
function isV1UpdaterKey(k: AccessKeyListEntry, signer: string): boolean {
  const p = k.access_key.permission;
  return typeof p === 'object' && p.FunctionCall.receiver_id === signer && sameSet(p.FunctionCall.method_names, V1_UPDATER_METHODS);
}

/**
 * A timelock counts as passed only this long after its time by the local clock: the contract checks block time, which
 * can trail the wall clock by a few seconds, and an early execute_upgrade or accept_owner fails (for accept_owner, a
 * Failed DAO proposal).
 */
export const CLOCK_MARGIN_MS = 10_000;

/** The signer may keep a full-access key: the manifest says so and it is a dev env on testnet (D86). */
export function signerFullAccessAllowed(m: Pick<Manifest, 'name' | 'network' | 'allowSignerFullAccessKey'>): boolean {
  return !!m.allowSignerFullAccessKey && m.network === 'testnet' && isDevEnv(m.name);
}

export function buildDeployPlan(m: Manifest, o: DeployObserved, opts: DeployOptions): DeployPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const done: string[] = [];
  const steps: DeployStep[] = [];

  if (m.network !== 'testnet') blockers.push(`Manifest network is ${m.network}; only testnet is allowed.`);
  if (o.chainId !== 'testnet') blockers.push(`RPC ${m.rpc} reports chain "${o.chainId}", not testnet.`);
  if (new Set([m.signer, m.relayer, m.owner]).size !== 3) blockers.push('signer, relayer and owner must be three different accounts.');
  const allowFull = signerFullAccessAllowed(m);
  if (m.allowSignerFullAccessKey && !allowFull) {
    blockers.push(`envs/${m.name}.json sets allowSignerFullAccessKey, which only a dev env (local*, sandbox*) on testnet may: staging and mainnet signers never have a full-access key (D86).`);
  }

  for (const role of ROLES) {
    const account = m[role];
    if (role === 'owner' && m.ownerKind === 'sputnik') continue; // the DAO: checked with the council below
    if (!o.accounts[role].exists) {
      blockers.push(
        `Account ${account} (${role}) does not exist. Create and fund it first, e.g.\n` +
          `    near account create-account sponsor-by-faucet-service ${account} autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`,
      );
    }
  }
  if (m.ownerKind === 'sputnik' || opts.transferOwner) {
    if (!m.council || !o.councilDao?.exists) blockers.push(`The council DAO ${m.council?.dao ?? '(none in the manifest)'} does not exist: run council-setup ${m.name} first.`);
    else if (o.councilDao.codeHash !== opts.sputnikCodeHash) blockers.push(`${m.council.dao} runs code ${o.councilDao.codeHash}, not the pinned Sputnik DAO ${opts.sputnikCodeHash} (contracts/sputnik/pin.json).`);
    else if (!o.councilDao.policy) blockers.push(`${m.council.dao} runs the Sputnik DAO code but get_policy fails (not initialised?): its council can't be checked against D81.`);
    else {
      // The code hash says nothing about who votes: a factory DAO may be 1 of 3, have an Everyone role or other
      // members. The owner must be exactly the council of the manifest, 2 of 3 for every proposal kind (D81).
      const p = policyProblems(o.councilDao.policy, m.council.members, opts.sputnikPolicy);
      for (const b of p.blockers) blockers.push(`${m.council.dao}: ${b} (D81: exactly ${m.council.members.join(', ')}, 2 of 3 for every proposal kind; contracts/sputnik/policy.json).`);
      for (const w of p.warnings) warnings.push(`${m.council.dao}: ${w}.`);
    }
  }

  // --- contract code + init / migration / upgrade ---
  const signerAcct = o.accounts.signer;
  const hasCode = signerAcct.exists && signerAcct.codeHash !== EMPTY_CODE_HASH;
  const initialised = o.config !== null;
  const v1 = initialised && o.governance === null;
  const delays = m.issuerKeyDelayMs !== undefined && m.governanceDelayMs !== undefined ? { issuer_key_delay_ms: m.issuerKeyDelayMs, governance_delay_ms: m.governanceDelayMs } : null;
  // The delays the env runs with once the plan ran: the manifest's (set by new / set-delay), else the
  // contract's own (the plan sets none then).
  const onChainDelay = (field: 'issuer_key_delay_ms' | 'governance_delay_ms'): number | undefined => {
    const v = o.config?.[field];
    return typeof v === 'number' ? v : undefined;
  };
  const delayCheck = governanceDelayProblems(m, {
    issuerKeyDelayMs: m.issuerKeyDelayMs ?? onChainDelay('issuer_key_delay_ms'),
    governanceDelayMs: m.governanceDelayMs ?? onChainDelay('governance_delay_ms'),
  });
  blockers.push(...delayCheck.blockers);
  warnings.push(...delayCheck.warnings);
  const signerFullKeys = o.signerAccessKeys.filter((k) => k.access_key.permission === 'FullAccess');
  /** Governance as it will be once the code steps of this plan ran (null: unknown, v1 not migrated). */
  let gov: GovernanceView | null = o.governance;
  const emptyGov = (watchdogs: string[]): GovernanceView => ({
    state_version: 2,
    watchdogs: watchdogs.map((account_id) => ({ account_id, confirm_from_ms: 0 })),
    keys_slow_until_ms: 0,
    updater_keys: [],
    pending_upgrade: null,
    pending_owner: null,
    pending_withdrawal: null,
  });

  if (!initialised) {
    if (hasCode) {
      blockers.push(`${m.signer} already has contract code but get_config fails (another contract or old hana-signer state). Use a fresh signer account.`);
    }
    if (!allowFull) {
      blockers.push(
        `${m.name} may not keep a full-access key on ${m.signer} (allowSignerFullAccessKey is off, D86), and a plain deploy needs one. ` +
          `Create the signer with the one-batch creation transaction instead: deploy-contract ${m.name} --creation-plan prints it (DeployContract + new + DeleteKey).`,
      );
    }
    if (!delays) blockers.push(`envs/${m.name}.json needs issuerKeyDelayMs and governanceDelayMs for new() (D80).`);
    if (!opts.skipBuild) steps.push({ kind: 'build' });
    steps.push({
      kind: 'deploy',
      init: {
        owner: m.owner,
        mpc: m.mpc,
        ckd_domain_id: m.ckdDomainId,
        change_delay_ms: m.changeDelayMs,
        issuer_key_delay_ms: delays?.issuer_key_delay_ms ?? 0,
        governance_delay_ms: delays?.governance_delay_ms ?? 0,
        watchdogs: [...(m.watchdogs ?? [])],
        updater_keys: [],
      },
    });
    gov = emptyGov((m.watchdogs ?? []));
  } else {
    const c = o.config as ContractConfig;
    if (c.owner !== undefined && c.owner !== m.owner) {
      if (m.council && c.owner === m.council.dao && m.ownerKind !== 'sputnik') {
        blockers.push(`The council DAO ${m.council.dao} owns ${m.signer} now: set "owner": "${m.council.dao}" and "ownerKind": "sputnik" in envs/${m.name}.json.`);
      } else blockers.push(`Contract owner is ${c.owner}, manifest says ${m.owner}.`);
    }
    if (c.mpc !== undefined && c.mpc !== m.mpc) warnings.push(`Contract mpc is ${c.mpc}, manifest says ${m.mpc}.`);
    if (c.ckd_domain_id !== undefined && c.ckd_domain_id !== m.ckdDomainId) warnings.push(`Contract ckd_domain_id is ${c.ckd_domain_id}, manifest says ${m.ckdDomainId}.`);
    try {
      if (sharedClientsOf(c) === null) {
        blockers.push(
          `${m.signer} runs a hana-signer without shared clients (get_config has no shared_clients; it predates batch A.2). ` +
            `No code migrates it: deploy to a fresh signer account (this changes every address in ${m.name}).`,
        );
      }
    } catch (err) {
      blockers.push((err as Error).message);
    }
    if (c.change_delay_ms !== undefined && c.change_delay_ms !== m.changeDelayMs) warnings.push(`Contract change_delay_ms is ${c.change_delay_ms}, manifest says ${m.changeDelayMs} (not changed by this script; use set_change_delay_ms).`);

    if (v1) {
      blockers.push(
        `${m.signer} runs the v1 (pre-governance) contract, which this code can't migrate: contract v3 has no migrate_v1 (D154). ` +
          `Upgrade it with the v2 code first (contracts/hana-signer at 26fb70a, deploy-contract --upgrade from that checkout), or deploy to a fresh signer account (this changes every address in ${m.name}).`,
      );
    } else if (gov) {
      const pending = gov.pending_upgrade;
      if (opts.upgrade) {
        const known = opts.skipBuild ? o.wasmCodeHash : null;
        if (!opts.skipBuild) steps.push({ kind: 'build' });
        if (pending && known === pending.code_hash) {
          if (o.nowMs >= pending.executable_at_ms + CLOCK_MARGIN_MS) steps.push({ kind: 'execute-upgrade', codeHash: pending.code_hash });
          else done.push(`Upgrade to ${pending.code_hash} proposed; executable from ${iso(pending.executable_at_ms)}. Re-run then with --upgrade --skip-build (or --wasm) to execute it.`);
        } else if (known && known === signerAcct.codeHash) {
          done.push(`${m.signer} already runs ${known}.`);
        } else {
          if (pending) warnings.push(`propose_upgrade replaces the pending upgrade ${pending.code_hash} (executable from ${iso(pending.executable_at_ms)}).`);
          steps.push({ kind: 'propose-upgrade', codeHash: known, replaces: pending?.code_hash ?? null, current: signerAcct.codeHash });
        }
      } else {
        done.push(`${m.signer} is deployed and initialised (pass --upgrade to change its code through propose_upgrade / execute_upgrade).`);
        if (pending) {
          warnings.push(
            `Upgrade ${pending.code_hash} is pending, executable from ${iso(pending.executable_at_ms)}. ` +
              `Execute it with --upgrade --skip-build (or --wasm <that build>); the owner cancels it with cancel_upgrade.`,
          );
        }
      }
    }
  }
  if (o.wasmBytes !== null && (!initialised || opts.upgrade)) {
    const need = BigInt(o.wasmBytes) * STORAGE_YOCTO_PER_BYTE;
    if (signerAcct.exists && signerAcct.balanceYocto < need + 10n ** 24n) {
      warnings.push(`${m.signer} has ${formatNear(signerAcct.balanceYocto)}; the ${o.wasmBytes}-byte wasm locks ~${formatNear(need)} for storage, plus state. Top it up if the deploy fails.`);
    }
  }

  // --- relayer function-call keys: two pools with their own method lists, counts and allowances ---
  const filePools = new Map<string, KeyPool>();
  for (const pool of KEY_POOLS) {
    for (const k of o.poolKeysInFile[pool]) {
      const other = filePools.get(k);
      if (other && other !== pool) {
        blockers.push(`${k} is in both .secrets/${m.name}/${poolFileName(other)} and ${poolFileName(pool)}; a key belongs to one pool. Remove it from one file.`);
      }
      filePools.set(k, pool);
    }
  }
  for (const pool of KEY_POOLS) {
    const methods = POOL_METHODS[pool];
    const file = `.secrets/${m.name}/${poolFileName(pool)}`;
    const fileKeys = o.poolKeysInFile[pool];
    const status = fileKeys.map((k) => [k, checkFunctionKey(o.relayerAccessKeys, k, m.signer, methods, opts.pools[pool].allowanceYocto)] as const);
    const live = status.filter(([, st]) => st.kind === 'ok').map(([k]) => k);
    const reuse = status.filter(([, st]) => st.kind === 'absent').map(([k]) => k);
    const bad = status.flatMap(([k, st]) => (st.kind === 'mismatch' ? [[k, st.reason] as const] : []));
    // A key already on the relayer with another permission (a previous signer, the batch A single-pool method list,
    // any-method) can't be re-added (AddKeyAlreadyExists) and must not be used as it is: stop and say how to fix it.
    if (bad.length) {
      blockers.push(
        `${file} holds ${bad.length} key(s) that are on ${m.relayer} with the wrong permission for the ${pool} pool ` +
          `(receiver ${m.signer}, methods ${methods.join(', ')}, allowance at most ${formatNear(opts.pools[pool].allowanceYocto)}):\n` +
          bad.map(([k, why]) => `      ${k} ${why}`).join('\n') +
          `\n    Delete them from ${m.relayer} and re-run, which re-adds them with the right permission:\n` +
          bad.map(([k]) => `      ${deleteKeyCmd(m.relayer, k)}`).join('\n') +
          `\n    Delete them even if you instead move ${file} aside (new keys are generated; re-upload the API secret): ` +
          `left on chain, the old keys keep their permission and allowance.`,
      );
    }
    const generate = Math.max(0, opts.pools[pool].count - fileKeys.length);
    if (reuse.length || generate) {
      steps.push({ kind: 'relayer-keys', pool, reuse, generate, methods: [...methods], allowanceYocto: opts.pools[pool].allowanceYocto });
    } else if (!bad.length) {
      done.push(`${live.length} ${pool}-pool relayer key(s) in place.`);
    }
  }
  // A stray key that may call any method, or methods of both pools (e.g. a batch A key left behind after its file
  // was moved aside), keeps the mixed permission the two pools exist to remove: stop on it.
  for (const k of strayFunctionKeys(o.relayerAccessKeys, m.signer, new Set(filePools.keys()))) {
    const what = `${k.public_key} (${describePermission(k.access_key.permission)})`;
    const methods = strayMethods(k);
    const pools = KEY_POOLS.filter((p) => methods.some((x) => POOL_METHODS[p].includes(x)));
    if (methods.length === 0) {
      blockers.push(`${m.relayer} has a key for ${m.signer} that is in neither pool file and may call ANY method: ${what}. Delete it: ${deleteKeyCmd(m.relayer, k.public_key)}`);
    } else if (pools.length > 1) {
      blockers.push(
        `${m.relayer} has a key for ${m.signer} that is in neither pool file and may call methods of both pools (session and owner): ${what}. ` +
          `Delete it: ${deleteKeyCmd(m.relayer, k.public_key)}`,
      );
    } else {
      warnings.push(`${m.relayer} has a function-call key for ${m.signer} in neither pool file (left untouched): ${what}. If it is no longer used, delete it: ${deleteKeyCmd(m.relayer, k.public_key)}`);
    }
  }

  // --- the signer's own keys: full access only where allowed; function-call keys only the contract's updater keys ---
  if (signerFullKeys.length && !allowFull && initialised) {
    blockers.push(
      `${m.signer} has ${signerFullKeys.length} full-access key(s) (${signerFullKeys.map((k) => k.public_key).join(', ')}), and ${m.name} may have none (D86): ` +
        `with it anyone holding it can replace the code at once. Delete it with itself: ${signerFullKeys.map((k) => deleteKeyCmd(m.signer, k.public_key)).join(' ; ')}`,
    );
  }
  if (gov) {
    const tracked = new Set(gov.updater_keys);
    const canDeleteAsSigner = allowFull && signerFullKeys.length > 0;
    for (const k of o.signerAccessKeys) {
      if (k.access_key.permission === 'FullAccess') continue;
      const what = `${k.public_key} (${describePermission(k.access_key.permission)})`;
      if (tracked.has(k.public_key)) {
        const st = checkFunctionKey(o.signerAccessKeys, k.public_key, m.signer, UPDATER_METHODS, UPDATER_ALLOWANCE_YOCTO);
        if (st.kind === 'mismatch') blockers.push(`Updater key ${k.public_key} on ${m.signer} ${st.reason}; the contract installs exactly ${UPDATER_METHODS.join(', ')} with at most 1 NEAR.`);
      } else if (isV1UpdaterKey(k, m.signer)) {
        // The pre-governance updater key (it may call set_issuer_key): replaced at the migration.
        steps.push({ kind: 'delete-signer-key', publicKey: k.public_key, why: 'the v1 keys-updater key (set_issuer_key, remove_issuer_key)', via: canDeleteAsSigner ? 'signer' : 'owner' });
      } else {
        blockers.push(
          `${m.signer} has a function-call key the contract didn't install (not in get_governance().updater_keys): ${what}. ` +
            `Delete it: ${canDeleteAsSigner ? deleteKeyCmd(m.signer, k.public_key) : `owner call delete_updater_key({"public_key":"${k.public_key}"}) (admin ${m.name} owner:call delete_updater_key …)`}`,
        );
      }
    }
    const onChain = new Set(o.signerAccessKeys.map((k) => k.public_key));
    for (const k of gov.updater_keys) if (!onChain.has(k)) warnings.push(`get_governance().updater_keys lists ${k}, which is not a key of ${m.signer} (deleted outside the contract?).`);

    // The API's KEYS_UPDATER_KEY: the key in keys-updater.json, installed by the contract.
    const file = o.updaterKeyInFile;
    const fileEntry = file ? o.signerAccessKeys.find((k) => k.public_key === file) : undefined;
    if (file && tracked.has(file) && fileEntry) {
      if (checkFunctionKey(o.signerAccessKeys, file, m.signer, UPDATER_METHODS, UPDATER_ALLOWANCE_YOCTO).kind === 'ok') done.push('Keys-updater key in place (installed by the contract).');
    } else if (file && fileEntry && !(isV1UpdaterKey(fileEntry, m.signer))) {
      // On chain, untracked, not the v1 key: reported as a blocker above.
    } else if (gov.updater_keys.length >= 2) {
      blockers.push(`${m.signer} already has 2 updater keys (the most); the one in keys-updater.json isn't one of them. Delete one with the owner's delete_updater_key first.`);
    } else {
      const reuse = file && !fileEntry ? file : null;
      if (reuse) warnings.push(`Re-adding the updater key from .secrets/${m.name}/keys-updater.json. If it may be compromised (e.g. a watchdog deleted it), move the file aside first so a new key is generated.`);
      steps.push({ kind: 'add-updater-key', reuse });
    }
    // Delete the old key only after its replacement is in.
    const deletes = steps.filter((s) => s.kind === 'delete-signer-key');
    for (const d of deletes) steps.splice(steps.indexOf(d), 1);
    steps.push(...deletes);

    // --- watchdogs and delays ---
    const onChainWatchdogs = gov.watchdogs.map((w) => w.account_id);
    for (const w of (m.watchdogs ?? [])) {
      if (onChainWatchdogs.includes(w)) continue;
      if (!o.watchdogAccounts[w]) warnings.push(`Watchdog ${w} does not exist on chain yet: add_watchdog skipped until it does (docs/governance-spec.md "Watchdog service").`);
      else steps.push({ kind: 'add-watchdog', accountId: w });
    }
    for (const w of onChainWatchdogs) if (!(m.watchdogs ?? []).includes(w)) warnings.push(`${w} is a watchdog on chain but not in envs/${m.name}.json (removing one is a deliberate owner action: remove_watchdog slows key changes to governance_delay_ms).`);
    const confirmLater = gov.watchdogs.filter((w) => w.confirm_from_ms > o.nowMs);
    for (const w of confirmLater) done.push(`Watchdog ${w.account_id} may confirm from ${iso(w.confirm_from_ms)}.`);
    if (o.config && delays && o.governance) {
      for (const [which, field, pendingField, want] of [
        ['issuer_key', 'issuer_key_delay_ms', 'pending_issuer_key_delay', delays.issuer_key_delay_ms],
        ['governance', 'governance_delay_ms', 'pending_governance_delay', delays.governance_delay_ms],
      ] as const) {
        const now = o.config[field];
        const pending = o.config[pendingField] as { change_delay_ms?: number; effective_at_ms?: number } | null | undefined;
        if (now === want) continue;
        if (pending?.change_delay_ms === want) done.push(`${field} becomes ${want} at ${iso(pending.effective_at_ms ?? 0)} (a decrease waits).`);
        else steps.push({ kind: 'set-delay', which, ms: want });
      }
    }

    // --- owner transfer to the council (migration step 6) ---
    if (opts.transferOwner) {
      if (!m.council) blockers.push(`--transfer-owner needs a council in envs/${m.name}.json.`);
      else if (m.ownerKind === 'sputnik' || o.config?.owner === m.council.dao) done.push(`The council DAO ${m.council.dao} owns ${m.signer}.`);
      else if (gov.pending_owner?.owner === m.council.dao) {
        if (o.nowMs >= gov.pending_owner.acceptable_at_ms + CLOCK_MARGIN_MS) steps.push({ kind: 'accept-owner', owner: m.council.dao });
        else done.push(`Owner transfer to ${m.council.dao} proposed; the DAO may accept from ${iso(gov.pending_owner.acceptable_at_ms)}. Re-run then.`);
      } else {
        if (gov.pending_owner) warnings.push(`propose_owner replaces the pending owner transfer to ${gov.pending_owner.owner}.`);
        steps.push({ kind: 'propose-owner', owner: m.council.dao });
      }
    } else if (gov.pending_owner) {
      warnings.push(`An owner transfer to ${gov.pending_owner.owner} is pending (acceptable from ${iso(gov.pending_owner.acceptable_at_ms)}).`);
    }
    if (gov.pending_withdrawal) warnings.push(`A withdrawal of ${gov.pending_withdrawal.amount} yocto to ${gov.pending_withdrawal.receiver} is pending (executable from ${iso(gov.pending_withdrawal.executable_at_ms)}).`);
  }

  // --- owner configuration calls ---
  const issValues = [...GOOGLE_ISS_VALUES];
  if (o.googleIssuer && sameSet(o.googleIssuer.iss_values, issValues)) done.push('Google issuer set.');
  else steps.push({ kind: 'set-issuer', provider: GOOGLE_PROVIDER, iss_values: issValues });

  const sponsors = [m.relayer];
  if (o.config?.sponsors && sameSet(o.config.sponsors, sponsors)) done.push('Sponsors set.');
  else steps.push({ kind: 'set-sponsors', sponsors });

  // Console audiences: removals apply at once, additions after change_delay_ms (pending ones count as set).
  const audiences = m.consoleAudiences.map(([p, a]) => [p, a] as [string, string]);
  const pendingAud = Array.isArray(o.config?.pending_console_audiences)
    ? (o.config.pending_console_audiences as { provider: string; aud: string }[]).map((x) => [x.provider, x.aud] as [string, string])
    : [];
  const currentAud = [...(o.config?.console_audiences ?? []), ...pendingAud];
  if (audiences.length && !samePairs(currentAud, audiences)) steps.push({ kind: 'set-console-audiences', audiences });
  else if (audiences.length) done.push(`Console audiences set${pendingAud.length ? ` (pending: ${pairText(pendingAud)})` : ''}.`);

  // Shared login clients: set_shared_clients replaces the list. Removals apply at once, additions after
  // change_delay_ms (pending, shown by get_config).
  if (m.sharedGoogleClientIds.some(isPlaceholder)) {
    warnings.push(`sharedGoogleClientIds is a placeholder: skipping set_shared_clients. Set Hana's shared Google client ID in envs/${m.name}.json and re-run.`);
  } else {
    const desired = m.sharedGoogleClientIds.map((aud) => [GOOGLE_PROVIDER, aud] as [string, string]);
    let current: SharedClientsView = { effective: [], pending: [] };
    try {
      current = (o.config && sharedClientsOf(o.config)) || current;
    } catch {
      // reported as a blocker above
    }
    for (const id of m.sharedGoogleClientIds) {
      const scope = o.sharedClientScopes[id];
      if (scope) blockers.push(`Shared client ${id} is registered as a client of scope "${scope}"; a client is either shared or a scope's own. Remove it from that scope or from sharedGoogleClientIds.`);
    }
    const onChain = [...current.effective, ...current.pending.map((p) => p.client)].filter((c, i, all) => all.findIndex((x) => samePairs([x], [c])) === i);
    const has = (list: readonly [string, string][], c: readonly [string, string]) => list.some(([p, a]) => p === c[0] && a === c[1]);
    if (samePairs(onChain, desired)) {
      if (desired.length) {
        const pending = current.pending.filter((p) => has(desired, p.client));
        const until = pending.map((p) => (p.unlockAtMs ? `${pairText([p.client])} from ${new Date(p.unlockAtMs).toISOString()}` : pairText([p.client]))).join(', ');
        done.push(`Shared clients set: ${pairText(desired)}${pending.length ? ` (pending: ${until})` : ''}.`);
      }
    } else {
      steps.push({ kind: 'set-shared-clients', clients: desired, added: desired.filter((c) => !has(onChain, c)), removed: onChain.filter((c) => !has(desired, c)) });
    }
  }

  // The console sink scope (docs/batch-c-spec.md "Address impact", D93 Q7, D238): Hana's console audiences are clients
  // of a dedicated `sN` scope owned by the manifest's owner (Owner::Near), with no other client, no shared login, no
  // app and no origins, so no scope owner can claim them with propose_change(AddClient), and a console-client token
  // can open no session in a scope with real wallets. They are never clients of "global": a console token whose nonce
  // followed the session layout would open a `global` session there and derive_key that user's `global` key. Fresh
  // env: the sink is registered before "global". Existing env: each console audience in "global" is removed from it
  // (remove_client, immediate), then the sink is registered once the removed clients' quarantine (change_delay_ms)
  // is over: until then only "global" could take them back.
  const sink = consoleSinkPlan(m, o, audiences);
  blockers.push(...sink.blockers);
  warnings.push(...sink.warnings);
  done.push(...sink.done);
  steps.push(...sink.steps);

  if (o.globalScope !== null && o.globalScope !== undefined) {
    done.push(`Scope "${GLOBAL_SCOPE}" registered.`);
  } else if (m.googleClientIds.length === 0 || m.googleClientIds.some(isPlaceholder)) {
    warnings.push(`googleClientIds is empty or a placeholder: skipping the "${GLOBAL_SCOPE}" scope. Set it in envs/${m.name}.json and re-run.`);
  } else {
    // Hana's own app logs in with its own clients only (never the shared one, never a console audience).
    const clients: [string, string][] = m.googleClientIds.map((aud) => [GOOGLE_PROVIDER, aud] as [string, string]);
    if (clients.length > 10) blockers.push(`The "${GLOBAL_SCOPE}" scope would get ${clients.length} clients (googleClientIds); the contract allows 10.`);
    steps.push({ kind: 'register-global', owners: [{ Near: { account_id: m.owner } }], clients, allowShared: false });
  }

  // The owner transfer goes last: everything else is configured by the current owner first.
  const transfer = steps.filter((s) => s.kind === 'propose-owner' || s.kind === 'accept-owner');
  for (const t of transfer) steps.splice(steps.indexOf(t), 1);
  steps.push(...transfer);

  // --- credentials needed by the planned steps ---
  const needed = new Set(steps.map(stepSigner).filter((r): r is Role => r !== null));
  for (const role of needed) {
    if (role === 'owner') continue;
    const cred = o.credentials[role];
    if (!o.accounts[role].exists) continue; // the create-account command above also saves the key
    if (!cred.found) blockers.push(`No key for ${m[role]} (${role}) in ~/.near-credentials/testnet/ (near CLI legacy keychain).`);
    else if (!cred.fullAccessOnChain) blockers.push(`The key for ${m[role]} in ~/.near-credentials/testnet/ (${cred.publicKey}) is not a full-access key on chain.`);
  }
  const ownerCalls = steps.map((s) => ownerCallOf(s)).filter((c): c is OwnerCall => c !== null);
  if (ownerCalls.some((c) => ownerRoute(m, c.method).kind === 'account')) {
    const cred = o.credentials.owner;
    if (o.accounts.owner.exists && !cred.found) blockers.push(`No key for ${m.owner} (owner) in ~/.near-credentials/testnet/ (near CLI legacy keychain).`);
    else if (o.accounts.owner.exists && !cred.fullAccessOnChain) blockers.push(`The key for ${m.owner} in ~/.near-credentials/testnet/ (${cred.publicKey}) is not a full-access key on chain.`);
  }
  const councilCall = ownerCalls.find((c) => ownerRoute(m, c.method).kind === 'sputnik');
  if (!councilCall && (opts.ownerTx.member || opts.ownerTx.approveWith)) warnings.push('--member/--approve-with are ignored: no planned step goes through the council.');
  if (councilCall && m.council) {
    try {
      checkOwnerTxOptions(m, ownerRoute(m, councilCall.method), opts.ownerTx);
      const member = proposingMember(m, opts.ownerTx);
      for (const a of [member, ...(opts.ownerTx.approveWith ? [opts.ownerTx.approveWith] : [])]) {
        if (!o.councilKeys[a]) blockers.push(`No signing key for council member ${a} (dev envs: .secrets/${m.name}/council/${a}.json from council-setup; others: ~/.near-credentials/${m.network}/${a}.json).`);
      }
    } catch (err) {
      blockers.push((err as Error).message);
    }
  }

  return { blockers, warnings, steps, done };
}

/** Human-readable description of a step (no secrets: only public keys and arguments). */
export function describeStep(m: Manifest, s: DeployStep, ownerTx: OwnerTxOptions = {}): string {
  const near = (y: bigint) => formatNear(y);
  const owner = ownerCallOf(s);
  switch (s.kind) {
    case 'build':
      return 'Build contracts/hana-signer wasm (cargo near build non-reproducible-wasm).';
    case 'deploy':
      return `Deploy wasm to ${m.signer} and call new(${JSON.stringify(s.init)}) [signed by ${m.signer}].`;
    case 'relayer-keys':
      return (
        `Add ${s.reuse.length + s.generate} ${s.pool}-pool function-call key(s) to ${m.relayer} (receiver ${m.signer}, allowance ${near(s.allowanceYocto)} each, methods ${s.methods.join(', ')})` +
        `${s.generate ? `; generate ${s.generate} new key(s) into .secrets/${m.name}/${poolFileName(s.pool)}` : ''}` +
        `${s.reuse.length ? `; re-add ${s.reuse.length} key(s) already in .secrets` : ''} [signed by ${m.relayer}].`
      );
    case 'add-updater-key':
      return `Install the keys-updater key (${UPDATER_METHODS.join(', ')}, 1 NEAR)${s.reuse ? ' from .secrets' : `, generated into .secrets/${m.name}/keys-updater.json`}: ${describeOwnerCall(m, owner!, ownerTx)}.`;
    case 'delete-signer-key':
      return s.via === 'signer'
        ? `Delete ${s.publicKey} from ${m.signer}: ${s.why} [signed by ${m.signer}].`
        : `Delete ${s.publicKey} from ${m.signer} (${s.why}): ${describeOwnerCall(m, owner!, ownerTx)}.`;
    case 'execute-upgrade':
      return `execute_upgrade(<wasm ${s.codeHash}>) on ${m.signer}: deploys it and runs its migrate in one receipt [anyone; signed by ${m.relayer}].`;
    case 'propose-upgrade':
      return `${s.codeHash ? '' : 'propose_upgrade of the wasm built above (its hash is computed after the build): '}${describeOwnerCall(m, owner!, ownerTx)}; executable after governance_delay_ms, then re-run with --upgrade --skip-build.`;
    case 'remove-console-client':
      return s.via.kind === 'owner'
        ? `Remove console audience ${pairText([[s.provider, s.aud]])} from "${GLOBAL_SCOPE}" (immediate; quarantined for change_delay_ms): ${describeOwnerCall(m, owner!, ownerTx)}.`
        : `Remove console audience ${pairText([[s.provider, s.aud]])} from "${GLOBAL_SCOPE}" (immediate; quarantined for change_delay_ms): remove_client(${JSON.stringify(removeConsoleClientArgs(s))}) [signed by ${s.via.account}, an Owner::Near of "${GLOBAL_SCOPE}"].`;
    case 'register-console-sink':
      return (
        `Register the console sink scope (a new sN: ${pairText(s.clients)}, owner ${m.owner}, no shared login): ${describeOwnerCall(m, owner!, ownerTx)}` +
        (s.quarantineMs > 0 ? `; after the removed clients' quarantine (${s.quarantineMs} ms), which this run waits out when it is at most ${SINK_WAIT_MAX_MS / 60_000} min.` : '.')
      );
    case 'set-shared-clients': {
      const changes = [s.added.length ? `adds ${pairText(s.added)} after the ${m.changeDelayMs} ms timelock` : '', s.removed.length ? `removes ${pairText(s.removed)} at once` : '']
        .filter(Boolean)
        .join('; ');
      return `${describeOwnerCall(m, owner!, ownerTx)}${changes ? ` (${changes})` : ''}.`;
    }
    default:
      return `${describeOwnerCall(m, owner!, ownerTx)}.`;
  }
}

/** The key of a client pair in `DeployObserved.consoleAudienceScopes`. */
export const clientKey = ([provider, aud]: readonly [string, string]): string => `${provider}/${aud}`;

/** Longest quarantine deploy-contract waits out inside one run before registering the sink; longer means re-run. */
export const SINK_WAIT_MAX_MS = 10 * 60_000;

/**
 * The console sink steps (see buildDeployPlan): which console audiences to remove from "global", which to register in a
 * new sink, and whether every one already sits in a sink. A console audience in any other scope is a blocker: someone
 * claimed it, and only its scope's owners can give it back.
 */
export function consoleSinkPlan(m: Manifest, o: DeployObserved, audiences: readonly [string, string][]): { steps: DeployStep[]; blockers: string[]; warnings: string[]; done: string[] } {
  const steps: DeployStep[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const done: string[] = [];
  if (!audiences.length) return { steps, blockers, warnings, done };
  const own = new Set(m.googleClientIds.map((aud) => clientKey([GOOGLE_PROVIDER, aud])));
  const both = audiences.filter((a) => own.has(clientKey(a)));
  if (both.length) blockers.push(`${pairText(both)} is both a console audience and one of googleClientIds: a console audience must never be a client of "${GLOBAL_SCOPE}".`);
  const scopes = o.consoleAudienceScopes ?? {};
  const inGlobal = audiences.filter((a) => scopes[clientKey(a)] === GLOBAL_SCOPE);
  const unregistered = audiences.filter((a) => (scopes[clientKey(a)] ?? null) === null);
  const sinkOwner: Owner = { Near: { account_id: m.owner } };
  const inSink = new Map<string, [string, string][]>();
  for (const a of audiences) {
    const id = scopes[clientKey(a)];
    if (id === undefined || id === null || id === GLOBAL_SCOPE) continue;
    const view = (o.consoleSinkScopes ?? {})[id] as { owners?: unknown[]; clients?: [string, string][]; allow_shared?: boolean } | null | undefined;
    const audienceSet = new Set(audiences.map(clientKey));
    // A sink: NEAR-account owners only (Hana's owner, or the owner of the time it was registered), console audiences
    // only, no shared login.
    const nearOwners = Array.isArray(view?.owners) ? view.owners.map((x) => (x as { Near?: { account_id?: unknown } } | null)?.Near?.account_id) : [];
    const isSink =
      !!view &&
      nearOwners.length > 0 &&
      nearOwners.every((x) => typeof x === 'string') &&
      Array.isArray(view.clients) &&
      view.clients.every((c) => audienceSet.has(clientKey(c))) &&
      view.allow_shared === false;
    if (!isSink) {
      blockers.push(
        `Console audience ${pairText([a])} is a client of scope "${id}", which is not a Hana console sink (NEAR-account owners only, console audiences only, no shared login). ` +
          `Find out who registered it there: only that scope's owners can remove it (D238).`,
      );
      continue;
    }
    if (!nearOwners.includes(m.owner) && !inSink.has(id)) warnings.push(`Console sink scope "${id}" is owned by ${nearOwners.join(', ')}, not the current owner ${m.owner} (registered before an owner transfer?).`);
    inSink.set(id, [...(inSink.get(id) ?? []), a]);
  }
  for (const [id, list] of inSink) done.push(`Console sink scope "${id}" holds ${pairText(list)}.`);

  if (inGlobal.length) {
    const g = o.globalScope as { owners?: unknown[]; clients?: [string, string][]; allow_shared?: boolean } | null;
    const left = (g?.clients ?? []).filter((c) => !inGlobal.some((a) => clientKey(a) === clientKey(c)));
    if (!left.length && !g?.allow_shared) blockers.push(`Removing the console audiences would leave "${GLOBAL_SCOPE}" without a client: add one of googleClientIds to it first.`);
    // remove_client takes OwnerAuth::Near: the predecessor must be an Owner::Near of "global" (registered with the owner
    // of the time, which may since have moved to the council).
    const nearOwners = (g?.owners ?? []).flatMap((x) => {
      const id = (x as { Near?: { account_id?: unknown } } | null)?.Near?.account_id;
      return typeof id === 'string' ? [id] : [];
    });
    let via: { kind: 'owner' } | { kind: 'account'; account: string } | null = null;
    if (nearOwners.includes(m.owner)) via = { kind: 'owner' };
    else {
      const account = nearOwners.find((a) => o.globalOwnerKeys?.[a]);
      if (account) via = { kind: 'account', account };
    }
    if (!via) {
      blockers.push(
        `"${GLOBAL_SCOPE}" is owned by ${nearOwners.join(', ') || 'no NEAR account'}, not ${m.owner}, and none of their keys is in ~/.near-credentials/${m.network}/: ` +
          `remove_client(${GLOBAL_SCOPE}, Near, …) must come from an Owner::Near of the scope.`,
      );
    } else {
      for (const [provider, aud] of inGlobal) steps.push({ kind: 'remove-console-client', provider, aud, via });
    }
  }
  const toRegister = [...inGlobal, ...unregistered];
  if (toRegister.length) {
    const quarantineMs = inGlobal.length ? Number(o.config?.change_delay_ms ?? m.changeDelayMs) : 0;
    steps.push({ kind: 'register-console-sink', owners: [sinkOwner], clients: toRegister.map(([p, a]) => [p, a] as [string, string]), quarantineMs });
    if (inGlobal.length && quarantineMs > SINK_WAIT_MAX_MS) {
      warnings.push(`The removed console audiences stay quarantined for change_delay_ms (${quarantineMs} ms): this run stops after removing them; re-run deploy-contract ${m.name} once that has passed to register the sink.`);
    }
  }
  return { steps, blockers, warnings, done };
}

/** admin_register_scope arguments for a console sink: a contract-assigned `sN`, no shared login. */
export function registerSinkArgs(s: Extract<DeployStep, { kind: 'register-console-sink' }>) {
  return { owners: s.owners, clients: s.clients, scope_id: null, allow_shared: false };
}

/** remove_client of a console audience from "global", as an Owner::Near of it. */
export function removeConsoleClientArgs(s: Extract<DeployStep, { kind: 'remove-console-client' }>) {
  return { scope_id: GLOBAL_SCOPE, auth: 'Near', provider: s.provider, aud: s.aud };
}

/** admin_register_scope arguments for the reserved global scope. */
export function registerGlobalArgs(s: Extract<DeployStep, { kind: 'register-global' }>) {
  return { owners: s.owners, clients: s.clients, scope_id: GLOBAL_SCOPE, allow_shared: s.allowShared };
}

export interface CreationPlanInput {
  /** NEAR code hash and size of the reproducible build, if given. */
  wasm: { codeHash: string; bytes: number } | null;
  updaterPublicKey: string | null;
  creationPublicKey: string | null;
}

/**
 * The mainnet-style signer creation batch (docs/governance-spec.md "Signer account full-access key", "Migration plan
 * → Mainnet"), printed only: DeployContract + new(owner = council DAO, …, watchdogs, updater_keys) + DeleteKey(creation
 * key), one transaction signed by the creation key. No AddKey: new() adds the updater key itself
 * (docs/contract-interface.md "new"), and an AddKey of the same key would make that promise fail and leave the key
 * untracked. Returns the lines to print, or the problems that stop it.
 */
export function creationPlan(m: Manifest, input: CreationPlanInput): { problems: string[]; lines: string[] } {
  const problems: string[] = [];
  if (!m.council) problems.push(`envs/${m.name}.json needs a council: the owner from the first transaction is the council DAO (D81).`);
  if (m.issuerKeyDelayMs === undefined || m.governanceDelayMs === undefined) problems.push(`envs/${m.name}.json needs issuerKeyDelayMs and governanceDelayMs (D80).`);
  if (!(m.watchdogs ?? []).length) problems.push(`envs/${m.name}.json lists no watchdogs: with none, every key change waits governance_delay_ms.`);
  const delayCheck = governanceDelayProblems(m);
  problems.push(...delayCheck.blockers);
  if (problems.length) return { problems, lines: [] };
  const updater = input.updaterPublicKey ?? '<updater public key: the API KEYS_UPDATER_KEY>';
  const creation = input.creationPublicKey ?? '<creation public key: the signer account\'s only key>';
  const init: NewArgs = {
    owner: m.council!.dao,
    mpc: m.mpc,
    ckd_domain_id: m.ckdDomainId,
    change_delay_ms: m.changeDelayMs,
    issuer_key_delay_ms: m.issuerKeyDelayMs!,
    governance_delay_ms: m.governanceDelayMs!,
    watchdogs: [...(m.watchdogs ?? [])],
    updater_keys: [updater],
  };
  const lines = [
    'MAINNET-STYLE SIGNER CREATION BATCH: printed only. This script never sends it; the user runs it, never an agent',
    '(docs/governance-spec.md "Migration plan" → Mainnet, docs/operations.md "Creating a signer with governance in place").',
    '',
    ...delayCheck.warnings.flatMap((w) => [`WARNING: ${w}`, '']),
    'Before: the council DAO and the watchdog account exist, the watchdog service and its alerts run, the updater key',
    'is generated where the API secret will live, and the build below is published (D86).',
    '',
    '1. Reproducible build (D86): cd contracts/hana-signer && cargo near build reproducible-wasm',
    `   code_hash ${input.wasm ? `${input.wasm.codeHash} (${input.wasm.bytes} bytes)` : '<pass --wasm <reproducible build> to print it>'}; publish the hash, the source commit and the build command first.`,
    `2. One transaction, signer = receiver = ${m.signer}, signed by the creation key ${creation} (the account's only key):`,
    `   a. DeployContract(the wasm above)`,
    `   b. FunctionCall new(${JSON.stringify(init)}), 0 deposit, 100 Tgas`,
    `   c. DeleteKey(${creation})`,
    '   No AddKey action: new() adds the updater key itself with exactly the contract\'s permission',
    `   (${UPDATER_METHODS.join(', ')}, receiver ${m.signer}, 1 NEAR) and tracks it in get_governance().updater_keys.`,
    '   The batch is atomic: there is never a moment with code and a full-access key.',
    `3. After: view_access_key_list(${m.signer}) is exactly ${updater} with that permission; get_config().owner is ${m.council!.dao};`,
    `   deploy-contract ${m.name} shows no blockers. Then the owner config goes through council proposals (set_issuer, sponsors,`,
    '   console audiences, shared clients, global scope); the first Google keys go through the normal path (watchdog confirms).',
  ];
  return { problems, lines };
}
