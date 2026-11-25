// The freeze mirror's hourly check (D918): the console holds an org's freeze (`orgs.status`), and the API holds its
// mirror (`platform_orgs.frozen`), which cancels the org's waiting platform keys and the platform's waiting web
// addresses, and which piece P3's request check will read. The staff route mirrors at once (routes.ts); this check
// repeats any mirror that didn't land.
//
// Every fix reads the console again just before its write (freeze and unfreeze alike); an unfreeze is a
// compare-and-swap on the mirror row's version, and the API refuses it inside the grace after the last freeze
// (PLATFORM_UNFREEZE_GRACE_MS). A freeze the mirror lacked is fixed and logged at error level. The rule and its
// invariants: docs/security.md "Platform keys", D918.
// It compares complete lists, never one page of each: every page of the console's organisations and every page of the
// API's mirror rows (each `next` cursor followed, at most MAX_PAGES each). An org with no mirror row counts as not
// frozen there, so a frozen console org without one is a difference to fix (never "fine"). At most MIRROR_FIXES are
// fixed a run; the rest are found again by the next run, and the backlog is logged at error level (with how many), as
// is a list it couldn't read in full (then nothing is "fixed" towards unfrozen, which could only loosen: a list cut
// short could hide a freeze).
import type { Env } from './env.ts';
import { errorName, log } from './log.ts';
import { systemCtx } from './rpc.ts';

export const MIRROR_FIXES = 10;
/** Pages read per list and run (200 orgs a console page, 500 rows an API page). */
export const MAX_PAGES = 20;

type Page<T> = { ok: true; items: T[]; next?: string | undefined } | { ok: false; code: string };

async function all<T>(read: (cursor: string | undefined) => Promise<Page<T>>): Promise<{ items: T[]; complete: boolean; code?: string }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const p = await read(cursor);
    if (!p.ok) return { items, complete: false, code: p.code };
    items.push(...p.items);
    if (!p.next) return { items, complete: true };
    cursor = p.next;
  }
  return { items, complete: false, code: 'too_many_pages' };
}

export interface ReconcileRun {
  fixed: number;
  failed: number;
  /** Differences left for the next run (beyond MIRROR_FIXES). */
  backlog: number;
  complete: boolean;
}

export async function reconcileFreezes(env: Pick<Env, 'API' | 'CONSOLE'>): Promise<ReconcileRun> {
  const out: ReconcileRun = { fixed: 0, failed: 0, backlog: 0, complete: false };
  let orgs, mirrored;
  try {
    [orgs, mirrored] = await Promise.all([
      all(async (cursor) => {
        const r = await env.CONSOLE.listOrgs({ ...systemCtx(), limit: 200, ...(cursor ? { cursor } : {}) });
        return r.ok ? { ok: true as const, items: r.orgs, next: r.next } : { ok: false as const, code: r.code };
      }),
      all(async (cursor) => {
        const r = await env.API.platformOrgs({ ...systemCtx(), limit: 500, ...(cursor ? { cursor } : {}) });
        return r.ok ? { ok: true as const, items: r.orgs, next: r.next } : { ok: false as const, code: r.code };
      }),
    ]);
  } catch (err) {
    log({ event: 'freeze_mirror', outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return out;
  }
  out.complete = orgs.complete && mirrored.complete;
  if (!out.complete) log({ event: 'freeze_mirror', outcome: 'error', code: orgs.code ?? mirrored.code ?? 'incomplete', count: orgs.items.length, step: 'read' }, 'error');
  const inApi = new Map(mirrored.items.map((o) => [o.orgId, o.frozen]));
  const versions = new Map(mirrored.items.map((o) => [o.orgId, o.version]));
  // A frozen console org the mirror doesn't show frozen (no row included) always needs the fix. Unfreezing the mirror
  // only from complete lists: a short read must never loosen a freeze.
  const wrong = orgs.items.filter((o) => {
    const api = inApi.get(o.id) ?? false;
    if (o.status === 'frozen') return !api;
    return api && out.complete;
  });
  out.backlog = Math.max(0, wrong.length - MIRROR_FIXES);
  for (const o of wrong.slice(0, MIRROR_FIXES)) {
    // A fresh read of the console (the truth) before each write. Tightening wins on uncertainty:
    // - the list said frozen: freeze, unless the fresh read says active (an unfreeze landed since the list); an
    //   unreadable console still freezes (logged at error level): a mirror frozen while the console is active is always
    //   repaired by a later run without touching the console (after the grace);
    // - the list said active: unfreeze only if the fresh read succeeds and says active; the API then holds it inside
    //   the grace after the last freeze, and it is a compare-and-swap on the version read with the list.
    const listed = o.status === 'frozen';
    const now = await env.CONSOLE.getOrg({ ...systemCtx(), orgId: o.id }).catch(() => null);
    const read = now?.ok ? now.org.status : null;
    if (read === null) log({ event: 'freeze_mirror', orgId: o.id, outcome: 'error', code: 'console_unreadable', step: listed ? 'freeze_anyway' : 'no_unfreeze' }, 'error');
    if (listed ? read === 'active' : read !== 'active') {
      if (read !== null) log({ event: 'freeze_mirror', orgId: o.id, outcome: 'rejected', code: 'console_moved' }, 'warn');
      out.failed++;
      continue;
    }
    const freeze = listed;
    const r = await env.API.setPlatformOrgFrozen({ ...systemCtx(), orgId: o.id, frozen: freeze, ...(freeze ? {} : { expectedVersion: versions.get(o.id) ?? 0 }) }).catch(() => null);
    if (r?.ok) out.fixed++;
    else out.failed++;
    // A freeze the mirror lacked is an error (the org's keys could have worked while it was frozen). An unfreeze held
    // by the grace or a newer write is ordinary (the next run repeats it); any other refusal is an error.
    const held = !freeze && r && !r.ok && (r.code === 'conflict' || r.code === 'version_conflict');
    const level = freeze || (r && !r.ok && !held) || !r ? 'error' : r.ok ? 'info' : 'warn';
    log({ event: 'freeze_mirror', orgId: o.id, outcome: r?.ok ? 'ok' : r ? 'rejected' : 'error', code: freeze ? 'mirror_was_unfrozen' : held ? 'unfreeze_held' : 'unfreeze', ...(r && !r.ok ? { step: r.code } : {}) }, level);
  }
  if (out.backlog > 0) log({ event: 'freeze_mirror', outcome: 'rejected', code: 'backlog', count: out.backlog }, 'error');
  return out;
}
