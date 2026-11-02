// Every limit (spec "Rate limits and abuse", D198): per mailbox (the address without its `+tag`) and requester, so an
// attacker who knows an address can neither mail it without bound nor lock its owner out; the atomic guess accounting
// (concurrent guesses can't outrun a lock check, a challenge never compares more than 5 codes); suppressions; and
// enumeration resistance (`start` answers alike for every valid address; every limit is the same generic 429).
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChallengeRecord } from '../src/challenge.ts';
import { addressKey } from '../src/keys.ts';
import { captureLogs, env, harness, seedApp, seedPlan, sessionCommitment, uid, type Harness, type TestApp } from './helpers.ts';

const startBody = (h: Harness, app: TestApp, email: string) => ({ pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
const start = async (h: Harness, app: TestApp, email: string, ip?: string) => {
  const r = await h.call('/v1/email/start', startBody(h, app, email), ip ? { ip } : {});
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const ipN = (n: number) => `198.51.${Math.floor(n / 250)}.${n % 250}`;
let ipSeq = Math.floor(Math.random() * 10_000);
const freshIp = () => ipN(ipSeq++);
const addr = (tag: string) => `${tag}${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');

describe('code mails per mailbox and requester', () => {
  it('3 per 15 min per requester: the 4th is a generic 429; another requester still gets a code', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = addr('a');
    const attacker = freshIp();
    for (let i = 0; i < 3; i++) expect((await start(h, app, a, attacker)).status).toBe(202);
    const r = await h.call('/v1/email/start', startBody(h, app, a), { ip: attacker });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'Too many requests, try again later', code: 'rate_limited' });
    expect(h.sender.to(a)).toHaveLength(3);
    // The owner, elsewhere, is not locked out.
    expect((await start(h, app, a, freshIp())).status).toBe(202);
    expect(h.sender.to(a)).toHaveLength(4);
  });

  it('mailbox-wide 10 per 15 min, then a small reserve for requesters new to the mailbox today', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = addr('b');
    const used: string[] = [];
    let sent = 0;
    // Spread over many requesters, and below the live-challenge cap (each verified away).
    const send = async (ip: string) => {
      const s = await start(h, app, a, ip);
      if (s.status !== 202) return s.status;
      sent++;
      await h.call('/v1/email/verify', { challengeId: s.body.challengeId, code: h.sender.codeFor(a) }, { ip });
      return 202;
    };
    for (let i = 0; i < 10; i++) {
      const ip = freshIp();
      used.push(ip);
      expect(await send(ip)).toBe(202);
    }
    expect(await send(used[0]!)).toBe(429);
    let reserve = 0;
    for (let i = 0; i < 7; i++) if ((await send(freshIp())) === 202) reserve++;
    expect(reserve).toBe(5);
    expect(sent).toBe(15);
  });

  it('tags share one mailbox (D159): name+a, name+b and name count together, each mail to the tagged address', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const base = `t${uid().replace(/[^a-z0-9]/gu, '')}`;
    const ip = freshIp();
    for (const tag of ['+a', '+b', '']) expect((await start(h, app, `${base}${tag}@example.com`, ip)).status).toBe(202);
    expect((await start(h, app, `${base}+c@example.com`, ip)).status).toBe(429);
    expect(h.sender.to(`${base}+a@example.com`)).toHaveLength(1);
    expect(h.sender.to(`${base}@example.com`)).toHaveLength(1);
  });

  it('at most 5 live challenges per mailbox; a refused start stores nothing', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = addr('l');
    for (let i = 0; i < 5; i++) expect((await start(h, app, a, freshIp())).status).toBe(202);
    expect((await start(h, app, a, freshIp())).status).toBe(429);
    expect(h.sender.to(a)).toHaveLength(5);
    h.clock.now += 10 * 60_000 + 1;
    expect((await start(h, app, a, freshIp())).status).toBe(202);
  });

  it('a suppressed address: 202 and no mail; its challenge holds no address and no code', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = addr('s');
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), a), 'bounce', 1).run();
    const s = await start(h, app, a);
    expect(s.status).toBe(202);
    expect(h.sender.to(a)).toHaveLength(0);
    await runInDurableObject(env.EMAIL_CHALLENGE.get(env.EMAIL_CHALLENGE.idFromName(s.body.challengeId as string)), (_o, state) => {
      const rec = state.storage.kv.get<ChallengeRecord>('challenge')!;
      expect(rec.silent).toBe(true);
      expect(rec.email).toBe('');
      expect(JSON.stringify(rec)).not.toContain('@');
    });
    h.clock.now += 30_000;
    expect((await h.call('/v1/email/resend', { challengeId: s.body.challengeId })).status).toBe(202);
    expect(h.sender.to(a)).toHaveLength(0);
    // Suppression is per exact address: a bounce on victim+x@ never suppresses victim@ (where `+` may not be
    // sub-addressing, those are two people's mailboxes).
    const victim = addr('v');
    const tagged = `${victim.split('@')[0]}+x@example.com`;
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), tagged), 'bounce', 1).run();
    expect((await start(h, app, victim)).status).toBe(202);
    expect(h.sender.to(victim)).toHaveLength(1);
    expect((await start(h, app, tagged)).status).toBe(202);
    expect(h.sender.to(tagged)).toHaveLength(0);
  });

  it('a suppressed address takes the same limiter path as any other (counted, never refunded)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const fresh = addr('sf');
    const suppressed = addr('ss');
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), suppressed), 'bounce', 1).run();
    const ip = freshIp();
    const seq = async (email: string) => {
      const out: number[] = [];
      for (let i = 0; i < 4; i++) out.push((await start(h, app, email, ip)).status);
      return out;
    };
    expect(await seq(fresh)).toEqual([202, 202, 202, 429]);
    expect(await seq(suppressed)).toEqual([202, 202, 202, 429]);
    expect(h.sender.to(suppressed)).toHaveLength(0);
    // Resends count alike: a fourth code for either from one requester within 15 min is refused.
    for (const email of [addr('rf'), addr('rs')]) {
      if (email.startsWith('rs')) await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), email), 'bounce', 1).run();
      const ip2 = freshIp();
      const s = await start(h, app, email, ip2);
      const out = [s.status];
      for (let i = 0; i < 3; i++) {
        h.clock.now += 30_000;
        out.push((await h.call('/v1/email/resend', { challengeId: s.body.challengeId }, { ip: ip2 })).status);
      }
      expect(out).toEqual([202, 202, 202, 429]);
    }
  });
});

describe('wrong codes: per requester, with a mailbox-wide backstop', () => {
  it('10 wrong codes from one requester lock it out of that mailbox for an hour; the owner elsewhere still signs in', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = addr('w');
    const attacker = freshIp();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await start(h, app, a, attacker)).body.challengeId as string);
    let n = 0;
    for (const id of ids) for (let k = 0; k < 4 && n < 10; k++, n++) expect((await h.call('/v1/email/verify', { challengeId: id, code: '000000' === h.sender.codeFor(a) ? '111111' : '000000' }, { ip: attacker })).status).toBe(400);
    // The attacker is locked out of this mailbox: verify and start.
    expect((await h.call('/v1/email/verify', { challengeId: ids[2], code: h.sender.codeFor(a) }, { ip: attacker })).status).toBe(429);
    h.clock.now += 15 * 60_000 + 1;
    expect((await start(h, app, a, attacker)).status).toBe(429);
    // The owner, from another requester, starts and verifies.
    const owner = freshIp();
    const s = await start(h, app, a, owner);
    expect(s.status).toBe(202);
    expect((await h.call('/v1/email/verify', { challengeId: s.body.challengeId, code: h.sender.codeFor(a) }, { ip: owner })).status).toBe(200);
    h.clock.now += 60 * 60_000;
    expect((await start(h, app, a, attacker)).status).toBe(202);
  });

  it('a right code takes its check back (9 wrong then right leaves no lock)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const h2 = h;
    const app2 = app;
    const b = addr('r2');
    const ip2 = freshIp();
    const ids2: string[] = [];
    for (let i = 0; i < 3; i++) ids2.push((await start(h2, app2, b, ip2)).body.challengeId as string);
    const code2 = h2.sender.codeFor(b);
    for (const [id, k] of [[ids2[0], 4], [ids2[1], 4], [ids2[2], 1]] as const) for (let i = 0; i < k; i++) await h2.call('/v1/email/verify', { challengeId: id, code: wrongFor(code2) }, { ip: ip2 });
    expect((await h2.call('/v1/email/verify', { challengeId: ids2[2], code: code2 }, { ip: ip2 })).status).toBe(200);
    h2.clock.now += 15 * 60_000 + 1;
    expect((await start(h2, app2, b, ip2)).status).toBe(202);
  });

  it('the mailbox-wide backstop: 50 checks a day from all requesters, then none for anyone', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = addr('k');
    let checks = 0;
    for (let round = 0; round < 12 && checks < 50; round++) {
      const ip = freshIp();
      const s = await start(h, app, a, ip);
      if (s.status !== 202) {
        h.clock.now += 10 * 60_000 + 1;
        continue;
      }
      for (let k = 0; k < 5 && checks < 50; k++, checks++) expect((await h.call('/v1/email/verify', { challengeId: s.body.challengeId, code: wrongFor(h.sender.codeFor(a)) }, { ip })).status).toBe(400);
      h.clock.now += 3 * 60_000;
    }
    expect(checks).toBe(50);
    // The backstop stops whoever guessed: a requester that already failed on this mailbox is refused.
    const guesser = freshIp();
    h.clock.now += 10 * 60_000 + 1;
    const g = await start(h, app, a, guesser);
    expect(g.status).toBe(202);
    expect((await h.call('/v1/email/verify', { challengeId: g.body.challengeId, code: wrongFor(h.sender.codeFor(a)) }, { ip: guesser })).status).toBe(400);
    expect((await h.call('/v1/email/verify', { challengeId: g.body.challengeId, code: h.sender.codeFor(a) }, { ip: guesser })).status).toBe(429);
    expect((await start(h, app, a, guesser)).status).toBe(429);
    // The owner, with no failure on this mailbox, still signs in.
    const owner = freshIp();
    const o = await start(h, app, a, owner);
    expect(o.status).toBe(202);
    expect((await h.call('/v1/email/verify', { challengeId: o.body.challengeId, code: h.sender.codeFor(a) }, { ip: owner })).status).toBe(200);
    // Parallel guesses from one new requester past the backstop: at most one is checked.
    const burst = freshIp();
    const b = await start(h, app, a, burst);
    const wrong = wrongFor(h.sender.codeFor(a));
    const statuses = await Promise.all(Array.from({ length: 10 }, () => h.call('/v1/email/verify', { challengeId: b.body.challengeId, code: wrong }, { ip: burst }).then((r) => r.status)));
    expect(statuses.filter((x) => x === 400)).toHaveLength(1);
  });

  it('concurrent wrong guesses: one challenge compares at most 5 codes; one requester checks at most 10', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = addr('c');
    const ip = freshIp();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await start(h, app, a, ip)).body.challengeId as string);
    const wrong = wrongFor(h.sender.codeFor(a));
    // 20 at once on one challenge.
    const one = await Promise.all(Array.from({ length: 20 }, () => h.call('/v1/email/verify', { challengeId: ids[0], code: wrong }, { ip })));
    const bodies = await Promise.all(one.map(async (r) => ({ status: r.status, body: (await r.json()) as { data?: { attemptsLeft: number } } })));
    const checked = bodies.filter((b) => b.status === 400);
    expect(checked).toHaveLength(5);
    expect(checked.map((b) => b.body.data!.attemptsLeft).sort()).toEqual([0, 1, 2, 3, 4]);
    // 30 at once over the other two challenges and a fresh one: the requester's lock stops at 10 checks in all.
    ids.push(...[(await start(h, app, a, freshIp())).body.challengeId as string]);
    const many = await Promise.all(Array.from({ length: 30 }, (_, i) => h.call('/v1/email/verify', { challengeId: ids[1 + (i % 3)], code: wrong }, { ip })));
    const statuses = many.map((r) => r.status);
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(5);
    expect(5 + statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(10);
    expect(statuses.every((s) => s === 400 || s === 429 || s === 410)).toBe(true);
  });
});

describe('per-IP, per-app and global limits (429)', () => {
  it('start per IP: 10 per 10 min, 50 per day', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await start(h, app, addr(`f${i}`), ip)).status).toBe(202);
    const r = await h.call('/v1/email/start', startBody(h, app, addr('g')), { ip });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).not.toBeNull();
    let okCount = 10;
    for (let w = 0; w < 6; w++) {
      h.clock.now += 10 * 60_000;
      for (let i = 0; i < 10; i++) if ((await start(h, app, addr(`h${w}${i}`), ip)).status === 202) okCount++;
    }
    expect(okCount).toBe(50);
  });

  it('verify per IP: 30 per 10 min', async () => {
    const h = await harness();
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await h.call('/v1/email/verify', { challengeId: 'x'.repeat(43), code: '123456' }, { ip })).status).toBe(410);
    expect((await h.call('/v1/email/verify', { challengeId: 'x'.repeat(43), code: '123456' }, { ip })).status).toBe(429);
  });

  it('per app: 20 × the plan’s per_minute per minute, and its per_day', async () => {
    const h = await harness();
    const plan = `p${uid().replace(/[^a-z0-9]/gu, '')}`;
    await seedPlan(plan, 1, 30);
    const app = await seedApp(h, { plan });
    let okCount = 0;
    for (let i = 0; i < 21; i++) if ((await start(h, app, addr(`i${i}`))).status === 202) okCount++;
    expect(okCount).toBe(20);
    h.clock.now += 60_000;
    for (let i = 0; i < 20; i++) if ((await start(h, app, addr(`j${i}`))).status === 202) okCount++;
    expect(okCount).toBe(30);
  });

  it('the daily send budget refuses new starts at the cap and logs a critical line', async () => {
    const h = await harness({ env: { ...env, ENV_NAME: `budget-${uid()}`, DAILY_SEND_BUDGET: '2' } });
    const app = await seedApp(h);
    await start(h, app, addr('k1'));
    await start(h, app, addr('k2'));
    const { result, lines } = await captureLogs(() => h.call('/v1/email/start', startBody(h, app, addr('k3'))));
    expect(result.status).toBe(429);
    expect(lines.some((l) => l.includes('"send_budget_exhausted"') && l.includes('"level":"error"'))).toBe(true);
    expect(h.sender.sent).toHaveLength(2);
  });
});

describe('enumeration resistance', () => {
  it('fresh and suppressed addresses: same status, body keys and similar timing; a limited mailbox: the IP limit’s exact body', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const suppressed = addr('m');
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), suppressed), 'complaint', 1).run();
    const runs: Record<string, number[]> = { fresh: [], suppressed: [] };
    for (let i = 0; i < 5; i++) {
      for (const [k, email] of [['fresh', addr(`n${i}`)], ['suppressed', suppressed]] as const) {
        const t0 = performance.now();
        const r = await start(h, app, email, freshIp());
        runs[k]!.push(performance.now() - t0);
        expect(r.status).toBe(202);
        expect(Object.keys(r.body).sort()).toEqual(['challengeId', 'expiresAtMs', 'resendAfterMs']);
      }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    expect(Math.abs(median(runs.fresh!) - median(runs.suppressed!))).toBeLessThan(50);
    // A mailbox limit answers exactly like an IP limit.
    const a = addr('o');
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await start(h, app, a, ip);
    const mailboxLimited = await h.call('/v1/email/start', startBody(h, app, a), { ip });
    const ipLimited = freshIp();
    for (let i = 0; i < 10; i++) await start(h, app, addr(`q${i}`), ipLimited);
    const ipRefused = await h.call('/v1/email/start', startBody(h, app, addr('q')), { ip: ipLimited });
    expect([mailboxLimited.status, ipRefused.status]).toEqual([429, 429]);
    expect(await mailboxLimited.json()).toEqual(await ipRefused.json());
  });
});
