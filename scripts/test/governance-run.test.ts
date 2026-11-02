// deploy-contract's governance flows end to end against the simulated chain (sim-chain.ts), never a network:
// v1 contracts refused (D154), upgrades only through
// propose_upgrade → wait → execute_upgrade, the owner transfer to the council DAO (--approve-with), council-owned
// runs that stop at the first proposal, and the printed-only creation batch.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, type Manifest } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import { OWNER_RELAYER_METHODS, SESSION_RELAYER_METHODS } from '../lib/contract.ts';
import { writeCouncilKey } from '../lib/council.ts';
import { CLOCK_MARGIN_MS } from '../lib/deploy-plan.ts';
import { DRY_RUN_LINE, deployMain } from '../lib/deploy-run.ts';
import { keysUpdaterFile, readKeysUpdater, writeKeysUpdater, writePoolKeys } from '../lib/keys.ts';
import { codeHashOf, TGAS } from '../lib/near.ts';
import { councilPolicy, readPin } from '../lib/sputnik.ts';
import { SimChain } from './sim-chain.ts';
import { ACCOUNT_OWNER, fcEntry, fullEntry, keychainKey, NOW, secretFragments, tempRoots, UPDATER, V1_UPDATER } from './sim-fixtures.ts';

const base: Manifest = { ...loadEnv('sandbox-dev'), ...ACCOUNT_OWNER };
const council = base.council!;
const [A, B] = council.members as [string, string, string];
const dao = council.dao;
const WATCHDOG = base.watchdogs![0]!;
const PIN = readPin();
const mode = (p: string) => statSync(p).mode & 0o777;

let roots: ReturnType<typeof tempRoots>;
let chain: SimChain;
let secrets: KeyPair[];
let wasm: string;
let manifestEdits: Record<string, string>[];

/** Everything an env deployed in batch B has, so the governance steps are all that is left. */
function configFor(m: Manifest) {
  return {
    owner: m.owner,
    mpc: m.mpc,
    ckd_domain_id: m.ckdDomainId,
    change_delay_ms: m.changeDelayMs,
    sponsors: [m.relayer],
    console_audiences: m.consoleAudiences,
    shared_clients: m.sharedGoogleClientIds.map((aud) => ['google', aud]),
    pending_shared_clients: [],
  };
}

beforeEach(() => {
  roots = tempRoots();
  chain = new SimChain(base.signer, { now: NOW, daoCodeHash: PIN.code_hash });
  secrets = [];
  manifestEdits = [];
  for (const account of [base.signer, base.relayer, base.owner]) {
    const k = keychainKey(roots.home, account);
    secrets.push(k);
    chain.addAccount(account, [fullEntry(k)]);
  }
  for (const member of council.members) {
    const k = KeyPair.fromRandom('ed25519');
    writeCouncilKey(base.name, member, k, roots.secretsRoot);
    chain.addAccount(member, [fullEntry(k)]);
    secrets.push(k);
  }
  chain.addDao(dao, councilPolicy(council.members));
  chain.addAccount(WATCHDOG);
  // Relayer pools already in place.
  const session = Array.from({ length: 3 }, () => KeyPair.fromRandom('ed25519'));
  const owner = [KeyPair.fromRandom('ed25519')];
  writePoolKeys(base.name, 'session', session, roots.secretsRoot);
  writePoolKeys(base.name, 'owner', owner, roots.secretsRoot);
  for (const k of session) chain.accounts.get(base.relayer)!.keys.push(fcEntry(k, base.signer, [...SESSION_RELAYER_METHODS], (2n * 10n ** 24n).toString()));
  for (const k of owner) chain.accounts.get(base.relayer)!.keys.push(fcEntry(k, base.signer, [...OWNER_RELAYER_METHODS], (10n ** 23n).toString()));
  secrets.push(...session, ...owner);
  chain.issuer = { iss_values: ['https://accounts.google.com', 'accounts.google.com'], kids: [] };
  chain.globalScope = { id: 'global', clients: base.consoleAudiences };
  wasm = join(roots.dir, 'hana_signer.wasm');
  writeFileSync(wasm, Buffer.from('v2 wasm'));
});

/** A v1 (batch B) contract with the hand-added v1 updater key in keys-updater.json. */
function v1(): KeyPair {
  chain.config = configFor(base);
  chain.governance = null;
  chain.accounts.get(base.signer)!.codeHash = 'V1CODE';
  const old = KeyPair.fromRandom('ed25519');
  writeKeysUpdater(base.name, base.signer, old, roots.secretsRoot);
  chain.accounts.get(base.signer)!.keys.push(fcEntry(old, base.signer, V1_UPDATER));
  secrets.push(old);
  return old;
}

/** A migrated v2 contract with its updater key and watchdog in place. */
function v2(m: Manifest = base): KeyPair {
  const k = KeyPair.fromRandom('ed25519');
  writeKeysUpdater(m.name, m.signer, k, roots.secretsRoot);
  chain.accounts.get(m.signer)!.keys.push(fcEntry(k, m.signer, UPDATER));
  chain.initV2(
    { ...configFor(m), issuer_key_delay_ms: m.issuerKeyDelayMs, governance_delay_ms: m.governanceDelayMs, pending_issuer_key_delay: null, pending_governance_delay: null, paused: false },
    { updater_keys: [k.getPublicKey().toString()], watchdogs: [{ account_id: WATCHDOG, confirm_from_ms: 0 }] },
  );
  secrets.push(k);
  return k;
}

async function deploy(argv: string[], m: Manifest = base) {
  const out: string[] = [];
  const sentBefore = chain.sent.length;
  const code = await deployMain(argv, {
    loadManifest: () => m,
    rpc: () => chain.rpc(),
    log: (l) => out.push(l),
    home: roots.home,
    secretsRoot: roots.secretsRoot,
    buildWasm: () => {
      throw new Error('no builds in these tests');
    },
    existingWasm: () => wasm,
    updateManifest: (_name, fields) => manifestEdits.push(fields),
    now: () => chain.now,
    sputnikCodeHash: PIN.code_hash,
  });
  const text = out.join('\n');
  for (const s of secretFragments(secrets)) expect(text).not.toContain(s);
  const sent = chain.sent.slice(sentBefore);
  return { code, out: text, sent, calls: sent.map((t) => `${t.signer}→${t.receiver}:${t.actions.map((a) => a.functionCall?.methodName ?? a.enum).join('+')}`) };
}

describe('v1 contracts (pre-governance)', () => {
  it('are refused: nothing is sent, with or without --yes (contract v3 has no migrate_v1, D154)', async () => {
    v1();
    for (const argv of [[base.name, '--upgrade', '--skip-build'], [base.name, '--upgrade', '--skip-build', '--yes']]) {
      const r = await deploy(argv);
      expect(r.code).toBe(1);
      expect(r.out).toContain('contract v1 (pre-governance)');
      expect(r.out).toContain("which this code can't migrate: contract v3 has no migrate_v1 (D154)");
      expect(r.sent).toEqual([]);
    }
    expect(chain.accounts.get(base.signer)!.codeHash).toBe('V1CODE');
  });
});

describe('upgrades: propose_upgrade → governance_delay_ms → execute_upgrade', () => {
  it('proposes the wasm hash, waits, then executes with the raw wasm; never a DeployContract', async () => {
    v2();
    const hash = codeHashOf(readFileSync(wasm));
    const proposed = await deploy([base.name, '--upgrade', '--wasm', wasm, '--yes']);
    expect(proposed.calls).toEqual([`${base.owner}→${base.signer}:propose_upgrade`]);
    expect(JSON.parse(Buffer.from(proposed.sent[0]!.actions[0]!.functionCall!.args).toString())).toEqual({ code_hash: hash });

    const early = await deploy([base.name, '--upgrade', '--wasm', wasm, '--yes']);
    expect(early.sent).toEqual([]);
    expect(early.out).toContain(`Upgrade to ${hash} proposed; executable from`);

    chain.now += 60_000 + CLOCK_MARGIN_MS;
    const executed = await deploy([base.name, '--upgrade', '--wasm', wasm, '--yes']);
    expect(executed.calls).toEqual([`${base.relayer}→${base.signer}:execute_upgrade`]);
    const fc = executed.sent[0]!.actions[0]!.functionCall!;
    expect(Buffer.from(fc.args).equals(readFileSync(wasm))).toBe(true); // raw wasm bytes, not JSON
    expect(fc.gas).toBe(300n * TGAS);
    expect(chain.accounts.get(base.signer)!.codeHash).toBe(hash);
    expect(chain.sent.flatMap((t) => t.actions.map((a) => a.enum))).not.toContain('deployContract');

    const done = await deploy([base.name, '--upgrade', '--wasm', wasm]);
    expect(done.out).toContain(`already runs ${hash}`);
  });

  it('reports a failed migrate (old code kept) instead of claiming success', async () => {
    v2();
    await deploy([base.name, '--upgrade', '--wasm', wasm, '--yes']);
    chain.now += 60_000 + CLOCK_MARGIN_MS;
    chain.failMigrate = true;
    await expect(deploy([base.name, '--upgrade', '--wasm', wasm, '--yes'])).rejects.toThrow('its migrate failed and the old code stayed');
  });
});

describe('owner transfer to the council DAO', () => {
  it('propose_owner by the old owner; after the delay the DAO accepts with --approve-with, and the manifest is updated', async () => {
    v2();
    const proposed = await deploy([base.name, '--transfer-owner', '--yes']);
    expect(proposed.calls).toEqual([`${base.owner}→${base.signer}:propose_owner`]);
    expect(chain.governance?.pending_owner?.owner).toBe(dao);

    const waiting = await deploy([base.name, '--transfer-owner', '--approve-with', B, '--yes']);
    expect(waiting.sent).toEqual([]);
    expect(waiting.out).toContain('the DAO may accept from');

    chain.now += 60_000 + CLOCK_MARGIN_MS;
    const accepted = await deploy([base.name, '--transfer-owner', '--approve-with', B, '--yes']);
    expect(accepted.calls).toEqual([`${A}→${dao}:add_proposal`, `${A}→${dao}:act_proposal`, `${B}→${dao}:act_proposal`]);
    expect(chain.config?.owner).toBe(dao);
    expect(manifestEdits).toEqual([{ owner: dao, ownerKind: 'sputnik' }]);

    // With the manifest updated, the env is clean; the DAO is the owner from now on.
    const daoOwned: Manifest = { ...base, owner: dao, ownerKind: 'sputnik' };
    const after = await deploy([base.name, '--transfer-owner'], daoOwned);
    expect(after.code).toBe(0);
    expect(after.out).toContain(`The council DAO ${dao} owns ${base.signer}`);
    expect(after.out).toContain('Nothing to do.');
  });
});

describe("the council DAO's policy is read, not only its code (D81)", () => {
  const oneOfThree = () => ({ ...councilPolicy(council.members), default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 3] as [number, number] } });

  it('--transfer-owner to a DAO with the pinned code but a 1-of-3 policy is blocked and nothing is sent', async () => {
    v2();
    chain.daos.get(dao)!.policy = oneOfThree();
    const r = await deploy([base.name, '--transfer-owner', '--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${dao}: default_vote_policy is`);
    expect(r.sent).toEqual([]);
    expect(chain.governance?.pending_owner).toBeNull();
  });

  it('a council-owned env whose DAO was reshaped (AddMember) is blocked on every run', async () => {
    const daoOwned: Manifest = { ...base, owner: dao, ownerKind: 'sputnik' };
    v2(daoOwned);
    chain.config = { ...chain.config, owner: dao };
    const p = councilPolicy([...council.members.slice(0, 2), 'mallory.testnet']);
    chain.daos.get(dao)!.policy = p;
    const r = await deploy([base.name, '--yes'], daoOwned);
    expect(r.code).toBe(1);
    expect(r.out).toContain('mallory.testnet');
    expect(r.sent).toEqual([]);
  });
});

describe('a council-owned env', () => {
  const daoOwned: Manifest = { ...base, owner: dao, ownerKind: 'sputnik' };

  it('without --approve-with: proposes the first owner step and stops until it is approved; a re-run reuses the proposal', async () => {
    v2(daoOwned);
    chain.config = { ...chain.config, owner: dao, governance_delay_ms: 600_000 };
    chain.governance!.watchdogs = [];
    const r = await deploy([base.name, '--yes'], daoOwned);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([`${A}→${dao}:add_proposal`]);
    expect(r.out).toContain('Stopped: step 1 waits for council votes');
    expect(r.out).toContain(`owner:vote 0 --member ${B} --yes`);
    const again = await deploy([base.name, '--yes'], daoOwned);
    expect(again.sent).toEqual([]);
    expect(again.out).toContain('already open');
    expect(chain.daos.get(dao)!.proposals).toHaveLength(1);
    // With a second member the same proposal executes, then the next step is proposed and approved too.
    const approved = await deploy([base.name, '--approve-with', B, '--yes'], daoOwned);
    expect(approved.code).toBe(0);
    expect(chain.governance?.watchdogs.map((w) => w.account_id)).toEqual([WATCHDOG]);
    expect(chain.daos.get(dao)!.proposals.map((p) => p.status)).toEqual(['Approved', 'Approved']);
  });
});

describe('guards', () => {
  it('a non-dev env with a signer full-access key is blocked and nothing is sent', async () => {
    const staging: Manifest = { ...base, name: 'staging', allowSignerFullAccessKey: undefined };
    v2(staging);
    const r = await deploy(['staging'], staging);
    expect(r.code).toBe(1);
    expect(r.out).toContain('may have none (D86)');
    expect(r.sent).toEqual([]);
  });

  it('--creation-plan prints the batch, reads no chain and sends nothing', async () => {
    const out: string[] = [];
    const code = await deployMain([base.name, '--creation-plan', '--wasm', wasm, '--updater-public-key', KeyPair.fromRandom('ed25519').getPublicKey().toString()], {
      loadManifest: () => base,
      rpc: () => {
        throw new Error('no RPC for a printed plan');
      },
      log: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`code_hash ${codeHashOf(readFileSync(wasm))}`);
    expect(out.join('\n')).toContain('c. DeleteKey(<creation public key');
    await expect(deployMain([base.name, '--creation-plan', '--yes'], { loadManifest: () => base, rpc: () => chain.rpc(), log: () => {} })).rejects.toThrow('never sends');
    await expect(deployMain([base.name, '--creation-plan', '--updater-public-key', 'nope'], { loadManifest: () => base, rpc: () => chain.rpc(), log: () => {} })).rejects.toThrow('ed25519');
  });
});
