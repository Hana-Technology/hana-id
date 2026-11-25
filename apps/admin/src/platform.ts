// The freeze mirror's hourly check (D918): the console holds an org's freeze (`orgs.status`), and the API holds its
// mirror (`platform_orgs.frozen`), which cancels the org's waiting platform keys and the platform's waiting web
// addresses. The staff route mirrors at once (routes.ts); this check repeats any mirror that didn't land: an org the
// console has frozen and the API hasn't, or the other way round. At most MIRROR_FIXES a run; every RPC is metered.
import type { Env } from './env.ts';
import { errorName, log } from './log.ts';
import { systemCtx } from './rpc.ts';

export const MIRROR_FIXES = 10;

export async function reconcileFreezes(env: Pick<Env, 'API' | 'CONSOLE'>): Promise<{ fixed: number; failed: number }> {
  const out = { fixed: 0, failed: 0 };
  let orgs, mirrored;
  try {
    [orgs, mirrored] = await Promise.all([env.CONSOLE.listOrgs({ ...systemCtx(), limit: 200 }), env.API.platformOrgs({ ...systemCtx(), limit: 500 })]);
  } catch (err) {
    log({ event: 'freeze_mirror', outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return out;
  }
  if (!orgs.ok || !mirrored.ok) {
    // An API before D918 has no platformOrgs: nothing to mirror into.
    log({ event: 'freeze_mirror', outcome: 'rejected', code: !orgs.ok ? orgs.code : (mirrored as { code: string }).code }, 'warn');
    return out;
  }
  const inApi = new Map(mirrored.orgs.map((o) => [o.orgId, o.frozen]));
  const wrong = orgs.orgs.filter((o) => (o.status === 'frozen') !== (inApi.get(o.id) ?? false)).slice(0, MIRROR_FIXES);
  for (const o of wrong) {
    const r = await env.API.setPlatformOrgFrozen({ ...systemCtx(), orgId: o.id, frozen: o.status === 'frozen' }).catch(() => null);
    if (r?.ok) out.fixed++;
    else out.failed++;
    log({ event: 'freeze_mirror', orgId: o.id, outcome: r?.ok ? 'ok' : 'rejected', ...(r && !r.ok ? { code: r.code } : {}) }, r?.ok ? 'info' : 'warn');
  }
  return out;
}
