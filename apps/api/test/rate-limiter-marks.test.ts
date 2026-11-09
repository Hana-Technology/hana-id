// The RateLimiter's single-use markers and counter pruning (D475): a call's row reads don't grow with the number of
// markers the object holds, a live marker is still refused, and expired ones are still deleted, by the alarm alone.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { limiter } from '../src/handlers.ts';
import type { Limit, RateLimiter } from '../src/rate-limiter.ts';
import { uid } from './helpers.ts';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const WINDOW: Limit[] = [{ name: 'home:apps:key', windowMs: MINUTE, max: 60 }];

const newStub = () => limiter(env, `marks-test:${uid()}`);

type Stub = ReturnType<typeof newStub>;

const seedMarks = (stub: Stub, n: number, untilMs: number) =>
  runInDurableObject(stub, (_i, state) => {
    for (let i = 0; i < n; i++) state.storage.kv.put(`mark:counter:seed-${i}`, untilMs);
  });

const keys = (stub: Stub): Promise<string[]> => runInDurableObject(stub, (_i, state) => [...state.storage.kv.list()].map(([k]) => k));

const passThrough = <T extends object>(target: T, overrides: Record<string, unknown>): T =>
  new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(t, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });

/** Runs `fn` against the object and counts every row its key-value reads return (`get`s and listed entries). */
function rowsRead<T>(stub: Stub, fn: (o: RateLimiter) => T): Promise<{ rows: number; result: T }> {
  return runInDurableObject(stub, (instance: RateLimiter) => {
    const holder = instance as unknown as { ctx: DurableObjectState };
    const original = holder.ctx;
    const kv = original.storage.kv;
    let rows = 0;
    const counted = passThrough(kv, {
      get: (key: string) => {
        rows++;
        return kv.get(key);
      },
      list: function* (options?: Parameters<typeof kv.list>[0]) {
        for (const entry of kv.list(options)) {
          rows++;
          yield entry;
        }
      },
    });
    const storage = passThrough(original.storage, { kv: counted });
    Object.defineProperty(holder, 'ctx', { value: passThrough(original, { storage }), configurable: true, writable: true });
    try {
      const result = fn(instance);
      return { rows, result };
    } finally {
      Object.defineProperty(holder, 'ctx', { value: original, configurable: true, writable: true });
    }
  });
}

describe('row reads do not grow with the markers held', () => {
  const homeRequest = (o: RateLimiter, counter: string) => {
    expect(o.hit(WINDOW, NOW)).toEqual({ ok: true });
    expect(o.reserve(`counter:${counter}`, NOW + 15 * MINUTE, NOW)).toBe(true);
  };

  it('a Home request (one hit, one reserve) reads the same rows with 3000 markers as with none, live or expired', async () => {
    const empty = newStub();
    const live = newStub();
    const expired = newStub();
    await seedMarks(live, 3000, NOW + 15 * MINUTE);
    await seedMarks(expired, 3000, NOW - 1);

    const base = await rowsRead(empty, (o) => homeRequest(o, 'a'));
    const withLive = await rowsRead(live, (o) => homeRequest(o, 'a'));
    const withExpired = await rowsRead(expired, (o) => homeRequest(o, 'a'));

    expect(withLive.rows).toBe(base.rows);
    expect(withExpired.rows).toBe(base.rows);
    // The counter's get, its list entry, and the marker's get.
    expect(base.rows).toBeLessThanOrEqual(3);
  });

  it('reserve alone reads one row, and hit alone doesn’t read a marker', async () => {
    const stub = newStub();
    await seedMarks(stub, 500, NOW + MINUTE);
    expect((await rowsRead(stub, (o) => o.reserve('x', NOW + MINUTE, NOW))).rows).toBe(1);
    expect((await rowsRead(stub, (o) => o.hit(WINDOW, NOW))).rows).toBeLessThanOrEqual(2);
  });

  it('hit reads only its own limits’ counters, not another limit’s', async () => {
    const stub = newStub();
    await runInDurableObject(stub, (_i, state) => {
      for (let i = 0; i < 200; i++) state.storage.kv.put(`other:${i}@${NOW}`, 1);
    });
    expect((await rowsRead(stub, (o) => o.hit(WINDOW, NOW))).rows).toBeLessThanOrEqual(2);
  });
});

describe('reserve: what the sweep’s removal must not change', () => {
  it('refuses a live marker however many others are stored, and until exactly its end', async () => {
    const stub = newStub();
    await seedMarks(stub, 200, NOW - 1);
    expect(await stub.reserve('k', NOW + 100, NOW)).toBe(true);
    expect(await stub.reserve('k', NOW + 500, NOW)).toBe(false);
    expect(await stub.reserve('k', NOW + 500, NOW + 99)).toBe(false);
  });

  it('an expired marker no longer counts: the key can be reserved again before any sweep', async () => {
    const stub = newStub();
    expect(await stub.reserve('k', NOW + 100, NOW)).toBe(true);
    expect(await stub.reserve('k', NOW + 500, NOW + 100)).toBe(true);
    expect(await stub.reserve('k', NOW + 900, NOW + 200)).toBe(false);
  });

  it('release frees a live marker, as before', async () => {
    const stub = newStub();
    expect(await stub.reserve('k', NOW + 100, NOW)).toBe(true);
    await stub.release('k');
    expect(await stub.reserve('k', NOW + 100, NOW)).toBe(true);
  });

  it('leaves expired markers for the alarm: a call deletes none', async () => {
    const stub = newStub();
    await seedMarks(stub, 3, NOW - 1);
    expect(await stub.reserve('k', NOW + 100, NOW)).toBe(true);
    expect((await keys(stub)).filter((k) => k.startsWith('mark:'))).toHaveLength(4);
  });
});

describe('the alarm deletes expired markers', () => {
  const alarmAt = (stub: Stub): Promise<number | null> => runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

  it('is armed by the first marker and not moved by later ones, so steady traffic can’t starve it', async () => {
    const stub = newStub();
    const first = Date.now() + 3_600_000;
    expect(await stub.reserve('a', first)).toBe(true);
    await expect.poll(() => alarmAt(stub)).toBe(first + 1);
    // A later marker, then many, each ending after the armed alarm: the alarm stays where it was.
    expect(await stub.reserve('b', first + 3_600_000)).toBe(true);
    for (let i = 0; i < 20; i++) expect(await stub.reserve(`c${i}`, first + 4_000_000 + i)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await alarmAt(stub)).toBe(first + 1);
  });

  it('deletes only what has expired, and re-arms for the latest live marker', async () => {
    const stub = newStub();
    const live = Date.now() + 3_600_000;
    const later = live + 3_600_000;
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put('mark:old-1', Date.now() - 1000);
      state.storage.kv.put('mark:old-2', Date.now() - 1);
      state.storage.kv.put('mark:live', live);
      state.storage.kv.put('mark:later', later);
      state.storage.kv.put(`${WINDOW[0]!.name}@${NOW}`, 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await keys(stub)).toEqual(expect.arrayContaining(['mark:live', 'mark:later', `${WINDOW[0]!.name}@${NOW}`]));
    expect((await keys(stub)).filter((k) => k.startsWith('mark:old'))).toEqual([]);
    expect(await alarmAt(stub)).toBe(later + 1);
  });

  it('a marker reserved after a sweep that left none arms a new alarm', async () => {
    const stub = newStub();
    const until = Date.now() + 3_600_000;
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put('mark:old', Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmAt(stub)).toBeNull();
    expect(await stub.reserve('k', until)).toBe(true);
    await expect.poll(() => alarmAt(stub)).toBe(until + 1);
  });
});

describe('counters', () => {
  it('prune drops the ended windows of the hit’s limits and keeps markers and other limits’ counters', async () => {
    const stub = newStub();
    const now = NOW + 5 * MINUTE;
    await runInDurableObject(stub, (_i, state) => {
      state.storage.kv.put(`${WINDOW[0]!.name}@${NOW}`, 3);
      state.storage.kv.put(`other@${NOW}`, 3);
      state.storage.kv.put('mark:keep', now + MINUTE);
    });
    expect(await stub.hit(WINDOW, now)).toEqual({ ok: true });
    const stored = await keys(stub);
    expect(stored).not.toContain(`${WINDOW[0]!.name}@${NOW}`);
    expect(stored).toEqual(expect.arrayContaining([`other@${NOW}`, 'mark:keep', `${WINDOW[0]!.name}@${Math.floor(now / MINUTE) * MINUTE}`]));
  });

  it('a name that extends this limit’s is left alone', async () => {
    const stub = newStub();
    const longer = `${WINDOW[0]!.name}@x@${NOW}`;
    await runInDurableObject(stub, (_i, state) => state.storage.kv.put(longer, 1));
    expect(await stub.hit(WINDOW, NOW + 5 * MINUTE)).toEqual({ ok: true });
    expect(await keys(stub)).toContain(longer);
  });

  it('hit still counts and refuses within its window', async () => {
    const stub = newStub();
    const one: Limit[] = [{ name: 'w', windowMs: MINUTE, max: 1 }];
    expect(await stub.hit(one, NOW)).toEqual({ ok: true });
    expect((await stub.hit(one, NOW)).ok).toBe(false);
    expect((await stub.hit(one, NOW + MINUTE)).ok).toBe(true);
  });
});
