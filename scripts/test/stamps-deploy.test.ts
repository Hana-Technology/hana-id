// deploy-stamps (D796) end to end against a stub chain and a temp keychain: the same shared flow as deploy-guestbook
// (lib/demo-deploy.ts; test/guestbook-deploy.test.ts covers it in full), with the stamps contract's account, probe
// (`totals()`), balance and texts: the --yes gate, the one deploy + new() transaction, the blockers, --lock, and that
// no secret key reaches the output.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Manifest, loadEnv } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import type { Action } from '@near-js/transactions';
import { CliError } from '../lib/cli.ts';
import { DEMO_DRY_RUN_LINE, DEMO_INIT_GAS, type DemoRpc } from '../lib/demo-deploy.ts';
import { STAMPS_STATE_BYTES, STAMPS_USAGE, stampsMain, stampsNeedYocto } from '../lib/stamps-deploy.ts';
import { type AccessKeyListEntry, type AccountView, codeHashOf, EMPTY_CODE_HASH, STORAGE_YOCTO_PER_BYTE, type TxSigner } from '../lib/near.ts';

const env = loadEnv('sandbox-dev');
const STAMPS = env.near!.demoStamps!;
const NEAR = 10n ** 24n;
const WASM_BYTES = 3000;

let home: string;
let wasm: string;
let key: KeyPair;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'hana-id-stamps-'));
  home = join(root, 'home');
  wasm = join(root, 'hana_stamps.wasm');
  writeFileSync(wasm, Buffer.alloc(WASM_BYTES, 5));
  const dir = join(home, '.near-credentials', 'testnet');
  mkdirSync(dir, { recursive: true });
  key = KeyPair.fromRandom('ed25519');
  writeFileSync(join(dir, `${STAMPS}.json`), JSON.stringify({ account_id: STAMPS, public_key: key.getPublicKey().toString(), private_key: key.toString() }), { mode: 0o600 });
});

interface Chain {
  exists: boolean;
  balance: bigint;
  codeHash: string;
  /** Answer of totals(); null = the view fails. */
  totals: unknown;
  keys: AccessKeyListEntry[];
  chainId?: string;
  /** What totals() answers right after new() (default: zeros). */
  afterNew?: unknown;
}

const fullKey = (k: KeyPair): AccessKeyListEntry => ({ public_key: k.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } });
const fresh = (over: Partial<Chain> = {}): Chain => ({ exists: true, balance: 10n * NEAR, codeHash: EMPTY_CODE_HASH, totals: null, keys: [fullKey(key)], ...over });
const ourHash = () => codeHashOf(Buffer.alloc(WASM_BYTES, 5));

function stub(chain: Chain) {
  const sent: { signer: string; receiver: string; actions: Action[] }[] = [];
  const views: string[] = [];
  const rpc: DemoRpc = {
    chainId: async () => chain.chainId ?? 'testnet',
    account: async (id: string): Promise<AccountView | null> => {
      expect(id).toBe(STAMPS);
      return chain.exists ? { amount: chain.balance.toString(), locked: '0', code_hash: chain.codeHash, storage_usage: 182 } : null;
    },
    accessKeys: async () => chain.keys,
    view: (async (_account: string, method: string) => {
      views.push(method);
      if (chain.totals === null) throw new Error('CodeDoesNotExist');
      return chain.totals;
    }) as DemoRpc['view'],
    sendTx: async (signer: TxSigner, receiver: string, actions: Action[]) => {
      sent.push({ signer: signer.accountId, receiver, actions });
      for (const a of actions) {
        if (a.deployContract) chain.codeHash = codeHashOf(a.deployContract.code);
        if (a.functionCall?.methodName === 'new') chain.totals = chain.afterNew ?? { passports: 0, stamps: 0 };
        if (a.deleteKey) chain.keys = chain.keys.filter((k) => k.public_key !== a.deleteKey!.publicKey.toString());
      }
      return { hash: `hash${sent.length}`, value: null };
    },
  };
  return { rpc, sent, views };
}

async function run(argv: string[], chain: Chain, manifest: Manifest = env) {
  const { rpc, sent, views } = stub(chain);
  const out: string[] = [];
  let built = 0;
  const code = await stampsMain(argv, {
    loadManifest: () => manifest,
    rpc: () => rpc,
    log: (l) => out.push(l),
    home,
    buildWasm: () => {
      built++;
      return wasm;
    },
    existingWasm: () => wasm,
  });
  const text = out.join('\n');
  expect(text).not.toContain(key.toString());
  expect(text).not.toContain(key.toString().slice(8, 40));
  return { code, sent, views, out: text, built };
}

const kinds = (actions: Action[]) => actions.map((a) => Object.keys(a).find((k) => (a as unknown as Record<string, unknown>)[k] !== undefined));

describe('deploy-stamps', () => {
  it('deploys to near.demoStamps: a dry run prints the plan and sends nothing', async () => {
    expect(STAMPS).toBe('hana-id-stamps-dev1.testnet');
    expect(STAMPS_USAGE).toContain('Usage: deploy-stamps.ts <env> [--yes] [--lock] [--wasm <file>] [--skip-build]');
    expect(STAMPS_USAGE).toContain('contracts/hana-stamps/target/near/hana_stamps.wasm');
    const r = await run(['sandbox-dev'], fresh());
    expect([r.code, r.sent, r.built]).toEqual([0, [], 0]);
    expect(r.out).toContain(`stamps contract ${STAMPS}`);
    expect(r.out).toContain('1. build contracts/hana-stamps (cargo near build non-reproducible-wasm --no-abi)');
    expect(r.out).toContain(`2. deploy the stamps contract to ${STAMPS} and call new() in the same transaction`);
    expect(r.out).toContain(DEMO_DRY_RUN_LINE);
  });

  it('--yes builds, deploys and initialises in one transaction, then checks totals() is zero', async () => {
    const chain = fresh();
    const r = await run(['sandbox-dev', '--yes'], chain);
    expect([r.code, r.built, r.sent.length]).toEqual([0, 1, 1]);
    const [tx] = r.sent;
    expect([tx!.signer, tx!.receiver]).toEqual([STAMPS, STAMPS]);
    expect(kinds(tx!.actions)).toEqual(['deployContract', 'functionCall']);
    const init = tx!.actions[1]!.functionCall!;
    expect([init.methodName, Buffer.from(init.args).toString(), init.gas, init.deposit]).toEqual(['new', '{}', DEMO_INIT_GAS, 0n]);
    expect(r.views).toEqual(['totals']);
    expect(r.out).toContain('totals() = {"passports":0,"stamps":0}');
    expect(r.out).toContain('whoever holds it can replace the code and every passport');
    expect(r.out).toContain('deploy-stamps sandbox-dev --lock --yes');
    expect(chain.keys).toHaveLength(1);
  });

  it('stops when totals() after new() is not zero', async () => {
    await expect(run(['sandbox-dev', '--skip-build', '--yes'], fresh({ afterNew: { passports: 1, stamps: 1 } }))).rejects.toThrow(/expected \{"passports":0,"stamps":0\}/u);
  });

  it('--lock with the deploy deletes the key in the same transaction; once deployed, --lock deletes every key on its own', async () => {
    const chain = fresh();
    const r = await run(['sandbox-dev', '--skip-build', '--lock', '--yes'], chain);
    expect(r.code).toBe(0);
    expect(kinds(r.sent[0]!.actions)).toEqual(['deployContract', 'functionCall', 'deleteKey']);
    expect(chain.keys).toEqual([]);
    expect(r.out).toContain('has no access keys: its code and passports are final');

    const deployed = fresh({ codeHash: ourHash(), totals: { passports: 4, stamps: 17 } });
    const again = await run(['sandbox-dev', '--yes'], deployed);
    expect([again.code, again.sent, again.built]).toEqual([0, [], 0]);
    expect(again.out).toContain('4 passports, 17 stamps so far');
    expect(again.out).toContain('Nothing to do.');
    const locked = await run(['sandbox-dev', '--lock', '--yes'], deployed);
    expect(locked.sent).toHaveLength(1);
    expect(kinds(locked.sent[0]!.actions)).toEqual(['deleteKey']);
    expect(deployed.keys).toEqual([]);
    expect((await run(['sandbox-dev', '--lock', '--yes'], deployed)).out).toContain('has no access keys (locked)');
  });

  it('blocks a missing account, an underfunded one, other code, another stamps build, no usable key, the wrong chain', async () => {
    const missing = await run(['sandbox-dev', '--yes'], fresh({ exists: false }));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(`near account create-account sponsor-by-faucet-service ${STAMPS} autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`);

    const need = stampsNeedYocto(182, WASM_BYTES);
    expect(need).toBe((182n + BigInt(WASM_BYTES) + STAMPS_STATE_BYTES) * STORAGE_YOCTO_PER_BYTE + 10n ** 23n);
    const short = await run(['sandbox-dev', '--skip-build', '--yes'], fresh({ balance: need - 1n }));
    expect([short.code, short.sent]).toEqual([1, []]);
    expect(short.out).toContain(`bytes of code and ${STAMPS_STATE_BYTES} bytes of passports to start with, plus gas`);
    expect((await run(['sandbox-dev', '--skip-build', '--yes'], fresh({ balance: need }))).code).toBe(0);
    // Before a build: the estimated size (155 000 bytes), 3.6 NEAR with the account's 182 bytes and the gas margin.
    const dry = await run(['sandbox-dev'], fresh({ balance: 3n * NEAR }));
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('needs at least 3.6518 NEAR (storage for about 155000 bytes of code');

    const other = await run(['sandbox-dev', '--yes'], fresh({ codeHash: 'Other1111111111111111111111111111', totals: null }));
    expect(other.out).toContain('not an initialised stamps contract');
    const guestbookLike = await run(['sandbox-dev', '--yes'], fresh({ codeHash: 'Other1111111111111111111111111111', totals: 3 }));
    expect(guestbookLike.out).toContain('not an initialised stamps contract');
    const older = await run(['sandbox-dev', '--skip-build', '--yes'], fresh({ codeHash: 'Older1111111111111111111111111111', totals: { passports: 0, stamps: 0 } }));
    expect([older.code, older.sent]).toEqual([1, []]);
    expect(older.out).toContain('The stamps contract has no upgrade path: deploy a new version to a new account (near.demoStamps)');

    expect((await run(['sandbox-dev', '--yes'], fresh({ keys: [fullKey(KeyPair.fromRandom('ed25519'))] }))).out).toContain('is not a full-access key');
    expect((await run(['sandbox-dev', '--yes'], fresh({ keys: [] }))).out).toContain('has no access keys: nothing can deploy to it. Name a new account in near.demoStamps');
    expect((await run(['sandbox-dev', '--yes'], fresh({ chainId: 'mainnet' }))).out).toContain('is on chain "mainnet"');
  });

  it('needs near.demoStamps in the manifest', async () => {
    const { demoStamps: _, ...near } = env.near!;
    await expect(run(['sandbox-dev'], fresh(), { ...env, near } as Manifest)).rejects.toThrow(/has no near\.demoStamps.*"Hackathon demo stamps \(NEAR\)"/u);
    await expect(run([], fresh())).rejects.toBeInstanceOf(CliError);
  });
});
