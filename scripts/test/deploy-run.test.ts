// Runs deploy-contract and admin scope:register end to end against a stub RPC, a temp keychain and a temp .secrets
// root: checks the --yes gate (dry run sends nothing and writes nothing) and that no secret key reaches the output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import type { Action } from '@near-js/transactions';
import { parseCli } from '../lib/cli.ts';
import { scopeRegister, SCOPE_DRY_RUN_LINE } from '../lib/admin-scope.ts';
import { DRY_RUN_LINE, type DeployRpc, deployMain } from '../lib/deploy-run.ts';
import { keysUpdaterFile, poolKeysFile, readKeysUpdater, readPoolKeys, readRelayerKeys, relayerKeysFile, writeRelayerKeys } from '../lib/keys.ts';
import type { AccessKeyListEntry, AccountView, TxSigner } from '../lib/near.ts';
import { ACCOUNT_OWNER, GOVERNANCE_DEFAULT, NOW } from './sim-fixtures.ts';

const m = {
  ...loadEnv('sandbox-dev'),
  ...ACCOUNT_OWNER,
  // The Google fields as an undeployed manifest has them; the real envs/sandbox-dev.json changes as it is deployed.
  googleClientIds: ['UNSET.apps.googleusercontent.com'],
  sharedGoogleClientIds: ['UNSET-shared.apps.googleusercontent.com'],
  consoleAudiences: [],
};
const NEAR = 10n ** 24n;
const mode = (p: string) => statSync(p).mode & 0o777;

interface SentTx {
  signer: string;
  receiver: string;
  actions: Action[];
}

let home: string;
let secretsRoot: string;
let wasm: string;
/** Full-access keys of signer/relayer/owner, written to the temp keychain. */
let fullKeys: Record<string, KeyPair>;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'hana-id-deploy-'));
  home = join(root, 'home');
  secretsRoot = join(root, 'repo');
  mkdirSync(secretsRoot);
  wasm = join(root, 'hana_signer.wasm');
  writeFileSync(wasm, Buffer.alloc(1000));
  const dir = join(home, '.near-credentials', 'testnet');
  mkdirSync(dir, { recursive: true });
  fullKeys = {};
  for (const account of [m.signer, m.relayer, m.owner]) {
    const k = KeyPair.fromRandom('ed25519');
    fullKeys[account] = k;
    writeFileSync(join(dir, `${account}.json`), JSON.stringify({ account_id: account, public_key: k.getPublicKey().toString(), private_key: k.toString() }), { mode: 0o600 });
  }
});

interface Chain {
  /** get_config result; null = not initialised (view fails like a code-less account). */
  config: object | null;
  codeHash: string;
  /** Extra access keys per account, on top of the full-access keychain key. */
  extraKeys?: Record<string, AccessKeyListEntry[]>;
}

function stubRpc(chain: Chain) {
  const sent: SentTx[] = [];
  const rpc: DeployRpc = {
    chainId: async () => 'testnet',
    account: async (id: string): Promise<AccountView> => ({ amount: (10n * NEAR).toString(), locked: '0', code_hash: id === m.signer ? chain.codeHash : '11111111111111111111111111111111', storage_usage: 0 }),
    accessKeys: async (id: string) => [
      ...(fullKeys[id] ? [{ public_key: fullKeys[id].getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' as const } }] : []),
      ...(chain.extraKeys?.[id] ?? []),
    ],
    view: (async (_account: string, method: string) => {
      if (method === 'get_config') {
        if (!chain.config) throw new Error('CodeDoesNotExist');
        return chain.config;
      }
      // A governance contract with the manifest's watchdog and no updater key yet.
      if (method === 'get_governance' && chain.config) return { ...GOVERNANCE_DEFAULT, watchdogs: m.watchdogs!.map((account_id) => ({ account_id, confirm_from_ms: 0 })) };
      return null;
    }) as DeployRpc['view'],
    sendTx: async (signer: TxSigner, receiver: string, actions: Action[]) => {
      sent.push({ signer: signer.accountId, receiver, actions });
      return { hash: `hash${sent.length}`, value: null };
    },
  };
  return { rpc, sent };
}

async function deploy(argv: string[], chain: Chain) {
  const { rpc, sent } = stubRpc(chain);
  const out: string[] = [];
  let built = 0;
  const code = await deployMain(argv, {
    loadManifest: () => m,
    rpc: () => rpc,
    log: (l) => out.push(l),
    home,
    secretsRoot,
    buildWasm: () => {
      built++;
      return wasm;
    },
    existingWasm: () => wasm,
    updateManifest: () => {
      throw new Error('no manifest edits in these tests');
    },
    now: () => NOW,
    sputnikCodeHash: 'AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH',
  });
  return { code, sent, out: out.join('\n'), built };
}

const initialised = {
  owner: m.owner,
  mpc: m.mpc,
  ckd_domain_id: m.ckdDomainId,
  change_delay_ms: m.changeDelayMs,
  sponsors: [],
  console_audiences: [],
  shared_clients: [],
  issuer_key_delay_ms: m.issuerKeyDelayMs,
  governance_delay_ms: m.governanceDelayMs,
  paused: false,
};

describe('deploy-contract --yes gate', () => {
  it('without --yes prints the plan, sends nothing, builds nothing and writes no .secrets', async () => {
    const r = await deploy([m.name], { config: null, codeHash: '11111111111111111111111111111111' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Plan:');
    expect(r.out).toContain(`Deploy wasm to ${m.signer}`);
    expect(r.out.trimEnd().endsWith(DRY_RUN_LINE)).toBe(true);
    expect(r.sent).toEqual([]);
    expect(r.built).toBe(0);
    expect(existsSync(join(secretsRoot, '.secrets'))).toBe(false);
  });

  it('with --yes runs every planned step', async () => {
    const r = await deploy([m.name, '--yes'], { config: null, codeHash: '11111111111111111111111111111111' });
    expect(r.code).toBe(0);
    expect(r.built).toBe(1);
    expect(r.out).not.toContain(DRY_RUN_LINE);
    expect(r.sent.map((t) => `${t.signer}→${t.receiver}`)).toEqual([
      `${m.signer}→${m.signer}`, // deploy + new
      `${m.relayer}→${m.relayer}`, // session-pool relayer keys
      `${m.relayer}→${m.relayer}`, // owner-pool relayer keys
      `${m.owner}→${m.signer}`, // add_updater_key: the contract installs the keys-updater key
      `${m.owner}→${m.signer}`, // set_issuer
      `${m.owner}→${m.signer}`, // set_sponsors
    ]);
    expect(r.sent[0]?.actions.map((a) => a.enum)).toEqual(['deployContract', 'functionCall']);
    const init = JSON.parse(Buffer.from(r.sent[0]!.actions[1]!.functionCall!.args).toString()) as Record<string, unknown>;
    expect(init).toEqual({
      owner: m.owner,
      mpc: m.mpc,
      ckd_domain_id: m.ckdDomainId,
      change_delay_ms: m.changeDelayMs,
      issuer_key_delay_ms: 120_000,
      governance_delay_ms: 60_000,
      watchdogs: m.watchdogs,
      updater_keys: [],
    });
    const addUpdater = r.sent[3]!.actions[0]!.functionCall!;
    expect(addUpdater.methodName).toBe('add_updater_key');
    expect(JSON.parse(Buffer.from(addUpdater.args).toString())).toEqual({ public_key: readKeysUpdater(m.name, secretsRoot)!.publicKey });
    // No hand-made AddKey on the signer any more.
    expect(r.sent.filter((t) => t.receiver === m.signer).flatMap((t) => t.actions.map((a) => a.enum))).not.toContain('addKey');
    expect(r.sent[1]?.actions.map((a) => a.enum)).toEqual(['addKey', 'addKey', 'addKey']);
    expect(r.sent[2]?.actions.map((a) => a.enum)).toEqual(['addKey']);
  });

  it('adds each pool with its own method list, count and allowance', async () => {
    const r = await deploy([m.name, '--yes', '--relayer-keys', '2', '--relayer-allowance', '3', '--owner-relayer-keys', '2', '--owner-relayer-allowance', '0.25'], {
      config: initialised,
      codeHash: 'abc',
    });
    expect(r.code).toBe(0);
    const perm = (tx: SentTx | undefined) => tx?.actions.map((a) => a.addKey?.accessKey.permission.functionCall);
    const session = perm(r.sent[0]);
    const owner = perm(r.sent[1]);
    expect(session).toHaveLength(2);
    expect(owner).toHaveLength(2);
    expect(session?.[0]).toMatchObject({ receiverId: m.signer, methodNames: ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'prune_sessions'], allowance: 3n * NEAR });
    expect(owner?.[0]).toMatchObject({
      receiverId: m.signer,
      methodNames: ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change', 'register_scope', 'apply_pending_config'],
      allowance: NEAR / 4n,
    });
    // The two pools hold different keys, each in its own file.
    const sessionKeys = readPoolKeys(m.name, 'session', secretsRoot).map((k) => k.getPublicKey().toString());
    const ownerKeys = readPoolKeys(m.name, 'owner', secretsRoot).map((k) => k.getPublicKey().toString());
    expect(sessionKeys).toHaveLength(2);
    expect(ownerKeys).toHaveLength(2);
    expect(sessionKeys.filter((k) => ownerKeys.includes(k))).toEqual([]);
  });

  it('rejects bad pool flags', async () => {
    await expect(deploy([m.name, '--owner-relayer-keys', '0'], { config: initialised, codeHash: 'abc' })).rejects.toThrow('--owner-relayer-keys must be between 1 and 5');
    await expect(deploy([m.name, '--owner-relayer-allowance', '0'], { config: initialised, codeHash: 'abc' })).rejects.toThrow('--owner-relayer-allowance must be more than 0');
    await expect(deploy([m.name, '--relayer-allowance', 'lots'], { config: initialised, codeHash: 'abc' })).rejects.toThrow('--relayer-allowance must be a NEAR amount');
  });
});

describe('deploy-contract never prints secrets', () => {
  it('keeps generated relayer / keys-updater keys and keychain keys out of the output; files are 0600', async () => {
    const r = await deploy([m.name, '--yes'], { config: initialised, codeHash: 'abc' });
    expect(r.code).toBe(0);
    expect(r.sent.map((t) => t.receiver)).toEqual([m.relayer, m.relayer, m.signer, m.signer, m.signer]);

    const relayerKeys = readRelayerKeys(m.name, secretsRoot);
    expect(relayerKeys).toHaveLength(3);
    const ownerKeys = readPoolKeys(m.name, 'owner', secretsRoot);
    expect(ownerKeys).toHaveLength(1);
    expect(mode(poolKeysFile(m.name, 'owner', secretsRoot))).toBe(0o600);
    const updater = JSON.parse(readFileSync(keysUpdaterFile(m.name, secretsRoot), 'utf8')) as { private_key: string; public_key: string };
    expect(mode(relayerKeysFile(m.name, secretsRoot))).toBe(0o600);
    expect(mode(keysUpdaterFile(m.name, secretsRoot))).toBe(0o600);
    expect(mode(join(secretsRoot, '.secrets', m.name))).toBe(0o700);

    // Public keys are printed (so the output was captured) ...
    for (const k of [...relayerKeys, ...ownerKeys]) expect(r.out).toContain(k.getPublicKey().toString());
    expect(r.out).toContain(updater.public_key);
    // ... secret keys never are, nor any part of them.
    const secrets = [...relayerKeys.map((k) => k.toString()), ...ownerKeys.map((k) => k.toString()), updater.private_key, ...Object.values(fullKeys).map((k) => k.toString())];
    for (const s of secrets) {
      expect(r.out).not.toContain(s);
      expect(r.out).not.toContain(s.slice('ed25519:'.length, 'ed25519:'.length + 20));
    }
  });
});

describe('deploy-contract with relayer keys left from a previous signer', () => {
  it('blocks instead of sending an AddKey that would fail with AddKeyAlreadyExists', async () => {
    const old = KeyPair.fromRandom('ed25519');
    writeRelayerKeys(m.name, [old], secretsRoot);
    const extraKeys = {
      [m.relayer]: [
        {
          public_key: old.getPublicKey().toString(),
          access_key: { nonce: 5, permission: { FunctionCall: { allowance: null, receiver_id: 'old-signer.testnet', method_names: [] } } },
        },
      ],
    };
    const r = await deploy([m.name, '--yes'], { config: initialised, codeHash: 'abc', extraKeys });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Cannot deploy');
    expect(r.out).toContain(`${old.getPublicKey().toString()} is a function-call key for old-signer.testnet (ANY method), not for ${m.signer}`);
    expect(r.out).not.toContain(old.toString());
    expect(r.sent).toEqual([]);
  });
});

describe('deploy-contract compares on-chain key permissions', () => {
  it('blocks a batch A relayer key (single pool with owner methods) instead of passing it as in place', async () => {
    const old = KeyPair.fromRandom('ed25519');
    writeRelayerKeys(m.name, [old], secretsRoot);
    const batchA = ['create_session', 'derive_key', 'revoke_session', 'prune_sessions', 'register_scope', 'propose_change', 'cancel_change', 'remove_client', 'execute_change'];
    const extraKeys = {
      [m.relayer]: [{ public_key: old.getPublicKey().toString(), access_key: { nonce: 5, permission: { FunctionCall: { allowance: null, receiver_id: m.signer, method_names: batchA } } } }],
    };
    const r = await deploy([m.name, '--yes'], { config: initialised, codeHash: 'abc', extraKeys });
    expect(r.code).toBe(1);
    expect(r.out).toContain('with the wrong permission for the session pool');
    expect(r.out).toContain(`has methods ${batchA.join(', ')}`);
    expect(r.out).not.toContain(old.toString());
    expect(r.sent).toEqual([]);
  });

  it('blocks a session key with an earlier allowlist (A.2, no create_session_and_derive) and says how to rotate it', async () => {
    // Access-key permissions can't be edited: each allowlist change (docs/batch-b-spec.md "Relayer allowlists") is a
    // delete and re-add of every session-pool key.
    const old = KeyPair.fromRandom('ed25519');
    writeRelayerKeys(m.name, [old], secretsRoot);
    const a2 = ['create_session', 'derive_key', 'revoke_session', 'prune_sessions'];
    const extraKeys = {
      [m.relayer]: [{ public_key: old.getPublicKey().toString(), access_key: { nonce: 5, permission: { FunctionCall: { allowance: String(NEAR), receiver_id: m.signer, method_names: a2 } } } }],
    };
    const r = await deploy([m.name, '--yes'], { config: initialised, codeHash: 'abc', extraKeys });
    expect(r.code).toBe(1);
    expect(r.out).toContain('with the wrong permission for the session pool');
    expect(r.out).toContain(`has methods ${a2.join(', ')}; expected create_session, create_session_and_derive, derive_key, revoke_session, prune_sessions`);
    expect(r.out).toContain(`near account delete-keys ${m.relayer} public-keys ${old.getPublicKey().toString()}`);
    expect(r.out).not.toContain(old.toString());
    expect(r.sent).toEqual([]);
  });
});

describe('admin scope:register --yes gate', () => {
  const run = async (argv: string[]) => {
    const sent: SentTx[] = [];
    let rpcMade = 0;
    const out: string[] = [];
    await scopeRegister(m, parseCli(argv, { multiple: ['client', 'owner-near', 'owner-google'], booleans: ['yes', 'allow-shared'] }), {
      rpc: () => {
        rpcMade++;
        return {
          chainId: async () => 'testnet',
          view: (async () => null) as <T>() => Promise<T>,
          sendTx: async (signer: TxSigner, receiver: string, actions: Action[]) => {
            sent.push({ signer: signer.accountId, receiver, actions });
            return { hash: 'h', value: 's1' };
          },
        };
      },
      log: (l) => out.push(l),
      home,
    });
    return { sent, rpcMade, out: out.join('\n') };
  };
  const argv = ['--client', 'partner.apps.googleusercontent.com', '--owner-near', 'partner.testnet'];

  it('without --yes only prints the call', async () => {
    const r = await run(argv);
    expect(r.out).toContain('admin_register_scope({"owners":[{"Near":{"account_id":"partner.testnet"}}]');
    expect(r.out.trimEnd().endsWith(SCOPE_DRY_RUN_LINE)).toBe(true);
    expect(r.rpcMade).toBe(0);
    expect(r.sent).toEqual([]);
  });

  it('with --yes sends one admin_register_scope signed by the owner, without printing its key', async () => {
    const r = await run([...argv, '--yes']);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ signer: m.owner, receiver: m.signer });
    expect(r.sent[0]?.actions[0]?.functionCall?.methodName).toBe('admin_register_scope');
    expect(r.out).toContain('Registered scope: s1');
    expect(r.out).not.toContain(fullKeys[m.owner]!.toString());
    const args = JSON.parse(Buffer.from(r.sent[0]!.actions[0]!.functionCall!.args).toString()) as unknown;
    expect(args).toEqual({ owners: [{ Near: { account_id: 'partner.testnet' } }], clients: [['google', 'partner.apps.googleusercontent.com']], scope_id: null, allow_shared: false });
  });

  it('--allow-shared with no --client registers a shared-only scope', async () => {
    const r = await run(['--allow-shared', '--owner-near', 'partner.testnet', '--yes']);
    const args = JSON.parse(Buffer.from(r.sent[0]!.actions[0]!.functionCall!.args).toString()) as unknown;
    expect(args).toEqual({ owners: [{ Near: { account_id: 'partner.testnet' } }], clients: [], scope_id: null, allow_shared: true });
    expect(r.out).toContain("through Hana's shared Google client only");
    expect(r.out).toContain('has no shared Google client yet'); // sandbox-dev's shared client is a placeholder
  });

  it('--allow-shared with --client keeps both login routes', async () => {
    const r = await run([...argv, '--allow-shared']);
    expect(r.out).toContain('"allow_shared":true');
    expect(r.out).toContain("and through Hana's shared client");
    expect(r.sent).toEqual([]);
  });

  it('refuses zero clients without --allow-shared, and the shared client as an own client', async () => {
    await expect(run(['--owner-near', 'partner.testnet'])).rejects.toThrow('--allow-shared');
    await expect(run(['--client', m.sharedGoogleClientIds[0]!, '--owner-near', 'partner.testnet'])).rejects.toThrow("is Hana's shared Google client");
  });
});
