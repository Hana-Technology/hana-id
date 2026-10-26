// Deploy plan: a pure function from (manifest, what is on chain, options) to the steps deploy-contract.ts will run.
// Re-running after a partial deploy plans only what is still missing.
import type { Manifest } from '@hana-id/env';
import {
  type ContractConfig,
  GLOBAL_SCOPE,
  GOOGLE_ISS_VALUES,
  GOOGLE_PROVIDER,
  type IssuerView,
  KEYS_UPDATER_METHODS,
  OWNER_RELAYER_METHODS,
  type Owner,
  SESSION_RELAYER_METHODS,
  type SharedClientsView,
  samePairs,
  sameSet,
  sharedClientsOf,
} from './contract.ts';
import { KEY_POOLS, type KeyPool, poolFileName } from './keys.ts';
import { type AccessKeyListEntry, describePermission, EMPTY_CODE_HASH, formatNear, STORAGE_YOCTO_PER_BYTE } from './near.ts';

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
  accounts: Record<Role, ObservedAccount>;
  credentials: Record<Role, ObservedCredential>;
  /** get_config result, or null if the signer isn't initialised (or has no code). */
  config: ContractConfig | null;
  /** Every access key on the relayer account (both pools live here, plus its full-access key). */
  relayerAccessKeys: AccessKeyListEntry[];
  /** Every access key on the signer account (the keys-updater key lives here). */
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
  /** Size of an already-built wasm, if known (for the storage estimate). */
  wasmBytes: number | null;
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
  updaterAllowanceYocto: bigint;
  /** Redeploy code to an already-initialised contract (no init call). */
  upgrade: boolean;
  /** Skip the wasm build and use the existing file. */
  skipBuild: boolean;
}

export type DeployStep =
  | { kind: 'build' }
  | { kind: 'deploy'; init: { owner: string; mpc: string; ckd_domain_id: number; change_delay_ms: number } | null }
  | { kind: 'relayer-keys'; pool: KeyPool; reuse: string[]; generate: number; methods: string[]; allowanceYocto: bigint }
  | { kind: 'updater-key'; reuse: string | null; methods: string[]; allowanceYocto: bigint }
  | { kind: 'set-issuer'; provider: string; iss_values: string[] }
  | { kind: 'set-sponsors'; sponsors: string[] }
  | { kind: 'set-console-audiences'; audiences: [string, string][] }
  | { kind: 'set-shared-clients'; clients: [string, string][]; added: [string, string][]; removed: [string, string][] }
  | { kind: 'register-global'; owners: Owner[]; clients: [string, string][]; allowShared: boolean };

export interface DeployPlan {
  /** Problems that stop the deploy (nothing runs while any exist). */
  blockers: string[];
  warnings: string[];
  steps: DeployStep[];
  /** Things already in place. */
  done: string[];
}

/** Which full-access keys each step signs with. */
export function stepSigner(step: DeployStep): Role | null {
  switch (step.kind) {
    case 'build':
      return null;
    case 'deploy':
    case 'updater-key':
      return 'signer';
    case 'relayer-keys':
      return 'relayer';
    default:
      return 'owner';
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

export function buildDeployPlan(m: Manifest, o: DeployObserved, opts: DeployOptions): DeployPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const done: string[] = [];
  const steps: DeployStep[] = [];

  if (m.network !== 'testnet') blockers.push(`Manifest network is ${m.network}; only testnet is allowed.`);
  if (o.chainId !== 'testnet') blockers.push(`RPC ${m.rpc} reports chain "${o.chainId}", not testnet.`);
  if (new Set([m.signer, m.relayer, m.owner]).size !== 3) blockers.push('signer, relayer and owner must be three different accounts.');

  for (const role of ROLES) {
    const account = m[role];
    if (!o.accounts[role].exists) {
      blockers.push(
        `Account ${account} (${role}) does not exist. Create and fund it first, e.g.\n` +
          `    near account create-account sponsor-by-faucet-service ${account} autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`,
      );
    }
  }

  // --- contract code + init ---
  const signerAcct = o.accounts.signer;
  const hasCode = signerAcct.exists && signerAcct.codeHash !== EMPTY_CODE_HASH;
  const initialised = o.config !== null;
  if (!opts.skipBuild && (!initialised || opts.upgrade)) steps.push({ kind: 'build' });
  if (!initialised) {
    if (hasCode) {
      blockers.push(`${m.signer} already has contract code but get_config fails (another contract or old hana-signer state). Use a fresh signer account.`);
    }
    steps.push({ kind: 'deploy', init: { owner: m.owner, mpc: m.mpc, ckd_domain_id: m.ckdDomainId, change_delay_ms: m.changeDelayMs } });
  } else {
    const c = o.config as ContractConfig;
    if (opts.upgrade) steps.push({ kind: 'deploy', init: null });
    else done.push(`${m.signer} is deployed and initialised (pass --upgrade to redeploy the code).`);
    if (c.owner !== undefined && c.owner !== m.owner) blockers.push(`Contract owner is ${c.owner}, manifest says ${m.owner}.`);
    if (c.mpc !== undefined && c.mpc !== m.mpc) warnings.push(`Contract mpc is ${c.mpc}, manifest says ${m.mpc}.`);
    if (c.ckd_domain_id !== undefined && c.ckd_domain_id !== m.ckdDomainId) warnings.push(`Contract ckd_domain_id is ${c.ckd_domain_id}, manifest says ${m.ckdDomainId}.`);
    try {
      if (sharedClientsOf(c) === null) {
        const msg = `${m.signer} runs a hana-signer without shared clients (get_config has no shared_clients; it predates batch A.2).`;
        if (opts.upgrade) warnings.push(`${msg} The new code must be able to read the old state, or the upgrade breaks the contract.`);
        else blockers.push(`${msg} Its state layout differs: deploy to a fresh signer account (this changes every address in ${m.name}), or pass --upgrade only if the new code migrates the state.`);
      }
    } catch (err) {
      blockers.push((err as Error).message);
    }
    if (c.change_delay_ms !== undefined && c.change_delay_ms !== m.changeDelayMs) warnings.push(`Contract change_delay_ms is ${c.change_delay_ms}, manifest says ${m.changeDelayMs} (not changed by this script; use set_change_delay_ms).`);
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

  // --- keys-updater function-call key on the signer ---
  const updaterStatus = o.updaterKeyInFile ? checkFunctionKey(o.signerAccessKeys, o.updaterKeyInFile, m.signer, KEYS_UPDATER_METHODS, opts.updaterAllowanceYocto) : ({ kind: 'absent' } as const);
  if (updaterStatus.kind === 'ok') {
    done.push('Keys-updater key in place.');
  } else if (updaterStatus.kind === 'mismatch') {
    blockers.push(
      `The keys-updater key in .secrets/${m.name}/keys-updater.json (${o.updaterKeyInFile}) ${updaterStatus.reason}; it must be limited to ${m.signer} and ${KEYS_UPDATER_METHODS.join(', ')}, with an allowance of at most ${formatNear(opts.updaterAllowanceYocto)}. ` +
        `Delete it (${deleteKeyCmd(m.signer, o.updaterKeyInFile ?? '<key>')}) and re-run.`,
    );
  } else {
    steps.push({ kind: 'updater-key', reuse: o.updaterKeyInFile, methods: [...KEYS_UPDATER_METHODS], allowanceYocto: opts.updaterAllowanceYocto });
  }
  // Any other key on the signer that can call set_issuer_key can install a forged Google key, i.e. derive anyone's
  // wallet: stop on it rather than leave it in place.
  for (const k of strayFunctionKeys(o.signerAccessKeys, m.signer, new Set(o.updaterKeyInFile ? [o.updaterKeyInFile] : []))) {
    const methods = strayMethods(k);
    const what = `${k.public_key} (${describePermission(k.access_key.permission)})`;
    if (methods.length === 0 || methods.some((x) => (KEYS_UPDATER_METHODS as readonly string[]).includes(x))) {
      blockers.push(`${m.signer} has a function-call key on itself, not in .secrets/${m.name}/keys-updater.json, that can rotate issuer keys: ${what}. Delete it: ${deleteKeyCmd(m.signer, k.public_key)}`);
    } else {
      warnings.push(`${m.signer} has a function-call key on itself not in .secrets (left untouched): ${what}. If it is no longer used, delete it: ${deleteKeyCmd(m.signer, k.public_key)}`);
    }
  }

  // --- owner configuration calls ---
  const issValues = [...GOOGLE_ISS_VALUES];
  if (o.googleIssuer && sameSet(o.googleIssuer.iss_values, issValues)) done.push('Google issuer set.');
  else steps.push({ kind: 'set-issuer', provider: GOOGLE_PROVIDER, iss_values: issValues });

  const sponsors = [m.relayer];
  if (o.config?.sponsors && sameSet(o.config.sponsors, sponsors)) done.push('Sponsors set.');
  else steps.push({ kind: 'set-sponsors', sponsors });

  const audiences = m.consoleAudiences.map(([p, a]) => [p, a] as [string, string]);
  const currentAud = o.config?.console_audiences ?? [];
  if (audiences.length && !samePairs(currentAud, audiences)) steps.push({ kind: 'set-console-audiences', audiences });
  else if (audiences.length) done.push('Console audiences set.');

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

  // Hana's console audiences are registered as clients of "global" too, so no scope owner can claim them with
  // propose_change(AddClient) (docs/contract-interface.md, Security notes).
  if (o.globalScope !== null && o.globalScope !== undefined) {
    done.push(`Scope "${GLOBAL_SCOPE}" registered.`);
    const globalClients = (o.globalScope as { clients?: [string, string][] }).clients ?? [];
    const missing = audiences.filter(([p, a]) => !globalClients.some(([gp, ga]) => gp === p && ga === a));
    if (missing.length) {
      warnings.push(
        `Console audience(s) not in the "${GLOBAL_SCOPE}" scope: ${missing.map(([p, a]) => `${p}/${a}`).join(', ')}. ` +
          `Until registered, any scope owner can claim them with propose_change(AddClient); add them to "${GLOBAL_SCOPE}" (or another Hana scope) early.`,
      );
    }
  } else if (m.googleClientIds.length === 0 || m.googleClientIds.some(isPlaceholder)) {
    warnings.push(`googleClientIds is empty or a placeholder: skipping the "${GLOBAL_SCOPE}" scope. Set it in envs/${m.name}.json and re-run.`);
  } else {
    const clients: [string, string][] = m.googleClientIds.map((aud) => [GOOGLE_PROVIDER, aud] as [string, string]);
    for (const [p, a] of audiences) if (!clients.some(([cp, ca]) => cp === p && ca === a)) clients.push([p, a]);
    if (clients.length > 10) blockers.push(`The "${GLOBAL_SCOPE}" scope would get ${clients.length} clients (googleClientIds + consoleAudiences); the contract allows 10.`);
    // Hana's own app logs in with its own client, not the shared one.
    steps.push({ kind: 'register-global', owners: [{ Near: { account_id: m.owner } }], clients, allowShared: false });
  }

  // --- credentials needed by the planned steps ---
  const needed = new Set(steps.map(stepSigner).filter((r): r is Role => r !== null));
  for (const role of needed) {
    const cred = o.credentials[role];
    if (!o.accounts[role].exists) continue; // the create-account command above also saves the key
    if (!cred.found) blockers.push(`No key for ${m[role]} (${role}) in ~/.near-credentials/testnet/ (near CLI legacy keychain).`);
    else if (!cred.fullAccessOnChain) blockers.push(`The key for ${m[role]} in ~/.near-credentials/testnet/ (${cred.publicKey}) is not a full-access key on chain.`);
  }

  return { blockers, warnings, steps, done };
}

/** Human-readable description of a step (no secrets: only public keys and arguments). */
export function describeStep(m: Manifest, s: DeployStep): string {
  const near = (y: bigint) => formatNear(y);
  switch (s.kind) {
    case 'build':
      return 'Build contracts/hana-signer wasm (cargo near build non-reproducible-wasm).';
    case 'deploy':
      return s.init
        ? `Deploy wasm to ${m.signer} and call new(${JSON.stringify(s.init)}) [signed by ${m.signer}].`
        : `Redeploy wasm to ${m.signer} (code only, no init) [signed by ${m.signer}].`;
    case 'relayer-keys':
      return (
        `Add ${s.reuse.length + s.generate} ${s.pool}-pool function-call key(s) to ${m.relayer} (receiver ${m.signer}, allowance ${near(s.allowanceYocto)} each, methods ${s.methods.join(', ')})` +
        `${s.generate ? `; generate ${s.generate} new key(s) into .secrets/${m.name}/${poolFileName(s.pool)}` : ''}` +
        `${s.reuse.length ? `; re-add ${s.reuse.length} key(s) already in .secrets` : ''} [signed by ${m.relayer}].`
      );
    case 'updater-key':
      return `Add the keys-updater function-call key to ${m.signer} (receiver ${m.signer}, methods ${s.methods.join(', ')}, allowance ${near(s.allowanceYocto)})${s.reuse ? ' from .secrets' : `; generate it into .secrets/${m.name}/keys-updater.json`} [signed by ${m.signer}].`;
    case 'set-issuer':
      return `set_issuer(${JSON.stringify({ provider: s.provider, iss_values: s.iss_values })}) [signed by ${m.owner}].`;
    case 'set-sponsors':
      return `set_sponsors(${JSON.stringify({ sponsors: s.sponsors })}) [signed by ${m.owner}].`;
    case 'set-console-audiences':
      return `set_console_audiences(${JSON.stringify({ audiences: s.audiences })}) [signed by ${m.owner}].`;
    case 'set-shared-clients': {
      const changes = [s.added.length ? `adds ${pairText(s.added)} after the ${m.changeDelayMs} ms timelock` : '', s.removed.length ? `removes ${pairText(s.removed)} at once` : '']
        .filter(Boolean)
        .join('; ');
      return `set_shared_clients(${JSON.stringify({ clients: s.clients })})${changes ? ` (${changes})` : ''} [signed by ${m.owner}].`;
    }
    case 'register-global':
      return `admin_register_scope(${JSON.stringify(registerGlobalArgs(s))}) [signed by ${m.owner}].`;
  }
}

/** admin_register_scope arguments for the reserved global scope. */
export function registerGlobalArgs(s: Extract<DeployStep, { kind: 'register-global' }>) {
  return { owners: s.owners, clients: s.clients, scope_id: GLOBAL_SCOPE, allow_shared: s.allowShared };
}
