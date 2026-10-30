// council-setup: the dev-env owner council (D81). Creates three throwaway testnet member accounts whose keys go to
// .secrets/<env>/council/<account>.json (0600, saved before the account exists on chain), then a Sputnik DAO v2
// through the testnet factory with contracts/sputnik/policy.json (2 of 3 for every proposal kind, only the council
// proposes). Plan first; --yes to act. Re-running plans only what is missing and checks what exists: a DAO with other
// code or another policy stops the plan.
//
// Accounts are created by a funder (default: the manifest owner, its full-access key from ~/.near-credentials):
// a top-level `<name>.testnet` through the registrar's `create_account(new_account_id, new_public_key)` (what
// near-cli-rs `create-account fund-myself` does), a sub-account of the funder with CreateAccount + Transfer + AddKey.
// Dev envs on testnet only: other envs' members create their own accounts and hold their own keys (Ledgers on mainnet).
import { isDevEnv, type Manifest, loadEnv } from '@hana-id/env';
import { actionCreators } from '@near-js/transactions';
import { CliError, parseCli } from './cli.ts';
import { councilKeysOnDisk, readCouncilKey, writeCouncilKey } from './council.ts';
import { findLegacyCredential, generateKey, type LoadedKey } from './keys.ts';
import { explorerTx, formatNear, hasFullAccess, type NearRpc, nearToYocto, TGAS } from './near.ts';
import {
  daoCreateDeposit,
  FACTORY_CREATE_GAS,
  factoryCreateArgs,
  policyProblems,
  readPin,
  readPolicyTemplate,
  type SputnikPin,
  type SputnikPolicy,
} from './sputnik.ts';

export const COUNCIL_USAGE = `Usage: council-setup.ts <env> [--yes] [--funder <account>] [--member-balance 2]
  Dev envs (local*, sandbox*) on testnet only. Creates the three council member accounts of envs/<env>.json
  (keys in .secrets/<env>/council/, 0600) and the council's Sputnik DAO v2 (contracts/sputnik/policy.json: 2 of 3
  for every proposal kind). Prints the plan; --yes sends it.
  --funder <account>     pays for the accounts and the DAO (default: the manifest owner; key from ~/.near-credentials)
  --member-balance NEAR  initial balance of each member account (default 2: proposal bonds of 0.1 NEAR and gas)`;

export const COUNCIL_DRY_RUN_LINE = 'Dry run: nothing changed. Re-run with --yes to apply.';

export type CouncilRpc = Pick<NearRpc, 'chainId' | 'account' | 'accessKeys' | 'view' | 'sendTx'>;

export interface CouncilObserved {
  chainId: string;
  factory: { exists: boolean; defaultCodeHash: string | null };
  dao: { exists: boolean; codeHash: string; policy: SputnikPolicy | null };
  members: Record<string, { exists: boolean; keyInFile: string | null; keyFullAccessOnChain: boolean }>;
  funder: { account: string; exists: boolean; balanceYocto: bigint; credentialFound: boolean; fullAccessOnChain: boolean };
}

export type MemberVia = { kind: 'registrar'; registrar: string } | { kind: 'subaccount' };

export type CouncilStep =
  | { kind: 'member'; account: string; generate: boolean; via: MemberVia; depositYocto: bigint }
  | { kind: 'dao'; depositYocto: bigint };

export interface CouncilPlan {
  blockers: string[];
  warnings: string[];
  steps: CouncilStep[];
  done: string[];
}

/** How the funder creates `account`: as its sub-account, or through the registrar of a top-level name. */
export function memberVia(account: string, funder: string): MemberVia | null {
  if (account.endsWith(`.${funder}`) && !account.slice(0, -funder.length - 1).includes('.')) return { kind: 'subaccount' };
  const dot = account.indexOf('.');
  const registrar = account.slice(dot + 1);
  if (dot > 0 && !registrar.includes('.')) return { kind: 'registrar', registrar };
  return null;
}

export function buildCouncilPlan(m: Manifest, o: CouncilObserved, opts: { memberBalanceYocto: bigint }, pin: SputnikPin, template: SputnikPolicy = readPolicyTemplate()): CouncilPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const steps: CouncilStep[] = [];
  const done: string[] = [];
  if (!councilKeysOnDisk(m)) {
    blockers.push(`council-setup is for dev envs (local*, sandbox*) on testnet only; ${m.name} isn't one. There each member creates and holds their own account (Ledgers on mainnet) and the DAO is created by hand (docs/operations.md "Owner council").`);
  }
  if (!m.council) {
    blockers.push(`envs/${m.name}.json has no council (factory, dao, members).`);
    return { blockers, warnings, steps, done };
  }
  const { council } = m;
  if (o.chainId !== 'testnet') blockers.push(`RPC ${m.rpc} reports chain "${o.chainId}", not testnet.`);
  if (!o.factory.exists) blockers.push(`The factory ${council.factory} does not exist on ${o.chainId}.`);
  else if (o.factory.defaultCodeHash !== pin.code_hash) {
    blockers.push(
      `The factory ${council.factory} deploys code ${o.factory.defaultCodeHash ?? '(unknown)'}, not the pinned ${pin.code_hash} (contracts/sputnik/pin.json, v${pin.version.join('.')}). ` +
        'Re-pin it and re-run the sandbox DAO test (contracts/integration-tests, sputnik_dao_owner_2_of_3) before creating a DAO with it.',
    );
  }

  for (const account of council.members) {
    const s = o.members[account] ?? { exists: false, keyInFile: null, keyFullAccessOnChain: false };
    if (s.exists) {
      if (!s.keyInFile) blockers.push(`Council member ${account} exists on chain but .secrets/${m.name}/council/${account}.json is missing: the name is taken or its key is lost. Pick another name in envs/${m.name}.json.`);
      else if (!s.keyFullAccessOnChain) blockers.push(`The key in .secrets/${m.name}/council/${account}.json (${s.keyInFile}) is not a full-access key of ${account} on chain.`);
      else done.push(`Council member ${account} in place (key in .secrets/${m.name}/council/).`);
      continue;
    }
    const via = memberVia(account, o.funder.account);
    if (!via) {
      blockers.push(`Can't create ${account}: it is neither a top-level testnet name (<name>.testnet) nor a sub-account of the funder ${o.funder.account}.`);
      continue;
    }
    steps.push({ kind: 'member', account, generate: !s.keyInFile, via, depositYocto: opts.memberBalanceYocto });
  }

  if (o.dao.exists) {
    if (o.dao.codeHash !== pin.code_hash) blockers.push(`${council.dao} exists with code ${o.dao.codeHash}, not the pinned Sputnik DAO ${pin.code_hash}.`);
    else if (!o.dao.policy) blockers.push(`${council.dao} has the DAO code but get_policy fails (not initialised?).`);
    else {
      const p = policyProblems(o.dao.policy, council.members, template);
      for (const b of p.blockers) blockers.push(`${council.dao}: ${b}.`);
      for (const w of p.warnings) warnings.push(`${council.dao}: ${w}.`);
      if (!p.blockers.length) done.push(`Council DAO ${council.dao} in place: ${council.members.join(', ')}, 2 of 3 for every proposal kind.`);
    }
  } else {
    steps.push({ kind: 'dao', depositYocto: daoCreateDeposit(pin) });
  }

  if (steps.length) {
    const need = steps.reduce((sum, s) => sum + s.depositYocto, 0n) + 10n ** 23n * BigInt(steps.length);
    if (!o.funder.exists) blockers.push(`The funder ${o.funder.account} does not exist.`);
    else if (!o.funder.credentialFound) blockers.push(`No key for the funder ${o.funder.account} in ~/.near-credentials/${m.network}/.`);
    else if (!o.funder.fullAccessOnChain) blockers.push(`The key for the funder ${o.funder.account} in ~/.near-credentials/${m.network}/ is not a full-access key on chain.`);
    else if (o.funder.balanceYocto < need) warnings.push(`The funder ${o.funder.account} has ${formatNear(o.funder.balanceYocto)}; the plan spends about ${formatNear(need)}. Top it up (testnet faucet) if a step fails.`);
  }
  return { blockers, warnings, steps, done };
}

export function describeCouncilStep(m: Manifest, s: CouncilStep, funder: string, pin: SputnikPin): string {
  const council = m.council!;
  if (s.kind === 'member') {
    const how = s.via.kind === 'registrar' ? `${s.via.registrar}.create_account` : 'CreateAccount + Transfer + AddKey (sub-account)';
    return `Create council member ${s.account} with ${formatNear(s.depositYocto)} (${how}, full-access key ${s.generate ? `generated into .secrets/${m.name}/council/${s.account}.json` : 'from .secrets'}) [signed by ${funder}].`;
  }
  return (
    `Create the council DAO ${council.dao}: ${council.factory}.create(name "${council.dao.slice(0, -council.factory.length - 1)}", ` +
    `Sputnik DAO v${pin.version.join('.')} code ${pin.code_hash}, members ${council.members.join(', ')}, policy contracts/sputnik/policy.json: 2 of 3 for every kind) ` +
    `with ${formatNear(s.depositYocto)} for its storage [signed by ${funder}].`
  );
}

export interface CouncilDeps {
  rpc: (url: string) => CouncilRpc;
  log: (line: string) => void;
  home?: string;
  secretsRoot?: string;
  loadManifest?: (name: string) => Manifest;
  pin?: SputnikPin;
  policyTemplate?: SputnikPolicy;
}

async function observe(m: Manifest, rpc: CouncilRpc, funder: LoadedKey | null, funderAccount: string, secretsRoot?: string): Promise<CouncilObserved> {
  const council = m.council!;
  const chainId = await rpc.chainId();
  const factoryAcct = await rpc.account(council.factory);
  const defaultCodeHash = factoryAcct ? await rpc.view<string>(council.factory, 'get_default_code_hash') : null;
  const daoAcct = await rpc.account(council.dao);
  let policy: SputnikPolicy | null = null;
  if (daoAcct) {
    try {
      policy = await rpc.view<SputnikPolicy>(council.dao, 'get_policy');
    } catch {
      policy = null;
    }
  }
  const members: CouncilObserved['members'] = {};
  for (const account of council.members) {
    const view = await rpc.account(account);
    const key = readCouncilKey(m.name, account, secretsRoot);
    const keys = view ? await rpc.accessKeys(account) : [];
    members[account] = { exists: !!view, keyInFile: key?.publicKey ?? null, keyFullAccessOnChain: !!key && hasFullAccess(keys, key.publicKey) };
  }
  const funderView = await rpc.account(funderAccount);
  const funderKeys = funderView ? await rpc.accessKeys(funderAccount) : [];
  return {
    chainId,
    factory: { exists: !!factoryAcct, defaultCodeHash },
    dao: { exists: !!daoAcct, codeHash: daoAcct?.code_hash ?? '', policy },
    members,
    funder: {
      account: funderAccount,
      exists: !!funderView,
      balanceYocto: funderView ? BigInt(funderView.amount) : 0n,
      credentialFound: !!funder,
      fullAccessOnChain: !!funder && hasFullAccess(funderKeys, funder.publicKey),
    },
  };
}

/** Runs council-setup with argv (without node and script path). Returns the exit code. */
export async function councilSetupMain(argv: readonly string[], deps: CouncilDeps): Promise<number> {
  const { log } = deps;
  const args = parseCli(argv, { booleans: ['yes', 'help'], strings: ['funder', 'member-balance'] });
  if (args.flag('help')) {
    log(COUNCIL_USAGE);
    return 0;
  }
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (!isDevEnv(m.name) || m.network !== 'testnet') throw new CliError(`council-setup is for dev envs (local*, sandbox*) on testnet only; ${m.name} isn't one`);
  if (!m.council) throw new CliError(`envs/${m.name}.json has no council`);
  let memberBalanceYocto: bigint;
  try {
    memberBalanceYocto = nearToYocto(args.str('member-balance') ?? '2');
  } catch {
    throw new CliError('--member-balance must be a NEAR amount such as 2');
  }
  if (memberBalanceYocto < 10n ** 24n / 2n) throw new CliError('--member-balance must be at least 0.5 NEAR (bonds and gas)');
  const funderAccount = args.str('funder') ?? m.owner;
  const pin = deps.pin ?? readPin();
  const template = deps.policyTemplate ?? readPolicyTemplate();
  const rpc = deps.rpc(m.rpc);
  const funder = findLegacyCredential(funderAccount, m.network, deps.home);

  log(`Environment ${m.name} (${m.network}, RPC ${m.rpc})`);
  log(`  council DAO ${m.council.dao} (factory ${m.council.factory}), members ${m.council.members.join(', ')}; funder ${funderAccount}\n`);
  const observed = await observe(m, rpc, funder, funderAccount, deps.secretsRoot);
  const plan = buildCouncilPlan(m, observed, { memberBalanceYocto }, pin, template);
  if (plan.done.length) log(`Already done:\n${plan.done.map((d) => `  ✓ ${d}`).join('\n')}`);
  if (plan.warnings.length) log(`\nWarnings:\n${plan.warnings.map((w) => `  ! ${w}`).join('\n')}`);
  log(plan.steps.length ? `\nPlan:\n${plan.steps.map((s, i) => `  ${i + 1}. ${describeCouncilStep(m, s, funderAccount, pin)}`).join('\n')}` : '\nNothing to do.');
  if (plan.blockers.length) {
    log(`\nCannot set up the council until these are fixed:\n${plan.blockers.map((b) => `  ✗ ${b}`).join('\n')}`);
    return 1;
  }
  if (!plan.steps.length) return 0;
  if (!args.flag('yes')) {
    log(`\n${COUNCIL_DRY_RUN_LINE}`);
    return 0;
  }
  if (!funder) throw new Error(`No key for ${funderAccount}`);
  const tx = { accountId: funder.accountId, keyPair: funder.keyPair };
  for (const [i, step] of plan.steps.entries()) {
    log(`\n[${i + 1}/${plan.steps.length}] ${describeCouncilStep(m, step, funderAccount, pin)}`);
    if (step.kind === 'member') {
      let key = readCouncilKey(m.name, step.account, deps.secretsRoot)?.keyPair;
      if (!key) {
        key = generateKey();
        // Saved before the account exists, so an account that lands on chain never has a lost key.
        writeCouncilKey(m.name, step.account, key, deps.secretsRoot);
      }
      const publicKey = key.getPublicKey();
      if (step.via.kind === 'registrar') {
        const { hash, value } = await rpc.sendTx(tx, step.via.registrar, [
          actionCreators.functionCall('create_account', { new_account_id: step.account, new_public_key: publicKey.toString() }, 30n * TGAS, step.depositYocto),
        ]);
        log(`    tx ${explorerTx(hash)}`);
        if (value !== true) throw new Error(`${step.via.registrar}.create_account returned ${JSON.stringify(value)}: ${step.account} was not created (deposit refunded)`);
      } else {
        const { hash } = await rpc.sendTx(tx, step.account, [actionCreators.createAccount(), actionCreators.transfer(step.depositYocto), actionCreators.addKey(publicKey, actionCreators.fullAccessKey())]);
        log(`    tx ${explorerTx(hash)}`);
      }
      log(`    created ${step.account} (key ${publicKey.toString()})`);
    } else {
      const { hash } = await rpc.sendTx(tx, m.council.factory, [
        actionCreators.functionCall('create', factoryCreateArgs(m.council, `hana-signer owner council for ${m.name} (D81)`, template), FACTORY_CREATE_GAS, step.depositYocto),
      ]);
      log(`    tx ${explorerTx(hash)}`);
      // The factory doesn't return its promise, so the transaction's value is always empty (its `on_create` result is
      // in a callback receipt): the DAO account existing is the check. The plan refused a DAO that already existed.
      if (!(await rpc.account(m.council.dao))) throw new Error(`${m.council.factory}.create did not create ${m.council.dao} (deposit refunded)`);
      const policy = await rpc.view<SputnikPolicy>(m.council.dao, 'get_policy');
      const problems = policyProblems(policy, m.council.members, template);
      if (problems.blockers.length) throw new Error(`${m.council.dao} was created but its policy is not the council policy: ${problems.blockers.join('; ')}`);
      log(`    ${m.council.dao} created: 2 of 3 of ${m.council.members.join(', ')} for every proposal kind`);
    }
  }
  log(`\nDone. Council keys are in .secrets/${m.name}/council/ (0600). Next (docs/operations.md "Governance migration (sandbox-dev)"):
  deploy-contract ${m.name} --upgrade                    # migrate_v1, updater key, watchdog
  deploy-contract ${m.name} --transfer-owner --approve-with <member>   # propose_owner(DAO), then the DAO accepts`);
  return 0;
}
