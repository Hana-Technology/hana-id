// GET /v1/evm/sponsor/status?chainId= (D847): whether this app's users can have their network fees paid on a chain
// right now, for the SDK and the vault to show or hide the offer. The partner page may call it (no signature, no chain
// read: the config and two read-only budget figures). It never tells an app about another app's spend: `remainingToday`
// is this app's own day budget left; the env's budget shows only as `available: false, reason: 'budget_exhausted'`.
import type { Env } from '../env.ts';
import { appGate, done, newCtx, reject } from '../handlers.ts';
import { sponsorChain } from './sponsor-config.ts';
import { appSponsoredOn, toStatusQuery } from './sponsor-checks.ts';
import { budgetLeft, budgetsSpent, EVM_SPONSOR_STATUS_ENDPOINT, evmSponsorReady, unconfigured } from './sponsor.ts';

export async function handleEvmSponsorStatus(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, EVM_SPONSOR_STATUS_ENDPOINT, request);
  const config = evmSponsorReady(env);
  if (!config) return unconfigured(ctx);
  const gate = await appGate(request, env, ctx, 'evm-sponsor');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const q = toStatusQuery(new URL(request.url));
  if (!q) return reject(ctx, 400, 'bad_request', 'The query is exactly chainId, a positive decimal');
  const chain = sponsorChain(config, q.chainId);
  if (!chain) return done(ctx, 200, { available: false, reason: 'chain_not_enabled' });
  if (!appSponsoredOn(config, app.id, chain.chainId)) return done(ctx, 200, { available: false, reason: 'app_not_sponsored' });
  let spent: { app: bigint; env: bigint };
  try {
    spent = await budgetsSpent(env, app, chain.chainId, Date.now());
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const remaining = chain.appDailyBudgetWei > spent.app ? chain.appDailyBudgetWei - spent.app : 0n;
  const available = budgetLeft(chain, spent);
  return done(ctx, 200, { available, ...(available ? {} : { reason: 'budget_exhausted' }), remainingToday: remaining.toString() });
}
