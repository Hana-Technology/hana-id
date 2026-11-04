// Dev envs' higher code limits (D340): `limitsFor` picks the set from the env name (`isDevEnv`: `local*`, `sandbox*`);
// a production env refuses at exactly the old numbers, a dev env passes them and refuses at its own; a mailbox object
// takes the set with each call, so counters stored under production's set pass at once under the dev set.
import { describe, expect, it } from 'vitest';
import { newChallengeId } from '../src/challenge-id.ts';
import {
  DEV_LIMITS,
  IP_RESEND_LIMITS,
  IP_START_LIMITS,
  IP_VERIFY_LIMITS,
  MAILBOX_CHALLENGES_PER_DAY,
  MAILBOX_CODE_LIMITS,
  MAILBOX_IP_CODE_LIMITS,
  MAILBOX_IP_WRONG_LIMIT,
  MAILBOX_OWNER_SLOT,
  MAILBOX_TICKET_SLOT,
  MAILBOX_WRONG_BACKSTOP,
  MAILBOX_WRONG_CEILING,
  MAX_LIVE_CHALLENGES,
  PRODUCTION_LIMITS,
  limitsFor,
  type Limits,
  type MailboxLimits,
} from '../src/limits.ts';
import { ADDRESS_OWNER_CHALLENGES } from '../src/limits.ts';
import { env, harness, mailboxObject, seedApp, seedPlan, sessionCommitment, uid, type Harness, type TestApp } from './helpers.ts';

const morning = Date.UTC(2027, 2, 10, 8, 0, 0);
let ipSeq = Math.floor(Math.random() * 10_000);
const freshIp = () => `10.${Math.floor(ipSeq / 250) % 250}.${ipSeq++ % 250}.7`;
const gmail = (tag: string) => `${tag}${uid().replace(/[^a-z0-9]/gu, '')}@gmail.com`;
const maxOf = (limits: readonly { name: string; max: number }[], name: string) => limits.find((l) => l.name === name)!.max;

/** A harness on its own env name with this prefix (limiter objects are named `<env>:<subject>`). */
const harnessFor = (prefix: string) => harness({ env: { ...env, ENV_NAME: `${prefix}-${uid()}` } });
/** An app on a plan big enough that its per-minute start limit and budget share never join these tests. */
const bigApp = async (h: Harness): Promise<TestApp> => {
  await seedPlan('dev-limits-big', 10_000, 1_000_000);
  return seedApp(h, { plan: 'dev-limits-big' });
};
const startBody = (h: Harness, app: TestApp, email: string) => ({ pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });

const DEV_NAMES = ['sandbox-dev', 'local-test'];
const PRODUCTION_NAME = 'prod';
const tiers: [string, Limits][] = [
  [PRODUCTION_NAME, PRODUCTION_LIMITS],
  ...DEV_NAMES.map((n): [string, Limits] => [n, DEV_LIMITS]),
];

describe('limitsFor: dev or production by env name', () => {
  it('local* and sandbox* are dev; every other name is production', () => {
    for (const name of ['sandbox-dev', 'local-test', 'local', 'sandbox', 'sandbox2', 'local-dev']) expect(limitsFor(name)).toBe(DEV_LIMITS);
    for (const name of ['prod', 'production', 'mainnet', 'staging', 'testnet', 'dev-sandbox', 'my-local', 't-abc', '']) expect(limitsFor(name)).toBe(PRODUCTION_LIMITS);
    expect(DEV_LIMITS.dev).toBe(true);
    expect(PRODUCTION_LIMITS.dev).toBe(false);
  });

  it('production keeps exactly the old numbers', () => {
    const m = PRODUCTION_LIMITS.mailbox;
    expect([maxOf(m.ipCodes, 'codes:15m'), maxOf(m.ipCodes, 'codes:1d')]).toEqual([3, 10]);
    expect([maxOf(m.codes, 'codes:15m'), maxOf(m.codes, 'codes:1d')]).toEqual([10, 30]);
    expect(m.maxLive).toBe(5);
    expect(m.challengesPerDay.max).toBe(35);
    expect(m.ipWrong.max).toBe(10);
    expect([m.wrongCeiling.max, m.wrongBackstop.max, m.ownerSlot.max, m.ticketSlot.max]).toEqual([25, 18, 4, 3]);
    expect([m.ticketSends.max, m.ticketSendsTotal.max]).toEqual([3, 9]);
    expect([maxOf(PRODUCTION_LIMITS.ipStart, 'ip:start:10m'), maxOf(PRODUCTION_LIMITS.ipStart, 'ip:start:1d')]).toEqual([10, 50]);
    expect(maxOf(PRODUCTION_LIMITS.ipResend, 'ip:resend:10m')).toBe(10);
    expect(maxOf(PRODUCTION_LIMITS.ipVerify, 'ip:verify:10m')).toBe(30);
    // And the named constants (the ones every other test and doc quotes) are that set.
    expect(m.ipCodes).toEqual(MAILBOX_IP_CODE_LIMITS);
    expect(m.codes).toEqual(MAILBOX_CODE_LIMITS);
    expect(m.maxLive).toBe(MAX_LIVE_CHALLENGES);
    expect([m.challengesPerDay, m.ipWrong, m.wrongCeiling, m.wrongBackstop, m.ownerSlot, m.ticketSlot]).toEqual([
      MAILBOX_CHALLENGES_PER_DAY,
      MAILBOX_IP_WRONG_LIMIT,
      MAILBOX_WRONG_CEILING,
      MAILBOX_WRONG_BACKSTOP,
      MAILBOX_OWNER_SLOT,
      MAILBOX_TICKET_SLOT,
    ]);
    expect([PRODUCTION_LIMITS.ipStart, PRODUCTION_LIMITS.ipResend, PRODUCTION_LIMITS.ipVerify]).toEqual([IP_START_LIMITS, IP_RESEND_LIMITS, IP_VERIFY_LIMITS]);
  });

  it('dev raises them (D340), same windows and names', () => {
    const m = DEV_LIMITS.mailbox;
    expect([maxOf(m.ipCodes, 'codes:15m'), maxOf(m.ipCodes, 'codes:1d')]).toEqual([20, 100]);
    expect([maxOf(m.codes, 'codes:15m'), maxOf(m.codes, 'codes:1d')]).toEqual([30, 200]);
    expect(m.maxLive).toBe(20);
    expect(m.challengesPerDay.max).toBe(250);
    expect(m.ipWrong.max).toBe(30);
    expect([m.wrongCeiling.max, m.wrongBackstop.max, m.ownerSlot.max, m.ticketSlot.max]).toEqual([100, 80, 17, 3]);
    expect([m.ticketSends.max, m.ticketSendsTotal.max]).toEqual([100, 300]);
    expect([maxOf(DEV_LIMITS.ipStart, 'ip:start:10m'), maxOf(DEV_LIMITS.ipStart, 'ip:start:1d')]).toEqual([30, 300]);
    expect(maxOf(DEV_LIMITS.ipResend, 'ip:resend:10m')).toBe(30);
    expect(maxOf(DEV_LIMITS.ipVerify, 'ip:verify:10m')).toBe(90);
    // Same counters (name and window) in both sets: only the maxes differ, so a switch applies to stored counts.
    const shape = (l: Limits) => JSON.stringify([...Object.values(l.mailbox).flat(), ...l.ipStart, ...l.ipResend, ...l.ipVerify].map((x) => (typeof x === 'number' ? 'n' : [x.name, x.windowMs])));
    expect(shape(DEV_LIMITS)).toBe(shape(PRODUCTION_LIMITS));
  });

  it('in both sets the ceiling is the sum of its slots, and the requester lock trips before the backstop', () => {
    for (const { mailbox: m } of [PRODUCTION_LIMITS, DEV_LIMITS]) {
      expect(m.wrongCeiling.max).toBe(m.wrongBackstop.max + m.ownerSlot.max + m.ticketSlot.max);
      expect(m.ipWrong.max).toBeLessThan(m.wrongBackstop.max);
      expect(m.ownerSlot.max).toBeGreaterThan(0);
    }
  });

  it('the sets are frozen', () => {
    expect(Object.isFrozen(PRODUCTION_LIMITS.mailbox.wrongCeiling)).toBe(true);
    expect(Object.isFrozen(DEV_LIMITS.mailbox.ipCodes)).toBe(true);
    expect(Object.isFrozen(DEV_LIMITS.ipStart[0])).toBe(true);
  });
});

describe('through the worker: each env name gets its set', () => {
  for (const [name, limits] of tiers) {
    const perRequester = maxOf(limits.mailbox.ipCodes, 'codes:15m');
    it(`${name}: ${perRequester} code mails per mailbox and requester in 15 min, the next a 429`, async () => {
      const h = await harnessFor(name);
      h.clock.now = morning;
      const app = await bigApp(h);
      const a = gmail('r');
      const ip = freshIp();
      for (let i = 0; i < perRequester; i++) {
        const s = await h.call('/v1/email/start', startBody(h, app, a), { ip });
        expect(s.status).toBe(202);
        // Verified away, so the live-challenge cap never decides.
        const { challengeId } = (await s.json()) as { challengeId: string };
        expect((await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(a) }, { ip })).status).toBe(200);
      }
      expect((await h.call('/v1/email/start', startBody(h, app, a), { ip })).status).toBe(429);
      expect(h.sender.to(a)).toHaveLength(perRequester);
    });

    const shared = maxOf(limits.mailbox.codes, 'codes:15m');
    it(`${name}: ${shared} code mails per mailbox in 15 min from every requester, then only the reserve`, async () => {
      const h = await harnessFor(name);
      h.clock.now = morning;
      const app = await bigApp(h);
      const a = gmail('m');
      const used: string[] = [];
      for (let i = 0; i < shared; i++) {
        const ip = freshIp();
        used.push(ip);
        const s = await h.call('/v1/email/start', startBody(h, app, a), { ip });
        expect(s.status).toBe(202);
        const { challengeId } = (await s.json()) as { challengeId: string };
        expect((await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(a) }, { ip })).status).toBe(200);
      }
      // A requester already counted today gets no more (the reserve is for new ones).
      expect((await h.call('/v1/email/start', startBody(h, app, a), { ip: used[0]! })).status).toBe(429);
    });

    const ipStarts = maxOf(limits.ipStart, 'ip:start:10m');
    it(`${name}: ${ipStarts} starts per IP in 10 min, the next a 429`, async () => {
      const h = await harnessFor(name);
      h.clock.now = morning;
      const app = await bigApp(h);
      const ip = freshIp();
      for (let i = 0; i < ipStarts; i++) expect((await h.call('/v1/email/start', startBody(h, app, gmail(`s${i}`)), { ip })).status).toBe(202);
      expect((await h.call('/v1/email/start', startBody(h, app, gmail('s-last')), { ip })).status).toBe(429);
    });

    const ipResends = maxOf(limits.ipResend, 'ip:resend:10m');
    const ipVerifies = maxOf(limits.ipVerify, 'ip:verify:10m');
    it(`${name}: ${ipResends} resends and ${ipVerifies} verifies per IP in 10 min, the next a 429`, async () => {
      const h = await harnessFor(name);
      h.clock.now = morning;
      const ip = freshIp();
      // Unknown challenges: the IP limit counts before the lookup (410), so the 429 is the IP limit's.
      for (let i = 0; i < ipResends; i++) expect((await h.call('/v1/email/resend', { challengeId: newChallengeId().id }, { ip })).status).toBe(410);
      expect((await h.call('/v1/email/resend', { challengeId: newChallengeId().id }, { ip })).status).toBe(429);
      for (let i = 0; i < ipVerifies; i++) expect((await h.call('/v1/email/verify', { challengeId: newChallengeId().id, code: '123456' }, { ip })).status).toBe(410);
      expect((await h.call('/v1/email/verify', { challengeId: newChallengeId().id, code: '123456' }, { ip })).status).toBe(429);
    });
  }
});

describe('the mailbox object under each set', () => {
  const box = async () => mailboxObject(await harness(), gmail('box'));

  for (const [label, { mailbox: lim }] of [['production', PRODUCTION_LIMITS], ['dev', DEV_LIMITS]] as [string, Limits][]) {
    it(`${label}: ${lim.maxLive} live challenges at once, then 'live'`, async () => {
      const b = await box();
      for (let i = 0; i < lim.maxLive; i++) expect((await b.admit(`r${i}`, morning + 600_000 + i, false, morning, null, lim)).ok).toBe(true);
      expect(await b.admit('r-next', morning + 600_000, false, morning, null, lim)).toMatchObject({ ok: false, reason: 'live' });
    });

    it(`${label}: ${lim.challengesPerDay.max} challenges a UTC day, then 'challenges'`, async () => {
      const b = await box();
      for (let i = 0; i < lim.challengesPerDay.max; i++) {
        const exp = morning + 600_000 + i;
        expect((await b.admit(`r${i}`, exp, false, morning, null, lim)).ok).toBe(true);
        await b.releaseLive(exp, morning);
      }
      expect(await b.admit('r-next', morning + 600_000, false, morning, null, lim)).toMatchObject({ ok: false, reason: 'challenges' });
    });

    it(`${label}: a device ticket's own code allowance (${lim.ticketSends.max} a day per address) is what a ticketed start meets`, async () => {
      const b = await box();
      await b.registerTicket('ak', 'tk', morning, morning);
      const ticket = { kind: 'ticket' as const, id: 'tk', addrKey: 'ak', issuedAtMs: morning, untagged: true };
      // Fewer starts than the per-address owner-challenge cap (past it the ticket counts as nothing), so every send
      // here is a ticketed one.
      const n = Math.min(lim.ticketSends.max, ADDRESS_OWNER_CHALLENGES.max) ;
      let sent = 0;
      for (let i = 0; i < n; i++) {
        const exp = morning + 600_000 + i;
        const a = await b.admit(`r${i}`, exp, true, morning, ticket, lim);
        if (a.ok && a.send) sent++;
        if (a.ok) await b.releaseLive(exp, morning);
      }
      expect(sent).toBe(n);
      if (lim.ticketSends.max < ADDRESS_OWNER_CHALLENGES.max) {
        expect(await b.admit('r-next', morning + 700_000, true, morning, ticket, lim)).toMatchObject({ ok: false, reason: 'codes' });
      }
    });

    it(`${label}: a requester's ${lim.ipWrong.max}th wrong code in an hour locks it out; others go on`, async () => {
      const b = await box();
      for (let i = 0; i < lim.ipWrong.max; i++) expect((await b.reserveGuess('r1', morning, null, lim)).ok).toBe(true);
      expect(await b.reserveGuess('r1', morning, null, lim)).toMatchObject({ ok: false, reason: 'locked' });
      expect((await b.reserveGuess('r2', morning, null, lim)).ok).toBe(true);
    });

    it(`${label}: the backstop trips at ${lim.wrongBackstop.max}; then only the owner slot (${lim.ownerSlot.max}) and the ticket slot (${lim.ticketSlot.max}), never past ${lim.wrongCeiling.max}`, async () => {
      const b = await box();
      // Owner-slot requesters: started before the trip, no failure today (a failure ends it, so one check each).
      const owners = Array.from({ length: lim.ownerSlot.max + 1 }, (_, i) => `owner${i}`);
      for (const [i, o] of owners.entries()) {
        const exp = morning + 600_000 + i;
        expect((await b.admit(o, exp, false, morning, null, lim)).ok).toBe(true);
        await b.releaseLive(exp, morning);
      }
      const perAttacker = lim.ipWrong.max - 1;
      let n = 0;
      let tripped: string | undefined;
      for (let a = 0; n < lim.wrongBackstop.max; a++) {
        for (let i = 0; i < perAttacker && n < lim.wrongBackstop.max; i++, n++) {
          const g = await b.reserveGuess(`attacker${a}`, morning, null, lim);
          expect(g.ok).toBe(true);
          if (g.ok && g.tripped) tripped = g.tripped;
        }
      }
      expect(tripped).toBe('backstop');
      // A requester new past the trip gets nothing; the owner gets its slot.
      expect(await b.reserveGuess('late', morning, null, lim)).toMatchObject({ ok: false, reason: 'locked' });
      let owner = 0;
      for (const o of owners) if ((await b.reserveGuess(o, morning, null, lim)).ok) owner++;
      expect(owner).toBe(lim.ownerSlot.max);
      // A ticket's challenge takes the ticket slot, up to the ceiling.
      await b.registerTicket('ak', 'tk', morning, morning);
      const ticket = { kind: 'ticket' as const, id: 'tk', addrKey: 'ak', issuedAtMs: morning };
      let t = 0;
      for (let i = 0; i < lim.ticketSlot.max + 2; i++) if ((await b.reserveGuess(`t${i}`, morning, ticket, lim)).ok) t++;
      expect(t).toBe(lim.ticketSlot.max);
      expect(n + owner + t).toBe(lim.wrongCeiling.max);
    });
  }

  it('counters stored under production pass at once under the dev set (no reset)', async () => {
    const b = await box();
    const P = PRODUCTION_LIMITS.mailbox;
    const D = DEV_LIMITS.mailbox;
    // One requester's code mails: production's 3, refused, then the dev set lets the 4th through.
    for (let i = 0; i < maxOf(P.ipCodes, 'codes:15m'); i++) {
      const exp = morning + 600_000 + i;
      expect((await b.admit('r1', exp, true, morning, null, P)).ok).toBe(true);
      await b.releaseLive(exp, morning);
    }
    expect(await b.admit('r1', morning + 700_000, true, morning, null, P)).toMatchObject({ ok: false, reason: 'codes' });
    expect((await b.reserveSend('r1', morning, null, P)).ok).toBe(false);
    expect((await b.reserveSend('r1', morning, null, D)).ok).toBe(true);
    // Wrong codes: a requester locked at production's 10 goes on under the dev set (its lock was production's), up to 30.
    for (let i = 0; i < P.ipWrong.max; i++) expect((await b.reserveGuess('r2', morning, null, P)).ok).toBe(true);
    expect((await b.reserveGuess('r2', morning, null, P)).ok).toBe(false);
    expect((await b.reserveGuess('r2', morning, null, D)).ok).toBe(true);
    // Production's lock still holds under production.
    expect((await b.reserveGuess('r2', morning, null, P)).ok).toBe(false);
    // The backstop: filled to production's 18 by others, a new requester is refused under production, allowed under dev.
    let n = P.ipWrong.max + 1;
    for (let a = 0; n < P.wrongBackstop.max; a++) for (let i = 0; i < P.ipWrong.max - 1 && n < P.wrongBackstop.max; i++, n++) expect((await b.reserveGuess(`x${a}`, morning, null, P)).ok).toBe(true);
    expect((await b.reserveGuess('fresh', morning, null, P)).ok).toBe(false);
    expect((await b.reserveGuess('fresh', morning, null, D)).ok).toBe(true);
  });

  it('a call without a set uses production (the strict default)', async () => {
    const b = await box();
    for (let i = 0; i < MAX_LIVE_CHALLENGES; i++) expect((await b.admit(`r${i}`, morning + 600_000 + i, false, morning)).ok).toBe(true);
    expect(await b.admit('r-next', morning + 600_000, false, morning)).toMatchObject({ ok: false, reason: 'live' });
    expect((await b.admit('r-next', morning + 600_000, false, morning, null, DEV_LIMITS.mailbox as MailboxLimits)).ok).toBe(true);
  });
});
