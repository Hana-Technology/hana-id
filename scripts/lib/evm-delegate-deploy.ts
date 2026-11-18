// deploy-evm-delegate's body (D849): puts contracts/evm-delegate's HanaDelegateExecutor and its demo target CheckIn on
// a test chain at the CREATE2 addresses their checked-in artifacts predict (D841), through the deterministic deployment
// proxy. Like the other deploy scripts it observes first, prints the plan and changes nothing without --yes.
//
// - Everything comes from the artifacts and envs/<env>.json: the env must be a testnet env, the chain a test chain
//   (never a mainnet ID, whatever the RPC says), and chains 31337/1337 only for `local*` envs. The RPC is the env's
//   `evm.sponsor.chains.<id>.rpc` when it has one, else `--rpc` (no path or query: a command line is echoed and kept
//   in shell history) or, for a keyed provider URL, the environment variable HANA_EVM_RPC_URL, for the chain `--chain`
//   names (default 84532); its eth_chainId is read before anything else and must be that chain. The URL is never
//   printed: messages show its scheme and host, and cast gets it in ETH_RPC_URL, not on its command line. cast and
//   forge run in an empty temporary directory (no foundry.toml there but the one forge is pointed at with --root).
// - The proxy must be on the chain with its known code. A predicted address that already has code is compared with
//   the artifact's runtime code hash: equal is "already deployed, matches" (nothing to do), anything else a MISMATCH
//   (a hard failure: the address is the artifact's own, so different code there means the artifact isn't what was
//   deployed, and nothing must pin it).
// - The deploy is `cast send <proxy> <salt ‖ init code> --account <name>`: Foundry signs with the user's keystore and
//   asks for its password on the terminal itself; this script never reads, receives or prints a key or a password,
//   and strips ETH_*/CAST_*/FOUNDRY_* from cast's environment so only the named keystore signs. After each send the
//   code at the address is read again and its hash compared.
// - Then it prints the explorer-verification commands (standard-JSON input; `--verify` runs them), the 84532-style
//   entry for core's pinned table and the manifest block with the real addresses: the follow-up PR's content.
//
// Dependencies are injectable: test/evm-delegate-deploy.test.ts runs it against a local anvil.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_EVM_MAINNETS, TEST_EVM_CHAINS } from '@hana-id/core';
import { type Manifest, OP_STACK_TEST_CHAIN_IDS, SPONSOR_TEST_EVM_CHAIN_IDS, isLocalEnv, loadEnv, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { type DelegateArtifact, DETERMINISTIC_DEPLOYER, DETERMINISTIC_DEPLOYER_CODE_HASH, deployCalldata, keccakHex, loadDelegateArtifacts } from './evm-delegate-artifacts.ts';
import { type EvmRpc, evmRpc, rpcFlagUrlProblem, rpcUrlProblem } from './evm-rpc.ts';

export const DEPLOY_EVM_DELEGATE_USAGE = `Usage: deploy-evm-delegate.ts <env> [--chain <id>] [--rpc <url>] [--yes --account <keystore>] [--verify] [--json]
  Deploys contracts/evm-delegate's HanaDelegateExecutor and CheckIn through the deterministic deployment proxy
  (CREATE2) at the addresses their checked-in artifacts predict. Prints the plan; changes nothing without --yes.
  --chain <id>        the chain (default 84532, Base Sepolia): test chains only, never a mainnet
  --rpc <url>         the chain's RPC, when envs/<env>.json has no evm.sponsor entry for it: https, no path or
                      query (e.g. https://sepolia.base.org). A provider URL with a key: export HANA_EVM_RPC_URL
                      instead (read -rs HANA_EVM_RPC_URL; export HANA_EVM_RPC_URL); never printed
  --yes               deploy what is missing with \`cast send\`, signed by your Foundry keystore (cast asks for its
                      password; this script never sees a key or a password)
  --account <name>    the keystore in ~/.foundry/keystores (made with \`cast wallet new ~/.foundry/keystores <name>\`);
                      required with --yes
  --verify            once both are deployed, run the explorer verification instead of printing its commands
  --json              print the plan as JSON (not with --yes)`;

export const EVM_DRY_RUN_LINE = 'Dry run: nothing sent. Re-run with --yes --account <keystore> to deploy.';
export const DEFAULT_EVM_CHAIN = 84532;
/** The environment variable a keyed RPC URL comes from (never a command line). */
export const EVM_RPC_ENV = 'HANA_EVM_RPC_URL';
/** Re-reads of an address that shows no code right after its deploy, and the wait before each (30 s in all). */
export const POST_DEPLOY_READS = 15;
export const POST_DEPLOY_WAIT_MS = 2_000;

/** Where a chain's explorers verify (forge's `--verifier` settings) and show addresses. */
export const EXPLORERS: Readonly<Record<number, { blockscout?: string; etherscan: boolean; addressUrls: readonly string[] }>> = Object.freeze({
  84532: { blockscout: 'https://base-sepolia.blockscout.com/api/', etherscan: true, addressUrls: ['https://sepolia.basescan.org/address/', 'https://base-sepolia.blockscout.com/address/'] },
});

/** The manifest's public RPCs for a chain, for the block template (none for a chain without known ones). */
const TEMPLATE_RPCS: Readonly<Record<number, { rpc: string; rpcFallback: string }>> = Object.freeze({
  84532: { rpc: 'https://sepolia.base.org', rpcFallback: 'https://base-sepolia-rpc.publicnode.com' },
});

/** One Foundry command with the terminal attached (cast's password prompt is its own). */
export type RunTool = (tool: 'cast' | 'forge', argv: string[], opts: { cwd: string; env: Record<string, string> }) => { status: number | null; error?: Error };

export interface EvmDeployDeps {
  log: (line: string) => void;
  runTool: RunTool;
  fetch?: typeof fetch;
  loadManifest?: (name: string) => Manifest;
  /** The repository root holding contracts/evm-delegate (default: this checkout's). */
  root?: string;
  /** Today, for the pinned-table comment. */
  now?: () => Date;
  /** Waits between reads of a just-deployed address (default setTimeout; tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Where HANA_EVM_RPC_URL and ETHERSCAN_API_KEY are looked for (default process.env; forge reads the key itself). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Environment variables a Foundry tool reads that could change who signs, where it sends or how it compiles. */
const FOUNDRY_ENV_RE = /^(?:ETH_|CAST_|FOUNDRY_|DAPP_)|^CHAIN$|^HANA_EVM_RPC_URL$/u;

/** process.env without those, plus `extra`. */
export function foundryEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !FOUNDRY_ENV_RE.test(k)) out[k] = v;
  return { ...out, ...extra };
}

export const defaultRunTool: RunTool = (tool, argv, opts) => {
  // stdio inherit: cast prompts for the keystore password on this terminal and reads it without echo; its output (the
  // transaction hash and receipt) goes straight to the user.
  const res = spawnSync(tool, argv, { cwd: opts.cwd, env: foundryEnv(opts.env), stdio: 'inherit' });
  return { status: res.status, ...(res.error ? { error: res.error } : {}) };
};

export const defaultEvmDeployDeps = (): EvmDeployDeps => ({ log: (l) => console.log(l), runTool: defaultRunTool });

export type RpcSource = 'manifest' | 'flag' | 'env';
export type ContractState = 'unread' | 'absent' | 'matches' | 'mismatch';

export interface PlannedContract {
  name: string;
  address: string;
  saltLabel: string;
  salt: string;
  runtimeCodeHash: string;
  /** keccak256 of the code at the address now, or null for none. */
  onChainCodeHash: string | null;
  state: ContractState;
}

export interface EvmDeployPlan {
  env: string;
  chainId: number;
  chainName: string;
  rpc: { source: RpcSource; label: string };
  /** The chain id the RPC answered, or null when it wasn't read. */
  rpcChainId: number | null;
  deployer: { address: string; state: 'ok' | 'missing' | 'other-code' | 'unknown' };
  contracts: PlannedContract[];
  /** Names of the contracts --yes deploys, in order. */
  deploy: string[];
  blockers: string[];
  warnings: string[];
}

const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** The chain id `--chain` names, or why it can't be used (mainnets refused outright, before any RPC). */
export function checkChain(raw: string | undefined, m: Pick<Manifest, 'name'>): number {
  if (raw !== undefined && !/^[1-9]\d{0,14}$/u.test(raw)) throw new CliError('--chain must be a decimal chain id');
  const chainId = raw === undefined ? DEFAULT_EVM_CHAIN : Number(raw);
  if (Object.hasOwn(KNOWN_EVM_MAINNETS, chainId)) throw new Error(`Chain ${chainId} is a mainnet (${KNOWN_EVM_MAINNETS[chainId]}): this script deploys to test chains only`);
  if (!SPONSOR_TEST_EVM_CHAIN_IDS.includes(chainId)) throw new Error(`Chain ${chainId} is not a known test chain (core's TEST_EVM_CHAINS): this script deploys to test chains only`);
  if ((chainId === 31337 || chainId === 1337) && !isLocalEnv(m.name)) throw new Error(`Chain ${chainId} is a local dev chain: only local* envs use it, not ${m.name}`);
  return chainId;
}

const chainName = (id: number): string => (Object.hasOwn(TEST_EVM_CHAINS, id) ? TEST_EVM_CHAINS[id]! : `chain ${id}`);

/** What the plan finds on chain, contract by contract. Pure over the RPC: the tests drive it through `evmDeployMain`. */
export async function observeEvmDeploy(m: Manifest, chainId: number, rpc: EvmRpc, source: RpcSource, artifacts: readonly DelegateArtifact[]): Promise<EvmDeployPlan> {
  const plan: EvmDeployPlan = {
    env: m.name,
    chainId,
    chainName: chainName(chainId),
    rpc: { source, label: rpc.label },
    rpcChainId: null,
    deployer: { address: DETERMINISTIC_DEPLOYER, state: 'unknown' },
    contracts: artifacts.map((a) => ({ name: a.contractName, address: a.address, saltLabel: a.saltLabel, salt: a.salt, runtimeCodeHash: a.runtimeCodeHash, onChainCodeHash: null, state: 'unread' })),
    deploy: [],
    blockers: [],
    warnings: [],
  };
  // The chain first: nothing else is read from an RPC on another chain.
  plan.rpcChainId = await rpc.chainId();
  if (plan.rpcChainId !== chainId) {
    const other = Object.hasOwn(KNOWN_EVM_MAINNETS, plan.rpcChainId) ? `, a mainnet (${KNOWN_EVM_MAINNETS[plan.rpcChainId]})` : '';
    plan.blockers.push(`The RPC (${rpc.label}) is on chain ${plan.rpcChainId}${other}, not ${chainId}: point it at ${chainName(chainId)}`);
    return plan;
  }
  const proxy = await rpc.code(DETERMINISTIC_DEPLOYER);
  if (proxy === '0x') {
    plan.deployer.state = 'missing';
    plan.blockers.push(
      `The deterministic deployment proxy ${DETERMINISTIC_DEPLOYER} has no code on chain ${chainId}. The predicted addresses depend on it, so this ` +
        'script never deploys another way. It is put on a chain with its one pre-signed transaction (github.com/Arachnid/deterministic-deployment-proxy: ' +
        'fund its one-time signer, then send the published raw transaction); most test chains, Base Sepolia among them, already have it',
    );
  } else if (keccakHex(proxy) !== DETERMINISTIC_DEPLOYER_CODE_HASH) {
    plan.deployer.state = 'other-code';
    plan.blockers.push(`${DETERMINISTIC_DEPLOYER} on chain ${chainId} runs other code than the deterministic deployment proxy (code hash ${keccakHex(proxy)}): the predicted addresses don't hold there`);
  } else {
    plan.deployer.state = 'ok';
  }
  for (const c of plan.contracts) {
    const code = await rpc.code(c.address);
    c.state = 'absent';
    if (code === '0x') continue;
    c.onChainCodeHash = keccakHex(code);
    c.state = c.onChainCodeHash === c.runtimeCodeHash ? 'matches' : 'mismatch';
    if (c.state === 'mismatch') {
      plan.blockers.push(`MISMATCH: ${c.name} at ${c.address} has runtime code hash ${c.onChainCodeHash}, not the artifact's ${c.runtimeCodeHash}. Don't pin it: find out what is deployed there`);
    }
  }
  const entry = m.evm?.sponsor?.chains[String(chainId)];
  const delegate = plan.contracts.find((c) => c.name === 'HanaDelegateExecutor');
  if (entry && delegate && entry.delegate.toLowerCase() !== delegate.address.toLowerCase()) {
    plan.warnings.push(`envs/${m.name}.json evm.sponsor.chains.${chainId}.delegate is ${entry.delegate}, not the artifact's ${delegate.address}: the follow-up PR must fix it`);
  }
  if (plan.blockers.length === 0) plan.deploy = plan.contracts.filter((c) => c.state === 'absent').map((c) => c.name);
  return plan;
}

function describePlan(p: EvmDeployPlan, log: (l: string) => void): void {
  log(`Environment ${p.env}: ${p.chainName} (chain ${p.chainId}), RPC ${p.rpc.label} (${p.rpc.source === 'manifest' ? `envs/${p.env}.json` : p.rpc.source === 'env' ? EVM_RPC_ENV : '--rpc'})`);
  if (p.rpcChainId !== null && p.rpcChainId === p.chainId) log(`  eth_chainId ${p.rpcChainId}: the right chain`);
  const proxy = { ok: 'present, with its known code', missing: 'NOT on this chain', 'other-code': 'OTHER CODE at its address', unknown: 'not read' }[p.deployer.state];
  log(`  deterministic deployment proxy ${p.deployer.address}: ${proxy}`);
  for (const c of p.contracts) {
    const state = { unread: 'not read', absent: 'not deployed', matches: 'already deployed, matches the artifact', mismatch: `MISMATCH (on chain ${c.onChainCodeHash})` }[c.state];
    log(`  ${c.name.padEnd(20)} ${c.address}  ${state}`);
    log(`  ${''.padEnd(20)} salt keccak256("${c.saltLabel}") = ${c.salt}`);
    log(`  ${''.padEnd(20)} runtime code hash ${c.runtimeCodeHash}`);
  }
  for (const w of p.warnings) log(`warning: ${w}`);
  if (p.blockers.length) {
    log(`\nCannot deploy until these are fixed:\n${p.blockers.map((b) => `  ✗ ${b}`).join('\n')}`);
    return;
  }
  if (p.deploy.length === 0) {
    log('\nNothing to deploy: both contracts are already deployed and match their artifacts.');
    return;
  }
  log(`\nPlan:\n${p.deploy.map((n, i) => `  ${i + 1}. deploy ${n} through the proxy (cast send, signed by your keystore)`).join('\n')}`);
}

/** The explorer-verification commands for one deployed contract, after `forge build --root <root>` (from the repo root, by default). */
export function verifyArgvs(a: Pick<DelegateArtifact, 'address' | 'forgeId' | 'compilerVersion' | 'contractName'>, chainId: number, root = 'contracts/evm-delegate'): { label: string; argv: string[] }[] {
  const base = ['verify-contract', a.address, a.forgeId, '--root', root, '--chain', String(chainId), '--compiler-version', a.compilerVersion];
  const ex = EXPLORERS[chainId];
  const out: { label: string; argv: string[] }[] = [];
  if (ex?.blockscout) out.push({ label: 'Blockscout (no API key)', argv: [...base, '--verifier', 'blockscout', '--verifier-url', ex.blockscout, '--watch'] });
  out.push({ label: 'Etherscan-family explorer (needs ETHERSCAN_API_KEY in the shell; never in the repo)', argv: [...base, '--verifier', 'etherscan', '--watch'] });
  return out;
}

const shellQuote = (a: string): string => (/^[\w@%+=:,./-]+$/u.test(a) ? a : `'${a.replace(/'/gu, `'\\''`)}'`);

function printVerification(artifacts: readonly DelegateArtifact[], chainId: number, log: (l: string) => void): void {
  log('\nVerify on the explorer (standard-JSON input; the metadata is stripped, so a flattened upload may not match).');
  log('From the repo root, at this commit (forge rebuilds with contracts/evm-delegate/foundry.toml). An Etherscan key goes in');
  log('the shell without echo or history first: read -rs ETHERSCAN_API_KEY; export ETHERSCAN_API_KEY');
  log('  forge build --root contracts/evm-delegate');
  for (const a of artifacts) {
    for (const v of verifyArgvs(a, chainId)) log(`  forge ${v.argv.map(shellQuote).join(' ')}   # ${a.contractName}: ${v.label}`);
  }
  log('The standard-JSON input itself, to upload by hand where an explorer asks for it (solc 0.8.28, optimizer 10000 runs, EVM prague, metadata bytecodeHash none, no CBOR, no constructor arguments):');
  for (const a of artifacts) log(`  forge verify-contract ${a.address} ${a.forgeId} --root contracts/evm-delegate --show-standard-json-input > ${a.contractName}.standard-input.json`);
  const urls = EXPLORERS[chainId]?.addressUrls ?? [];
  for (const a of artifacts) for (const u of urls) log(`  ${a.contractName}: ${u}${a.address}`);
}

/** The entry for core's pinned table (packages/core/src/evm-sponsor/delegates.ts), exactly as the follow-up PR adds it. */
export function delegatesEntry(chainId: number, delegate: Pick<DelegateArtifact, 'address' | 'runtimeCodeHash'>, today: string): string {
  return [
    `  // ${chainName(chainId)}: the deterministic deployment of contracts/evm-delegate (artifacts/HanaDelegateExecutor.json`,
    `  // \`create2\` and \`runtimeCodeHash\`), deployed with deploy-evm-delegate; the on-chain runtime code hash read and checked`,
    `  // against the artifact on ${today}.`,
    `  ${chainId}: Object.freeze({`,
    `    address: '${delegate.address}',`,
    `    runtimeCodeHash: '${delegate.runtimeCodeHash}',`,
    '    domain: SPONSOR_DELEGATE_DOMAIN,',
    '    abiVersion: SPONSOR_ABI_VERSION,',
    '    placeholder: false,',
    '  }),',
  ].join('\n');
}

/** The demo check-in's line for DEMO_CHECK_IN (packages/core/src/demo-check-in.ts, D854), exactly as the follow-up PR adds it. */
export function checkInEntry(chainId: number, checkIn: Pick<DelegateArtifact, 'address' | 'runtimeCodeHash'>, today: string): string {
  return `  ${chainId}: Object.freeze({ address: '${checkIn.address}', runtimeCodeHash: '${checkIn.runtimeCodeHash}' }), // ${chainName(chainId)}, code hash checked on ${today}`;
}

/** The manifest block with the real addresses; `<…>` marks what the founder fills in. The numbers are D836's. */
export function manifestTemplate(chainId: number, delegate: string, checkIn: string, rpc: { rpc: string; rpcFallback: string } | undefined): string {
  const r = rpc ?? { rpc: '<https RPC of a DNS name, no path, no API key>', rpcFallback: '<another provider, same rules>' };
  return [
    '"evm": { "sponsor": {',
    '  "relayerAddress": "<the address evm-relay-keys printed>",',
    `  "chains": { "${chainId}": {`,
    `    "rpc": "${r.rpc}", "rpcFallback": "${r.rpcFallback}",`,
    `    "delegate": "${delegate}", "opStack": ${OP_STACK_TEST_CHAIN_IDS.includes(chainId)},`,
    '    "maxGasPerTx": 300000, "maxFeePerGasGwei": 1, "maxPriorityFeePerGasGwei": 0.01,',
    '    "maxCallsPerBatch": 4, "deadlineMaxS": 600, "minGas": 100000,',
    '    "dailyBudgetEth": 0.02, "appDailyBudgetEth": 0.01, "lowBalanceEth": 0.05,',
    '    "perUserPerDay": 30, "perAppPerDay": 2000, "sendsPerDay": 5000, "sendsPerMinute": 60,',
    '    "requireKnownAccount": true } },',
    `  "apps": { "<the demo app's app_… id>": { "${chainId}": [ { "address": "${checkIn}", "selectors": ["0x183ff085"], "exactCalldata": ["0x183ff085"],`,
    '                                       "maxDataBytes": 4, "label": "Journear demo check-in" } ] } } } }',
  ].join('\n');
}

function printFollowUp(m: Manifest, chainId: number, artifacts: readonly DelegateArtifact[], today: string, log: (l: string) => void): void {
  const delegate = artifacts.find((a) => a.contractName === 'HanaDelegateExecutor')!;
  const checkIn = artifacts.find((a) => a.contractName === 'CheckIn')!;
  log('\nThe follow-up PR (base next). 1) Add this entry to SPONSOR_DELEGATES in packages/core/src/evm-sponsor/delegates.ts,');
  log('   and update the comment above the table ("Today: …") to say the chain has it:');
  log(delegatesEntry(chainId, delegate, today));
  log('   and this line to DEMO_CHECK_IN in packages/core/src/demo-check-in.ts (the check-in reads plainly and is on the verified list there, D854):');
  log(checkInEntry(chainId, checkIn, today));
  log(`2) Add the block to envs/${m.name}.json (the relayer's address from \`evm-relay-keys ${m.name}\`; the app id of the demo app):`);
  log(manifestTemplate(chainId, delegate.address, checkIn.address, TEMPLATE_RPCS[chainId]));
  log('3) Update the docs that say the chain has no pinned delegate yet: envs/README.md "evm.sponsor", docs/operations.md');
  log('   "EVM gas sponsorship" and "EVM sponsorship relay"; record the deploy (date, both addresses, the explorer links) in D849.');
  log('Then corepack pnpm verify (core\'s test checks the new entry against the artifact).');
}

/** Runs deploy-evm-delegate with argv (without node and script path). Returns the exit code. */
export async function evmDeployMain(argv: readonly string[], deps: EvmDeployDeps = defaultEvmDeployDeps()): Promise<number> {
  const args = parseCli(argv, { booleans: ['yes', 'verify', 'json', 'help'], strings: ['chain', 'rpc', 'account'] });
  const log = deps.log;
  if (args.flag('help')) {
    log(DEPLOY_EVM_DELEGATE_USAGE);
    return 0;
  }
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const yes = args.flag('yes');
  const json = args.flag('json');
  if (json && yes) throw new CliError('--json prints the plan only: not with --yes');
  const account = args.str('account');
  if (account !== undefined && !ACCOUNT_RE.test(account)) throw new CliError('--account is a keystore name (letters, digits, ".", "_", "-"), not a path or a key');
  if (yes && account === undefined) throw new CliError('--yes needs --account <keystore name> (a Foundry keystore: cast wallet new ~/.foundry/keystores <name>)');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env`);
  const chainId = checkChain(args.str('chain'), m);
  const entry = m.evm?.sponsor?.chains[String(chainId)];
  const flagRpc = args.str('rpc');
  const shellEnv = deps.env ?? process.env;
  const envRpc = shellEnv[EVM_RPC_ENV] === '' ? undefined : shellEnv[EVM_RPC_ENV];
  if (entry && (flagRpc !== undefined || envRpc !== undefined)) throw new CliError(`envs/${m.name}.json names chain ${chainId}'s RPC (evm.sponsor.chains.${chainId}.rpc): drop ${flagRpc !== undefined ? '--rpc' : `${EVM_RPC_ENV} (unset it)`}`);
  if (flagRpc !== undefined && envRpc !== undefined) throw new CliError(`Both --rpc and ${EVM_RPC_ENV} are set: use one`);
  const url = entry?.rpc ?? flagRpc ?? envRpc;
  if (url === undefined) throw new CliError(`envs/${m.name}.json has no evm.sponsor entry for chain ${chainId}: pass --rpc <its https RPC, no path>${chainId === 84532 ? ' (e.g. https://sepolia.base.org)' : ''}, or a keyed provider URL in ${EVM_RPC_ENV}`);
  const source: RpcSource = entry ? 'manifest' : flagRpc !== undefined ? 'flag' : 'env';
  const urlProblem = source === 'flag' ? rpcFlagUrlProblem(url) : rpcUrlProblem(url);
  if (urlProblem) throw new CliError(`The RPC ${source === 'env' ? `in ${EVM_RPC_ENV} ` : ''}${urlProblem}`);
  const root = deps.root ?? repoRoot;
  const artifacts = loadDelegateArtifacts(root);
  const rpc = evmRpc(url, deps.fetch ?? fetch);

  const plan = await observeEvmDeploy(m, chainId, rpc, source, artifacts);
  if (json) {
    log(JSON.stringify(plan, null, 2));
    return plan.blockers.length ? 1 : 0;
  }
  describePlan(plan, log);
  if (plan.blockers.length) return 1;
  const today = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  if (plan.deploy.length > 0 && !yes) {
    log(`\n${EVM_DRY_RUN_LINE}`);
    return 0;
  }
  // cast and forge run in an empty directory of their own, so no foundry.toml but contracts/evm-delegate's (named
  // with --root) can change who signs, where it sends or how it builds.
  const toolCwd = mkdtempSync(join(tmpdir(), 'hana-evm-cwd-'));
  try {
    if (plan.deploy.length > 0) {
      for (const [i, name] of plan.deploy.entries()) {
        const a = artifacts.find((x) => x.contractName === name)!;
        log(`\n[${i + 1}/${plan.deploy.length}] deploy ${name} at ${a.address}: cast send to the proxy, signed by keystore "${account}" (cast asks for its password)`);
        const res = deps.runTool('cast', ['send', DETERMINISTIC_DEPLOYER, deployCalldata(a), '--account', account!, '--chain', String(chainId)], { cwd: toolCwd, env: { ETH_RPC_URL: url } });
        if (res.error) throw new Error(`cast could not run (${res.error.message}): install Foundry 1.5.1 (foundryup --install 1.5.1)`);
        if (res.status !== 0) throw new Error(`cast send for ${name} failed (exit ${res.status}; its own message is above): nothing more was sent. Re-run the plan to see what is deployed`);
        // A public RPC is several nodes: one that lags the receipt cast waited for answers no code for a few seconds.
        let code = await rpc.code(a.address);
        for (let t = 0; code === '0x' && t < POST_DEPLOY_READS; t++) {
          await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(POST_DEPLOY_WAIT_MS);
          code = await rpc.code(a.address);
        }
        if (code === '0x') throw new Error(`${name}: no code at ${a.address} after the transaction (see cast's receipt above): stop and find out why`);
        const hash = keccakHex(code);
        if (hash !== a.runtimeCodeHash) throw new Error(`MISMATCH after the deploy: ${name} at ${a.address} has runtime code hash ${hash}, not the artifact's ${a.runtimeCodeHash}. Don't pin it`);
        log(`    ✓ ${name} at ${a.address}: runtime code hash ${hash}, the artifact's`);
      }
      log(`\nDeployed: both contracts are at their predicted addresses on chain ${chainId} and match their artifacts.`);
    }
    if (args.flag('verify')) {
      log('\nVerifying on the explorer (forge verify-contract, standard-JSON input):');
      const dir = join(root, 'contracts', 'evm-delegate');
      const build = deps.runTool('forge', ['build', '--root', dir], { cwd: toolCwd, env: {} });
      if (build.status !== 0) throw new Error(`forge build failed (exit ${build.status ?? 'none'}): verification not attempted`);
      let failed = 0;
      for (const a of artifacts) {
        for (const v of verifyArgvs(a, chainId, dir)) {
          if (v.argv.includes('etherscan') && !shellEnv.ETHERSCAN_API_KEY) {
            log(`  skipped ${a.contractName} on the Etherscan-family explorer: no ETHERSCAN_API_KEY in the shell`);
            continue;
          }
          log(`  ${a.contractName}: ${v.label}`);
          // forge reads ETHERSCAN_API_KEY from the environment itself: the key is never on a command line.
          const res = deps.runTool('forge', v.argv, { cwd: toolCwd, env: {} });
          if (res.status !== 0) failed++;
        }
      }
      if (failed) log(`${failed} verification(s) failed (forge's messages are above); the commands below retry them.`);
    }
  } finally {
    rmSync(toolCwd, { recursive: true, force: true });
  }
  printVerification(artifacts, chainId, log);
  printFollowUp(m, chainId, artifacts, today, log);
  return 0;
}
