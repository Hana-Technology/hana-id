// admin.ts owner:* and governance:status: owner actions through the manifest's owner (an account, or the council
// DAO, D81) and a read-only governance status (docs/governance-spec.md "Monitoring in the admin portal").
//
// owner:call <method> --args <json>   prints the call (and, for a council owner, the proposal); --yes sends it. With
//   --approve-with <member> (dev envs on testnet only) the proposer and that member approve in the same command, so
//   it executes; elsewhere it only proposes and prints the vote each member must sign.
// owner:vote <id> --member <m> [--reject]   one VoteApprove, or VoteReject (dev envs: key from .secrets/<env>/council/).
// owner:proposals [--json]            the council's recent proposals, decoded.
// governance:status [--json]          get_config / get_governance / get_key_changes / the signer's keys / the council,
//   with findings. Its --json output is the machine-readable source batch C's "Security & monitoring" view starts
//   from (docs/operations.md "Governance status for the admin portal").
import { governanceDelayProblems, type Manifest } from '@hana-id/env';
import { type Args, CliError } from './cli.ts';
import { type ContractConfig, GOOGLE_PROVIDER, type GovernanceView, type KeyChangeView, normaliseIssuer, tryView, UPDATER_ALLOWANCE_YOCTO, UPDATER_METHODS } from './contract.ts';
import { checkFunctionKey, signerFullAccessAllowed } from './deploy-plan.ts';
import { fetchGoogleJwks, usableKeys } from './jwks.ts';
import { type AccessKeyListEntry, describePermission, type NearRpc, TGAS } from './near.ts';
import { castVote, describeOwnerCall, isOwnerMethod, type OwnerTxDeps, type OwnerTxOptions, sendOwnerCall } from './owner-tx.ts';
import { approvers, type DaoProposal, decodeFunctionCall, decodeMemberChange, isOpen, policyProblems, recentProposals, type SputnikPolicy, votesNeeded } from './sputnik.ts';

export const OWNER_DRY_RUN_LINE = 'Dry run: re-run with --yes to send.';

export interface AdminOwnerDeps extends Omit<OwnerTxDeps, 'rpc'> {
  rpc: Pick<NearRpc, 'chainId' | 'view' | 'sendTx' | 'accessKeys' | 'account'>;
  /** Google's JWKS (default: fetched), to check the contract's google keys against what Google publishes. */
  fetchJwks?: () => Promise<{ keys?: unknown }>;
}

function ownerTxOptions(args: Args): OwnerTxOptions {
  return { member: args.str('member'), approveWith: args.str('approve-with') };
}

async function assertTestnet(rpc: Pick<NearRpc, 'chainId'>, m: Manifest): Promise<void> {
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);
}

/** The council DAO the commands vote on: the owner if it is the council, else the manifest's council. */
export function councilDao(m: Manifest): string {
  if (!m.council) throw new CliError(`envs/${m.name}.json has no council`);
  return m.ownerKind === 'sputnik' ? m.owner : m.council.dao;
}

export async function ownerCallCmd(m: Manifest, method: string, args: Args, deps: AdminOwnerDeps): Promise<void> {
  if (!isOwnerMethod(method)) throw new CliError(`${method} is not an owner method of hana-signer`);
  let callArgs: unknown;
  try {
    callArgs = JSON.parse(args.str('args') ?? '{}');
  } catch {
    throw new CliError('--args must be a JSON object');
  }
  if (!callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) throw new CliError('--args must be a JSON object');
  const gas = BigInt(args.int('gas', 100, { min: 1, max: 250 })) * TGAS;
  const call = { method, args: callArgs, gas };
  const opts = ownerTxOptions(args);
  deps.log(`${describeOwnerCall(m, call, opts)} on ${m.signer}`);
  if (!args.flag('yes')) return void deps.log(OWNER_DRY_RUN_LINE);
  await assertTestnet(deps.rpc, m);
  const r = await sendOwnerCall(m, call, opts, deps);
  if (r.kind === 'executed') deps.log(`Done: ${JSON.stringify(r.value)}`);
  else if (r.kind === 'approved') deps.log(`Done: proposal #${r.proposalId} approved and executed.`);
  else deps.log(`Proposed #${r.proposalId}: waiting for ${r.needed - r.approvals.length} more approval(s).`);
}

export function describeProposal(p: DaoProposal, policy: SputnikPolicy, nowMs: number): string[] {
  const group = (policy.roles?.[0]?.kind as { Group?: string[] } | undefined)?.Group ?? [];
  const needed = votesNeeded(policy.default_vote_policy.threshold, group.length);
  const calls = decodeFunctionCall(p.kind);
  const change = decodeMemberChange(p.kind);
  const what = calls
    ? calls.map((c) => `${c.receiver}.${c.method}(${typeof c.args === 'string' ? c.args : JSON.stringify(c.args)})`).join(' + ')
    : change
      ? `${change.op === 'add' ? 'AddMemberToRole' : 'RemoveMemberFromRole'}(${change.member}, role ${change.role})`
      : JSON.stringify(p.kind);
  const rejecters = Object.entries(p.votes ?? {}).filter(([, v]) => v === 'Reject').map(([a]) => a);
  const expiresMs = Number((BigInt(p.submission_time) + BigInt(policy.proposal_period)) / 1_000_000n);
  const status = p.status === 'InProgress' && !isOpen(p, policy, nowMs) ? 'Expired (not finalized)' : p.status;
  return [
    `#${p.id} ${status}: ${what}`,
    `    by ${p.proposer}; approvals ${approvers(p).length}/${needed} (${approvers(p).join(', ') || 'none'})${rejecters.length ? `; rejections ${rejecters.length}/${needed} (${rejecters.join(', ')})` : ''}${p.status === 'InProgress' ? `; open until ${new Date(expiresMs).toISOString()}` : ''}`,
    `    "${p.description}"`,
  ];
}

export async function ownerVoteCmd(m: Manifest, idText: string, args: Args, deps: AdminOwnerDeps): Promise<void> {
  if (!/^\d{1,10}$/u.test(idText)) throw new CliError('owner:vote takes a proposal id');
  const id = Number(idText);
  const dao = councilDao(m);
  const member = args.required('member');
  const policy = await deps.rpc.view<SputnikPolicy>(dao, 'get_policy');
  const p = await deps.rpc.view<DaoProposal>(dao, 'get_proposal', { id });
  const nowMs = deps.now?.() ?? Date.now();
  for (const line of describeProposal(p, policy, nowMs)) deps.log(line);
  if (!isOpen(p, policy, nowMs)) throw new Error(`Proposal #${id} is not open for votes`);
  // A member votes once (the DAO refuses a second vote: ERR_ALREADY_VOTED).
  const prior = p.votes?.[member];
  if (prior === 'Approve') return void deps.log(`${member} already approved #${id}.`);
  if (prior) return void deps.log(`${member} already voted ${prior} on #${id}.`);
  const action = args.flag('reject') ? 'VoteReject' : 'VoteApprove';
  deps.log(`${action} #${id} on ${dao} by ${member}`);
  if (!args.flag('yes')) return void deps.log(OWNER_DRY_RUN_LINE);
  await assertTestnet(deps.rpc, m);
  const status = await castVote(m, dao, id, member, action, deps);
  deps.log(
    status === 'Approved'
      ? `#${id} approved and executed.`
      : status === 'Failed'
        ? `#${id} reached the threshold but its call failed (status Failed).`
        : status === 'Rejected'
          ? `#${id} rejected: it will not execute (the proposer's bond is refunded).`
          : `#${id} is ${status}.`,
  );
}

export async function ownerProposalsCmd(m: Manifest, args: Args, deps: AdminOwnerDeps): Promise<void> {
  const dao = councilDao(m);
  const limit = args.int('limit', 20, { min: 1, max: 100 });
  const policy = await deps.rpc.view<SputnikPolicy>(dao, 'get_policy');
  const proposals = await recentProposals(deps.rpc, dao, limit);
  if (args.flag('json')) return void deps.log(JSON.stringify({ dao, policy, proposals: proposals.map((p) => ({ ...p, calls: decodeFunctionCall(p.kind) })) }, null, 2));
  if (!proposals.length) return void deps.log(`No proposals on ${dao}.`);
  for (const p of proposals) for (const line of describeProposal(p, policy, deps.now?.() ?? Date.now())) deps.log(line);
}

export interface GovernanceStatus {
  env: string;
  signer: string;
  owner: { account: string; kind: 'account' | 'sputnik' };
  observedAtMs: number;
  contract: { codeHash: string; stateVersion: number | null };
  config: ContractConfig | null;
  governance: GovernanceView | null;
  keyChanges: KeyChangeView[];
  activeKids: string[];
  signerKeys: { publicKey: string; permission: string; tracked: boolean }[];
  council: { dao: string; policy: SputnikPolicy | null; openProposals: DaoProposal[] } | null;
  /** Problems a monitor should show (each a sentence): untracked keys, full-access keys where none are allowed, … */
  findings: string[];
}

/** Collects the governance status (read-only views only). */
export async function governanceStatus(m: Manifest, deps: AdminOwnerDeps): Promise<GovernanceStatus> {
  const { rpc } = deps;
  const nowMs = deps.now?.() ?? Date.now();
  const account = await rpc.account(m.signer);
  const config = account ? await tryView<ContractConfig>(rpc, m.signer, 'get_config') : null;
  const governance = config ? await tryView<GovernanceView>(rpc, m.signer, 'get_governance') : null;
  const keyChanges = governance ? ((await tryView<KeyChangeView[]>(rpc, m.signer, 'get_key_changes')) ?? []) : [];
  const issuer = config ? normaliseIssuer(await tryView<unknown>(rpc, m.signer, 'get_issuer', { provider: GOOGLE_PROVIDER })) : null;
  const keys: AccessKeyListEntry[] = account ? await rpc.accessKeys(m.signer) : [];
  const tracked = new Set([...(governance?.updater_keys ?? []), ...(governance?.pending_updater_keys ?? [])]);
  const findings: string[] = [];
  if (!config) findings.push(`${m.signer} is not initialised.`);
  else if (!governance) findings.push(`${m.signer} runs the v1 (pre-governance) contract.`);
  for (const k of keys) {
    if (k.access_key.permission === 'FullAccess') {
      if (!signerFullAccessAllowed(m)) findings.push(`${m.signer} has a full-access key ${k.public_key} (none allowed on ${m.name}, D86).`);
    } else if (!tracked.has(k.public_key)) {
      findings.push(`${m.signer} has a function-call key the contract didn't install: ${k.public_key} (${describePermission(k.access_key.permission)}).`);
    } else {
      const st = checkFunctionKey(keys, k.public_key, m.signer, UPDATER_METHODS, UPDATER_ALLOWANCE_YOCTO);
      if (st.kind === 'mismatch') findings.push(`Updater key ${k.public_key} ${st.reason}.`);
    }
  }
  for (const k of governance?.updater_keys ?? []) if (!keys.some((e) => e.public_key === k)) findings.push(`updater_keys lists ${k}, which is not on ${m.signer}.`);
  if (config?.paused) findings.push(`${m.signer} is paused.`);
  if (config) {
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    for (const b of governanceDelayProblems(m, { issuerKeyDelayMs: num(config.issuer_key_delay_ms), governanceDelayMs: num(config.governance_delay_ms) }).blockers) findings.push(`On chain: ${b}`);
  }
  if (governance?.pending_upgrade) findings.push(`Upgrade ${governance.pending_upgrade.code_hash} pending, executable from ${new Date(governance.pending_upgrade.executable_at_ms).toISOString()}.`);
  if (governance?.pending_owner) findings.push(`Owner transfer to ${governance.pending_owner.owner} pending, acceptable from ${new Date(governance.pending_owner.acceptable_at_ms).toISOString()}.`);
  if (governance?.pending_withdrawal) findings.push(`Withdrawal of ${governance.pending_withdrawal.amount} yocto to ${governance.pending_withdrawal.receiver} pending.`);
  if (governance && !governance.watchdogs.length) findings.push('No watchdog: every key change waits governance_delay_ms.');
  else if (governance && !governance.watchdogs.some((w) => w.confirm_from_ms <= nowMs)) {
    const first = Math.min(...governance.watchdogs.map((w) => w.confirm_from_ms));
    findings.push(`No watchdog may confirm yet (the first from ${new Date(first).toISOString()}): every key change proposed until then waits governance_delay_ms.`);
  }
  for (const c of keyChanges) if (nowMs >= c.executable_at_ms) findings.push(`Key change #${c.id} (${c.op} ${c.provider}/${c.kid}) is due and not executed.`);
  // Google keys Google doesn't publish: an active one is the attack the delay exists to stop (tokens signed by it log
  // in; the watchdog pauses on it), a pending Add one the watchdog should cancel within one run. Fetched only when
  // there is a key to check.
  const pendingAdds = keyChanges.filter((c) => c.provider === GOOGLE_PROVIDER && c.op === 'Add');
  if (issuer?.kids.length || pendingAdds.length) {
    let published: Set<string> | null = null;
    try {
      published = new Set(usableKeys(await (deps.fetchJwks ?? fetchGoogleJwks)()).map((k) => k.kid));
    } catch (err) {
      findings.push(`Couldn't read Google's JWKS to check the google keys: ${(err as Error).message}.`);
    }
    if (published) {
      for (const kid of issuer?.kids ?? []) {
        if (!published.has(kid)) findings.push(`Active google key ${kid} is not in Google's JWKS: tokens signed by it log in. Pause, then remove it through the owner (docs/operations.md "Watchdog alerts").`);
      }
      for (const c of pendingAdds) if (!published.has(c.kid)) findings.push(`Key change #${c.id} adds google/${c.kid}, which Google doesn't publish: cancel it (owner or a watchdog).`);
    }
  }
  if (config && config.owner !== m.owner) findings.push(`The contract owner is ${String(config.owner)}, envs/${m.name}.json says ${m.owner}.`);

  let council: GovernanceStatus['council'] = null;
  if (m.council) {
    const dao = councilDao(m);
    const daoAccount = await rpc.account(dao);
    if (daoAccount) {
      const policy = await tryView<SputnikPolicy>(rpc, dao, 'get_policy');
      // The council must be exactly the manifest's, 2 of 3 for every kind (D81): a ChangePolicy, AddMember or
      // RemoveMember shows here (and in the watchdog's critical alerts).
      if (policy) for (const b of policyProblems(policy, m.council.members).blockers) findings.push(`The council DAO ${dao}: ${b}.`);
      else findings.push(`The council DAO ${dao} has no readable get_policy.`);
      const proposals = policy ? await recentProposals(rpc, dao) : [];
      council = { dao, policy, openProposals: policy ? proposals.filter((p) => isOpen(p, policy, nowMs)) : [] };
    } else {
      council = { dao, policy: null, openProposals: [] };
      findings.push(`The council DAO ${dao} does not exist yet (council-setup ${m.name}).`);
    }
  }
  return {
    env: m.name,
    signer: m.signer,
    owner: { account: m.owner, kind: m.ownerKind ?? 'account' },
    observedAtMs: nowMs,
    contract: { codeHash: account?.code_hash ?? '', stateVersion: governance?.state_version ?? (config ? 1 : null) },
    config,
    governance,
    keyChanges,
    activeKids: issuer?.kids ?? [],
    signerKeys: keys.map((k) => ({ publicKey: k.public_key, permission: describePermission(k.access_key.permission), tracked: tracked.has(k.public_key) })),
    council,
    findings,
  };
}

export async function governanceStatusCmd(m: Manifest, args: Args, deps: AdminOwnerDeps): Promise<void> {
  const s = await governanceStatus(m, deps);
  if (args.flag('json')) return void deps.log(JSON.stringify(s, null, 2));
  const iso = (ms: number) => new Date(ms).toISOString();
  deps.log(`${s.env}: ${s.signer} code ${s.contract.codeHash} (state v${s.contract.stateVersion ?? '-'}); owner ${s.owner.account} (${s.owner.kind})`);
  if (s.config) {
    deps.log(`  delays: issuer key ${String(s.config.issuer_key_delay_ms ?? '-')} ms, governance ${String(s.config.governance_delay_ms ?? '-')} ms, change ${String(s.config.change_delay_ms ?? '-')} ms; paused ${String(s.config.paused ?? false)}`);
  }
  if (s.governance) {
    deps.log(`  watchdogs: ${s.governance.watchdogs.map((w) => `${w.account_id} (confirms from ${iso(w.confirm_from_ms)})`).join(', ') || 'none'}`);
    deps.log(`  updater keys: ${s.governance.updater_keys.join(', ') || 'none'}`);
  }
  deps.log(`  active kids: ${s.activeKids.join(', ') || 'none'}`);
  for (const c of s.keyChanges) deps.log(`  pending #${c.id} ${c.op} ${c.provider}/${c.kid} by ${c.by}, executable from ${iso(c.executable_at_ms)}`);
  for (const k of s.signerKeys) deps.log(`  signer key ${k.publicKey}: ${k.permission}${k.tracked ? ' (updater key)' : ''}`);
  if (s.council) {
    deps.log(`  council ${s.council.dao}: ${s.council.openProposals.length} open proposal(s)`);
    if (s.council.policy) for (const p of s.council.openProposals) for (const line of describeProposal(p, s.council.policy, s.observedAtMs)) deps.log(`    ${line}`);
  }
  deps.log(s.findings.length ? `Findings:\n${s.findings.map((f) => `  ! ${f}`).join('\n')}` : 'No findings.');
}
