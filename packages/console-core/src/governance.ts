// The pending-upgrades page of both consoles (D86, docs/governance-spec.md "Alerts": public notice of an upgrade, owner
// change or withdrawal): what hana-signer's owner has queued that partners and users must be able to react to within
// `governance_delay_ms` (export keys, D41). One view for the admin console and the partner console, built in the API
// from the same snapshot as `GET /v1/governance` (apps/api/src/governance-status.ts) and served by `AdminRpc` and
// `ConsoleRpc` `pendingUpgrades`. Everything in it is public on chain; it carries nothing of any org, no access key, no
// watchdog state and nothing the API's cron keeps.
//
// The code hash is on chain; its source commit, reproducible-build command and the diff to the release before it are
// not. They come from CONTRACT_RELEASES below: a hash that isn't listed there is shown as "not a published release"
// (D333).
import { z } from 'zod';
import { orgIdInput } from './rpc.ts';
import { ctx } from './types.ts';

// ---- the release registry ----

/** NEAR's account `code_hash` (base58 of the wasm's sha256): 32 bytes, 43 or 44 base58 characters. */
export const CODE_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/u;
/** A full git commit id (40 lowercase hex). */
export const COMMIT_RE = /^[0-9a-f]{40}$/u;
/** The only build a published release may name (D86 Q14: every mainnet proposal is a reproducible build). */
export const REPRODUCIBLE_BUILD_COMMAND = 'cd contracts/hana-signer && cargo near build reproducible-wasm';

export interface ContractRelease {
  /** `view_account(signer).code_hash` after it is executed, and `propose_upgrade`'s argument. */
  codeHash: string;
  /** `contracts/hana-signer/Cargo.toml` `version` of the build. */
  version: string;
  /** The source commit the build was made from. */
  commit: string;
  /** How to rebuild it and get the same hash. */
  buildCommand: string;
  /** The commit of the release before it (the diff's base), or null for the first one. */
  previousCommit: string | null;
}

/**
 * Every published hana-signer release, oldest first. Add an entry (and deploy the API, which serves it) **before** the
 * owner proposes the upgrade (`docs/operations.md` "Pending upgrades page"); test/governance.test.ts checks each entry's
 * shape. Empty while no env runs a reproducible build: testnet upgrades are `non-reproducible-wasm` builds, so their
 * hashes show as "not a published release", which is accurate.
 */
export const CONTRACT_RELEASES: readonly ContractRelease[] = [];

/** The problems of a release list (shape, duplicates, chain of previous commits), or []. */
export function releaseProblems(list: readonly ContractRelease[]): string[] {
  const out: string[] = [];
  const hashes = new Set<string>();
  const commits = new Set<string>();
  list.forEach((r, i) => {
    const at = `release ${i} (${r.version})`;
    if (!CODE_HASH_RE.test(r.codeHash)) out.push(`${at}: codeHash is not a base58 sha256`);
    if (!/^\d+\.\d+\.\d+$/u.test(r.version)) out.push(`${at}: version is not x.y.z`);
    if (!COMMIT_RE.test(r.commit)) out.push(`${at}: commit is not a 40-hex commit id`);
    if (r.buildCommand !== REPRODUCIBLE_BUILD_COMMAND) out.push(`${at}: buildCommand is not the reproducible build`);
    if (hashes.has(r.codeHash)) out.push(`${at}: codeHash listed twice`);
    if (commits.has(r.commit)) out.push(`${at}: commit listed twice`);
    const expected = i === 0 ? null : list[i - 1]!.commit;
    if (r.previousCommit !== expected) out.push(`${at}: previousCommit must be the release before it (${expected ?? 'null'})`);
    hashes.add(r.codeHash);
    commits.add(r.commit);
  });
  return out;
}

// ---- the view ----

/** The parts of the API's governance snapshot (`GET /v1/governance`) this view reads. */
export interface GovernanceSnapshotInput {
  signer: string;
  env: string;
  readAtMs: number;
  paused: boolean;
  delays: {
    issuerKeyDelayMs: number;
    governanceDelayMs: number;
    changeDelayMs: number;
    pendingIssuerKeyDelay: { valueMs: number; effectiveAtMs: number } | null;
    pendingGovernanceDelay: { valueMs: number; effectiveAtMs: number } | null;
    pendingChangeDelay: { valueMs: number; effectiveAtMs: number } | null;
  };
  pendingUpgrade: { codeHash: string; proposedAtMs: number; executableAtMs: number; due: boolean } | null;
  pendingOwner: { owner: string; acceptableAtMs: number; due: boolean } | null;
  pendingWithdrawal: { receiver: string; amountYocto: string; executableAtMs: number; due: boolean } | null;
  pendingConsoleAudiences: { provider: string; aud: string; effectiveAtMs: number }[];
}

export interface PendingUpgradeRelease {
  version: string;
  commit: string;
  buildCommand: string;
  previousCommit: string | null;
  /** `git diff <previous>..<commit> -- contracts/hana-signer`, or null for the first release. */
  diffCommand: string | null;
}

export interface PendingUpgradesView {
  signer: string;
  env: string;
  /** When the chain was read (countdowns are the reader's: `executableAtMs − now`). */
  readAtMs: number;
  paused: boolean;
  governanceDelayMs: number;
  upgrade: {
    codeHash: string;
    proposedAtMs: number;
    executableAtMs: number;
    due: boolean;
    /** The published release with this hash, or null: no source commit or build command is on record for it. */
    release: PendingUpgradeRelease | null;
  } | null;
  ownerTransfer: { owner: string; acceptableAtMs: number; due: boolean } | null;
  withdrawal: { receiver: string; amountYocto: string; executableAtMs: number; due: boolean } | null;
  /** Delay decreases waiting to take effect (increases apply at once, so they never wait here). */
  delayDecreases: { delay: 'issuer_key' | 'governance' | 'change'; currentMs: number; valueMs: number; effectiveAtMs: number }[];
  /** New console audiences: their tokens will authorise OIDC owner actions once in force (D86 Q13). */
  consoleAudienceAdditions: { provider: string; aud: string; effectiveAtMs: number }[];
  /** True when anything above is pending. */
  anyPending: boolean;
}

export const diffCommand = (r: Pick<ContractRelease, 'commit' | 'previousCommit'>): string | null => (r.previousCommit ? `git diff ${r.previousCommit}..${r.commit} -- contracts/hana-signer` : null);

export function pendingUpgradesView(s: GovernanceSnapshotInput, releases: readonly ContractRelease[] = CONTRACT_RELEASES): PendingUpgradesView {
  const up = s.pendingUpgrade;
  const release = up ? releases.find((r) => r.codeHash === up.codeHash) : undefined;
  const delays: PendingUpgradesView['delayDecreases'] = [];
  const d = s.delays;
  if (d.pendingIssuerKeyDelay) delays.push({ delay: 'issuer_key', currentMs: d.issuerKeyDelayMs, ...d.pendingIssuerKeyDelay });
  if (d.pendingGovernanceDelay) delays.push({ delay: 'governance', currentMs: d.governanceDelayMs, ...d.pendingGovernanceDelay });
  if (d.pendingChangeDelay) delays.push({ delay: 'change', currentMs: d.changeDelayMs, ...d.pendingChangeDelay });
  const view: PendingUpgradesView = {
    signer: s.signer,
    env: s.env,
    readAtMs: s.readAtMs,
    paused: s.paused,
    governanceDelayMs: d.governanceDelayMs,
    upgrade: up
      ? {
          codeHash: up.codeHash,
          proposedAtMs: up.proposedAtMs,
          executableAtMs: up.executableAtMs,
          due: up.due,
          release: release ? { version: release.version, commit: release.commit, buildCommand: release.buildCommand, previousCommit: release.previousCommit, diffCommand: diffCommand(release) } : null,
        }
      : null,
    ownerTransfer: s.pendingOwner ? { owner: s.pendingOwner.owner, acceptableAtMs: s.pendingOwner.acceptableAtMs, due: s.pendingOwner.due } : null,
    withdrawal: s.pendingWithdrawal ? { receiver: s.pendingWithdrawal.receiver, amountYocto: s.pendingWithdrawal.amountYocto, executableAtMs: s.pendingWithdrawal.executableAtMs, due: s.pendingWithdrawal.due } : null,
    delayDecreases: delays,
    consoleAudienceAdditions: s.pendingConsoleAudiences.map((a) => ({ provider: a.provider, aud: a.aud, effectiveAtMs: a.effectiveAtMs })),
    anyPending: false,
  };
  view.anyPending = !!(view.upgrade || view.ownerTransfer || view.withdrawal || view.delayDecreases.length || view.consoleAudienceAdditions.length);
  return view;
}

// ---- RPC inputs ----

/** `AdminRpc.governance` and `AdminRpc.pendingUpgrades`: no fields beyond the call's context. */
export const governanceInput = ctx.strict();
/** `ConsoleRpc.pendingUpgrades`: the member's org (the budget is the org's; the console checked the membership). */
export const pendingUpgradesInput = ctx.extend({ orgId: orgIdInput }).strict();
export type GovernanceInput = z.infer<typeof governanceInput>;
export type PendingUpgradesInput = z.infer<typeof pendingUpgradesInput>;
