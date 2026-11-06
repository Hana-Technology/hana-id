// admin.ts console:remove-audience <aud> [--provider google]: retire a console client from its console sink scope (D416).
//
// A console client (the partner console's Google OAuth client, `consoleAudiences`) lives in a dedicated sink scope
// owned by the manifest's owner (D238). Replacing the client leaves the old one in the sink, and deploy-contract then
// refuses the sink ("not a Hana console sink": a client that isn't a console audience). This command sends the one
// `remove_client(sN, Near, provider, aud)` that fixes it, through the manifest's owner (the council DAO: a proposal,
// approved in the same command with --approve-with on dev envs), and only when:
//   - the audience is no longer in envs/<env>.json `consoleAudiences` (drop it there first: the manifest decides);
//   - the scope holding it on chain is not "global" and is a Hana console sink by deploy-contract's own test
//     (isConsoleSinkView) with that audience allowed, and the manifest's owner is an Owner::Near of it (remove_client
//     takes OwnerAuth::Near: the owner route's account is the predecessor);
//   - another client stays in the sink (the contract refuses a sink's last client).
// Dry run by default; --yes sends it and re-reads get_scope to confirm the client is gone. Afterwards deploy-contract
// sets console_audiences to the manifest's list (set_console_audiences).
import type { Manifest } from '@hana-id/env';
import { type Args, CliError } from './cli.ts';
import { GOOGLE_PROVIDER, tryView } from './contract.ts';
import { clientKey, hanaOwnerAccounts, isConsoleSinkView } from './deploy-plan.ts';
import { describeOwnerCall, type OwnerCall, sendOwnerCall } from './owner-tx.ts';
import { type AdminOwnerDeps, OWNER_DRY_RUN_LINE } from './admin-owner.ts';
import { TGAS } from './near.ts';

const GLOBAL_SCOPE = 'global';
const REMOVE_GAS = 100n * TGAS;

interface ScopeView {
  owners?: unknown[];
  clients?: [string, string][];
  allow_shared?: boolean;
}

export async function consoleRemoveAudienceCmd(m: Manifest, aud: string, args: Args, deps: AdminOwnerDeps): Promise<void> {
  const provider = args.str('provider') ?? GOOGLE_PROVIDER;
  if (!aud || aud.length > 255 || /\s/u.test(aud)) throw new CliError(`Invalid audience: ${aud}`);
  if (!provider || provider.length > 64 || /\s/u.test(provider)) throw new CliError(`Invalid provider: ${provider}`);
  const target: [string, string] = [provider, aud];
  const key = clientKey(target);
  if (m.consoleAudiences.some((a) => clientKey(a) === key)) {
    throw new CliError(`${key} is still in envs/${m.name}.json consoleAudiences: drop it there first (the manifest decides which console clients are trusted)`);
  }
  const { rpc, log } = deps;
  const scopeId = await rpc.view<string | null>(m.signer, 'scope_for_client', { provider, aud });
  if (scopeId === null || scopeId === undefined) return void log(`${key} is not a client of any scope on ${m.signer}: nothing to do.`);
  if (scopeId === GLOBAL_SCOPE) {
    throw new CliError(`${key} is a client of "${GLOBAL_SCOPE}", not of a console sink: this command only retires console clients from their sink (deploy-contract moves console audiences out of "${GLOBAL_SCOPE}", D238)`);
  }
  const view = await tryView<ScopeView>(rpc, m.signer, 'get_scope', { scope_id: scopeId });
  const trusted = hanaOwnerAccounts(m);
  const allowed = new Set([...m.consoleAudiences.map(clientKey), key]);
  if (!isConsoleSinkView(view, trusted, allowed)) {
    throw new CliError(
      `Scope "${scopeId}" holding ${key} is not a Hana console sink (owners only known Hana accounts: ${[...trusted].join(', ')}; ` +
        `clients only the manifest's console audiences and ${key}; no shared login): only that scope's owners can change it (D238)`,
    );
  }
  const nearOwners = (view!.owners ?? []).map((x) => (x as { Near?: { account_id?: unknown } } | null)?.Near?.account_id);
  if (!nearOwners.includes(m.owner)) {
    throw new CliError(`Scope "${scopeId}" is owned by ${nearOwners.join(', ')}, not ${m.owner}: remove_client must come from an Owner::Near of the scope, and this command sends it only as the manifest's owner`);
  }
  const remaining = (view!.clients ?? []).filter((c) => clientKey(c) !== key);
  if (!remaining.length) {
    throw new CliError(`${key} is the last client of "${scopeId}" (the contract refuses it): register the new console client first (add it to consoleAudiences, then deploy-contract)`);
  }
  const call: OwnerCall = { method: 'remove_client', args: { scope_id: scopeId, auth: 'Near', provider, aud }, gas: REMOVE_GAS };
  const opts = { member: args.str('member'), approveWith: args.str('approve-with') };
  log(`Console sink "${scopeId}" holds ${(view!.clients ?? []).map(clientKey).join(', ')}; ${key} is no longer a console audience.`);
  log(`Plan: ${describeOwnerCall(m, call, opts)} on ${m.signer}; "${scopeId}" keeps ${remaining.map(clientKey).join(', ')}.`);
  if (!args.flag('yes')) return void log(OWNER_DRY_RUN_LINE);
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);
  const r = await sendOwnerCall(m, call, opts, deps);
  if (r.kind === 'proposed') return void log(`Proposed #${r.proposalId}: waiting for ${r.needed - r.approvals.length} more approval(s). Re-run without --yes once it executes to check.`);
  const after = await tryView<ScopeView>(rpc, m.signer, 'get_scope', { scope_id: scopeId });
  if ((after?.clients ?? []).some((c) => clientKey(c) === key)) throw new Error(`remove_client ran but "${scopeId}" still lists ${key}: check the transaction`);
  log(`Done: "${scopeId}" holds ${(after?.clients ?? []).map(clientKey).join(', ')}. Next: deploy-contract ${m.name} (set_console_audiences to the manifest's list).`);
}
