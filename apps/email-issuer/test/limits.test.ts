// Every limit (spec "Rate limits and abuse", D198): per mailbox (the address without its `+tag`) and requester, so an
// attacker who knows an address can neither mail it without bound nor lock its owner out; the atomic guess accounting
// (concurrent guesses can't outrun a lock check, a challenge never compares more than 5 codes); suppressions; and
// enumeration resistance (`start` answers alike for every valid address; every limit is the same generic 429).
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ChallengeRecord } from '../src/challenge.ts';
import { normalizeEmail } from '@hana-id/email';
import { suppressionKey as addressKey, mailboxKey } from '../src/keys.ts';
import { captureLogs, challengeObject, env, harness, seedApp, seedPlan, sessionCommitment, uid, type Harness, type TestApp } from './helpers.ts';

const startBody = (h: Harness, app: TestApp, email: string) => ({ pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
const start = async (h: Harness, app: TestApp, email: string, ip?: string) => {
  const r = await h.call('/v1/email/start', startBody(h, app, email), ip ? { ip } : {});
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
// Each fresh requester on its own /24, so the per-/24 aggregate limit (200 starts a day) never joins unrelated tests.
const ipN = (n: number) => `10.${Math.floor(n / 250) % 250}.${n % 250}.9`;
const morning = Date.UTC(2027, 0, 15, 8, 0, 0);
let ipSeq = Math.floor(Math.random() * 10_000);
const freshIp = () => ipN(ipSeq++);
const addr = (tag: string) => `${tag}${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
const normalizeMailbox = (email: string): string => {
  const r = normalizeEmail(email);
  if (!r.ok) throw new Error('bad test address');
  return r.mailbox;
};
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
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), a), 'bounce', h.clock.now).run();
    const s = await start(h, app, a);
    expect(s.status).toBe(202);
    expect(h.sender.to(a)).toHaveLength(0);
    await runInDurableObject(challengeObject(s.body.challengeId), (_o, state) => {
      const rec = state.storage.kv.get<ChallengeRecord>('challenge')!;
      expect(rec.silent).toBe(true);
      expect(rec.emailEnc).toBe("");
      expect(JSON.stringify(rec)).not.toContain('@');
    });
    h.clock.now += 30_000;
    expect((await h.call('/v1/email/resend', { challengeId: s.body.challengeId })).status).toBe(202);
    expect(h.sender.to(a)).toHaveLength(0);
    // Suppression is per exact address: a bounce on victim+x@ never suppresses victim@ (where `+` may not be
    // sub-addressing, those are two people's mailboxes).
    const victim = addr('v');
    const tagged = `${victim.split('@')[0]}+x@example.com`;
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), tagged), 'bounce', h.clock.now).run();
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
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), suppressed), 'bounce', h.clock.now).run();
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
      if (email.startsWith('rs')) await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), email), 'bounce', h.clock.now).run();
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

  // The hard ceiling (D198): ≤ 25 failed checks per mailbox per UTC day, whoever asks. The clock is set to a UTC
  // morning so no test crosses midnight by accident.

  const guessWrong = async (h: Harness, id: unknown, code: string, ip: string) => (await h.call('/v1/email/verify', { challengeId: id, code: wrongFor(code) }, { ip })).status;

  it('many requesters: the backstop stops everyone at 18 failed checks but owner-slot requesters, and nothing passes 25', async () => {
    const h = await harness();
    h.clock.now = morning;
    const app = await seedApp(h);
    const a = addr('cx');
    let failed = 0;
    // Four requesters start a challenge before anything trips (each a would-be owner).
    const early = Array.from({ length: 4 }, freshIp);
    const earlyIds: unknown[] = [];
    for (const ip of early) {
      const s = await start(h, app, a, ip);
      expect(s.status).toBe(202);
      earlyIds.push(s.body.challengeId);
    }
    const { result, lines } = await captureLogs(async () => {
      // Fifty attackers, each: start, then five wrong codes.
      for (let i = 0; i < 50; i++) {
        const ip = freshIp();
        const s = await start(h, app, a, ip);
        if (s.status !== 202) continue;
        for (let k = 0; k < 5; k++) if ((await guessWrong(h, s.body.challengeId, h.sender.codeFor(a), ip)) === 400) failed++;
      }
      // The early requesters guess wrong too, in parallel, five each on their own challenge: each gets one owner-slot
      // check, and its first failure ends its exemption.
      const statuses = await Promise.all(early.flatMap((ip, n) => Array.from({ length: 5 }, () => guessWrong(h, earlyIds[n], h.sender.codeFor(a), ip))));
      failed += statuses.filter((s) => s === 400).length;
      // Twenty more fresh requesters: nothing.
      for (let i = 0; i < 20; i++) expect((await start(h, app, a, freshIp())).status).toBe(429);
      return failed;
    });
    expect(result).toBeLessThanOrEqual(25);
    expect(result).toBe(18 + early.length);
    expect(lines.some((l) => l.includes('"mailbox_guess_limit"') && l.includes('"code":"backstop"') && l.includes('"level":"error"'))).toBe(true);
    for (const l of lines) expect(l).not.toContain(a);
    // The next UTC day starts afresh.
    h.clock.now = morning + 86_400_000;
    const ip = freshIp();
    const s = await start(h, app, a, ip);
    expect(s.status).toBe(202);
    expect((await h.call('/v1/email/verify', { challengeId: s.body.challengeId, code: h.sender.codeFor(a) }, { ip })).status).toBe(200);
  });
  it('the owner slot: a requester that started before the trip still signs in; one that started after can’t', async () => {
    const h = await harness();
    h.clock.now = morning;
    const app = await seedApp(h);
    const a = addr('co');
    const owner = freshIp();
    const o = await start(h, app, a, owner);
    const ownerCode = h.sender.codeFor(a);
    // 18 failures: 5 + 5 + 5 + 3.
    for (const n of [5, 5, 5, 3]) {
      const ip = freshIp();
      const s = await start(h, app, a, ip);
      for (let k = 0; k < n; k++) expect(await guessWrong(h, s.body.challengeId, h.sender.codeFor(a), ip)).toBe(400);
    }
    const late = freshIp();
    expect((await start(h, app, a, late)).status).toBe(429);
    expect((await h.call('/v1/email/verify', { challengeId: o.body.challengeId, code: '123456' }, { ip: late })).status).toBe(429);
    expect((await h.call('/v1/email/verify', { challengeId: o.body.challengeId, code: ownerCode }, { ip: owner })).status).toBe(200);
  });
  it('the ceiling: 18 + the 4 owner-slot checks + the 3 ticket checks, then nobody until the UTC day ends; logged', async () => {
    const h = await harness();
    h.clock.now = morning;
    const app = await seedApp(h);
    const a = addr('cc');
    // The owner signed in earlier today: it holds a device ticket.
    const t = freshIp();
    const first = await start(h, app, a, t);
    const v = await h.call('/v1/email/verify', { challengeId: first.body.challengeId, code: h.sender.codeFor(a) }, { ip: t });
    const { deviceTicket } = (await v.json()) as { deviceTicket: string };
    expect(deviceTicket).toMatch(/^dt1\.[A-Za-z0-9_-]{54}$/u);
    // Four clean early starters (and a fifth, kept clean for the end).
    const early = Array.from({ length: 5 }, freshIp);
    const earlyIds: unknown[] = [];
    for (const ip of early) earlyIds.push((await start(h, app, a, ip)).body.challengeId);
    // The attackers: 18 failures trip the backstop.
    h.clock.now += 10 * 60_000 + 1;
    for (const n of [5, 5, 5, 3]) {
      const ip = freshIp();
      const s = await start(h, app, a, ip);
      expect(s.status).toBe(202);
      for (let k = 0; k < n; k++) expect(await guessWrong(h, s.body.challengeId, h.sender.codeFor(a), ip)).toBe(400);
    }
    h.clock.now += 15 * 60_000 + 1;
    const { lines } = await captureLogs(async () => {
      // The owner slot: four clean early starters, one wrong check each.
      for (const ip of early.slice(0, 4)) {
        const s = await start(h, app, a, ip);
        expect(s.status).toBe(202);
        expect(await guessWrong(h, s.body.challengeId, h.sender.codeFor(a), ip)).toBe(400);
      }
      // The ticket slot: three checks of a ticketed challenge.
      const ts = await h.call('/v1/email/start', { ...startBody(h, app, a), deviceTicket }, { ip: t });
      expect(ts.status).toBe(202);
      const tid = ((await ts.json()) as { challengeId: string }).challengeId;
      for (let k = 0; k < 3; k++) expect(await guessWrong(h, tid, h.sender.codeFor(a), t)).toBe(400);
    });
    expect(lines.some((l) => l.includes('"mailbox_guess_limit"') && l.includes('"code":"ceiling"'))).toBe(true);
    // 25 failed checks: the fifth early starter (clean, pre-trip) and the ticket holder are refused too, until midnight
    // UTC, with the one mailbox-level retry-after.
    const r = await h.call('/v1/email/start', startBody(h, app, a), { ip: early[4]! });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
    expect((await h.call('/v1/email/start', { ...startBody(h, app, a), deviceTicket }, { ip: t })).status).toBe(429);
    expect((await start(h, app, a, freshIp())).status).toBe(429);
    h.clock.now = Date.UTC(2027, 0, 16, 0, 0, 1);
    expect((await start(h, app, a, early[4]!)).status).toBe(202);
  });
  it('challenges per mailbox per day are capped at 35, every kind', async () => {
    const h = await harness();
    h.clock.now = morning;
    const app = await seedApp(h);
    const a = addr('cd');
    let made = 0;
    for (let i = 0; i < 45; i++) {
      const ip = freshIp();
      const s = await start(h, app, a, ip);
      if (s.status === 202) {
        made++;
        await h.call('/v1/email/verify', { challengeId: s.body.challengeId, code: h.sender.codeFor(a) }, { ip });
      }
      if (i % 9 === 8) h.clock.now += 15 * 60_000 + 1;
    }
    // 30 mailbox-wide plus the 5-a-day reserve: the code limits and the challenge cap agree at 35.
    expect(made).toBe(35);
  });

  it('a check that turned out right doesn’t leave a trip marker: the owner slot follows the real trip', async () => {
    const h = await harness();
    h.clock.now = morning;
    const app = await seedApp(h);
    const a = addr('tm');
    // 17 failed checks (5, 5, 5, 2), then the 18th check is right: reserved (the backstop's 18th place, the trip),
    // then refunded.
    let last: { ip: string; id: unknown } | null = null;
    for (const n of [5, 5, 5, 2]) {
      const ip = freshIp();
      const s = await start(h, app, a, ip);
      for (let k = 0; k < n; k++) await guessWrong(h, s.body.challengeId, h.sender.codeFor(a), ip);
      last = { ip, id: s.body.challengeId };
    }
    expect((await h.call('/v1/email/verify', { challengeId: last!.id, code: h.sender.codeFor(a) }, { ip: last!.ip })).status).toBe(200);
    // The owner starts now, before any real trip.
    const owner = freshIp();
    const o = await start(h, app, a, owner);
    expect(o.status).toBe(202);
    const ownerCode = h.sender.codeFor(a);
    // The real trip.
    const x = freshIp();
    const s = await start(h, app, a, x);
    expect(await guessWrong(h, s.body.challengeId, h.sender.codeFor(a), x)).toBe(400);
    expect((await start(h, app, a, freshIp())).status).toBe(429);
    // The owner started before it: the owner slot is open to it.
    expect((await h.call('/v1/email/verify', { challengeId: o.body.challengeId, code: ownerCode }, { ip: owner })).status).toBe(200);
  });
  it('the day’s challenge cap is taken back when the budget refuses the start or the first code isn’t delivered', async () => {
    const env2 = { ...env, ENV_NAME: `cap-${uid()}`, DAILY_SEND_BUDGET: '10' };
    const h = await harness({ env: env2 });
    h.clock.now = morning;
    const app = await seedApp(h);
    const a = addr('cr');
    const count = async () => {
      const key = await mailboxKey(await h.deps.keys(), normalizeMailbox(a));
      const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${env2.ENV_NAME}:mbx:${key}`));
      return runInDurableObject(stub, (_o, state) => state.storage.kv.get<number>(`challenges:1d@${Date.UTC(2027, 0, 15)}`) ?? 0);
    };
    // The provider refuses the first code: the challenge stays (resendable), its place in the cap doesn't.
    h.sender.next = { ok: false, reason: 'unavailable', providerStatus: 503 };
    expect((await start(h, app, a, freshIp())).status).toBe(202);
    expect(await count()).toBe(0);
    h.sender.next = { ok: true };
    expect((await start(h, app, a, freshIp())).status).toBe(202);
    expect(await count()).toBe(1);
    // The app's share of the budget (10% of 10: 1) is spent: every further start is refused and none takes a place.
    for (let i = 0; i < 5; i++) expect((await start(h, app, a, freshIp())).status).toBe(429);
    expect(await count()).toBe(1);
  });
  it('unadmit takes back the challenge’s place and its live slot', async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`unadmit-${uid()}`));
    const exp = morning + 600_000;
    const adm = await stub.admit('r1', exp, false, morning);
    expect(adm.ok).toBe(true);
    if (!adm.ok) return;
    await stub.unadmit(adm.created, exp, morning);
    await runInDurableObject(stub, (_o, state) => {
      expect(state.storage.kv.get(`challenges:1d@${Date.UTC(2027, 0, 15)}`)).toBeUndefined();
      expect(state.storage.kv.get('live')).toBeUndefined();
    });
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
    // Exempt-provider addresses, so the recipient domain's per-prefix share doesn't count here.
    const gaddr = (tag: string) => `${tag}${uid().replace(/[^a-z0-9]/gu, '')}@gmail.com`;
    for (let i = 0; i < 10; i++) expect((await start(h, app, gaddr(`f${i}`), ip)).status).toBe(202);
    const r = await h.call('/v1/email/start', startBody(h, app, gaddr('g')), { ip });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).not.toBeNull();
    let okCount = 10;
    for (let w = 0; w < 6; w++) {
      h.clock.now += 10 * 60_000;
      for (let i = 0; i < 10; i++) if ((await start(h, app, gaddr(`h${w}${i}`), ip)).status === 202) okCount++;
    }
    expect(okCount).toBe(50);
  });

  it('verify per IP: 30 per 10 min', async () => {
    const h = await harness();
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await h.call('/v1/email/verify', { challengeId: 'x'.repeat(43), code: '123456' }, { ip })).status).toBe(410);
    expect((await h.call('/v1/email/verify', { challengeId: 'x'.repeat(43), code: '123456' }, { ip })).status).toBe(429);
  });

  it('per app: the plan’s per_minute per minute and its per_day (H1: no "20 ×"); a refused mailbox costs the app nothing', async () => {
    const h = await harness();
    const plan = `p${uid().replace(/[^a-z0-9]/gu, '')}`;
    await seedPlan(plan, 2, 4);
    // A fixed clock: no 15-minute window boundary between the steps.
    h.clock.now = morning;
    const app = await seedApp(h, { plan });
    // A start the mailbox refuses never reaches the app's quota: the requester pays first.
    const busy = addr('busy');
    const ip = freshIp();
    for (let i = 0; i < 2; i++) expect((await start(h, app, busy, ip)).status).toBe(202);
    h.clock.now += 60_000;
    // `busy` from the same requester is now at 2 of its 3 per 15 min; a third, then refusals by the mailbox.
    expect((await start(h, app, busy, ip)).status).toBe(202);
    for (let i = 0; i < 3; i++) expect((await start(h, app, busy, ip)).status).toBe(429);
    h.clock.now += 60_000;
    // The app's day (4): the three refused starts didn't count, so a fourth start passes, and a fifth doesn't.
    expect((await start(h, app, addr('x1'))).status).toBe(202);
    expect((await start(h, app, addr('x2'))).status).toBe(429);
    const h2 = await harness();
    const app2 = await seedApp(h2, { plan });
    let okCount = 0;
    for (let i = 0; i < 3; i++) if ((await start(h2, app2, addr(`i${i}`))).status === 202) okCount++;
    expect(okCount).toBe(2);
    h2.clock.now += 60_000;
    for (let i = 0; i < 3; i++) if ((await start(h2, app2, addr(`j${i}`))).status === 202) okCount++;
    expect(okCount).toBe(4);
  });
  it('the global budget is shared out: 10% per app, the last 20% only for apps under half their share; logged', async () => {
    const env2 = { ...env, ENV_NAME: `budget-${uid()}`, DAILY_SEND_BUDGET: '100' };
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${env2.ENV_NAME}:global`));
    const now = morning;
    // App share: 10. App b uses half its share; a0..a6 their whole share; a7 half: 80 = the general pool.
    for (let k = 0; k < 5; k++) expect((await stub.reserveBudget('b', 100, now)).ok).toBe(true);
    for (let i = 0; i < 7; i++) for (let k = 0; k < 10; k++) expect((await stub.reserveBudget(`a${i}`, 100, now)).ok).toBe(true);
    expect(await stub.reserveBudget('a0', 100, now)).toEqual({ ok: false, limit: 'app' });
    for (let k = 0; k < 5; k++) expect((await stub.reserveBudget('a7', 100, now)).ok).toBe(true);
    // The reserve (the last 20): an app that has used half its share (b, a7) can't draw on it; one under half can.
    expect(await stub.reserveBudget('b', 100, now)).toEqual({ ok: false, limit: 'reserve' });
    expect(await stub.reserveBudget('a7', 100, now)).toEqual({ ok: false, limit: 'reserve' });
    const c = await stub.reserveBudget('c', 100, now);
    expect(c.ok && c.crossed).toEqual([]);
    // Logs at 50% and 80% of the global budget and of an app's share, through start.
    const h = await harness({ env: { ...env, ENV_NAME: `budget2-${uid()}`, DAILY_SEND_BUDGET: '20' } });
    const app = await seedApp(h);
    const { result, lines } = await captureLogs(async () => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) out.push((await start(h, app, addr(`k${i}`))).status);
      return out;
    });
    // App share of 20: 2. The third start is refused.
    expect(result).toEqual([202, 202, 429]);
    expect(lines.some((l) => l.includes('"email_budget"') && l.includes('"code":"app_50"'))).toBe(true);
    expect(lines.some((l) => l.includes('"send_budget_exhausted"') && l.includes('"code":"app"') && l.includes('"level":"error"'))).toBe(true);
    expect(h.sender.sent).toHaveLength(2);
  });
});

describe('enumeration resistance', () => {
  it('fresh and suppressed addresses: same status, body keys and similar timing; every mailbox-level refusal: one body and one retry-after (L1)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const suppressed = addr('m');
    await env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await addressKey(await h.deps.keys(), suppressed), 'complaint', h.clock.now).run();
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
    // Mailbox-level refusals of different kinds: the per-requester code limit, the live-challenge cap.
    const a = addr('o');
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await start(h, app, a, ip);
    const byCodes = await h.call('/v1/email/start', startBody(h, app, a), { ip });
    const b = addr('q');
    for (let i = 0; i < 5; i++) await start(h, app, b, freshIp());
    const byLive = await h.call('/v1/email/start', startBody(h, app, b), { ip: freshIp() });
    expect([byCodes.status, byLive.status]).toEqual([429, 429]);
    expect([byCodes.headers.get('retry-after'), byLive.headers.get('retry-after')]).toEqual(['900', '900']);
    const ipLimited = freshIp();
    for (let i = 0; i < 10; i++) await start(h, app, addr(`q${i}`), ipLimited);
    const ipRefused = await h.call('/v1/email/start', startBody(h, app, addr('q')), { ip: ipLimited });
    const bodies = [await byCodes.json(), await byLive.json(), await ipRefused.json()];
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual(bodies[2]);
  });
});
