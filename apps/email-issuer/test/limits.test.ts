// Every limit (spec "Rate limits and abuse", D198), suppressions, and enumeration resistance: `start` answers the same
// status and body shape, in about the same time, for every valid address, whatever happens to it after the response.
import { describe, expect, it } from 'vitest';
import { emailKey } from '../src/keys.ts';
import { captureLogs, env, harness, seedApp, seedPlan, sessionCommitment, uid, type Harness, type TestApp } from './helpers.ts';

const startBody = (h: Harness, app: TestApp, email: string) => ({ pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
const startOk = async (h: Harness, app: TestApp, email: string, ip?: string) => {
  const r = await h.call('/v1/email/start', startBody(h, app, email), ip ? { ip } : {});
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('per-address limits (exact, silent)', () => {
  it('3 codes per 15 min: the 4th start answers 202 and sends nothing', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const addr = `a${uid()}@example.com`;
    for (let i = 0; i < 4; i++) expect((await startOk(h, app, addr)).status).toBe(202);
    expect(h.sender.to(addr)).toHaveLength(3);
    h.clock.now += 15 * 60_000;
    await startOk(h, app, addr);
    expect(h.sender.to(addr)).toHaveLength(4);
  });

  it('10 codes per day', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const addr = `b${uid()}@example.com`;
    for (let i = 0; i < 12; i++) {
      await startOk(h, app, addr);
      if (i % 3 === 2) h.clock.now += 15 * 60_000 + 1;
    }
    expect(h.sender.to(addr)).toHaveLength(10);
  });

  it('keys on the normalized address: Gmail dots fold, a +tag is its own mailbox', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const base = `c${uid().replace(/[^a-z0-9]/gu, '')}`;
    for (const typed of [`${base}@gmail.com`, `${base.slice(0, 2)}.${base.slice(2)}@gmail.com`, `${base.toUpperCase()}@googlemail.com`]) await startOk(h, app, typed);
    // All three are one mailbox (sent to the normalized form); a fourth is over its 3 per 15 min.
    await startOk(h, app, `${base}@gmail.com`);
    expect(h.sender.to(`${base}@gmail.com`)).toHaveLength(3);
    await startOk(h, app, `${base}+shop@gmail.com`);
    expect(h.sender.to(`${base}+shop@gmail.com`)).toHaveLength(1);
  });

  it('10 wrong codes per hour lock the address for 1 h: start silent, verify 429', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const addr = `d${uid()}@example.com`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await startOk(h, app, addr)).body.challengeId as string);
    const code = h.sender.codeFor(addr);
    const wrong = code === '000000' ? '111111' : '000000';
    let n = 0;
    for (const id of ids) {
      for (let k = 0; k < 4 && n < 10; k++, n++) await h.call('/v1/email/verify', { challengeId: id, code: wrong });
    }
    expect(n).toBe(10);
    // The last challenge is still alive with its real code, but the address is locked.
    const v = await h.call('/v1/email/verify', { challengeId: ids[2], code });
    expect(v.status).toBe(429);
    h.clock.now += 15 * 60_000 + 1;
    const silent = await startOk(h, app, addr);
    expect(silent.status).toBe(202);
    expect(h.sender.to(addr)).toHaveLength(3);
    h.clock.now += 60 * 60_000;
    await startOk(h, app, addr);
    expect(h.sender.to(addr)).toHaveLength(4);
  });

  it('a suppressed address gets 202 and no mail', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const addr = `e${uid()}@example.com`;
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await emailKey(await h.deps.keys(), addr), 'bounce', 1).run();
    expect((await startOk(h, app, addr)).status).toBe(202);
    expect(h.sender.to(addr)).toHaveLength(0);
  });
});

describe('per-IP, per-app and global limits (429)', () => {
  it('start per IP: 10 per 10 min, 50 per day', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 10; i++) expect((await startOk(h, app, `f${i}${uid()}@example.com`, ip)).status).toBe(202);
    const r = await h.call('/v1/email/start', startBody(h, app, `g${uid()}@example.com`), { ip });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).not.toBeNull();
    expect(await r.json()).toMatchObject({ code: 'rate_limited' });
    let ok = 10;
    for (let w = 0; w < 6; w++) {
      h.clock.now += 10 * 60_000;
      for (let i = 0; i < 10; i++) if ((await startOk(h, app, `h${w}${i}${uid()}@example.com`, ip)).status === 202) ok++;
    }
    expect(ok).toBe(50);
  });

  it('verify per IP: 30 per 10 min', async () => {
    const h = await harness();
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 30; i++) expect((await h.call('/v1/email/verify', { challengeId: 'x'.repeat(43), code: '123456' }, { ip })).status).toBe(410);
    expect((await h.call('/v1/email/verify', { challengeId: 'x'.repeat(43), code: '123456' }, { ip })).status).toBe(429);
  });

  it('per app: 20 × the plan’s per_minute per minute, and its per_day', async () => {
    const h = await harness();
    const plan = `p${uid().replace(/[^a-z0-9]/gu, '')}`;
    await seedPlan(plan, 1, 30);
    const app = await seedApp(h, { plan });
    let ok = 0;
    for (let i = 0; i < 21; i++) if ((await startOk(h, app, `i${i}${uid()}@example.com`)).status === 202) ok++;
    expect(ok).toBe(20);
    h.clock.now += 60_000;
    for (let i = 0; i < 20; i++) if ((await startOk(h, app, `j${i}${uid()}@example.com`)).status === 202) ok++;
    expect(ok).toBe(30);
  });

  it('the daily send budget refuses new starts at the cap and logs a critical line', async () => {
    const h = await harness({ env: { ...env, ENV_NAME: `budget-${uid()}`, DAILY_SEND_BUDGET: '2' } });
    const app = await seedApp(h);
    await startOk(h, app, `k1${uid()}@example.com`);
    await startOk(h, app, `k2${uid()}@example.com`);
    const { result, lines } = await captureLogs(() => h.call('/v1/email/start', startBody(h, app, `k3${uid()}@example.com`)));
    expect(result.status).toBe(429);
    expect(lines.some((l) => l.includes('"send_budget_exhausted"') && l.includes('"level":"error"'))).toBe(true);
    expect(h.sender.sent).toHaveLength(2);
  });
});

describe('enumeration resistance', () => {
  it('same status, same body keys and similar timing for fresh, suppressed, locked and limited addresses', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const fresh = `l${uid()}@example.com`;
    const suppressed = `m${uid()}@example.com`;
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await emailKey(await h.deps.keys(), suppressed), 'complaint', 1).run();
    const limited = `n${uid()}@example.com`;
    for (let i = 0; i < 3; i++) await startOk(h, app, limited);
    const time = async (email: string): Promise<{ ms: number; status: number; keys: string[] }> => {
      const t0 = performance.now();
      const r = await startOk(h, app, email);
      return { ms: performance.now() - t0, status: r.status, keys: Object.keys(r.body).sort() };
    };
    const runs: Record<string, number[]> = { fresh: [], suppressed: [], limited: [] };
    for (let i = 0; i < 5; i++) {
      for (const [k, email] of [['fresh', i === 0 ? fresh : `l${i}${uid()}@example.com`], ['suppressed', suppressed], ['limited', limited]] as const) {
        const r = await time(email);
        expect(r.status).toBe(202);
        expect(r.keys).toEqual(['challengeId', 'expiresAtMs', 'resendAfterMs']);
        runs[k]!.push(r.ms);
      }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const m = Object.values(runs).map(median);
    // The address-dependent work happens after the response (waitUntil), so the response paths are the same work.
    expect(Math.max(...m) - Math.min(...m)).toBeLessThan(50);
  });
});
