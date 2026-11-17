// A local anvil for the EVM deploy tests (D849): `anvil --hardfork prague` on a free port of 127.0.0.1, started inside
// the test and stopped after it. Nothing here talks to a public network. Foundry is optional, as for verify's `evm`
// step: without `anvil` and `cast` on the PATH the tests that need them skip and say why.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runs = (tool: string) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;

/** Why the anvil tests can't run here, or null. */
export const FOUNDRY_MISSING: string | null = runs('anvil') && runs('cast') ? null : 'Foundry not installed (no `anvil`/`cast` on PATH; contracts/evm-delegate/README.md): the anvil tests are skipped';

/** A free TCP port on 127.0.0.1 (the OS picks it; anvil binds it a moment later). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface Anvil {
  url: string;
  rpc: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
  stop: () => Promise<void>;
}

/** Starts anvil (Prague) and waits until it answers eth_chainId. */
export async function startAnvil(opts: { chainId?: number; noCreate2Deployer?: boolean } = {}): Promise<Anvil> {
  const port = await freePort();
  const args = ['--hardfork', 'prague', '--host', '127.0.0.1', '--port', String(port), '--silent', ...(opts.chainId ? ['--chain-id', String(opts.chainId)] : []), ...(opts.noCreate2Deployer ? ['--disable-default-create2-deployer'] : [])];
  const child: ChildProcess = spawn('anvil', args, { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  let id = 0;
  const rpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await rpc('eth_chainId');
      break;
    } catch {
      if (Date.now() > deadline || child.exitCode !== null) {
        child.kill('SIGKILL');
        throw new Error(`anvil did not start on port ${port}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  return { url, rpc, stop };
}

/** anvil's published development mnemonic (its default accounts: public test keys, never funded anywhere real). */
export const ANVIL_TEST_MNEMONIC = 'test test test test test test test test test test test junk';
/** Its first account, funded with 10 000 test ETH on every anvil. */
export const ANVIL_DEV_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * A temporary Foundry keystore holding anvil's first development account, as `cast wallet import` makes one. Returns
 * the keystore's directory, its name and its (throwaway) password.
 */
export function devKeystore(): { dir: string; name: string; password: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hana-evm-keystore-'));
  const name = 'hana-test-deployer';
  const password = `test-only-${Math.random().toString(36).slice(2)}`;
  const r = spawnSync('cast', ['wallet', 'import', name, '--mnemonic', ANVIL_TEST_MNEMONIC, '--mnemonic-index', '0', '--keystore-dir', dir, '--unsafe-password', password], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cast wallet import failed: ${r.stderr}`);
  return { dir, name, password };
}
