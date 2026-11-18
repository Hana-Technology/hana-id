// The anvil lane's global setup (Node, D868): starts `anvil --hardfork prague` on chain 31337 on a free loopback port,
// deploys the REAL HanaDelegateExecutor and CheckIn from their checked-in artifacts with the repo's own deploy library
// (scripts/lib/evm-delegate-deploy.ts, through the deterministic deployment proxy anvil has), checks both runtime code
// hashes are core's pin, and hands the URL to the Workers tests (`inject('anvil')`). Stops anvil after the run, also
// when the run fails or is interrupted. Nothing here talks to a public network; the deploy signs as anvil's first
// published development account (unlocked on every anvil: no key is read or written).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '@hana-id/env';
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import type { TestProject } from 'vitest/node';
import '../provided.ts';
import { keccakHex, loadDelegateArtifacts } from '../../../../scripts/lib/evm-delegate-artifacts.ts';
import { type RunTool, evmDeployMain, foundryEnv } from '../../../../scripts/lib/evm-delegate-deploy.ts';
import { ANVIL_DEV_ADDRESS, type Anvil, FOUNDRY_MISSING, startAnvil } from '../../../../scripts/test/anvil.ts';

/** `safe` = head − this on our anvil: the relayer's confirmed depth, reached with a few `anvil_mine` blocks. */
export const SAFE_DEPTH = 4;
/** The starting base fee (0.01 gwei): below the test manifest's 1 gwei cap with room for the relayer's two bumps. */
export const START_BASE_FEE_WEI = 10_000_000;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [delegate, checkIn] = loadDelegateArtifacts();
  const skip = (why: string) => {
    if (process.env.HANA_ANVIL_REQUIRED === '1') throw new Error(`HANA_ANVIL_REQUIRED=1 but ${why}`);
    project.provide('anvil', { url: null, skipped: why, safeDepth: SAFE_DEPTH, delegate: delegate!.address, checkIn: checkIn!.address });
    console.warn(`anvil lane skipped: ${why}`);
    return async () => undefined;
  };
  if (FOUNDRY_MISSING) return skip(FOUNDRY_MISSING);

  const anvil: Anvil = await startAnvil({ chainId: 31337, args: ['--base-fee', String(START_BASE_FEE_WEI), '--slots-in-an-epoch', String(SAFE_DEPTH)] });
  // A synchronous kill if the runner exits without calling the teardown (an interrupt, a crash).
  const killNow = () => {
    try {
      if (anvil.pid) process.kill(anvil.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  process.once('exit', killNow);
  const tmp = mkdtempSync(join(tmpdir(), 'hana-anvil-lane-'));
  try {
    // The deploy library's `cast send … --account <name>`, run as anvil's unlocked development account instead.
    const runTool: RunTool = (tool, argv, opts) => {
      if (tool !== 'cast') return { status: 0 };
      const i = argv.indexOf('--account');
      const mapped = i < 0 ? argv : [...argv.slice(0, i), '--from', ANVIL_DEV_ADDRESS, '--unlocked', ...argv.slice(i + 2)];
      const r = spawnSync('cast', mapped, { cwd: opts.cwd, env: foundryEnv(opts.env), encoding: 'utf8' });
      return { status: r.status };
    };
    const lines: string[] = [];
    const manifest = { name: 'local-anvil-lane', network: 'testnet' } as unknown as Manifest;
    const code = await evmDeployMain(['local-anvil-lane', '--chain', '31337', '--rpc', anvil.url, '--yes', '--account', 'anvil-dev'], {
      log: (l) => lines.push(l),
      runTool,
      loadManifest: () => manifest,
      sleep: async () => undefined,
      env: {},
      tmpRoot: tmp,
    });
    if (code !== 0) throw new Error(`deploy-evm-delegate failed on the anvil lane:\n${lines.join('\n')}`);
    for (const a of [delegate!, checkIn!]) {
      const hash = keccakHex(await anvil.rpc<string>('eth_getCode', [a.address, 'latest']));
      if (hash !== a.runtimeCodeHash) throw new Error(`${a.contractName} at ${a.address}: code hash ${hash}, not the artifact's ${a.runtimeCodeHash}`);
    }
    const pin = SPONSOR_DELEGATES[31337]!;
    if (pin.address !== delegate!.address || pin.runtimeCodeHash !== delegate!.runtimeCodeHash) throw new Error("core's 31337 pin is not the deployed delegate");
  } catch (e) {
    await anvil.stop();
    process.removeListener('exit', killNow);
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  rmSync(tmp, { recursive: true, force: true });
  project.provide('anvil', { url: anvil.url, skipped: null, safeDepth: SAFE_DEPTH, delegate: delegate!.address, checkIn: checkIn!.address });
  return async () => {
    await anvil.stop();
    process.removeListener('exit', killNow);
  };
}
