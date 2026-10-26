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
  type Owner,
  RELAYER_METHODS,
  samePairs,
  sameSet,
} from './contract.ts';
import { EMPTY_CODE_HASH, formatNear, STORAGE_YOCTO_PER_BYTE } from './near.ts';

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
  /** Public keys of function-call keys on the relayer whose receiver is the signer. */
  relayerKeysOnChain: string[];
  /**
   * Every other access key on the relayer (full-access, or a function-call key for another receiver, e.g. a previous
   * signer): public key → description. A key in this map cannot be added again (AddKeyAlreadyExists).
   */
  relayerKeysElsewhere: Record<string, string>;
  /** Public keys in .secrets/<env>/relayer-keys.json. */
  relayerKeysInFile: string[];
  /** Public keys of function-call keys on the signer whose receiver is the signer. */
  signerFunctionKeysOnChain: string[];
  /** Public key in .secrets/<env>/keys-updater.json. */
  updaterKeyInFile: string | null;
  googleIssuer: IssuerView | null;
  /** get_scope("global") result (null if absent). */
  globalScope: unknown;
  /** Size of an already-built wasm, if known (for the storage estimate). */
  wasmBytes: number | null;
}

export interface DeployOptions {
  relayerKeyCount: number;
  relayerAllowanceYocto: bigint;
  updaterAllowanceYocto: bigint;
  /** Redeploy code to an already-initialised contract (no init call). */
  upgrade: boolean;
  /** Skip the wasm build and use the existing file. */
  skipBuild: boolean;
}

export type DeployStep =
  | { kind: 'build' }
  | { kind: 'deploy'; init: { owner: string; mpc: string; ckd_domain_id: number; change_delay_ms: number } | null }
  | { kind: 'relayer-keys'; reuse: string[]; generate: number; methods: string[]; allowanceYocto: bigint }
  | { kind: 'updater-key'; reuse: string | null; methods: string[]; allowanceYocto: bigint }
  | { kind: 'set-issuer'; provider: string; iss_values: string[] }
  | { kind: 'set-sponsors'; sponsors: string[] }
  | { kind: 'set-console-audiences'; audiences: [string, string][] }
  | { kind: 'register-global'; owners: Owner[]; clients: [string, string][] };

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
    if (c.change_delay_ms !== undefined && c.change_delay_ms !== m.changeDelayMs) warnings.push(`Contract change_delay_ms is ${c.change_delay_ms}, manifest says ${m.changeDelayMs} (not changed by this script; use set_change_delay_ms).`);
  }
  if (o.wasmBytes !== null && (!initialised || opts.upgrade)) {
    const need = BigInt(o.wasmBytes) * STORAGE_YOCTO_PER_BYTE;
    if (signerAcct.exists && signerAcct.balanceYocto < need + 10n ** 24n) {
      warnings.push(`${m.signer} has ${formatNear(signerAcct.balanceYocto)}; the ${o.wasmBytes}-byte wasm locks ~${formatNear(need)} for storage, plus state. Top it up if the deploy fails.`);
    }
  }

  // --- relayer function-call keys ---
  const onChain = new Set(o.relayerKeysOnChain);
  const fileKeys = o.relayerKeysInFile;
  const live = fileKeys.filter((k) => onChain.has(k));
  // A file key already on the relayer with another permission (typically a function-call key for a previous signer
  // after switching signer accounts) can't be re-added: AddKey fails with AddKeyAlreadyExists and takes the whole
  // relayer-keys transaction with it. Stop and say how to fix it instead of planning a doomed re-add.
  const conflicting = fileKeys.filter((k) => !onChain.has(k) && Object.hasOwn(o.relayerKeysElsewhere, k));
  if (conflicting.length) {
    blockers.push(
      `.secrets/${m.name}/relayer-keys.json holds ${conflicting.length} key(s) that are already on ${m.relayer} with a different permission, so they can't be added for ${m.signer}:\n` +
        conflicting.map((k) => `      ${k}: ${o.relayerKeysElsewhere[k]}`).join('\n') +
        `\n    Either move .secrets/${m.name}/relayer-keys.json aside (new keys are then generated; it is also the API's RELAYER_KEYS, so re-upload it) ` +
        `or delete those keys from ${m.relayer} (near account delete-keys ${m.relayer} public-keys <key> network-config testnet sign-with-legacy-keychain send), then re-run.`,
    );
  }
  const reuse = fileKeys.filter((k) => !onChain.has(k) && !conflicting.includes(k));
  const generate = Math.max(0, opts.relayerKeyCount - fileKeys.length);
  const strays = o.relayerKeysOnChain.filter((k) => !fileKeys.includes(k));
  if (strays.length) warnings.push(`${m.relayer} has ${strays.length} function-call key(s) for ${m.signer} not in .secrets (left untouched): ${strays.join(', ')}`);
  if (reuse.length || generate) {
    steps.push({ kind: 'relayer-keys', reuse, generate, methods: [...RELAYER_METHODS], allowanceYocto: opts.relayerAllowanceYocto });
  } else {
    done.push(`${live.length} relayer key(s) in place.`);
  }

  // --- keys-updater function-call key on the signer ---
  if (o.updaterKeyInFile && o.signerFunctionKeysOnChain.includes(o.updaterKeyInFile)) {
    done.push('Keys-updater key in place.');
  } else {
    steps.push({ kind: 'updater-key', reuse: o.updaterKeyInFile, methods: [...KEYS_UPDATER_METHODS], allowanceYocto: opts.updaterAllowanceYocto });
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
    steps.push({ kind: 'register-global', owners: [{ Near: { account_id: m.owner } }], clients });
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
        `Add ${s.reuse.length + s.generate} function-call key(s) to ${m.relayer} (receiver ${m.signer}, allowance ${near(s.allowanceYocto)} each, methods ${s.methods.join(', ')})` +
        `${s.generate ? `; generate ${s.generate} new key(s) into .secrets/${m.name}/relayer-keys.json` : ''}` +
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
    case 'register-global':
      return `admin_register_scope(${JSON.stringify({ owners: s.owners, clients: s.clients, scope_id: GLOBAL_SCOPE })}) [signed by ${m.owner}].`;
  }
}
