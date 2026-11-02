// The review fixes (D198, D199): requester aggregates and the missing-IP refusal, the recipient-domain cap, owner
// device tickets, per-purpose mail texts, link_account end to end, the complaint-rate log and the webhook's header
// checks before the body.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { toHex, utf8, base64Encode } from '../src/bytes.ts';
import { isExemptDomain, registrableDomain } from '../src/domain.ts';
import { ipAggregates } from '../src/ip.ts';
import { DEVICE_TICKET_TTL_MS, deviceTicket, domainKey, isDeviceTicketFor, mailboxKey, readDeviceTicket, suppressionKey } from '../src/keys.ts';
import { DOMAIN_SENDS_BASE, DOMAIN_SENDS_MAX, MAILBOX_GRANT_SLOT, MAILBOX_OWNER_SLOT, MAILBOX_TICKET_SLOT, MAILBOX_WRONG_BACKSTOP, MAILBOX_WRONG_CEILING } from '../src/limits.ts';
import { linkAccountPreimage, nonceOf } from '../src/layouts.ts';
import { codeMail } from '../src/mail.ts';
import { captureLogs, decodeToken, env, harness, mailboxObject, seedApp, seedPlan, sessionCommitment, uid, type Harness, type TestApp } from './helpers.ts';

const startBody = (h: Harness, app: TestApp, email: string, extra: Record<string, unknown> = {}) => ({ pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json, ...extra });
const morning = Date.UTC(2027, 1, 3, 8, 0, 0);

describe('requesters: aggregates and a missing address (H1, L4)', () => {
  it('aggregate prefixes: IPv4 /24, IPv6 /56 and /48; mapped IPv6 counts as IPv4', () => {
    expect(ipAggregates('203.0.113.7')).toEqual(['v4net:203.0.113.0/24']);
    expect(ipAggregates('2001:db8:aa:bbcc:1::1')).toEqual(['v6net:2001:db8:aa:bb00::/56', 'v6net:2001:db8:aa::/48']);
    expect(ipAggregates('::ffff:203.0.113.7')).toEqual(['v4net:203.0.113.0/24']);
    expect(ipAggregates(null)).toEqual([]);
  });

  it('a /48 gets 1000 starts a day, whatever its /64s; a valid device ticket skips the prefix limits (M2)', async () => {
    const h = await harness();
    h.clock.now = morning;
    const app = await seedApp(h);
    // The owner signed in once from elsewhere: a ticket.
    const owner = `o${uid().replace(/[^a-z0-9]/gu, '')}@gmail.com`;
    const s0 = (await (await h.call('/v1/email/start', startBody(h, app, owner), { ip: '192.0.2.70' })).json()) as { challengeId: string };
    const v0 = (await (await h.call('/v1/email/verify', { challengeId: s0.challengeId, code: h.sender.codeFor(owner) }, { ip: '192.0.2.70' })).json()) as { deviceTicket: string };
    // 2001:db8:77::/48 has used 998 of its 1000 today (its /56s are each fresh).
    const day = Date.UTC(2027, 1, 3);
    const agg = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${h.deps.env.ENV_NAME}:ip:v6net:2001:db8:77::/48`));
    await runInDurableObject(agg, (_o, state) => state.storage.kv.put(`agg:start:1d@${day}`, 998));
    let ok = 0;
    for (let i = 0; i < 5; i++) {
      const ip = `2001:db8:77:${(i * 256).toString(16)}::1`;
      if ((await h.call('/v1/email/start', startBody(h, app, `p${i}${uid()}@gmail.com`), { ip })).status === 202) ok++;
    }
    expect(ok).toBe(2);
    // The owner, from inside the full /48: its ticket is checked first and skips the prefix limits.
    const ip = '2001:db8:77:5500::1';
    expect((await h.call('/v1/email/start', startBody(h, app, owner), { ip })).status).toBe(429);
    expect((await h.call('/v1/email/start', startBody(h, app, owner, { deviceTicket: v0.deviceTicket }), { ip })).status).toBe(202);
  });

  it('refuses a request without a client address on every IP-limited route, logged (fail closed)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const { result, lines } = await captureLogs(() => h.call('/v1/email/start', startBody(h, app, 'x@example.com'), { ip: null }));
    expect(result.status).toBe(400);
    expect(((await result.json()) as { code: string }).code).toBe('missing_client_ip');
    expect(lines.some((l) => l.includes('"missing_client_ip"'))).toBe(true);
    for (const path of ['/v1/email/resend', '/v1/email/verify']) expect((await h.call(path, { challengeId: 'A'.repeat(43), code: '123456' }, { ip: null })).status).toBe(400);
    expect((await h.call('/v1/email/start', startBody(h, app, 'x@example.com'), { ip: 'not-an-ip' })).status).toBe(400);
    expect(h.sender.sent).toHaveLength(0);
  });
});

describe('the recipient-domain cap (H1, M4)', () => {
  it('registrable domains (PSL), and the exempt providers', () => {
    expect(registrableDomain('a.b.victim.example')).toBe('victim.example');
    expect(registrableDomain('mail.example.co.uk')).toBe('example.co.uk');
    for (const d of ['gmail.com', 'outlook.com', 'gmx.de', 'yandex.ru', 'proton.me', '163.com']) expect(isExemptDomain(registrableDomain(d))).toBe(true);
    expect(isExemptDomain(registrableDomain('gmx.attacker.example'))).toBe(false);
  });

  it('100 code mails a day per registrable domain, subdomains together; an exempt provider is not capped', async () => {
    const h = await harness();
    h.clock.now = morning;
    const apps = await Promise.all(Array.from({ length: 3 }, () => seedApp(h)));
    let ok = 0;
    for (let i = 0; i < 103; i++) {
      const r = await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `u${i}@s${i % 7}.catchall.example`));
      if (r.status === 202) ok++;
      else {
        expect(r.status).toBe(429);
        expect(r.headers.get('retry-after')).toBe('900');
      }
      if (i % 50 === 49) h.clock.now += 60_000;
    }
    expect(ok).toBe(100);
    expect((await h.call('/v1/email/start', startBody(h, apps[0]!, `z${uid()}@gmail.com`))).status).toBe(202);
  });
});

describe('the recipient-domain cap: per-prefix shares, ticketed starts, the log (scan finding 2)', () => {
  it('one /24 gets at most 20% of a domain’s day; other requesters still get the rest; email_domain_cap at the cap', async () => {
    const h = await harness();
    h.clock.now = morning;
    const apps = await Promise.all(Array.from({ length: 3 }, () => seedApp(h)));
    const dom = `corp${uid().replace(/[^a-z0-9]/gu, '')}.example`;
    let fromOne = 0;
    // One /24 (distinct addresses inside it, so the per-IP limit doesn't bite first).
    for (let i = 0; i < 25; i++) if ((await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `a${i}@${dom}`), { ip: `203.0.113.${i + 1}` })).status === 202) fromOne++;
    expect(fromOne).toBe(20);
    // An IPv6 /48 likewise, whatever its /56s.
    let fromV6 = 0;
    for (let i = 0; i < 25; i++) if ((await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `b${i}@${dom}`), { ip: `2001:db8:99:${(i * 256).toString(16)}::1` })).status === 202) fromV6++;
    expect(fromV6).toBe(20);
    // Others fill the rest: 100 in all, and the mail that fills the day is logged.
    let rest = 0;
    const { lines } = await captureLogs(async () => {
      for (let i = 0; i < 70; i++) if ((await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `c${i}@${dom}`), { ip: `10.${77 + Math.floor(i / 200)}.${i}.1` })).status === 202) rest++;
    });
    expect(rest).toBe(60);
    expect(lines.filter((l) => l.includes('"email_domain_cap"'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(dom);
  });

  it('a ticketed start skips the domain cap: a filled company domain never locks its owners out', async () => {
    const h = await harness();
    h.clock.now = morning;
    const apps = await Promise.all(Array.from({ length: 3 }, () => seedApp(h)));
    const dom = `full${uid().replace(/[^a-z0-9]/gu, '')}.example`;
    const a = `owner@${dom}`;
    const s0 = (await (await h.call('/v1/email/start', startBody(h, apps[0]!, a), { ip: '192.0.2.60' })).json()) as { challengeId: string };
    const v0 = (await (await h.call('/v1/email/verify', { challengeId: s0.challengeId, code: h.sender.codeFor(a) }, { ip: '192.0.2.60' })).json()) as { deviceTicket: string };
    // Fill the domain's day (its cap: 100 + 2 for the owner's verified login, which also gave its own place back).
    let n = 0;
    for (let i = 0; i < 200; i++) {
      if ((await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `x${i}@${dom}`), { ip: `10.${90 + Math.floor(i / 200)}.${i}.1` })).status !== 202) break;
      n++;
    }
    expect(n).toBe(102);
    expect((await h.call('/v1/email/start', startBody(h, apps[0]!, a), { ip: '192.0.2.61' })).status).toBe(429);
    const s = await h.call('/v1/email/start', startBody(h, apps[0]!, a, { deviceTicket: v0.deviceTicket }), { ip: '192.0.2.61' });
    expect(s.status).toBe(202);
    const cid = ((await s.json()) as { challengeId: string }).challengeId;
    // Its resend skips the domain cap too.
    h.clock.now += 31_000;
    expect((await h.call('/v1/email/resend', { challengeId: cid }, { ip: '192.0.2.61' })).status).toBe(202);
  });
});

describe('owner device tickets (D198, M1)', () => {
  it('opaque, bound to the mailbox, 30 days', async () => {
    const h = await harness();
    const keys = await h.deps.keys();
    const mine = await mailboxKey(keys, 'owner@example.com');
    const other = await mailboxKey(keys, 'other@example.com');
    const t = await deviceTicket(keys, mine, morning);
    expect(t).toMatch(/^dt2\.[A-Za-z0-9_-]{75}$/u);
    expect(await isDeviceTicketFor(keys, t, mine, morning + 1)).toBe(true);
    expect(await isDeviceTicketFor(keys, t, other, morning + 1)).toBe(false);
    expect(await isDeviceTicketFor(keys, t, mine, morning + DEVICE_TICKET_TTL_MS + 1)).toBe(false);
    expect(await isDeviceTicketFor(keys, `${t.slice(0, -2)}AA`, mine, morning + 1)).toBe(false);
    expect(await isDeviceTicketFor(keys, 'dt2.x', mine, morning)).toBe(false);
    // Two tickets for one address are distinct (a nonce each).
    expect(await deviceTicket(keys, mine, morning)).not.toBe(t);
  });

  it('a drained mailbox still gives its owner 3 codes a day with a ticket; nobody else qualifies', async () => {
    const h = await harness();
    h.clock.now = morning;
    const apps = await Promise.all(Array.from({ length: 2 }, () => seedApp(h)));
    const a = `d${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
    // The owner signed in once: a ticket.
    const s0 = (await (await h.call('/v1/email/start', startBody(h, apps[0]!, a), { ip: '192.0.2.50' })).json()) as { challengeId: string };
    const v0 = (await (await h.call('/v1/email/verify', { challengeId: s0.challengeId, code: h.sender.codeFor(a) }, { ip: '192.0.2.50' })).json()) as { deviceTicket: string };
    // An attacker drains the mailbox's code allowance (30 + the 5-a-day reserve) from many /24s, without ever reading a
    // code (so without a ticket): its challenges just expire.
    let drained = 1;
    for (let i = 0; i < 200 && drained < 35; i++) {
      const s = await h.call('/v1/email/start', startBody(h, apps[i % 2]!, a), { ip: `10.${100 + Math.floor(i / 200)}.${i % 200}.1` });
      if (s.status !== 202) {
        h.clock.now += 10 * 60_000 + 1;
        continue;
      }
      drained++;
    }
    expect(drained).toBe(35);
    const owner = '192.0.2.51';
    expect((await h.call('/v1/email/start', startBody(h, apps[0]!, a), { ip: owner })).status).toBe(429);
    // A ticket for another mailbox, or a forged one, doesn't help.
    const keys = await h.deps.keys();
    const foreign = await deviceTicket(keys, await mailboxKey(keys, 'other@example.com'), h.clock.now);
    expect((await h.call('/v1/email/start', startBody(h, apps[0]!, a, { deviceTicket: foreign }), { ip: owner })).status).toBe(429);
    // The owner's ticket: three codes today, and each verifies.
    for (let i = 0; i < 3; i++) {
      const s = await h.call('/v1/email/start', startBody(h, apps[0]!, a, { deviceTicket: v0.deviceTicket }), { ip: owner });
      expect(s.status).toBe(202);
      const cid = ((await s.json()) as { challengeId: string }).challengeId;
      expect((await h.call('/v1/email/verify', { challengeId: cid, code: h.sender.codeFor(a) }, { ip: owner })).status).toBe(200);
    }
    expect((await h.call('/v1/email/start', startBody(h, apps[0]!, a, { deviceTicket: v0.deviceTicket }), { ip: owner })).status).toBe(429);
  });
});

describe('per-purpose mail texts (tokens review M1)', () => {
  it('each purpose has its own subject and body; no code in a subject, no link in a code mail', () => {
    const want: Record<string, [string, string]> = {
      session: ['Your sign-in code for Wallet', 'sign in to “Wallet”'],
      link_new: ['Your code to add this email to your wallet in Wallet', 'add this email as a sign-in method of your wallet in “Wallet”'],
      link_account: ['Your code to allow another sign-in method in Wallet', 'allow another sign-in method to open the wallet this email opens in “Wallet”'],
      link_change: ['Your code to remove a sign-in method in Wallet', 'remove or cancel a sign-in method of the wallet this email opens in “Wallet”'],
      auto_link: ['Your code to link your Google sign-in in Wallet', 'link your Google sign-in to the wallet this email opens in “Wallet”'],
    };
    const subjects = new Set<string>();
    for (const [purpose, [subject, what]] of Object.entries(want)) {
      const m = codeMail({ to: 'a@example.com', code: '482913', appName: 'Wallet', authOrigin: 'https://auth.test', purpose: purpose as never });
      expect(m.subject).toBe(subject);
      expect(m.text).toContain(`Your code to ${what} with Hana:`);
      expect(m.subject).not.toContain('482913');
      expect(m.text).not.toMatch(/https?:\/\//u);
      subjects.add(m.subject);
      const unsafe = codeMail({ to: 'a@example.com', code: '482913', appName: 'Wa‮llet', authOrigin: 'https://auth.test', purpose: purpose as never });
      expect(unsafe.subject).not.toContain('Wa');
      expect(unsafe.subject).not.toMatch(/ (?:for|in)$/u);
    }
    expect(subjects.size).toBe(5);
  });
});

describe('link_account end to end', () => {
  it('start with the link_account commitment, the mail says so, verify mints the token with that nonce', async () => {
    const h = await harness();
    const app = await seedApp(h, { name: 'Wallet' });
    const email = `la${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
    const rootIk = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const newIk = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const salt = [...crypto.getRandomValues(new Uint8Array(16))];
    const s = await h.call('/v1/email/start', { pk: app.pk, email, purpose: 'link_account', commitment: { scopeId: app.scope, rootIk, newIk, epoch: 2, salt } });
    expect(s.status).toBe(202);
    const mail = h.sender.to(email)[0]!;
    expect(mail.subject).toBe('Your code to allow another sign-in method in Wallet');
    const { challengeId } = (await s.json()) as { challengeId: string };
    const v = await h.call('/v1/email/verify', { challengeId, code: h.sender.codeFor(email) });
    expect(v.status).toBe(200);
    const body = (await v.json()) as { idToken: string; deviceTicket: string };
    const t = await decodeToken(body.idToken);
    const hex = (x: string) => Uint8Array.from(x.match(/../gu)!.map((b) => parseInt(b, 16)));
    expect(t.claims.nonce).toBe(nonceOf(linkAccountPreimage(env.SIGNER_ACCOUNT, app.scope, hex(rootIk), hex(newIk), 2, Uint8Array.from(salt))));
    expect(body.deviceTicket).toMatch(/^dt2\./u);
  });
});

describe('the webhook (L5, M4)', () => {
  const toDer = (p1363: Uint8Array): Uint8Array => {
    const int = (b: Uint8Array) => {
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      const v = b.subarray(i);
      return v[0]! & 0x80 ? Uint8Array.of(0x02, v.length + 1, 0, ...v) : Uint8Array.of(0x02, v.length, ...v);
    };
    const r = int(p1363.subarray(0, 32));
    const s = int(p1363.subarray(32));
    return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
  };

  it('refuses bad headers before reading the body; logs email_complaint_rate past 5 complaints in 24 h', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = base64Encode(new Uint8Array((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer));
    const h = await harness();
    h.deps = { ...h.deps, env: { ...h.deps.env, SENDGRID_WEBHOOK_PUBLIC_KEY: spki } };
    const ts = String(Math.floor(h.clock.now / 1000));
    let bodyRead = false;
    const stream = new ReadableStream({
      pull(c) {
        bodyRead = true;
        c.enqueue(utf8('[]'));
        c.close();
      },
    }, { highWaterMark: 0 });
    const { route } = await import('../src/handlers.ts');
    const res = await route(new Request('https://api.test/v1/email/webhooks/sendgrid', { method: 'POST', body: stream, headers: { 'cf-connecting-ip': '198.51.100.1', 'x-twilio-email-event-webhook-timestamp': 'abc', 'x-twilio-email-event-webhook-signature': 'zz' }, duplex: 'half' } as RequestInit), h.deps);
    expect(res.status).toBe(401);
    expect(bodyRead).toBe(false);
    const send = async (events: unknown[]) => {
      const body = JSON.stringify(events);
      const sig = base64Encode(toDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(ts + body)))));
      return route(new Request('https://api.test/v1/email/webhooks/sendgrid', { method: 'POST', body, headers: { 'cf-connecting-ip': '198.51.100.1', 'x-twilio-email-event-webhook-timestamp': ts, 'x-twilio-email-event-webhook-signature': sig } }), h.deps);
    };
    const { lines } = await captureLogs(async () => {
      const r = await send(Array.from({ length: 6 }, (_, i) => ({ event: 'spamreport', email: `c${i}${uid()}@example.com`, category: ['hana-id-code'] })));
      expect(r.status).toBe(200);
    });
    expect(lines.some((l) => l.includes('"email_complaint_rate"') && l.includes('"level":"error"'))).toBe(true);
    void suppressionKey;
  });
});

describe('the owner’s recovery never depends on a pool an attacker can fill (abuse re-check)', () => {
  const ticketFor = async (h: Harness, app: TestApp, a: string, ip = '192.0.2.80') => {
    const s0 = (await (await h.call('/v1/email/start', startBody(h, app, a), { ip })).json()) as { challengeId: string };
    return ((await (await h.call('/v1/email/verify', { challengeId: s0.challengeId, code: h.sender.codeFor(a) }, { ip })).json()) as { deviceTicket: string }).deviceTicket;
  };

  it('H1: an app’s share spent by someone else, the ticket holder still gets mail from the owner pool', async () => {
    const h = await harness();
    h.clock.now = morning;
    const plan = `o${uid().replace(/[^a-z0-9]/gu, '')}`;
    await seedPlan(plan, 600, 100);
    const app = await seedApp(h, { plan });
    const owner = `w${uid().replace(/[^a-z0-9]/gu, '')}@gmail.com`;
    const ticket = await ticketFor(h, app, owner);
    // An attacker spends the rest of the app's share (10) on other addresses.
    for (let i = 0; i < 9; i++) expect((await h.call('/v1/email/start', startBody(h, app, `z${i}${uid()}@gmail.com`))).status).toBe(202);
    expect((await h.call('/v1/email/start', startBody(h, app, `z9${uid()}@gmail.com`))).status).toBe(429);
    expect((await h.call('/v1/email/start', startBody(h, app, owner))).status).toBe(429);
    expect((await h.call('/v1/email/start', startBody(h, app, owner, { deviceTicket: ticket }))).status).toBe(202);
    expect(h.sender.to(owner).filter((m) => m.kind === 'code')).toHaveLength(2);
  });

  it('H1: a non-local env without dailySendBudget sends nothing and says why (no silent default)', async () => {
    const h = await harness({ env: { ...env, ENV_NAME: `sandbox-x${uid()}`, DAILY_SEND_BUDGET: undefined } });
    const app = await seedApp(h);
    const { result, lines } = await captureLogs(() => h.call('/v1/email/start', startBody(h, app, `q${uid()}@gmail.com`)));
    expect(result.status).toBe(429);
    expect(lines.some((l) => l.includes('"send_budget_exhausted"') && l.includes('"code":"unconfigured"'))).toBe(true);
    expect(h.sender.sent).toHaveLength(0);
  });

  it('M1: the domain cap grows by 2 per distinct verified mailbox a day over 7 days, to at most 2000; a verified challenge gives its place back', async () => {
    const h = await harness();
    h.clock.now = morning;
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${h.deps.env.ENV_NAME}:dom:unit-${uid()}`));
    const first = await stub.reserveDomain([], morning);
    expect(first.ok && first.cap).toBe(DOMAIN_SENDS_BASE);
    const verifyOne = async (mbx: string) => {
      const d = await stub.reserveDomain([], morning);
      if (!d.ok) throw new Error('domain full');
      await stub.domainVerified([d.reservation], mbx, morning);
    };
    for (let i = 0; i < 10; i++) await verifyOne(`mbx-${i}`);
    // The same mailbox again, and a challenge that reserved no domain place (an owner's): no growth (scan).
    for (let i = 0; i < 5; i++) await verifyOne('mbx-0');
    await stub.domainVerified([], 'mbx-new', morning);
    const grown = await stub.reserveDomain([], morning);
    expect(grown.ok && grown.cap).toBe(DOMAIN_SENDS_BASE + 20);
    // A prefix's share follows the cap (20% of 120).
    let fromOne = 0;
    for (let i = 0; i < 30; i++) if ((await stub.reserveDomain(['p1'], morning)).ok) fromOne++;
    expect(fromOne).toBe(24);
    // Eight days on, those logins no longer count.
    const later = await stub.reserveDomain([], morning + 8 * 86_400_000);
    expect(later.ok && later.cap).toBe(DOMAIN_SENDS_BASE);
    // The hard ceiling: however many logins, 2000 a day.
    const big = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${h.deps.env.ENV_NAME}:dom:big-${uid()}`));
    await runInDurableObject(big, (_o, state) => state.storage.kv.put(`verified@${Date.UTC(2027, 1, 3)}`, 5000));
    const capped = await big.reserveDomain([], morning);
    expect(capped.ok && capped.cap).toBe(DOMAIN_SENDS_MAX);
    // Through the routes: a verified login's place comes back.
    const app = await seedApp(h);
    const dom = `v${uid().replace(/[^a-z0-9]/gu, '')}.example`;
    const a = `x@${dom}`;
    const s = (await (await h.call('/v1/email/start', startBody(h, app, a))).json()) as { challengeId: string };
    const dk = await domainKey(await h.deps.keys(), dom);
    const dstub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${h.deps.env.ENV_NAME}:dom:${dk}`));
    const day = Date.UTC(2027, 1, 3);
    const count = () => runInDurableObject(dstub, (_o, state) => state.storage.kv.get<number>(`domain:sends:1d@${day}`) ?? 0);
    expect(await count()).toBe(1);
    expect((await h.call('/v1/email/verify', { challengeId: s.challengeId, code: h.sender.codeFor(a) })).status).toBe(200);
    expect(await count()).toBe(0);
    expect(await runInDurableObject(dstub, (_o, state) => state.storage.kv.get<number>(`verified@${day}`))).toBe(1);
  });

  it('M1: the regional variants of the large providers are exempt', () => {
    for (const d of ['mail.yahoo.co.jp', 'yahoo.co.uk', 'hotmail.co.uk', 'outlook.de', 'live.fr', 'web.de', 't-online.de', 'naver.com', '126.com', 'yeah.net', 'foxmail.com', 'comcast.net', 'orange.fr', 'free.fr', 'libero.it', 'pm.me', 'fastmail.com']) {
      expect(isExemptDomain(registrableDomain(d))).toBe(true);
    }
    expect(isExemptDomain(registrableDomain('outlook.attacker.example'))).toBe(false);
  });

  it('tickets: bound to the exact address (not its +tag siblings), allowances per ticket', async () => {
    const h = await harness();
    h.clock.now = morning;
    const app = await seedApp(h);
    const base = `t${uid().replace(/[^a-z0-9]/gu, '')}`;
    const plain = `${base}@gmail.com`;
    const tagged = `${base}+x@gmail.com`;
    const ticket = await ticketFor(h, app, tagged);
    const keys = await h.deps.keys();
    expect(await readDeviceTicket(keys, ticket, await suppressionKey(keys, tagged), h.clock.now)).not.toBeNull();
    expect(await readDeviceTicket(keys, ticket, await suppressionKey(keys, plain), h.clock.now)).toBeNull();
    // Many tickets of one address share its 3 code mails a day (scan: re-verifying can't multiply them).
    const box = await mailboxObject(h, plain);
    const addrKey = await suppressionKey(keys, plain);
    const claim = (id: string) => ({ kind: 'ticket' as const, id, addrKey, issuedAtMs: morning });
    for (const id of ['one', 'two', 'three']) await box.registerTicket(addrKey, id, morning, morning);
    const sends = async (id: string) => {
      let n = 0;
      for (let i = 0; i < 5; i++) if ((await box.admit(`r${id}${i}`, morning + 600_000, true, morning, claim(id))).ok) n++;
      return n;
    };
    expect((await sends('one')) + (await sends('two')) + (await sends('three'))).toBe(3);
    // An unregistered ticket (forged id, or pushed out) counts as nothing.
    expect(await box.checkOwner(claim('never-issued'), morning)).toBe(false);
  });

  it('tickets: at most 5 live per address, a 6th revokes the oldest; at most 10 ticket challenges per address a day', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const a = `l${uid().replace(/[^a-z0-9]/gu, '')}@gmail.com`;
    const tickets: string[] = [];
    for (let i = 0; i < 6; i++) tickets.push(await ticketFor(h, app, a, `192.0.2.${100 + i}`));
    const keys = await h.deps.keys();
    const addrKey = await suppressionKey(keys, a);
    const box = await mailboxObject(h, a);
    const live = async (t: string) => {
      const info = (await readDeviceTicket(keys, t, addrKey, h.clock.now))!;
      return box.checkOwner({ kind: 'ticket', id: info.id, addrKey, issuedAtMs: info.issuedAtMs }, h.clock.now);
    };
    expect(await live(tickets[0]!)).toBe(false);
    for (const t of tickets.slice(1)) expect(await live(t)).toBe(true);
    // The owner-challenge cap: 10 a day per mailbox, then a ticket counts as nothing.
    const info = (await readDeviceTicket(keys, tickets[5], addrKey, h.clock.now))!;
    const claim = { kind: 'ticket' as const, id: info.id, addrKey, issuedAtMs: info.issuedAtMs };
    let owners = 0;
    for (let i = 0; i < 12; i++) {
      const adm = await box.admit(`o${i}`, h.clock.now + 600_000, false, h.clock.now, claim);
      if (adm.ok && adm.owner) owners++;
    }
    expect(owners).toBe(10);
  });

  it('final check M1: past half the owner pool, fresh (sock-puppet) tickets fall back to the general pool; aged ones and grants keep it; logged', async () => {
    const h = await harness();
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${h.deps.env.ENV_NAME}:global`));
    // Budget 20: the owner pool, 20, beside the general pool (15 here, after the staff pool's 5).
    let fresh = 0;
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await stub.reserveBudget(`x${i % 2}`, 20, 2, 'owner', morning);
      if (r.ok) {
        fresh++;
        lines.push(...r.crossed);
      }
    }
    // Half the owner pool (10), then only the apps' general shares (2 each): fresh tickets can't fill the rest.
    expect(fresh).toBe(10 + 4);
    expect(lines).toContain('owner_50');
    // The aged real tickets (and grants) still get the other half.
    let aged = 0;
    for (let i = 0; i < 15; i++) if ((await stub.reserveBudget('x0', 20, 2, 'owner_aged', morning)).ok) aged++;
    expect(aged).toBe(10);
    // Through start: the crossing is logged as email_owner_pool.
    const h2 = await harness({ env: { ...env, ENV_NAME: `op-${uid()}`, DAILY_SEND_BUDGET: '12' } });
    h2.clock.now = morning;
    const app = await seedApp(h2);
    const a = `op${uid().replace(/[^a-z0-9]/gu, '')}@gmail.com`;
    const ticket = await ticketFor(h2, app, a, '192.0.2.120');
    // The owner pool (12) has 5 used: the next owner mail reaches half.
    const g2 = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${h2.deps.env.ENV_NAME}:global`));
    await runInDurableObject(g2, (_o, state) => state.storage.kv.put(`budget-owner@${Date.UTC(2027, 1, 3)}`, 5));
    const { lines: logs } = await captureLogs(() => h2.call('/v1/email/start', startBody(h2, app, a, { deviceTicket: ticket }), { ip: '192.0.2.121' }));
    expect(logs.some((l) => l.includes('"email_owner_pool"') && l.includes('"code":"owner_50"'))).toBe(true);
  });

  it('a ticket revoked after its challenge started gets no owner path on resend: domain cap and general budget apply (scan)', async () => {
    const h = await harness();
    h.clock.now = morning;
    const apps = await Promise.all(Array.from({ length: 3 }, () => seedApp(h)));
    const app = apps[0]!;
    const dom = `rv${uid().replace(/[^a-z0-9]/gu, '')}.example`;
    const a = `owner@${dom}`;
    const ticket = await ticketFor(h, app, a, '192.0.2.90');
    // Fill the domain's day from other requesters (three apps, so no app's minute refuses first).
    let filled = 0;
    for (let i = 0; i < 200; i++) {
      if ((await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `f${i}@${dom}`), { ip: `10.${120 + Math.floor(i / 200)}.${i}.1` })).status !== 202) break;
      filled++;
    }
    expect(filled).toBe(102);
    const s = await h.call('/v1/email/start', startBody(h, app, a, { deviceTicket: ticket }), { ip: '192.0.2.91' });
    expect(s.status).toBe(202);
    const cid = ((await s.json()) as { challengeId: string }).challengeId;
    const keys = await h.deps.keys();
    await (await mailboxObject(h, a)).revokeTickets(await suppressionKey(keys, a), h.clock.now);
    h.clock.now += 31_000;
    // Revoked: the resend is an ordinary one, and the full domain refuses it.
    expect((await h.call('/v1/email/resend', { challengeId: cid }, { ip: '192.0.2.91' })).status).toBe(429);
  });

  it('M3: a grant’s challenge checks in the ticket slot, then its own 2 outside the ceiling; the yearly bound stays under 1%', async () => {
    const h = await harness();
    const box = await mailboxObject(h, `grant${uid().replace(/[^a-z0-9]/gu, '')}@gmail.com`);
    const day = Date.UTC(2027, 1, 3);
    // The day's ceiling reached by everyone else.
    await runInDurableObject(box, (_o, state) => {
      state.storage.kv.put(`${MAILBOX_WRONG_CEILING.name}@${day}`, MAILBOX_WRONG_CEILING.max);
      state.storage.kv.put(`${MAILBOX_WRONG_BACKSTOP.name}@${day}`, MAILBOX_WRONG_BACKSTOP.max);
      state.storage.kv.put(`${MAILBOX_TICKET_SLOT.name}@${day}`, MAILBOX_TICKET_SLOT.max);
    });
    expect((await box.admit('attacker', morning + 600_000, false, morning)).ok).toBe(false);
    await box.issueGrant('hash-1', morning);
    const adm = await box.admit('owner', morning + 600_000, false, morning, { kind: 'grant', hash: 'hash-1' });
    expect(adm.ok).toBe(true);
    if (!adm.ok) return;
    let checks = 0;
    for (let i = 0; i < 4; i++) if ((await box.reserveGuess('owner', morning, adm.owner)).ok) checks++;
    expect(checks).toBe(MAILBOX_GRANT_SLOT.max);
    expect(await runInDurableObject(box, (_o, state) => state.storage.kv.get<number>(`${MAILBOX_WRONG_CEILING.name}@${day}`))).toBe(MAILBOX_WRONG_CEILING.max);
    // A second start with the same grant: used up.
    expect((await box.admit('owner', morning + 600_000, false, morning, { kind: 'grant', hash: 'hash-1' })).ok).toBe(false);
    // The bound: the ceiling every day plus each unlock's own checks (at most 3 unlocks in 30 days).
    expect(MAILBOX_WRONG_CEILING.max).toBe(MAILBOX_WRONG_BACKSTOP.max + MAILBOX_OWNER_SLOT.max + MAILBOX_TICKET_SLOT.max);
    const unlocksPerYear = Math.ceil((365 / 30) * 3);
    expect((365 * MAILBOX_WRONG_CEILING.max + unlocksPerYear * MAILBOX_GRANT_SLOT.max) / 1e6).toBeLessThan(0.01);
  });
});
