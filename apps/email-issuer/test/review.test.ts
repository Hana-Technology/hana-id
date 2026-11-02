// The review fixes (D198, D199): requester aggregates and the missing-IP refusal, the recipient-domain cap, owner
// device tickets, per-purpose mail texts, link_account end to end, the complaint-rate log and the webhook's header
// checks before the body.
import { describe, expect, it } from 'vitest';
import { toHex, utf8, base64Encode } from '../src/bytes.ts';
import { isExemptDomain, registrableDomain } from '../src/domain.ts';
import { ipAggregates } from '../src/ip.ts';
import { DEVICE_TICKET_TTL_MS, deviceTicket, isDeviceTicketFor, mailboxKey, suppressionKey } from '../src/keys.ts';
import { linkAccountPreimage, nonceOf } from '../src/layouts.ts';
import { codeMail } from '../src/mail.ts';
import { captureLogs, decodeToken, env, harness, seedApp, sessionCommitment, uid, type Harness, type TestApp } from './helpers.ts';

const startBody = (h: Harness, app: TestApp, email: string, extra: Record<string, unknown> = {}) => ({ pk: app.pk, email, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json, ...extra });
const morning = Date.UTC(2027, 1, 3, 8, 0, 0);

describe('requesters: aggregates and a missing address (H1, L4)', () => {
  it('aggregate prefixes: IPv4 /24, IPv6 /56 and /48; mapped IPv6 counts as IPv4', () => {
    expect(ipAggregates('203.0.113.7')).toEqual(['v4net:203.0.113.0/24']);
    expect(ipAggregates('2001:db8:aa:bbcc:1::1')).toEqual(['v6net:2001:db8:aa:bb00::/56', 'v6net:2001:db8:aa::/48']);
    expect(ipAggregates('::ffff:203.0.113.7')).toEqual(['v4net:203.0.113.0/24']);
    expect(ipAggregates(null)).toEqual([]);
  });

  it('a /48 gets 200 starts a day, whatever its /64s', async () => {
    const h = await harness();
    h.clock.now = morning;
    const apps = await Promise.all(Array.from({ length: 3 }, () => seedApp(h)));
    let ok = 0;
    for (let i = 0; i < 205; i++) {
      // A new /64 each time, all in 2001:db8:77::/48.
      const ip = `2001:db8:77:${(i % 256).toString(16)}${Math.floor(i / 256)}::1`;
      const r = await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `p${i}${uid()}@gmail.com`), { ip });
      if (r.status === 202) ok++;
      if (i % 50 === 49) h.clock.now += 60_000;
    }
    expect(ok).toBe(200);
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
    let n = 1;
    for (let i = 0; n < 100 && i < 200; i++) if ((await h.call('/v1/email/start', startBody(h, apps[i % 3]!, `x${i}@${dom}`), { ip: `10.${90 + Math.floor(i / 200)}.${i}.1` })).status === 202) n++;
    expect(n).toBe(100);
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
    expect(t).toMatch(/^dt1\.[A-Za-z0-9_-]{54}$/u);
    expect(await isDeviceTicketFor(keys, t, mine, morning + 1)).toBe(true);
    expect(await isDeviceTicketFor(keys, t, other, morning + 1)).toBe(false);
    expect(await isDeviceTicketFor(keys, t, mine, morning + DEVICE_TICKET_TTL_MS + 1)).toBe(false);
    expect(await isDeviceTicketFor(keys, `${t.slice(0, -2)}AA`, mine, morning + 1)).toBe(false);
    expect(await isDeviceTicketFor(keys, 'dt1.x', mine, morning)).toBe(false);
  });

  it('a drained mailbox still gives its owner 3 codes a day with a ticket; nobody else qualifies', async () => {
    const h = await harness();
    h.clock.now = morning;
    const apps = await Promise.all(Array.from({ length: 2 }, () => seedApp(h)));
    const a = `d${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
    // The owner signed in once: a ticket.
    const s0 = (await (await h.call('/v1/email/start', startBody(h, apps[0]!, a), { ip: '192.0.2.50' })).json()) as { challengeId: string };
    const v0 = (await (await h.call('/v1/email/verify', { challengeId: s0.challengeId, code: h.sender.codeFor(a) }, { ip: '192.0.2.50' })).json()) as { deviceTicket: string };
    // An attacker drains the mailbox's code allowance (30 + the 5-a-day reserve) from many /24s.
    let drained = 1;
    for (let i = 0; i < 80 && drained < 35; i++) {
      const s = await h.call('/v1/email/start', startBody(h, apps[i % 2]!, a), { ip: `10.${100 + Math.floor(i / 200)}.${i % 200}.1` });
      if (s.status !== 202) continue;
      drained++;
      await h.call('/v1/email/verify', { challengeId: ((await s.json()) as { challengeId: string }).challengeId, code: h.sender.codeFor(a) }, { ip: `10.${100 + Math.floor(i / 200)}.${i % 200}.1` });
      if (drained % 9 === 0) h.clock.now += 15 * 60_000 + 1;
    }
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
    expect(body.deviceTicket).toMatch(/^dt1\./u);
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
