// D918: the freeze mirror's hourly check pages through every organisation and every mirror row (never one page of
// each), counts an org with no mirror row as not frozen there (a frozen org without one is fixed, never "fine"), fixes
// at most MIRROR_FIXES a run and logs the backlog for the next, and never loosens a freeze from a list it couldn't read
// in full.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { MIRROR_FIXES, reconcileFreezes } from '../src/platform.ts';

afterEach(() => vi.restoreAllMocks());

type Org = { id: string; status: 'active' | 'frozen' };
function fake(orgs: Org[], mirror: Map<string, boolean>, o: { consolePage?: number; apiPage?: number; consoleFailsAt?: number; statusNow?: (id: string) => 'active' | 'frozen'; versions?: Map<string, number> } = {}) {
  const fixes: { orgId: string; frozen: boolean; expectedVersion?: number }[] = [];
  const versions = o.versions ?? new Map<string, number>();
  const page = <T extends { key: string }>(items: T[], size: number, cursor: string | undefined) => {
    const start = cursor ? items.findIndex((x) => x.key === cursor) + 1 : 0;
    const slice = items.slice(start, start + size);
    return { slice, next: start + size < items.length ? slice[slice.length - 1]!.key : undefined };
  };
  let consoleCalls = 0;
  const env = {
    CONSOLE: {
      listOrgs: async (c: { cursor?: string }) => {
        consoleCalls++;
        if (o.consoleFailsAt !== undefined && consoleCalls > o.consoleFailsAt) return { ok: false, code: 'internal' };
        const p = page(orgs.map((x) => ({ ...x, key: x.id })), o.consolePage ?? 200, c.cursor);
        return { ok: true, orgs: p.slice.map((x) => ({ id: x.id, name: x.id, kind: 'partner', status: x.status, createdAt: 1 })), ...(p.next ? { next: p.next } : {}) };
      },
      getOrg: async (c: { orgId: string }) => ({ ok: true, org: { id: c.orgId, name: c.orgId, kind: 'partner', status: o.statusNow ? o.statusNow(c.orgId) : (orgs.find((x) => x.id === c.orgId)?.status ?? 'active'), createdAt: 1 }, members: [], invites: [], statusSince: 5 }),
    },
    API: {
      platformOrgs: async (c: { cursor?: string }) => {
        const rows = [...mirror.entries()].sort().map(([orgId, frozen]) => ({ key: orgId, orgId, enabled: false, frozen }));
        const p = page(rows, o.apiPage ?? 500, c.cursor);
        return { ok: true, orgs: p.slice.map(({ orgId, enabled, frozen }) => ({ orgId, enabled, frozen, version: versions.get(orgId) ?? 1 })), ...(p.next ? { next: p.next } : {}) };
      },
      setPlatformOrgFrozen: async (c: { orgId: string; frozen: boolean; expectedVersion?: number; consoleActiveSince?: number }) => {
        if (!c.frozen && c.consoleActiveSince !== 5) return { ok: false, code: 'bad_request' };
        // As the API: an unfreeze is a compare-and-swap on the version read.
        if (c.expectedVersion !== undefined && c.expectedVersion !== (versions.get(c.orgId) ?? 1)) return { ok: false, code: 'version_conflict' };
        fixes.push({ orgId: c.orgId, frozen: c.frozen, ...(c.expectedVersion !== undefined ? { expectedVersion: c.expectedVersion } : {}) });
        mirror.set(c.orgId, c.frozen);
        versions.set(c.orgId, (versions.get(c.orgId) ?? 1) + 1);
        return { ok: true, changed: true };
      },
    },
  } as unknown as Pick<Env, 'API' | 'CONSOLE'>;
  return { env, fixes };
}
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `org_${String(from + i).padStart(5, '0')}`);

describe('the freeze mirror’s check', () => {
  it('finds a frozen org on the console’s second page and one missing from the mirror, with the mirror paged too', async () => {
    const orgs: Org[] = ids(450).map((id) => ({ id, status: 'active' }));
    orgs[250]!.status = 'frozen'; // second page, no mirror row
    orgs[420]!.status = 'frozen'; // third page, mirror says not frozen
    const mirror = new Map<string, boolean>(ids(300, 100).map((id) => [id, false]));
    mirror.set('org_00010', true); // first page: mirror frozen, console active → unfreeze (lists complete)
    const { env, fixes } = fake(orgs, mirror, { consolePage: 200, apiPage: 50 });
    const r = await reconcileFreezes(env);
    expect(r).toMatchObject({ complete: true, backlog: 0, failed: 0, fixed: 3 });
    expect(fixes.sort((a, b) => a.orgId.localeCompare(b.orgId))).toEqual([
      { orgId: 'org_00010', frozen: false, expectedVersion: 1 },
      { orgId: 'org_00250', frozen: true },
      { orgId: 'org_00420', frozen: true },
    ]);
  });

  it('more differences than the cap: MIRROR_FIXES now, the backlog logged at error level, the rest the next run', async () => {
    const orgs: Org[] = ids(MIRROR_FIXES + 7).map((id) => ({ id, status: 'frozen' }));
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    const { env, fixes } = fake(orgs, new Map());
    const first = await reconcileFreezes(env);
    expect(first).toMatchObject({ fixed: MIRROR_FIXES, backlog: 7 });
    expect(errors.some((l) => l.includes('"code":"backlog"') && l.includes('"count":7'))).toBe(true);
    const second = await reconcileFreezes(env);
    expect(second).toMatchObject({ fixed: 7, backlog: 0 });
    expect(new Set(fixes.map((f) => f.orgId)).size).toBe(MIRROR_FIXES + 7);
  });

  it('a list it couldn’t read in full still freezes what it saw, never unfreezes, and says so', async () => {
    const orgs: Org[] = ids(400).map((id) => ({ id, status: 'active' }));
    orgs[5]!.status = 'frozen';
    const mirror = new Map<string, boolean>([['org_00007', true]]);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    const { env, fixes } = fake(orgs, mirror, { consolePage: 200, consoleFailsAt: 1 });
    const r = await reconcileFreezes(env);
    expect(r.complete).toBe(false);
    expect(fixes).toEqual([{ orgId: 'org_00005', frozen: true }]);
    expect(mirror.get('org_00007')).toBe(true);
    expect(errors.some((l) => l.includes('"event":"freeze_mirror"') && l.includes('"step":"read"'))).toBe(true);
  });
});

describe('the freeze mirror’s unfreeze (after PR 149’s review, finding 4)', () => {
  it('a freeze landing after the lists were read wins: the console is read again first, and the unfreeze is a compare-and-swap', async () => {
    const orgs: Org[] = [{ id: 'org_00001', status: 'active' }, { id: 'org_00002', status: 'active' }];
    const mirror = new Map<string, boolean>([['org_00001', true], ['org_00002', true]]);
    // org_00001 froze in the console after the list was read; org_00002's mirror row moved after it was read.
    const versions = new Map<string, number>([['org_00001', 1], ['org_00002', 1]]);
    const { env, fixes } = fake(orgs, mirror, { statusNow: (id) => (id === 'org_00001' ? 'frozen' : 'active'), versions });
    const api = (env as unknown as { API: { platformOrgs: (c: unknown) => Promise<unknown> } }).API;
    const read = api.platformOrgs.bind(api);
    api.platformOrgs = async (c: unknown) => {
      const r = await read(c);
      versions.set('org_00002', 2);
      return r;
    };
    const r = await reconcileFreezes(env);
    expect(fixes).toEqual([]);
    expect(r).toMatchObject({ fixed: 0, failed: 2 });
    expect(mirror.get('org_00001')).toBe(true);
    expect(mirror.get('org_00002')).toBe(true);
  });
});
