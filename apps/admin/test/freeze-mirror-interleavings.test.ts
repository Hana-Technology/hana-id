// D918 (after the second review): the freeze mirror's rule, proved over every interleaving. The real staff route
// (`staffFreeze`: mirror, console, mirror; unfreeze: console, a fresh read, mirror) and the real hourly check
// (`reconcileFreezes`) run against a model of the console (its `orgs.status`, the truth) and of the API's mirror (the
// API's one unfreeze rule, console-core `mirrorUnfreeze`, plus the version compare-and-swap; each API call is atomic,
// as its commit predicate re-checks the rule: apps/api/test/platform-keys.test.ts races it). Every binding call is a
// step; a scheduler runs every ordering of two staff members' calls and one check's, from four starting states, with
// no failure or with any one call failing. After each run it asserts:
// - the mirror never ends unfrozen while the console is frozen without an error-level log (I1, never silently);
// - after the grace, one more check with nothing failing brings the mirror to the console's state without touching
//   the console (I1 and I2: at most one run plus the grace, and nothing is unrecoverable).
import { PLATFORM_UNFREEZE_GRACE_MS, mirrorUnfreeze } from '@hana-id/console-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import { reconcileFreezes } from '../src/platform.ts';
import { type RouteCtx, staffFreeze } from '../src/routes.ts';

/** Error-level log lines of the run in progress (the console is spied once per test, not per run). */
let sink: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation((l: unknown) => void sink.push(String(l)));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const ORG = 'org_Mirror0001';
type Mirror = { frozen: boolean; frozenAt: number | null; version: number } | null;
interface World {
  status: 'active' | 'frozen';
  mirror: Mirror;
  now: number;
  /** Console writes (the recovery must make none). */
  consoleWrites: number;
}
type Start = { name: string; status: 'active' | 'frozen'; mirror: Mirror };
const T0 = 10_000_000_000;
const STARTS: Start[] = [
  { name: 'active, mirror frozen an hour ago', status: 'active', mirror: { frozen: true, frozenAt: T0 - 3_600_000, version: 3 } },
  { name: 'frozen, mirror frozen', status: 'frozen', mirror: { frozen: true, frozenAt: T0 - 3_600_000, version: 3 } },
  { name: 'active, no mirror row', status: 'active', mirror: null },
  { name: 'frozen, mirror not frozen', status: 'frozen', mirror: { frozen: false, frozenAt: T0 - 7_200_000, version: 4 } },
];

type Ctx = { actor: { kind: string; id?: string } };

interface Gate {
  actor: string;
  label: string;
  release: () => void;
}

/** One run: `choices[i]` picks which waiting call goes next at the i-th step; `failAt` makes that call (by order) throw. */
async function run(from: Start, staff: [boolean, boolean], choices: number[], failAt: number | null) {
  const w: World = { status: from.status, mirror: from.mirror && { ...from.mirror }, now: T0, consoleWrites: 0 };
  const pending: Gate[] = [];
  const branching: number[] = [];
  const errors: string[] = [];
  let calls = 0;
  sink = errors;
  const who = (c: Ctx) => (c.actor.kind === 'system' ? 'check' : c.actor.id!);
  /** A binding call: wait for the scheduler, then fail if it is the chosen one, else act on the world. */
  const step = async <T>(c: Ctx, label: string, act: () => T): Promise<T> => {
    await new Promise<void>((release) => pending.push({ actor: who(c), label, release }));
    w.now += 1000;
    if (calls++ === failAt) throw new Error('Service unavailable');
    return act();
  };
  const orgView = () => ({ id: ORG, name: 'Mirror test', kind: 'partner' as const, status: w.status, createdAt: 1 });
  const env = {
    CONSOLE: {
      listOrgs: (c: Ctx) => step(c, 'console.listOrgs', () => ({ ok: true, orgs: [orgView()] })),
      getOrg: (c: Ctx) => step(c, 'console.getOrg', () => ({ ok: true, org: orgView(), members: [], invites: [] })),
      freezeOrg: (c: Ctx & { frozen: boolean }) =>
        step(c, `console.freezeOrg(${c.frozen})`, () => {
          if ((w.status === 'frozen') !== c.frozen) w.consoleWrites++;
          w.status = c.frozen ? 'frozen' : 'active';
          return { ok: true };
        }),
    },
    API: {
      platformOrgs: (c: Ctx) =>
        step(c, 'api.platformOrgs', () => ({ ok: true, orgs: w.mirror ? [{ orgId: ORG, enabled: false, frozen: w.mirror.frozen, version: w.mirror.version }] : [] })),
      setPlatformOrgFrozen: (c: Ctx & { frozen: boolean; expectedVersion?: number }) =>
        step(c, `api.setPlatformOrgFrozen(${c.frozen})`, () => {
          if (c.frozen) {
            w.mirror = { frozen: true, frozenAt: w.now, version: (w.mirror?.version ?? 0) + 1 };
            return { ok: true, changed: true };
          }
          const rule = mirrorUnfreeze(w.mirror, w.now);
          if (rule === 'not_frozen') return { ok: true, changed: false };
          if (rule === 'too_soon') return { ok: false, code: 'conflict' };
          if (c.expectedVersion !== undefined && c.expectedVersion !== (w.mirror?.version ?? 0)) return { ok: false, code: 'version_conflict' };
          w.mirror = { frozen: false, frozenAt: w.mirror!.frozenAt, version: w.mirror!.version + 1 };
          return { ok: true, changed: true };
        }),
    },
  } as unknown as Env;
  const ctx = (id: string, frozen: boolean): RouteCtx =>
    ({ env, staff: { actor: { kind: 'hana', id, email: `${id}@hana.example` }, requestId: `req_${id}`, clientIp: '198.51.100.9' }, params: { org: ORG }, body: { frozen } }) as unknown as RouteCtx;
  /** Actors still running: each is either waiting at a binding call or about to reach one. */
  let live = 0;
  const start = <T>(p: Promise<T>) => {
    live++;
    return p.finally(() => void live--);
  };
  const actors = [start(staffFreeze(ctx('staff-a', staff[0]), staff[0])), start(staffFreeze(ctx('staff-b', staff[1]), staff[1])), start(reconcileFreezes(env))];
  const settle = async () => {
    for (let i = 0; i < 500 && pending.length < live; i++) await Promise.resolve();
    if (pending.length < live) throw new Error('an actor waited on something other than a binding call');
  };
  await settle();
  for (let i = 0; pending.length > 0; i++) {
    branching.push(pending.length);
    const [g] = pending.splice(Math.min(choices[i] ?? 0, pending.length - 1), 1);
    g!.release();
    await settle();
  }
  await Promise.all(actors);
  const end = { status: w.status, mirrorFrozen: w.mirror?.frozen ?? false };
  const errored = errors.length > 0;
  // Recovery: the grace passes, then one check with nothing failing or racing, and no console write.
  const writesBefore = w.consoleWrites;
  w.now += PLATFORM_UNFREEZE_GRACE_MS + 1;
  failAt = null;
  const rec = start(reconcileFreezes(env));
  await settle();
  while (pending.length > 0) {
    pending.shift()!.release();
    await settle();
  }
  await rec;
  return { branching, end, errored, recovered: (w.mirror?.frozen ?? false) === (w.status === 'frozen'), consoleTouched: w.consoleWrites !== writesBefore, calls };
}

/** Every ordering: depth-first over the scheduler's choices, re-running each prefix. */
async function everyOrdering(start: Start, staff: [boolean, boolean], failAt: number | null, check: (r: Awaited<ReturnType<typeof run>>, path: string) => void): Promise<{ runs: number; maxCalls: number }> {
  let choices: number[] = [];
  let runs = 0;
  let maxCalls = 0;
  for (;;) {
    const r = await run(start, staff, choices, failAt);
    runs++;
    maxCalls = Math.max(maxCalls, r.calls);
    check(r, `${start.name} / staff ${staff.join(',')} / fail ${failAt} / ${choices.join('')}`);
    // The next sequence: the last position with an untried option moves on; everything after it starts again.
    const full = r.branching.map((_, i) => choices[i] ?? 0);
    let i = full.length - 1;
    while (i >= 0 && full[i]! + 1 >= r.branching[i]!) i--;
    if (i < 0) return { runs, maxCalls };
    choices = [...full.slice(0, i), full[i]! + 1];
  }
}

describe('the freeze mirror over every interleaving of two staff members and the hourly check (D918)', () => {
  const invariants = (r: Awaited<ReturnType<typeof run>>, path: string) => {
    if (r.end.status === 'frozen' && !r.end.mirrorFrozen && !r.errored) throw new Error(`silently unfrozen mirror of a frozen org: ${path}`);
    if (!r.recovered) throw new Error(`not recovered by one check after the grace: ${path} (${JSON.stringify(r.end)})`);
    if (r.consoleTouched) throw new Error(`the recovery wrote to the console: ${path}`);
  };

  for (const start of STARTS)
    for (const staff of [
      [true, false],
      [true, true],
      [false, false],
    ] as [boolean, boolean][])
      it(`${start.name}; staff ${staff.map((f) => (f ? 'freeze' : 'unfreeze')).join(' and ')}: every ordering, no failure or any one call failing`, { timeout: 600_000 }, async () => {
        const { runs, maxCalls } = await everyOrdering(start, staff, null, invariants);
        let total = runs;
        for (let failAt = 0; failAt < maxCalls; failAt++) total += (await everyOrdering(start, staff, failAt, invariants)).runs;
        expect(total).toBeGreaterThan(100);
      });
});
