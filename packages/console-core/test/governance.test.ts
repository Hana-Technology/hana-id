// The pending-upgrades view (src/governance.ts, D86): what both consoles show from the API's governance snapshot, the
// release registry's rules, and the RPC inputs.
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_RELEASES,
  type ContractRelease,
  type GovernanceSnapshotInput,
  REPRODUCIBLE_BUILD_COMMAND,
  governanceInput,
  pendingUpgradesInput,
  pendingUpgradesView,
  releaseProblems,
} from '../src/index.ts';

const NOW = Date.UTC(2026, 10, 4, 12);
const HASH = '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp';
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);

const snapshot = (over: Partial<GovernanceSnapshotInput> = {}): GovernanceSnapshotInput => ({
  signer: 'signer.test.near',
  env: 'sandbox-test',
  readAtMs: NOW,
  paused: false,
  delays: { issuerKeyDelayMs: 7_200_000, governanceDelayMs: 259_200_000, changeDelayMs: 172_800_000, pendingIssuerKeyDelay: null, pendingGovernanceDelay: null, pendingChangeDelay: null },
  pendingUpgrade: null,
  pendingOwner: null,
  pendingWithdrawal: null,
  pendingConsoleAudiences: [],
  ...over,
});

const releases: ContractRelease[] = [
  { codeHash: '4'.repeat(44), version: '0.3.0', commit: C1, buildCommand: REPRODUCIBLE_BUILD_COMMAND, previousCommit: null },
  { codeHash: HASH, version: '0.3.1', commit: C2, buildCommand: REPRODUCIBLE_BUILD_COMMAND, previousCommit: C1 },
];

describe('pendingUpgradesView', () => {
  it('nothing pending: every list empty, anyPending false', () => {
    expect(pendingUpgradesView(snapshot())).toEqual({
      signer: 'signer.test.near',
      env: 'sandbox-test',
      readAtMs: NOW,
      paused: false,
      governanceDelayMs: 259_200_000,
      upgrade: null,
      ownerTransfer: null,
      withdrawal: null,
      delayDecreases: [],
      consoleAudienceAdditions: [],
      anyPending: false,
    });
  });

  it('a published release: hash, commit, build command, the diff to the last release and the countdown inputs', () => {
    const v = pendingUpgradesView(snapshot({ pendingUpgrade: { codeHash: HASH, proposedAtMs: NOW - 1000, executableAtMs: NOW + 259_199_000, due: false } }), releases);
    expect(v.upgrade).toEqual({
      codeHash: HASH,
      proposedAtMs: NOW - 1000,
      executableAtMs: NOW + 259_199_000,
      due: false,
      release: { version: '0.3.1', commit: C2, buildCommand: REPRODUCIBLE_BUILD_COMMAND, previousCommit: C1, diffCommand: `git diff ${C1}..${C2} -- contracts/hana-signer` },
    });
    expect(v.anyPending).toBe(true);
  });

  it('a hash that is not a published release has no release (the page says so)', () => {
    const v = pendingUpgradesView(snapshot({ pendingUpgrade: { codeHash: '9'.repeat(44), proposedAtMs: 1, executableAtMs: 2, due: true } }), releases);
    expect(v.upgrade).toMatchObject({ due: true, release: null });
  });

  it('the first release has no diff', () => {
    const v = pendingUpgradesView(snapshot({ pendingUpgrade: { codeHash: '4'.repeat(44), proposedAtMs: 1, executableAtMs: 2, due: false } }), releases);
    expect(v.upgrade!.release!.diffCommand).toBeNull();
  });

  it('owner transfer, withdrawal, delay decreases and console-audience additions', () => {
    const v = pendingUpgradesView(
      snapshot({
        paused: true,
        pendingOwner: { owner: 'new-dao.sputnik.test', acceptableAtMs: NOW + 5, due: false },
        pendingWithdrawal: { receiver: 'ops.test', amountYocto: '1000', executableAtMs: NOW - 1, due: true },
        delays: { ...snapshot().delays, pendingIssuerKeyDelay: { valueMs: 3_600_000, effectiveAtMs: NOW + 9 }, pendingChangeDelay: { valueMs: 60_000, effectiveAtMs: NOW + 8 } },
        pendingConsoleAudiences: [{ provider: 'google', aud: 'c2.apps.googleusercontent.com', effectiveAtMs: NOW + 7 }],
      }),
    );
    expect(v).toMatchObject({
      paused: true,
      ownerTransfer: { owner: 'new-dao.sputnik.test', acceptableAtMs: NOW + 5, due: false },
      withdrawal: { receiver: 'ops.test', amountYocto: '1000', executableAtMs: NOW - 1, due: true },
      delayDecreases: [
        { delay: 'issuer_key', currentMs: 7_200_000, valueMs: 3_600_000, effectiveAtMs: NOW + 9 },
        { delay: 'change', currentMs: 172_800_000, valueMs: 60_000, effectiveAtMs: NOW + 8 },
      ],
      consoleAudienceAdditions: [{ provider: 'google', aud: 'c2.apps.googleusercontent.com', effectiveAtMs: NOW + 7 }],
      anyPending: true,
    });
  });

  it('carries only the fields it names (no access keys, watchdogs, updater or key changes from a fuller snapshot)', () => {
    const full = { ...snapshot(), signerAccessKeys: [{ publicKey: 'ed25519:x' }], updater: { lastRuns: [] }, watchdogs: [], keyChanges: [], updaterKeys: ['ed25519:x'] } as GovernanceSnapshotInput;
    expect(Object.keys(pendingUpgradesView(full)).sort()).toEqual(['anyPending', 'consoleAudienceAdditions', 'delayDecreases', 'env', 'governanceDelayMs', 'ownerTransfer', 'paused', 'readAtMs', 'signer', 'upgrade', 'withdrawal']);
  });
});

describe('the release registry', () => {
  it('the published list is well-formed', () => {
    expect(releaseProblems(CONTRACT_RELEASES)).toEqual([]);
    expect(releaseProblems(releases)).toEqual([]);
  });

  it('refuses a bad hash, commit, build, a duplicate and a broken previous chain', () => {
    expect(releaseProblems([{ ...releases[0]!, codeHash: '0OIl', commit: 'abc', buildCommand: 'cargo near build non-reproducible-wasm', version: 'v1' }])).toEqual([
      'release 0 (v1): codeHash is not a base58 sha256',
      'release 0 (v1): version is not x.y.z',
      'release 0 (v1): commit is not a 40-hex commit id',
      'release 0 (v1): buildCommand is not the reproducible build',
    ]);
    expect(releaseProblems([releases[0]!, { ...releases[1]!, previousCommit: null }])).toEqual([`release 1 (0.3.1): previousCommit must be the release before it (${C1})`]);
    expect(releaseProblems([releases[0]!, { ...releases[0]!, previousCommit: C1 }])).toEqual(['release 1 (0.3.0): codeHash listed twice', 'release 1 (0.3.0): commit listed twice']);
  });
});

describe('RPC inputs', () => {
  const ctx = { actor: { kind: 'hana', id: 'access-sub', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '198.51.100.1' } as const;
  it('governance takes the context only; pendingUpgrades also the org', () => {
    expect(governanceInput.safeParse(ctx).success).toBe(true);
    expect(governanceInput.safeParse({ ...ctx, orgId: 'org_a' }).success).toBe(false);
    expect(pendingUpgradesInput.safeParse({ ...ctx, orgId: 'org_a' }).success).toBe(true);
    expect(pendingUpgradesInput.safeParse(ctx).success).toBe(false);
    expect(pendingUpgradesInput.safeParse({ ...ctx, orgId: "org_x' OR 1" }).success).toBe(false);
  });
});
