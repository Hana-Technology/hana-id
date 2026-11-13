// The testnet-only manifest overrides of D793: EMAIL_TIGHTER_LIMITS lowers a few per-IP and per-requester windows and
// never raises one; EMAIL_APP_SHARES gives named apps their own share of the general pool. Absent or malformed, the
// env's limits and the plan-sized shares are exactly as before.
import { describe, expect, it } from 'vitest';
import { DEV_LIMITS, PRODUCTION_LIMITS, appBudgetShare, generalPool, limitsFor, namedAppShare, parseAppShares, parseTighterLimits, tighten, type Limits } from '../src/limits.ts';
import { newChallengeId } from '../src/challenge-id.ts';
import { captureLogs, env, harness, seedApp, sessionCommitment, uid, type Harness, type TestApp } from './helpers.ts';

const maxOf = (limits: readonly { name: string; max: number }[], name: string) => limits.find((l) => l.name === name)!.max;
const startBody = (h: Harness, app: TestApp, email: string) => ({ pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
const start = async (h: Harness, app: TestApp, email: string, ip: string) => (await h.call('/v1/email/start', startBody(h, app, email), { ip })).status;
let ipSeq = Math.floor(Math.random() * 10_000);
const freshIp = () => `10.${Math.floor(ipSeq / 250) % 250}.${ipSeq++ % 250}.11`;
/** A fresh IPv4 /24 of its own: `n` gives its nth address. */
const freshPrefix = () => {
  const p = freshIp().split('.').slice(0, 3).join('.');
  return (n: number) => `${p}.${n}`;
};
const configLines = (lines: string[]) => lines.filter((l) => l.includes('"config_ignored"'));
const addr = (tag: string) => `${tag}${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
const JUDGING = { ipStart: { per10m: 10, perDay: 30 }, ipResend: { per10m: 10 }, mailboxIpCodes: { per15m: 5, perDay: 15 }, aggStart: { perDay: 100 } };

describe('EMAIL_TIGHTER_LIMITS (D793)', () => {
  it('parses only its own windows with whole numbers of at least 1', () => {
    expect(parseTighterLimits(undefined)).toBeNull();
    expect(parseTighterLimits('')).toBeNull();
    expect(parseTighterLimits(JSON.stringify(JUDGING))).toEqual(JUDGING);
    for (const bad of ['{', '[]', 'null', '5', '{"ipVerify":{"per10m":5}}', '{"ipStart":{"per1h":5}}', '{"ipStart":{"perDay":0}}', '{"ipStart":{"perDay":2.5}}', '{"ipStart":{"perDay":"5"}}', '{"ipStart":5}', '{"__proto__":{"perDay":5}}', '{"constructor":{"perDay":5}}', '{"toString":{}}']) {
      expect(parseTighterLimits(bad), bad).toBeNull();
    }
  });

  it('lowers the named windows of the env set, leaves every other limit as it is', () => {
    const t = limitsFor('sandbox-dev', JUDGING);
    expect([maxOf(t.ipStart, 'ip:start:10m'), maxOf(t.ipStart, 'ip:start:1d')]).toEqual([10, 30]);
    expect(maxOf(t.ipResend, 'ip:resend:10m')).toBe(10);
    expect([maxOf(t.mailbox.ipCodes, 'codes:15m'), maxOf(t.mailbox.ipCodes, 'codes:1d')]).toEqual([5, 15]);
    expect(maxOf(t.ipAggStart, 'agg:start:1d')).toBe(100);
    const { ipStart: _s, ipResend: _r, ipAggStart: _a, mailbox, ...rest } = t;
    const { ipStart: _bs, ipResend: _br, ipAggStart: _ba, mailbox: baseMailbox, ...baseRest } = DEV_LIMITS;
    expect(rest).toEqual(baseRest);
    const { ipCodes: _c, ...box } = mailbox;
    const { ipCodes: _bc, ...baseBox } = baseMailbox;
    expect(box).toEqual(baseBox);
    expect(Object.isFrozen(t) && Object.isFrozen(t.mailbox) && Object.isFrozen(t.ipStart[0])).toBe(true);
    // The shared sets are untouched.
    expect(maxOf(DEV_LIMITS.ipStart, 'ip:start:1d')).toBe(300);
    expect(maxOf(DEV_LIMITS.ipAggStart, 'agg:start:1d')).toBe(1000);
  });

  it('never raises a limit: a value above the env set changes nothing', () => {
    const loose = { ipStart: { per10m: 1000, perDay: 10_000 }, ipResend: { per10m: 1000 }, mailboxIpCodes: { per15m: 1000, perDay: 1000 }, aggStart: { perDay: 10_000 } };
    for (const [name, base] of [['sandbox-dev', DEV_LIMITS], ['prod', PRODUCTION_LIMITS]] as [string, Limits][]) {
      expect(limitsFor(name, loose)).toEqual(base);
      expect(tighten(base, {})).toEqual(base);
    }
    // Production's 10 starts in 10 minutes with a dev-sized value: still 10.
    expect(maxOf(limitsFor('prod', JUDGING).ipStart, 'ip:start:10m')).toBe(10);
  });

  it('absent: the env set itself', () => {
    expect(limitsFor('sandbox-dev')).toBe(DEV_LIMITS);
    expect(limitsFor('sandbox-dev', null)).toBe(DEV_LIMITS);
    expect(limitsFor('prod', null)).toBe(PRODUCTION_LIMITS);
  });

  it('applies to start: per IP and per mailbox and requester; without it the dev set passes the same starts', async () => {
    const tight = { ipStart: { per10m: 3 }, mailboxIpCodes: { per15m: 2 } };
    const h = await harness({ env: { ...env, ENV_NAME: `sandbox-t${uid()}`, EMAIL_TIGHTER_LIMITS: JSON.stringify(tight) } });
    const app = await seedApp(h);
    const ip = freshIp();
    expect([await start(h, app, addr('a'), ip), await start(h, app, addr('b'), ip), await start(h, app, addr('c'), ip), await start(h, app, addr('d'), ip)]).toEqual([202, 202, 202, 429]);
    // One address from one requester: the second code mail in 15 minutes passes, the third is refused.
    const one = addr('e');
    const ip2 = freshIp();
    expect([await start(h, app, one, ip2), await start(h, app, one, ip2), await start(h, app, one, ip2)]).toEqual([202, 202, 429]);
    // The same steps on a dev env without the var: all pass.
    const plain = await harness({ env: { ...env, ENV_NAME: `sandbox-p${uid()}` } });
    const app2 = await seedApp(plain);
    const ip3 = freshIp();
    const out: number[] = [];
    for (const tag of ['a', 'b', 'c', 'd']) out.push(await start(plain, app2, addr(tag), ip3));
    const two = addr('f');
    const ip4 = freshIp();
    for (let i = 0; i < 3; i++) out.push(await start(plain, app2, two, ip4));
    expect(out).toEqual(Array<number>(7).fill(202));
  });

  it('applies to start: the per-IP day, the per-address day from one requester and the /24 day', async () => {
    const h = await harness({ env: { ...env, ENV_NAME: `sandbox-d${uid()}`, EMAIL_TIGHTER_LIMITS: JSON.stringify({ ipStart: { perDay: 3 }, mailboxIpCodes: { perDay: 2 }, aggStart: { perDay: 4 } }) } });
    const app = await seedApp(h);
    // The per-IP day: 3 starts across the day (spaced past every 10-minute and 15-minute window), the 4th refused.
    const ip = freshIp();
    const perIp: number[] = [];
    for (const tag of ['a', 'b', 'c', 'd']) {
      perIp.push(await start(h, app, addr(tag), ip));
      h.clock.now += 20 * 60_000;
    }
    expect(perIp).toEqual([202, 202, 202, 429]);
    // One address from one requester: 2 code mails a day, the third refused, though 15 minutes apart.
    const one = addr('e');
    const ip2 = freshIp();
    const perAddress: number[] = [];
    for (let i = 0; i < 3; i++) {
      perAddress.push(await start(h, app, one, ip2));
      h.clock.now += 20 * 60_000;
    }
    expect(perAddress).toEqual([202, 202, 429]);
    // One /24, each start from another address in it: 4 a day, the 5th refused.
    const at = freshPrefix();
    const perPrefix: number[] = [];
    for (let i = 1; i <= 5; i++) perPrefix.push(await start(h, app, addr(`p${i}`), at(i)));
    expect(perPrefix).toEqual([202, 202, 202, 202, 429]);
  });

  it('applies to resend per IP', async () => {
    const h = await harness({ env: { ...env, ENV_NAME: `sandbox-r${uid()}`, EMAIL_TIGHTER_LIMITS: JSON.stringify({ ipResend: { per10m: 2 } }) } });
    const ip = freshIp();
    // Unknown challenges: the IP window counts before the lookup (410), so the 429 is the IP limit's.
    for (let i = 0; i < 2; i++) expect((await h.call('/v1/email/resend', { challengeId: newChallengeId().id }, { ip })).status).toBe(410);
    expect((await h.call('/v1/email/resend', { challengeId: newChallengeId().id }, { ip })).status).toBe(429);
  });

  it('a malformed var is ignored (the env set applies) and logged once, by name only', async () => {
    const bad = '{"ipStart":{"per10m":0}}';
    const h = await harness({ env: { ...env, ENV_NAME: `sandbox-m${uid()}`, EMAIL_TIGHTER_LIMITS: bad } });
    const app = await seedApp(h);
    const ip = freshIp();
    const { result, lines } = await captureLogs(async () => {
      const out: number[] = [];
      for (const tag of ['a', 'b', 'c', 'd']) out.push(await start(h, app, addr(tag), ip));
      return out;
    });
    expect(result).toEqual([202, 202, 202, 202]);
    const ignored = configLines(lines);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain('"code":"EMAIL_TIGHTER_LIMITS:malformed"');
    expect(ignored[0]).toContain('"level":"warn"');
    expect(ignored[0]).not.toContain('per10m');
  });
});

describe('EMAIL_APP_SHARES (D793)', () => {
  it('parses app ids to whole mails; anything malformed gives no named share at all', () => {
    expect(parseAppShares(undefined)?.size).toBe(0);
    expect(parseAppShares('{}')?.size).toBe(0);
    expect([...(parseAppShares('{"app_abc":250,"app_x-y":3}') ?? [])]).toEqual([['app_abc', 250], ['app_x-y', 3]]);
    for (const bad of ['{', '[]', 'null', '{"abc":3}', '{"app_a":0}', '{"app_a":1.5}', '{"app_a":"3"}', '{"app_a":3,"b":4}', '{"__proto__":3}']) expect(parseAppShares(bad), bad).toBeNull();
  });

  it('a named share is capped at the general pool and is at least 1', () => {
    expect(namedAppShare(250, 330)).toBe(250);
    expect(namedAppShare(1000, 330)).toBe(generalPool(330));
    expect(namedAppShare(0, 330)).toBe(1);
  });

  it('replaces the named app’s plan-sized share only; other apps keep theirs', async () => {
    // Budget 40: general pool 35 (staff 5). A free-plan app's share is 2% of 5000 = 100, capped at 35.
    expect(appBudgetShare(5000, 40)).toBe(35);
    const h = await harness({ env: { ...env, ENV_NAME: `t-share${uid()}`, DAILY_SEND_BUDGET: '40' } });
    const named = await seedApp(h);
    const other = await seedApp(h);
    h.deps.env.EMAIL_APP_SHARES = JSON.stringify({ [named.id]: 3 });
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push(await start(h, named, addr(`n${i}`), freshIp()));
    expect(out).toEqual([202, 202, 202, 429]);
    for (let i = 0; i < 4; i++) expect(await start(h, other, addr(`o${i}`), freshIp())).toBe(202);
  });

  it('keeps the 80% reserve rule: a named app past half its share stops at the line, an app under half goes on', async () => {
    // Budget 40: general pool 35, its last 20% from 28. The named app's share 30 (half: 15).
    const h = await harness({ env: { ...env, ENV_NAME: `t-reserve${uid()}`, DAILY_SEND_BUDGET: '40' } });
    const named = await seedApp(h);
    const other = await seedApp(h);
    h.deps.env.EMAIL_APP_SHARES = JSON.stringify({ [named.id]: 30 });
    const out: number[] = [];
    for (let i = 0; i < 29; i++) out.push(await start(h, named, addr(`r${i}`), freshIp()));
    expect(out).toEqual([...Array<number>(28).fill(202), 429]);
    expect(await start(h, other, addr('u'), freshIp())).toBe(202);
  });

  it('only on testnet: elsewhere the var is ignored, the plan share applies, and that is logged once by name', async () => {
    const h = await harness({ env: { ...env, ENV_NAME: `t-net${uid()}`, DAILY_SEND_BUDGET: '40', NEAR_NETWORK: 'mainnet' } });
    const app = await seedApp(h);
    h.deps.env.EMAIL_APP_SHARES = JSON.stringify({ [app.id]: 1 });
    const { result, lines } = await captureLogs(async () => [await start(h, app, addr('m1'), freshIp()), await start(h, app, addr('m2'), freshIp())]);
    // With the named share of 1 the second would be refused; ignored, the plan's share (35) lets both through.
    expect(result).toEqual([202, 202]);
    const ignored = configLines(lines);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain('"code":"EMAIL_APP_SHARES:not_testnet"');
    expect(ignored[0]).not.toContain(app.id);
  });

  it('a malformed var gives every app its plan share and is logged once by name', async () => {
    const h = await harness({ env: { ...env, ENV_NAME: `t-bad${uid()}`, DAILY_SEND_BUDGET: '40', EMAIL_APP_SHARES: '{"app_x":0}' } });
    const app = await seedApp(h);
    const { result, lines } = await captureLogs(async () => [await start(h, app, addr('b1'), freshIp()), await start(h, app, addr('b2'), freshIp())]);
    expect(result).toEqual([202, 202]);
    const ignored = configLines(lines);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain('"code":"EMAIL_APP_SHARES:malformed"');
    expect(ignored[0]).not.toContain('app_x');
  });
});
