// deploy-guestbook end to end against a stub chain and a temp keychain: the --yes gate (a dry run sends nothing), the
// one deploy + new() transaction, the blockers, --lock, and that no secret key reaches the output.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Manifest, loadEnv } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import type { Action } from '@near-js/transactions';
import { CliError } from '../lib/cli.ts';
import { GUESTBOOK_DRY_RUN_LINE, GUESTBOOK_INIT_GAS, GUESTBOOK_STATE_BYTES, type GuestbookRpc, guestbookMain, guestbookNeedYocto } from '../lib/guestbook-deploy.ts';
import { type AccessKeyListEntry, type AccountView, codeHashOf, EMPTY_CODE_HASH, STORAGE_YOCTO_PER_BYTE, type TxSigner } from '../lib/near.ts';

const env = loadEnv('sandbox-dev');
const BOOK = env.near!.demoGuestbook!;
const NEAR = 10n ** 24n;
const WASM_BYTES = 2000;

let home: string;
let wasm: string;
let key: KeyPair;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'hana-id-guestbook-'));
  home = join(root, 'home');
  wasm = join(root, 'hana_guestbook.wasm');
  writeFileSync(wasm, Buffer.alloc(WASM_BYTES, 7));
  const dir = join(home, '.near-credentials', 'testnet');
  mkdirSync(dir, { recursive: true });
  key = KeyPair.fromRandom('ed25519');
  writeFileSync(join(dir, `${BOOK}.json`), JSON.stringify({ account_id: BOOK, public_key: key.getPublicKey().toString(), private_key: key.toString() }), { mode: 0o600 });
});

interface Chain {
  exists: boolean;
  balance: bigint;
  codeHash: string;
  /** Answer of total_messages(); null = the view fails. */
  total: number | null;
  keys: AccessKeyListEntry[];
  chainId?: string;
}

const fullKey = (k: KeyPair): AccessKeyListEntry => ({ public_key: k.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } });
const fresh = (over: Partial<Chain> = {}): Chain => ({ exists: true, balance: 10n * NEAR, codeHash: EMPTY_CODE_HASH, total: null, keys: [fullKey(key)], ...over });

interface SentTx {
  signer: string;
  publicKey: string;
  receiver: string;
  actions: Action[];
}

function stub(chain: Chain) {
  const sent: SentTx[] = [];
  const rpc: GuestbookRpc = {
    chainId: async () => chain.chainId ?? 'testnet',
    account: async (id: string): Promise<AccountView | null> => {
      expect(id).toBe(BOOK);
      return chain.exists ? { amount: chain.balance.toString(), locked: '0', code_hash: chain.codeHash, storage_usage: 182 } : null;
    },
    accessKeys: async () => chain.keys,
    view: (async (_account: string, method: string) => {
      expect(method).toBe('total_messages');
      if (chain.total === null) throw new Error('CodeDoesNotExist');
      return chain.total;
    }) as GuestbookRpc['view'],
    sendTx: async (signer: TxSigner, receiver: string, actions: Action[]) => {
      sent.push({ signer: signer.accountId, publicKey: signer.keyPair.getPublicKey().toString(), receiver, actions });
      for (const a of actions) {
        if (a.deployContract) chain.codeHash = codeHashOf(a.deployContract.code);
        if (a.functionCall?.methodName === 'new') chain.total = 0;
        if (a.deleteKey) chain.keys = chain.keys.filter((k) => k.public_key !== a.deleteKey!.publicKey.toString());
      }
      return { hash: `hash${sent.length}`, value: null };
    },
  };
  return { rpc, sent };
}

async function run(argv: string[], chain: Chain, manifest: Manifest = env) {
  const { rpc, sent } = stub(chain);
  const out: string[] = [];
  let built = 0;
  const code = await guestbookMain(argv, {
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
  // Never a secret key in the output.
  expect(text).not.toContain(key.toString());
  expect(text).not.toContain(key.toString().slice(8, 40));
  return { code, sent, out: text, built };
}

describe('deploy-guestbook', () => {
  it('a dry run prints the plan and sends nothing', async () => {
    const r = await run(['sandbox-dev'], fresh());
    expect(r.code).toBe(0);
    expect(r.sent).toEqual([]);
    expect(r.built).toBe(0);
    expect(r.out).toContain(`guestbook ${BOOK}`);
    expect(r.out).toContain('1. build contracts/hana-guestbook (cargo near build non-reproducible-wasm --no-abi)');
    expect(r.out).toContain(`2. deploy the guestbook to ${BOOK} and call new() in the same transaction`);
    expect(r.out).toContain(GUESTBOOK_DRY_RUN_LINE);
  });

  it('--yes builds, then deploys and initialises in one transaction signed by the keychain key', async () => {
    const chain = fresh();
    const r = await run(['sandbox-dev', '--yes'], chain);
    expect(r.code).toBe(0);
    expect(r.built).toBe(1);
    expect(r.sent).toHaveLength(1);
    const [tx] = r.sent;
    expect(tx!.signer).toBe(BOOK);
    expect(tx!.receiver).toBe(BOOK);
    expect(tx!.publicKey).toBe(key.getPublicKey().toString());
    expect(tx!.actions).toHaveLength(2);
    expect(tx!.actions[0]!.deployContract!.code).toHaveLength(WASM_BYTES);
    const init = tx!.actions[1]!.functionCall!;
    expect(init.methodName).toBe('new');
    expect(Buffer.from(init.args).toString()).toBe('{}');
    expect(init.gas).toBe(GUESTBOOK_INIT_GAS);
    expect(init.deposit).toBe(0n);
    expect(chain.keys).toHaveLength(1);
    expect(r.out).toContain('total_messages() = 0');
    expect(r.out).toContain('still has its full-access key');
    expect(r.out).toContain('deploy-guestbook sandbox-dev --lock --yes');
  });

  it('--wasm skips the build and deploys that file', async () => {
    const r = await run(['sandbox-dev', '--wasm', wasm, '--yes'], fresh());
    expect(r.code).toBe(0);
    expect(r.built).toBe(0);
    expect(r.out).toContain(`code_hash ${codeHashOf(Buffer.alloc(WASM_BYTES, 7))}`);
  });

  it('--lock with the deploy deletes the key in the same transaction', async () => {
    const chain = fresh();
    const r = await run(['sandbox-dev', '--skip-build', '--lock', '--yes'], chain);
    expect(r.code).toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.actions.map((a) => Object.keys(a).find((k) => (a as unknown as Record<string, unknown>)[k] !== undefined))).toEqual(['deployContract', 'functionCall', 'deleteKey']);
    expect(chain.keys).toEqual([]);
    expect(r.out).toContain('has no access keys: its code and messages are final');
  });

  it('once deployed: nothing to do; --lock deletes every key on its own', async () => {
    const other = KeyPair.fromRandom('ed25519');
    const deployed = () => fresh({ codeHash: codeHashOf(Buffer.alloc(WASM_BYTES, 7)), total: 12, keys: [fullKey(key), { public_key: other.getPublicKey().toString(), access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: BOOK, method_names: [] } } } }] });
    const again = await run(['sandbox-dev', '--yes'], deployed());
    expect(again.code).toBe(0);
    expect(again.sent).toEqual([]);
    expect(again.built).toBe(0);
    expect(again.out).toContain('12 messages so far');
    expect(again.out).toContain('Nothing to do.');

    const chain = deployed();
    const locked = await run(['sandbox-dev', '--lock', '--yes'], chain);
    expect(locked.code).toBe(0);
    expect(locked.sent).toHaveLength(1);
    expect(locked.sent[0]!.actions.map((a) => a.deleteKey?.publicKey.toString())).toEqual([key.getPublicKey().toString(), other.getPublicKey().toString()]);
    expect(chain.keys).toEqual([]);

    const done = await run(['sandbox-dev', '--lock', '--yes'], chain);
    expect(done.code).toBe(0);
    expect(done.sent).toEqual([]);
    expect(done.out).toContain('has no access keys (locked)');
  });

  it('blocks a missing account with the command that creates it', async () => {
    const r = await run(['sandbox-dev', '--yes'], fresh({ exists: false }));
    expect(r.code).toBe(1);
    expect(r.sent).toEqual([]);
    expect(r.out).toContain(`near account create-account sponsor-by-faucet-service ${BOOK} autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`);
  });

  it('blocks an underfunded account with the amount needed', async () => {
    const need = guestbookNeedYocto(182, WASM_BYTES);
    expect(need).toBe((182n + BigInt(WASM_BYTES) + GUESTBOOK_STATE_BYTES) * STORAGE_YOCTO_PER_BYTE + 10n ** 23n);
    const short = await run(['sandbox-dev', '--skip-build', '--yes'], fresh({ balance: need - 1n }));
    expect(short.code).toBe(1);
    expect(short.sent).toEqual([]);
    expect(short.out).toMatch(/needs at least 0\.\d{4} NEAR/u);
    expect(short.out).toContain(`send-near ${BOOK}`);
    expect((await run(['sandbox-dev', '--skip-build', '--yes'], fresh({ balance: need }))).code).toBe(0);
    // Before a build the check uses the estimated size (1.85 NEAR with the account's 182 bytes and the gas margin).
    const dry = await run(['sandbox-dev'], fresh({ balance: NEAR }));
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('needs at least 1.8518 NEAR (storage for about 125000 bytes of code');
  });

  it('never redeploys: other code, or another guestbook build, is a blocker', async () => {
    const other = await run(['sandbox-dev', '--yes'], fresh({ codeHash: 'Other1111111111111111111111111111', total: null }));
    expect(other.code).toBe(1);
    expect(other.out).toContain('not an initialised guestbook');
    const older = await run(['sandbox-dev', '--skip-build', '--yes'], fresh({ codeHash: 'Older1111111111111111111111111111', total: 3 }));
    expect(older.code).toBe(1);
    expect(older.out).toContain('has no upgrade path');
    expect(older.sent).toEqual([]);
  });

  it('blocks without a usable keychain key, and on the wrong chain', async () => {
    const stranger = KeyPair.fromRandom('ed25519');
    const notOnChain = await run(['sandbox-dev', '--yes'], fresh({ keys: [fullKey(stranger)] }));
    expect(notOnChain.code).toBe(1);
    expect(notOnChain.out).toContain('is not a full-access key');
    const noKeys = await run(['sandbox-dev', '--yes'], fresh({ keys: [] }));
    expect(noKeys.code).toBe(1);
    expect(noKeys.out).toContain('has no access keys: nothing can deploy to it');
    const wrongChain = await run(['sandbox-dev', '--yes'], fresh({ chainId: 'mainnet' }));
    expect(wrongChain.code).toBe(1);
    expect(wrongChain.out).toContain('is on chain "mainnet"');
  });

  it('needs near.demoGuestbook in the manifest', async () => {
    const { near: _, ...without } = env;
    await expect(run(['sandbox-dev'], fresh(), without as Manifest)).rejects.toBeInstanceOf(CliError);
    await expect(run([], fresh())).rejects.toBeInstanceOf(CliError);
  });
});
