// deploy-evm-delegate (D849) against a local `anvil --hardfork prague` started here (never a public network): the
// plan, a fresh deploy of both contracts at their predicted CREATE2 addresses through a real Foundry keystore, an
// idempotent second run, a MISMATCH, the wrong chain, mainnet ids, a missing or foreign deterministic deployer, the
// post-deploy hash check, --verify and the follow-up PR's content. The deploy path's argv carries `--account` only:
// the test runner maps it to a temporary keystore of anvil's published dev account, so no key is in the code.
// deploy-check's `evm` group runs against the deployed contracts too. Skips when Foundry is not installed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { deployCheck } from '../lib/deploy-check.ts';
import { DETERMINISTIC_DEPLOYER, create2Address, deployCalldata, keccakHex, loadDelegateArtifacts } from '../lib/evm-delegate-artifacts.ts';
import { type EvmDeployDeps, type EvmDeployPlan, type RunTool, checkChain, checkInEntry, delegatesEntry, evmDeployMain, foundryEnv, manifestTemplate } from '../lib/evm-delegate-deploy.ts';
import { rpcLabel, rpcUrlProblem } from '../lib/evm-rpc.ts';
import { FIXTURE_APP, sponsorFixture } from '../../packages/env/src/evm-sponsor.fixture.ts';
import { ANVIL_DEV_ADDRESS, type Anvil, FOUNDRY_MISSING, devKeystore, leftoverTempDirs, startAnvil } from './anvil.ts';

const FILE_START = Date.now();
const sandbox = loadEnv('sandbox-dev');
const [DELEGATE, CHECK_IN] = loadDelegateArtifacts();
const PROXY_CODE = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';

describe('the artifacts and the pure parts (no chain)', () => {
  it('re-derives each artifact: salt from its label, init code hash, CREATE2 address through the proxy', () => {
    expect(DELEGATE!.address).toBe('0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA');
    expect(CHECK_IN!.address).toBe('0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e');
    for (const a of [DELEGATE!, CHECK_IN!]) {
      expect(a.salt).toBe(keccakHex(new TextEncoder().encode(a.saltLabel)));
      expect(create2Address(DETERMINISTIC_DEPLOYER, a.salt, keccakHex(a.bytecode))).toBe(a.address);
    }
    expect(keccakHex(PROXY_CODE)).toBe('0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989');
  });

  it('refuses mainnet chain ids outright, unknown chains, and the local chains outside local* envs', () => {
    for (const id of ['1', '8453', '10', '42161']) expect(() => checkChain(id, sandbox)).toThrow(/is a mainnet .*test chains only/u);
    expect(() => checkChain('999999', sandbox)).toThrow(/not a known test chain/u);
    expect(() => checkChain('31337', sandbox)).toThrow(/only local\* envs/u);
    expect(checkChain('31337', { name: 'local-evm' })).toBe(31337);
    expect(checkChain(undefined, sandbox)).toBe(84532);
    expect(() => checkChain('0x14a34', sandbox)).toThrow(CliError);
  });

  it('accepts https or a loopback http RPC, never shows its path or query, and strips Foundry signer settings from cast', () => {
    expect(rpcUrlProblem('https://base-sepolia.g.example.com/v2/abc')).toBeNull();
    expect(rpcUrlProblem('http://127.0.0.1:8545')).toBeNull();
    expect(rpcUrlProblem('http://rpc.example.com')).toMatch(/https/u);
    expect(rpcUrlProblem('https://user:pw@rpc.example.com')).toMatch(/user name or password/u);
    expect(rpcLabel('https://base-sepolia.g.example.com/v2/abc?x=1')).toBe('https://base-sepolia.g.example.com/…');
    const env = foundryEnv({ ETH_RPC_URL: 'http://127.0.0.1:1' }, { PATH: '/bin', HOME: '/h', ETH_FROM: '0x1', ETH_KEYSTORE: '/k', ETH_KEYSTORE_ACCOUNT: 'a', ETH_PASSWORD: '/p', CAST_ASYNC: 'true', FOUNDRY_PROFILE: 'x', CHAIN: '1', ETHERSCAN_API_KEY: 'k' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ETHERSCAN_API_KEY: 'k', ETH_RPC_URL: 'http://127.0.0.1:1' });
  });

  it('prints the pinned-table entry and the manifest block with the real addresses', () => {
    const entry = delegatesEntry(84532, DELEGATE!, '2026-11-26');
    expect(entry).toContain(`  84532: Object.freeze({\n    address: '${DELEGATE!.address}',\n    runtimeCodeHash: '${DELEGATE!.runtimeCodeHash}',\n    domain: SPONSOR_DELEGATE_DOMAIN,\n    abiVersion: SPONSOR_ABI_VERSION,\n    placeholder: false,\n  }),`);
    expect(entry).toContain('2026-11-26');
    // The demo check-in's pin: one line for DEMO_CHECK_IN (packages/core/src/demo-check-in.ts, D854).
    expect(checkInEntry(84532, CHECK_IN!, '2026-11-26')).toBe(`  84532: Object.freeze({ address: '${CHECK_IN!.address}', runtimeCodeHash: '${CHECK_IN!.runtimeCodeHash}' }), // Base Sepolia, code hash checked on 2026-11-26`);
    const block = manifestTemplate(84532, DELEGATE!.address, CHECK_IN!.address, { rpc: 'https://sepolia.base.org', rpcFallback: 'https://base-sepolia-rpc.publicnode.com' });
    expect(block).toContain(`"delegate": "${DELEGATE!.address}", "opStack": true`);
    expect(block).toContain(`"address": "${CHECK_IN!.address}", "selectors": ["0x183ff085"], "exactCalldata": ["0x183ff085"]`);
  });
});

/** The deploy's tools for the tests: cast with the keystore's directory and password in place of `--account`. */
function testTools(ks: { dir: string; name: string; password: string }) {
  const calls: { tool: string; argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  const runTool: RunTool = (tool, argv, opts) => {
    // Every tool runs in an empty directory of its own (no project foundry.toml can apply).
    if (readdirSync(opts.cwd).length !== 0 || !basename(opts.cwd).startsWith('hana-evm-cwd-')) throw new Error(`tool cwd ${opts.cwd} is not an empty hana-evm-cwd- directory`);
    calls.push({ tool, argv, env: opts.env, cwd: opts.cwd });
    if (tool !== 'cast') return { status: 0 };
    const i = argv.indexOf('--account');
    if (i < 0 || argv[i + 1] !== ks.name) throw new Error('the deploy must sign with --account <keystore>');
    const mapped = [...argv.slice(0, i), '--keystore', `${ks.dir}/${ks.name}`, '--password', ks.password, ...argv.slice(i + 2)];
    const r = spawnSync('cast', mapped, { cwd: opts.cwd, env: foundryEnv(opts.env), encoding: 'utf8' });
    return { status: r.status };
  };
  return { calls, runTool };
}

describe.skipIf(FOUNDRY_MISSING !== null)('deploy-evm-delegate on a local anvil (chain 84532)', () => {
  let anvil: Anvil;
  let snapshot: string;
  let ks: ReturnType<typeof devKeystore>;
  beforeAll(async () => {
    anvil = await startAnvil({ chainId: 84532 });
    ks = devKeystore();
  }, 30_000);
  afterAll(async () => {
    await anvil?.stop();
    if (ks) rmSync(ks.dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    snapshot = await anvil.rpc<string>('evm_snapshot');
  });
  afterEach(async () => {
    await anvil.rpc('evm_revert', [snapshot]);
  });

  const run = async (argv: string[], over: Partial<EvmDeployDeps> = {}) => {
    const lines: string[] = [];
    const tools = testTools(ks);
    const code = await evmDeployMain(['sandbox-dev', '--rpc', anvil.url, ...argv], { log: (l) => lines.push(l), runTool: tools.runTool, now: () => new Date('2026-11-26T10:00:00Z'), sleep: async () => undefined, env: {}, ...over });
    return { code, out: lines.join('\n'), calls: tools.calls };
  };
  const codeHashAt = async (a: string) => keccakHex(await anvil.rpc<string>('eth_getCode', [a, 'latest']));
  const plan = async (argv: string[] = []) => {
    const r = await run(['--json', ...argv]);
    return { code: r.code, plan: JSON.parse(r.out) as EvmDeployPlan };
  };

  it('plans by default: predicted addresses, salts and hashes from the artifacts, the proxy present (anvil has it), nothing sent', async () => {
    const { code, out, calls } = await run([]);
    expect(code).toBe(0);
    expect(out).toContain('Environment sandbox-dev: Base Sepolia (chain 84532), RPC http://127.0.0.1:');
    expect(out).toContain('eth_chainId 84532: the right chain');
    expect(out).toContain(`deterministic deployment proxy ${DETERMINISTIC_DEPLOYER}: present, with its known code`);
    for (const a of [DELEGATE!, CHECK_IN!]) {
      expect(out).toMatch(new RegExp(`${a.contractName}\\s+${a.address}  not deployed`, 'u'));
      expect(out).toContain(`salt keccak256("${a.saltLabel}") = ${a.salt}`);
      expect(out).toContain(`runtime code hash ${a.runtimeCodeHash}`);
    }
    expect(out).toContain('1. deploy HanaDelegateExecutor through the proxy');
    expect(out).toContain('2. deploy CheckIn through the proxy');
    expect(out).toContain('Dry run: nothing sent. Re-run with --yes --account <keystore> to deploy.');
    expect(calls).toEqual([]);
    expect(await anvil.rpc('eth_getCode', [DELEGATE!.address, 'latest'])).toBe('0x');

    const j = await plan();
    expect(j.code).toBe(0);
    expect(j.plan).toMatchObject({ env: 'sandbox-dev', chainId: 84532, rpcChainId: 84532, rpc: { source: 'flag' }, deployer: { state: 'ok' }, deploy: ['HanaDelegateExecutor', 'CheckIn'], blockers: [] });
    expect(j.plan.contracts.map((c) => [c.name, c.address, c.state, c.runtimeCodeHash])).toEqual([
      ['HanaDelegateExecutor', DELEGATE!.address, 'absent', DELEGATE!.runtimeCodeHash],
      ['CheckIn', CHECK_IN!.address, 'absent', CHECK_IN!.runtimeCodeHash],
    ]);
  });

  it('deploys both through the proxy with the keystore, checks the code hashes, then prints verification and the follow-up; a second run has nothing to do', async () => {
    const { code, out, calls } = await run(['--yes', '--account', ks.name]);
    expect(code, out).toBe(0);
    expect(calls.map((c) => c.argv.slice(0, 2))).toEqual([
      ['send', DETERMINISTIC_DEPLOYER],
      ['send', DETERMINISTIC_DEPLOYER],
    ]);
    for (const c of calls) {
      expect(c.argv).toEqual(['send', DETERMINISTIC_DEPLOYER, expect.stringMatching(/^0x[0-9a-f]+$/u), '--account', ks.name, '--chain', '84532']);
      expect(c.argv.join(' ')).not.toMatch(/private-key|password|mnemonic|interactive/u);
      // The RPC goes to cast in its environment, never on its command line.
      expect(c.env).toEqual({ ETH_RPC_URL: anvil.url });
      // Its empty working directory is removed after the run.
      expect(existsSync(c.cwd)).toBe(false);
    }
    expect(calls[0]!.argv[2]).toBe(`0x${DELEGATE!.salt.slice(2)}${DELEGATE!.bytecode.slice(2)}`);
    expect(await codeHashAt(DELEGATE!.address)).toBe(DELEGATE!.runtimeCodeHash);
    expect(await codeHashAt(CHECK_IN!.address)).toBe(CHECK_IN!.runtimeCodeHash);
    expect(out).toContain(`✓ HanaDelegateExecutor at ${DELEGATE!.address}: runtime code hash ${DELEGATE!.runtimeCodeHash}, the artifact's`);
    expect(out).toContain(`✓ CheckIn at ${CHECK_IN!.address}`);
    expect(out).toContain(`forge verify-contract ${DELEGATE!.address} src/HanaDelegateExecutor.sol:HanaDelegateExecutor --root contracts/evm-delegate --chain 84532 --compiler-version 0.8.28+commit.7893614a --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/ --watch`);
    expect(out).toContain(`forge verify-contract ${CHECK_IN!.address} src/demo/CheckIn.sol:CheckIn --root contracts/evm-delegate --chain 84532 --compiler-version 0.8.28+commit.7893614a --verifier etherscan --watch`);
    expect(out).toContain('--show-standard-json-input > HanaDelegateExecutor.standard-input.json');
    expect(out).toContain(delegatesEntry(84532, DELEGATE!, '2026-11-26'));
    expect(out).toContain(checkInEntry(84532, CHECK_IN!, '2026-11-26'));
    expect(out).toContain('DEMO_CHECK_IN in packages/core/src/demo-check-in.ts');
    expect(out).toContain(`"delegate": "${DELEGATE!.address}"`);
    expect(out).toContain('"rpc": "https://sepolia.base.org"');

    const again = await run(['--yes', '--account', ks.name]);
    expect(again.code).toBe(0);
    expect(again.calls).toEqual([]);
    expect(again.out).toMatch(/HanaDelegateExecutor\s+0x\w+  already deployed, matches the artifact/u);
    expect(again.out).toContain('Nothing to deploy: both contracts are already deployed and match their artifacts.');
    expect(again.out).toContain(delegatesEntry(84532, DELEGATE!, '2026-11-26'));
    expect((await plan()).plan.contracts.map((c) => c.state)).toEqual(['matches', 'matches']);
  }, 60_000);

  it('deploys only what is missing', async () => {
    // CheckIn first, by hand, through the same proxy.
    const pre = spawnSync('cast', ['send', DETERMINISTIC_DEPLOYER, deployCalldata(CHECK_IN!), '--keystore', `${ks.dir}/${ks.name}`, '--password', ks.password, '--rpc-url', anvil.url], { encoding: 'utf8', env: foundryEnv({}) });
    expect(pre.status, pre.stderr).toBe(0);
    const { code, out, calls } = await run(['--yes', '--account', ks.name]);
    expect(code).toBe(0);
    expect(out).toMatch(/CheckIn\s+0x\w+  already deployed, matches the artifact/u);
    expect(calls.map((c) => c.argv[2])).toEqual([deployCalldata(DELEGATE!)]);
  }, 60_000);

  it('MISMATCH: other code at a predicted address is a hard failure, and nothing is sent', async () => {
    await anvil.rpc('anvil_setCode', [CHECK_IN!.address, '0x6000600055']);
    const { code, out, calls } = await run(['--yes', '--account', ks.name]);
    expect(code).toBe(1);
    expect(out).toContain(`MISMATCH: CheckIn at ${CHECK_IN!.address} has runtime code hash ${keccakHex('0x6000600055')}, not the artifact's ${CHECK_IN!.runtimeCodeHash}`);
    expect(calls).toEqual([]);
    const j = await plan();
    expect(j.code).toBe(1);
    expect(j.plan.contracts.map((c) => c.state)).toEqual(['absent', 'mismatch']);
    expect(j.plan.deploy).toEqual([]);
  });

  it('checks the code after the transaction: other code there after a "successful" send is a MISMATCH', async () => {
    // A send that "succeeds" but leaves other code at the address.
    const runTool: RunTool = (_tool, argv) => {
      const target = argv[2] === deployCalldata(DELEGATE!) ? DELEGATE!.address : CHECK_IN!.address;
      return { status: spawnSync('cast', ['rpc', 'anvil_setCode', target, '0x00', '--rpc-url', anvil.url], { env: foundryEnv({}) }).status };
    };
    await expect(evmDeployMain(['sandbox-dev', '--rpc', anvil.url, '--yes', '--account', ks.name], { log: () => undefined, runTool, env: {} })).rejects.toThrow(/MISMATCH after the deploy: HanaDelegateExecutor .* Don't pin it/u);
  });

  it('re-reads an address that shows no code right after the send (a lagging RPC node), then says so if it stays empty', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    // A send that "succeeds" and leaves nothing.
    await expect(evmDeployMain(['sandbox-dev', '--rpc', anvil.url, '--yes', '--account', ks.name], { log: () => undefined, runTool: () => ({ status: 0 }), sleep, env: {} })).rejects.toThrow(/HanaDelegateExecutor: no code at 0x\w+ after the transaction/u);
    expect(waits).toEqual(Array(15).fill(2000));
    // The code turns up on a later read: the run goes on.
    waits.length = 0;
    const late = async (ms: number) => {
      waits.push(ms);
      if (waits.length === 2) {
        const pre = spawnSync('cast', ['send', DETERMINISTIC_DEPLOYER, deployCalldata(DELEGATE!), '--keystore', `${ks.dir}/${ks.name}`, '--password', ks.password, '--rpc-url', anvil.url], { env: foundryEnv({}) });
        expect(pre.status).toBe(0);
      }
    };
    const lines: string[] = [];
    const tools = testTools(ks);
    let first = true;
    const runTool: RunTool = (tool, argv, opts) => (first ? ((first = false), { status: 0 }) : tools.runTool(tool, argv, opts));
    expect(await evmDeployMain(['sandbox-dev', '--rpc', anvil.url, '--yes', '--account', ks.name], { log: (l) => lines.push(l), runTool, sleep: late, env: {} })).toBe(0);
    expect(waits).toHaveLength(2);
    expect(lines.join('\n')).toContain(`✓ HanaDelegateExecutor at ${DELEGATE!.address}`);
  }, 60_000);

  it('a failed cast send stops the run and says nothing more was sent', async () => {
    const calls: string[][] = [];
    await expect(evmDeployMain(['sandbox-dev', '--rpc', anvil.url, '--yes', '--account', ks.name], { log: () => undefined, runTool: (_t, argv) => (calls.push(argv), { status: 1 }), env: {} })).rejects.toThrow(/cast send for HanaDelegateExecutor failed \(exit 1.*nothing more was sent/u);
    expect(calls).toHaveLength(1);
  });

  it('refuses an RPC on another chain before reading anything else', async () => {
    const methods: string[] = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      methods.push((JSON.parse(String(init?.body)) as { method: string }).method);
      return fetch(input, init);
    }) as typeof fetch;
    const r = await run(['--chain', '11155111'], { fetch: spy });
    expect(r.code).toBe(1);
    expect(r.out).toContain('The RPC (http://127.0.0.1:');
    expect(r.out).toContain('is on chain 84532, not 11155111: point it at Sepolia');
    expect(r.out).toMatch(/HanaDelegateExecutor\s+0x\w+  not read/u);
    expect(methods).toEqual(['eth_chainId']);
    expect(r.calls).toEqual([]);
  });

  it('refuses a mainnet id before any RPC, and an RPC that answers a mainnet id', async () => {
    let fetched = 0;
    const counting = ((...a: Parameters<typeof fetch>) => (fetched++, fetch(...a))) as typeof fetch;
    await expect(run(['--chain', '8453'], { fetch: counting })).rejects.toThrow(/Chain 8453 is a mainnet \(Base\)/u);
    await expect(run(['--chain', '1', '--yes', '--account', ks.name], { fetch: counting })).rejects.toThrow(/Chain 1 is a mainnet \(Ethereum\)/u);
    expect(fetched).toBe(0);
    await anvil.rpc('anvil_setChainId', [8453]);
    try {
      const r = await run(['--yes', '--account', ks.name]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('is on chain 8453, a mainnet (Base), not 84532');
      expect(r.calls).toEqual([]);
    } finally {
      await anvil.rpc('anvil_setChainId', [84532]);
    }
  });

  it('refuses to deploy without the deterministic deployer, or with other code at its address, and says what to do', async () => {
    await anvil.rpc('anvil_setCode', [DETERMINISTIC_DEPLOYER, '0x']);
    let r = await run(['--yes', '--account', ks.name]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`deterministic deployment proxy ${DETERMINISTIC_DEPLOYER}: NOT on this chain`);
    expect(r.out).toMatch(/has no code on chain 84532\. The predicted addresses depend on it.*github\.com\/Arachnid\/deterministic-deployment-proxy/u);
    expect(r.calls).toEqual([]);
    await anvil.rpc('anvil_setCode', [DETERMINISTIC_DEPLOYER, '0x6000']);
    r = await run([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('runs other code than the deterministic deployment proxy');
  });

  it('takes a keyed provider URL only from HANA_EVM_RPC_URL, never printing it; --rpc takes no path or query', async () => {
    const keyed = 'https://rpc.example.test/v2/not-a-real-key-123?token=abc';
    const toAnvil = ((_i: string | URL | Request, init?: RequestInit) => fetch(anvil.url, init)) as typeof fetch;
    const lines: string[] = [];
    const deps = { log: (l: string) => lines.push(l), runTool: () => ({ status: 0 }), fetch: toAnvil };
    expect(await evmDeployMain(['sandbox-dev'], { ...deps, env: { HANA_EVM_RPC_URL: keyed } })).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('RPC https://rpc.example.test/… (HANA_EVM_RPC_URL)');
    expect(out).not.toMatch(/not-a-real-key|token=abc/u);
    lines.length = 0;
    expect(await evmDeployMain(['sandbox-dev', '--json'], { ...deps, env: { HANA_EVM_RPC_URL: keyed } })).toBe(0);
    expect((JSON.parse(lines.join('\n')) as EvmDeployPlan).rpc).toEqual({ source: 'env', label: 'https://rpc.example.test/…' });
    expect(lines.join('\n')).not.toContain('not-a-real-key');
    // On the command line: no path, no query (pnpm echoes it, the shell keeps it).
    for (const url of [keyed, 'https://rpc.example.test/v2/abc', 'https://rpc.example.test/?key=abc', 'https://rpc.example.test/#k']) {
      await expect(evmDeployMain(['sandbox-dev', '--rpc', url], { ...deps, env: {} })).rejects.toThrow(/no path, query or fragment .*HANA_EVM_RPC_URL/u);
    }
    await expect(evmDeployMain(['sandbox-dev', '--rpc', anvil.url], { ...deps, env: { HANA_EVM_RPC_URL: keyed } })).rejects.toThrow(/Both --rpc and HANA_EVM_RPC_URL/u);
    await expect(evmDeployMain(['sandbox-dev'], { ...deps, env: { HANA_EVM_RPC_URL: 'http://rpc.example.test/v2/k' } })).rejects.toThrow(/in HANA_EVM_RPC_URL must be an https URL/u);
  });

  it('takes the RPC from the manifest when it has the chain (and refuses --rpc then)', async () => {
    const withSponsor = { ...sandbox, evm: { sponsor: { ...sponsorFixture(), chains: { '84532': { ...sponsorFixture().chains['84532']!, rpc: anvil.url, delegate: DELEGATE!.address } } } } } as Manifest;
    const lines: string[] = [];
    const code = await evmDeployMain(['sandbox-dev', '--json'], { log: (l) => lines.push(l), runTool: () => ({ status: 0 }), loadManifest: () => withSponsor, env: {} });
    expect(code).toBe(0);
    expect((JSON.parse(lines.join('\n')) as EvmDeployPlan).rpc.source).toBe('manifest');
    await expect(evmDeployMain(['sandbox-dev', '--rpc', anvil.url], { log: () => undefined, runTool: () => ({ status: 0 }), loadManifest: () => withSponsor, env: {} })).rejects.toThrow(/drop --rpc/u);
    await expect(evmDeployMain(['sandbox-dev'], { log: () => undefined, runTool: () => ({ status: 0 }), loadManifest: () => withSponsor, env: { HANA_EVM_RPC_URL: 'https://rpc.example.test/v2/k' } })).rejects.toThrow(/drop HANA_EVM_RPC_URL/u);
  });

  it('--verify runs forge build and the verifications (Etherscan only with its key in the shell, never on a command line)', async () => {
    await run(['--yes', '--account', ks.name]);
    let r = await run(['--verify']);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => [c.tool, ...c.argv.slice(0, 1)])).toEqual([['forge', 'build'], ['forge', 'verify-contract'], ['forge', 'verify-contract']]);
    // forge is pointed at the contract's own directory by an absolute --root.
    for (const c of r.calls) expect(c.argv[c.argv.indexOf('--root') + 1]).toBe(join(repoRoot, 'contracts', 'evm-delegate'));
    expect(r.calls.filter((c) => c.argv.includes('blockscout')).map((c) => c.argv[1])).toEqual([DELEGATE!.address, CHECK_IN!.address]);
    expect(r.out).toContain('skipped HanaDelegateExecutor on the Etherscan-family explorer: no ETHERSCAN_API_KEY in the shell');
    r = await run(['--verify'], { env: { ETHERSCAN_API_KEY: 'test-only-explorer-key' } });
    expect(r.calls.filter((c) => c.argv.includes('etherscan'))).toHaveLength(2);
    for (const c of r.calls) expect(JSON.stringify(c)).not.toContain('test-only-explorer-key');
  }, 60_000);

  it('deploy-check --only evm checks the deployed delegate, core pin, relayer funds and targets', async () => {
    await run(['--yes', '--account', ks.name]);
    const relayer = '0x00000000000000000000000000000000000Ae1a7';
    const sponsor = sponsorFixture();
    const chain = { ...sponsor.chains['84532']!, rpc: anvil.url, rpcFallback: anvil.url, delegate: DELEGATE!.address };
    const m = { ...sandbox, evm: { sponsor: { ...sponsor, relayerAddress: relayer, chains: { '84532': chain }, apps: { [FIXTURE_APP]: { '84532': [{ ...sponsor.apps[FIXTURE_APP]!['84532']![0]!, address: CHECK_IN!.address }] } } } } } as Manifest;
    const pinned = { 84532: { address: DELEGATE!.address, runtimeCodeHash: DELEGATE!.runtimeCodeHash, placeholder: false } };
    const check = async (over: Partial<Parameters<typeof deployCheck>[1]> = {}, manifest: Manifest = m) => {
      const lines: string[] = [];
      const code = await deployCheck(['sandbox-dev', '--only', 'evm'], { loadManifest: () => manifest, localBuild: () => ({ id: 'abc', commit: 'abc', dirty: false, head: 'abc' }), log: (l) => lines.push(l), pinnedDelegates: pinned, ...over });
      return { code, out: lines.join('\n') };
    };
    await anvil.rpc('anvil_setBalance', [relayer, '0x16345785d8a0000']); // 0.1 ETH
    let r = await check();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`evm 84532  delegate ${DELEGATE!.address} runs the artifact's code (${DELEGATE!.runtimeCodeHash})`);
    expect(r.out).toContain(`evm 84532  relayer ${relayer} holds 0.1 ETH (low-balance line 0.05 ETH)`);
    expect(r.out).toContain(`target ${CHECK_IN!.address} (Journear demo check-in) has code`);
    expect(r.out).toContain("OK: sandbox-dev's EVM sponsorship checks out");

    // Core's real table has no Base Sepolia entry yet.
    r = await check({ pinnedDelegates: undefined });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: evm 84532: core pins no delegate for chain 84532');

    await anvil.rpc('anvil_setBalance', [relayer, '0x2386f26fc10000']); // 0.01 ETH: below the 0.05 line
    r = await check();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`warning: evm 84532: the relayer ${relayer} holds 0.01 ETH, below lowBalanceEth (0.05 ETH): top it up`);
    await anvil.rpc('anvil_setBalance', [relayer, '0x0']);
    r = await check();
    expect(r.code).toBe(1);
    expect(r.out).toContain("holds 0 ETH, less than 0.0006 ETH, one transaction's worst execution cost (0.0003 ETH: maxGasPerTx × maxFeePerGasGwei) doubled as a margin for the OP Stack L1 data fee, which is extra: sends would fail");
    // Between one and two transactions' worth on an OP Stack chain still fails (the L1 data fee is extra).
    await anvil.rpc('anvil_setBalance', [relayer, '0x221b262dd8000']); // exactly 0.0006 ETH: at the floor
    r = await check();
    expect(r.out).not.toContain('sends would fail');
    await anvil.rpc('anvil_setBalance', [relayer, '0x221b262dd7fff']);
    r = await check();
    expect(r.out).toContain('less than 0.0006 ETH');

    await anvil.rpc('anvil_setBalance', [relayer, '0x16345785d8a0000']);
    await anvil.rpc('anvil_setCode', [DELEGATE!.address, '0x00']);
    await anvil.rpc('anvil_setCode', [CHECK_IN!.address, '0x']);
    r = await check();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL: evm 84532: MISMATCH: the delegate ${DELEGATE!.address} has runtime code hash ${keccakHex('0x00')}`);
    expect(r.out).toContain(`FAIL: evm 84532: ${FIXTURE_APP}'s target ${CHECK_IN!.address} (Journear demo check-in) has no code`);

    // A manifest on the wrong chain fails without reading further.
    r = await check({}, { ...m, evm: { sponsor: { ...m.evm!.sponsor!, chains: { '11155111': chain }, apps: {} } } } as Manifest);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: evm 11155111: RPC http://127.0.0.1:');
  }, 60_000);
});

describe.skipIf(FOUNDRY_MISSING !== null)('deploy-evm-delegate on a local env (chain 31337) whose anvil lacks the deterministic deployer', () => {
  let anvil: Anvil;
  beforeAll(async () => {
    anvil = await startAnvil({ noCreate2Deployer: true });
  }, 30_000);
  afterAll(async () => anvil?.stop());

  it('says the proxy is missing; with the proxy placed (anvil_setCode, as a chain would get it), plans both deploys', async () => {
    const local = { ...sandbox, name: 'local-evm' } as Manifest;
    const lines: string[] = [];
    const deps: EvmDeployDeps = { log: (l) => lines.push(l), runTool: () => ({ status: 0 }), loadManifest: () => local, env: {} };
    expect(await evmDeployMain(['local-evm', '--chain', '31337', '--rpc', anvil.url], deps)).toBe(1);
    expect(lines.join('\n')).toContain('has no code on chain 31337');
    await anvil.rpc('anvil_setCode', [DETERMINISTIC_DEPLOYER, PROXY_CODE]);
    lines.length = 0;
    expect(await evmDeployMain(['local-evm', '--chain', '31337', '--rpc', anvil.url], deps)).toBe(0);
    expect(lines.join('\n')).toContain('Environment local-evm: Local (Hardhat, Anvil) (chain 31337)');
    expect(lines.join('\n')).toContain('Dry run: nothing sent.');
    expect(await anvil.rpc('eth_getBalance', [ANVIL_DEV_ADDRESS, 'latest'])).not.toBe('0x0');
  });
});

describe('deploy-evm-delegate refusals (no chain)', () => {
  const deps: EvmDeployDeps = { log: () => undefined, runTool: () => ({ status: 0 }), fetch: (() => Promise.reject(new Error('no network in this test'))) as typeof fetch, env: {} };
  it('refuses bad arguments before any RPC', async () => {
    await expect(evmDeployMain([], deps)).rejects.toBeInstanceOf(CliError);
    await expect(evmDeployMain(['sandbox-dev', '--yes', '--rpc', 'https://rpc.example.test'], deps)).rejects.toThrow(/--yes needs --account/u);
    await expect(evmDeployMain(['sandbox-dev', '--yes', '--account', '../keys/x', '--rpc', 'https://rpc.example.test'], deps)).rejects.toThrow(/keystore name/u);
    await expect(evmDeployMain(['sandbox-dev', '--json', '--yes', '--account', 'x'], deps)).rejects.toThrow(/--json prints the plan only/u);
    await expect(evmDeployMain(['sandbox-dev'], deps)).rejects.toThrow(/no evm.sponsor entry for chain 84532: pass --rpc .*https:\/\/sepolia\.base\.org.*HANA_EVM_RPC_URL/u);
    await expect(evmDeployMain(['sandbox-dev', '--rpc', 'http://rpc.example.test'], deps)).rejects.toThrow(/https URL/u);
    await expect(evmDeployMain(['sandbox-dev', '--private-key', 'x'], deps)).rejects.toBeInstanceOf(CliError);
    await expect(evmDeployMain(['sandbox-dev', '--chain', '31337', '--rpc', 'http://127.0.0.1:1'], deps)).rejects.toThrow(/only local\* envs/u);
  });
});

// Last: this file's temporary keystores and tool directories are all gone.
describe('cleanup', () => {
  it('leaves no hana-evm-keystore-* or hana-evm-cwd-* directory of this run behind', () => {
    expect(leftoverTempDirs(['hana-evm-keystore-', 'hana-evm-cwd-'], FILE_START)).toEqual([]);
  });
});
