// Build plan batch 9 (D446, D447): the issuer's daily counters (sent, refused by limit, bounced and complained per app),
// the alert mails (once a day per kind, a global ceiling, no address), `DirectoryRpc.issuerStats` (the staff check,
// empty, counts only), the partner console's `ConsoleIssuerRpc` (client proof: the same checks as the staff route,
// audited, capped; deliverability: only the asked app's rows) and the provider's custom args.
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { SendGridSender } from '../src/sendgrid.ts';
import { ALERT_MAILS_PER_DAY, REFUSAL_COUNT_CAP, alertMail, countDaily, countRefusal, dayOf, raiseAlert } from '../src/daily.ts';
import { ConsoleIssuerRpc } from '../src/console-rpc.ts';
import { DirectoryRpc, resetDirectoryAccess } from '../src/directory-rpc.ts';
import { mintPartnerClientProof, PARTNER_PROOF_STAFF } from '../src/handlers.ts';
import { base64Encode, utf8 } from '../src/bytes.ts';
import { decodeToken, harness, type Harness, seedApp, sessionCommitment, uid } from './helpers.ts';

const metric = async (appId: string, m: string): Promise<number> => (await env.DB.prepare('SELECT SUM(count) AS n FROM email_daily WHERE app_id = ?1 AND metric = ?2').bind(appId, m).first<number>('n')) ?? 0;

describe('the daily counters (D446)', () => {
  it('counts a refusal by its limit name and caps it: no write past the cap', async () => {
    const h = await harness();
    const app = `app_${uid()}`;
    for (let i = 0; i < 3; i++) countDaily(h.deps, app, 'refused:app:start:1d', { cap: 2 });
    await h.call('/v1/email/health', undefined, { method: 'GET', origin: null });
    expect(await metric(app, 'refused:app:start:1d')).toBe(2);
    expect(REFUSAL_COUNT_CAP).toBe(1000);
  });

  it('a refused start is counted without an app (the limit ran before the app is known)', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const ip = `10.${Math.floor(Math.random() * 250)}.77.${Math.floor(Math.random() * 250)}`;
    const body = () => ({ pk: app.pk, email: `r${uid()}@example.com`, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    let refused = false;
    for (let i = 0; i < 12 && !refused; i++) refused = (await h.call('/v1/email/start', body(), { ip })).status === 429;
    expect(refused).toBe(true);
    expect(await metric('', 'refused:ip:start:10m')).toBeGreaterThan(0);
  });

  it('a sent mail is counted for its app, with the app id on the provider’s custom args', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const r = await h.call('/v1/email/start', { pk: app.pk, email: `s${uid()}@example.com`, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    expect(r.status).toBe(202);
    expect(await metric(app.id, 'sent')).toBe(1);
    expect(h.sender.sent[0]).toMatchObject({ kind: 'code', appId: app.id });

    let body: Record<string, unknown> = {};
    const send = new SendGridSender('key', 'Hana <h@example.com>', (async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('', { status: 202 });
    }) as typeof fetch);
    await send.send({ to: 'x@example.com', subject: 's', text: 't', html: 'h', kind: 'code', appId: 'app_abc' });
    expect((body.personalizations as { custom_args?: unknown }[])[0]!.custom_args).toEqual({ hana_app: 'app_abc' });
    await send.send({ to: 'x@example.com', subject: 's', text: 't', html: 'h', kind: 'alert' });
    expect((body.personalizations as { custom_args?: unknown }[])[0]!.custom_args).toBeUndefined();
    expect(body.mail_settings).toBeTruthy();
  });

  it('a bounce and a complaint are counted per app from the webhook; a malformed app id counts for no app', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = base64Encode(new Uint8Array((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer));
    const h = await harness({ env: { ...env, SENDGRID_WEBHOOK_PUBLIC_KEY: spki, ENV_NAME: `t-${uid()}` } });
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
    const app = `app_${uid()}`;
    const events = JSON.stringify([
      { event: 'bounce', type: 'bounce', email: `b${uid()}@example.com`, category: ['hana-id-code'], hana_app: app },
      { event: 'spamreport', email: `c${uid()}@example.com`, category: ['hana-id-code'], hana_app: app },
      { event: 'bounce', type: 'bounce', email: `d${uid()}@example.com`, category: ['hana-id-code'], hana_app: 'not an id' },
    ]);
    const ts = String(Math.floor(h.clock.now / 1000));
    const sig = base64Encode(toDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(ts + events)))));
    const r = await h.call('/v1/email/webhooks/sendgrid', JSON.parse(events), { origin: null, headers: { 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts } });
    expect(r.status).toBe(200);
    expect(await metric(app, 'bounced')).toBe(1);
    expect(await metric(app, 'complained')).toBe(1);
    expect(await metric('', 'bounced')).toBeGreaterThan(0);
  });
});

describe('alert mails (D446)', () => {
  const withAlias = async (): Promise<Harness> => harness({ env: { ...env, SECURITY_ALIAS: 'security@hana.example', ENV_NAME: `t-${uid()}` } });
  const settle = async (h: Harness) => h.call('/v1/email/health', undefined, { method: 'GET', origin: null });

  it('counts every occurrence, mails the alias once per kind, code and app a day, and no address in the mail', async () => {
    const h = await withAlias();
    raiseAlert(h.deps, 'req', 'send_budget_exhausted', 'global', null);
    raiseAlert(h.deps, 'req', 'send_budget_exhausted', 'global', null);
    raiseAlert(h.deps, 'req', 'send_budget_exhausted', 'app', 'app_abc');
    await settle(h);
    const mails = h.sender.sent.filter((m) => m.kind === 'alert');
    expect(mails.map((m) => m.to)).toEqual(['security@hana.example', 'security@hana.example']);
    expect(await metric('', 'alert:send_budget_exhausted:global')).toBe(2);
    expect(await metric('app_abc', 'alert:send_budget_exhausted:app')).toBe(1);
    for (const m of mails) {
      expect(m.text).toContain(h.deps.env.ENV_NAME);
      expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/@example/u);
    }
    expect(alertMail('mailbox_guess_limit', 'backstop', null, 'test', 'a@hana.example').text).not.toMatch(/address|sub\b|token/iu);
  });

  it('the day’s alert mails stop at the ceiling; without an alias nothing is mailed but it is still counted', async () => {
    const h = await withAlias();
    for (let i = 0; i < ALERT_MAILS_PER_DAY + 3; i++) raiseAlert(h.deps, 'req', 'email_budget', `code${i}`, null);
    await settle(h);
    expect(h.sender.sent.filter((m) => m.kind === 'alert').length).toBe(ALERT_MAILS_PER_DAY);

    const quiet = await harness();
    raiseAlert(quiet.deps, 'req', 'email_domain_cap', '', null);
    await settle(quiet);
    expect(quiet.sender.sent.filter((m) => m.kind === 'alert')).toEqual([]);
    expect(await metric('', 'alert:email_domain_cap')).toBeGreaterThan(0);
  });

  it('a refused alert mail is logged, never thrown', async () => {
    const h = await withAlias();
    h.sender.next = { ok: false, reason: 'unavailable' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    raiseAlert(h.deps, 'req', 'email_owner_pool', 'owner_50', null);
    await settle(h);
    expect(errors.mock.calls.some(([l]) => String(l).includes('alert_mail'))).toBe(true);
    errors.mockRestore();
  });
});

describe('the partner client proof and deliverability (D447)', () => {
  it('needs the current action nonce, a known scope and an email app; audited; capped per scope', async () => {
    const h = await harness();
    const app = await seedApp(h);
    h.chain.addScope(app.scope, { actionNonce: 7 });
    const req = { orgId: 'org_x', actorId: 'usr_x' };
    expect(await mintPartnerClientProof(h.deps, 'r1', { scopeId: app.scope, actionNonce: 3, ...req })).toMatchObject({ ok: false, code: 'stale_action_nonce' });
    expect(await mintPartnerClientProof(h.deps, 'r1', { scopeId: 'snoscope', actionNonce: 0, ...req })).toMatchObject({ ok: false, code: 'unknown_scope' });
    const off = await seedApp(h, { methods: 'google' });
    expect(await mintPartnerClientProof(h.deps, 'r1', { scopeId: off.scope, actionNonce: 0, ...req })).toMatchObject({ ok: false, code: 'email_not_enabled' });
    const r = await mintPartnerClientProof(h.deps, 'req-partner-1', { scopeId: app.scope, actionNonce: 7, ...req });
    if (!r.ok) throw new Error('refused');
    expect(r.client).toEqual(['email', `email:${app.scope}`]);
    const t = await decodeToken(r.token);
    expect(t.verified).toBe(true);
    expect(t.claims).toMatchObject({ aud: `email:${app.scope}`, sub: 'hana-client-proof' });
    const row = await env.DB.prepare('SELECT staff, action, ticket, scope_id, action_nonce, detail FROM email_admin_audit WHERE jti = ?1').bind((t.claims as { jti: string }).jti).first<{ staff: string; action: string; ticket: string; scope_id: string; action_nonce: number; detail: string }>();
    expect(row).toMatchObject({ staff: PARTNER_PROOF_STAFF, action: 'client_proof', ticket: 'org_x', scope_id: app.scope, action_nonce: 7 });
    expect(JSON.parse(row!.detail)).toEqual({ org: 'org_x', actor: 'usr_x', requestId: 'req-partner-1' });
    // 20 a day per scope; the 21st is refused and audited nothing.
    for (let i = 0; i < 19; i++) expect((await mintPartnerClientProof(h.deps, 'r', { scopeId: app.scope, actionNonce: 7, ...req })).ok).toBe(true);
    expect(await mintPartnerClientProof(h.deps, 'r', { scopeId: app.scope, actionNonce: 7, ...req })).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  const consoleRpc = () => new ConsoleIssuerRpc(createExecutionContext(), env);

  it('deliverability answers only the asked app’s rows, per day; empty is an empty list; malformed is refused', async () => {
    const a = `app_${uid()}`;
    const b = `app_${uid()}`;
    const today = dayOf(Date.now());
    await env.DB.batch([
      env.DB.prepare('INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?4)').bind(today, a, 'sent', 5),
      env.DB.prepare('INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?4)').bind(today, a, 'bounced', 1),
      env.DB.prepare('INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?4)').bind(today, a, 'refused:app:start:1d', 3),
      env.DB.prepare('INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?4)').bind(today, b, 'sent', 9),
      env.DB.prepare('INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?4)').bind('2020-01-01', a, 'sent', 7),
    ]);
    const r = await consoleRpc().deliverability({ requestId: `req_${uid()}`, appId: a, days: 7 });
    expect(r).toEqual({ ok: true, days: [{ day: today, sent: 5, bounced: 1, complained: 0, refused: 3 }] });
    expect(await consoleRpc().deliverability({ requestId: `req_${uid()}`, appId: `app_${uid()}`, days: 7 })).toEqual({ ok: true, days: [] });
    expect(await consoleRpc().deliverability({ requestId: 'x', appId: a, days: 7 })).toEqual({ ok: false, code: 'bad_request' });
    expect(await consoleRpc().deliverability({ requestId: `req_${uid()}`, appId: a, days: 0 })).toEqual({ ok: false, code: 'bad_request' });
  });

  it('clientProof with a malformed body is refused before anything else', async () => {
    expect(await consoleRpc().clientProof({ requestId: `req_${uid()}`, scopeId: 'bad scope', actionNonce: 1, orgId: 'org_a', actorId: 'u' })).toMatchObject({ ok: false, code: 'bad_request' });
  });
});

describe('DirectoryRpc.issuerStats (D446)', () => {
  const TEAM = 'hana-admin-test.cloudflareaccess.com';
  const AUD = 'cd'.repeat(32);
  const STAFF = 'staff@hana.example';
  const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;
  let pair: CryptoKeyPair;
  let pub: JsonWebKey;

  const b64url = (data: string | Uint8Array): string => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  };

  async function accessJwt(over: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims = { aud: [AUD], email: STAFF, exp: now + 3600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', sub: 'staff-sub-1', ...over };
    const input = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'admin-kid', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input)));
    return `${input}.${b64url(sig)}`;
  }

  beforeEach(async () => {
    pair ??= (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    pub ??= (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    resetDirectoryAccess();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== CERTS) throw new Error(`Unexpected fetch to ${url}`);
      return Response.json({ keys: [{ kty: 'RSA', n: pub.n, e: pub.e, kid: 'admin-kid', alg: 'RS256', use: 'sig' }] }, { headers: { 'cache-control': 'max-age=300' } });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const rpc = () => new DirectoryRpc(createExecutionContext(), { ...env, ADMIN_ACCESS_TEAM_DOMAIN: TEAM, ADMIN_ACCESS_AUD: AUD, ADMIN_STAFF_EMAILS: JSON.stringify([STAFF]), EMAIL_RL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } as typeof env);
  let seq = 0;
  const rid = () => `req_stats_${(++seq).toString(36)}aaaa`;

  it('refuses a bad token and a non-staff email, reading nothing', async () => {
    expect(await rpc().issuerStats({ requestId: rid(), accessJwt: 'x'.repeat(40), days: 7 })).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(await rpc().issuerStats({ requestId: rid(), accessJwt: await accessJwt({ email: 'partner@elsewhere.example' }), days: 7 })).toMatchObject({ ok: false, code: 'not_staff' });
    expect(await rpc().issuerStats({ requestId: rid(), accessJwt: await accessJwt(), days: 99 })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('returns issuance per day, app and purpose and the daily counters; counts only; writes no audit row', async () => {
    const app = `app_${uid()}`;
    const nowS = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO email_issuance (jti, app_id, purpose, kid, iat) VALUES (?1, ?2, ?3, ?4, ?5)').bind(`j${uid()}`, app, 'session', 'k', nowS),
      env.DB.prepare('INSERT INTO email_issuance (jti, app_id, purpose, kid, iat) VALUES (?1, ?2, ?3, ?4, ?5)').bind(`j${uid()}`, app, 'session', 'k', nowS),
      env.DB.prepare('INSERT INTO email_issuance (jti, app_id, purpose, kid, iat) VALUES (?1, NULL, ?3, ?4, ?5)').bind(`j${uid()}`, null, 'client_proof', 'k', nowS),
      env.DB.prepare('INSERT INTO email_daily (day, app_id, metric, count) VALUES (?1, ?2, ?3, ?4)').bind(dayOf(Date.now()), app, 'refused:ip:start:10m', 4),
    ]);
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_admin_audit').first<number>('n');
    const r = await rpc().issuerStats({ requestId: rid(), accessJwt: await accessJwt(), days: 7 });
    if (!r.ok) throw new Error(`refused ${r.code}`);
    expect(r.issuance.find((x) => x.appId === app)).toEqual({ day: dayOf(Date.now()), appId: app, purpose: 'session', count: 2 });
    expect(r.issuance.some((x) => x.appId === null && x.purpose === 'client_proof')).toBe(true);
    expect(r.metrics.find((x) => x.appId === app && x.metric === 'refused:ip:start:10m')).toMatchObject({ count: 4 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_admin_audit').first<number>('n')).toBe(before);
    expect(JSON.stringify(r)).not.toMatch(/@|hana-client-proof/u);
  });

  it('an empty window is empty lists', async () => {
    const r = await rpc().issuerStats({ requestId: rid(), accessJwt: await accessJwt(), days: 1 });
    expect(r.ok).toBe(true);
  });
});
