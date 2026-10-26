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
import { keysUpdaterFile, readRelayerKeys, relayerKeysFile, writeRelayerKeys } from '../lib/keys.ts';
import type { AccessKeyListEntry, AccountView, TxSigner } from '../lib/near.ts';

const m = loadEnv('sandbox-dev');
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
      { public_key: fullKeys[id]!.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } },
      ...(chain.extraKeys?.[id] ?? []),
    ],
    view: (async (_account: string, method: string) => {
      if (method === 'get_config') {
        if (!chain.config) throw new Error('CodeDoesNotExist');
        return chain.config;
      }
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
    rpc: () => rpc,
    log: (l) => out.push(l),
    home,
    secretsRoot,
    buildWasm: () => {
      built++;
      return wasm;
    },
    existingWasm: () => wasm,
  });
  return { code, sent, out: out.join('\n'), built };
}

const initialised = { owner: m.owner, mpc: m.mpc, ckd_domain_id: m.ckdDomainId, change_delay_ms: m.changeDelayMs, sponsors: [], console_audiences: [] };

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
      `${m.relayer}→${m.relayer}`, // relayer keys
      `${m.signer}→${m.signer}`, // keys-updater key
      `${m.owner}→${m.signer}`, // set_issuer
      `${m.owner}→${m.signer}`, // set_sponsors
    ]);
    expect(r.sent[0]?.actions.map((a) => a.enum)).toEqual(['deployContract', 'functionCall']);
    expect(r.sent[1]?.actions.map((a) => a.enum)).toEqual(['addKey', 'addKey', 'addKey']);
  });
});

describe('deploy-contract never prints secrets', () => {
  it('keeps generated relayer / keys-updater keys and keychain keys out of the output; files are 0600', async () => {
    const r = await deploy([m.name, '--yes'], { config: initialised, codeHash: 'abc' });
    expect(r.code).toBe(0);
    expect(r.sent.map((t) => t.receiver)).toEqual([m.relayer, m.signer, m.signer, m.signer]);

    const relayerKeys = readRelayerKeys(m.name, secretsRoot);
    expect(relayerKeys).toHaveLength(3);
    const updater = JSON.parse(readFileSync(keysUpdaterFile(m.name, secretsRoot), 'utf8')) as { private_key: string; public_key: string };
    expect(mode(relayerKeysFile(m.name, secretsRoot))).toBe(0o600);
    expect(mode(keysUpdaterFile(m.name, secretsRoot))).toBe(0o600);
    expect(mode(join(secretsRoot, '.secrets', m.name))).toBe(0o700);

    // Public keys are printed (so the output was captured) ...
    for (const k of relayerKeys) expect(r.out).toContain(k.getPublicKey().toString());
    expect(r.out).toContain(updater.public_key);
    // ... secret keys never are, nor any part of them.
    const secrets = [...relayerKeys.map((k) => k.toString()), updater.private_key, ...Object.values(fullKeys).map((k) => k.toString())];
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
    expect(r.out).toContain(`${old.getPublicKey().toString()}: a function-call key for old-signer.testnet`);
    expect(r.out).not.toContain(old.toString());
    expect(r.sent).toEqual([]);
  });
});

describe('admin scope:register --yes gate', () => {
  const run = async (argv: string[]) => {
    const sent: SentTx[] = [];
    let rpcMade = 0;
    const out: string[] = [];
    await scopeRegister(m, parseCli(argv, { multiple: ['client', 'owner-near', 'owner-google'], booleans: ['yes'] }), {
      rpc: () => {
        rpcMade++;
        return {
          chainId: async () => 'testnet',
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
  });
});
