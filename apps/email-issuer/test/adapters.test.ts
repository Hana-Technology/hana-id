// The sender adapters (SendGrid, D194; the outbox stub), Cloudflare Access for client proofs (D88), SendGrid's signed
// Event Webhook into email_suppressions, the NEAR view client, and the limiter objects' cleanup.
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.ts';
import { describe, expect, it } from 'vitest';
import { AccessVerifier } from '../src/access.ts';
import { base64Encode, base64UrlEncode, fromUtf8, utf8 } from '../src/bytes.ts';
import { NearChain } from '../src/chain.ts';
import { senderFor } from '../src/deps.ts';
import { addressKey } from '../src/keys.ts';
import { clientProofPreimage, nonceOf } from '../src/layouts.ts';
import { codeMail, displayAppName, linkNoticeMail } from '../src/mail.ts';
import { OutboxSender } from '../src/outbox.ts';
import { SENDGRID_URL, SendGridSender, parseFrom } from '../src/sendgrid.ts';
import { derToP1363 } from '../src/webhook.ts';
import { captureLogs, decodeToken, env, harness, seedApp, sessionCommitment, uid } from './helpers.ts';

const mail = codeMail({ to: 'a@example.com', code: '123456', appName: 'Wallet', authOrigin: 'https://auth.test', purpose: 'session' });

describe('SendGrid sender', () => {
  it('POSTs v3 mail/send with the key, to the normalized address, tracking off; counts only a 202', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const reply = { status: 202, headers: { 'x-message-id': 'msg-1' } as Record<string, string>, body: '' };
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(reply.body || null, { status: reply.status, headers: reply.headers });
    }) as unknown as typeof fetch;
    const s = new SendGridSender('SG.key', 'Hana <login@mail.example.com>', fetcher);
    expect(await s.send(mail)).toEqual({ ok: true });
    expect(seen[0]!.url).toBe(SENDGRID_URL);
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer SG.key');
    const body = JSON.parse(seen[0]!.init.body as string) as Record<string, any>;
    expect(body.personalizations).toEqual([{ to: [{ email: 'a@example.com' }] }]);
    expect(body.from).toEqual({ email: 'login@mail.example.com', name: 'Hana' });
    expect(body.subject).toBe('Your sign-in code for Wallet');
    expect(body.content.map((c: { type: string }) => c.type)).toEqual(['text/plain', 'text/html']);
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false }, ganalytics: { enable: false } });
    for (const [status, reason] of [[400, 'rejected'], [401, 'misconfigured'], [403, 'misconfigured'], [429, 'unavailable'], [500, 'unavailable'], [200, 'rejected']] as const) {
      reply.status = status;
      reply.body = status === 400 ? JSON.stringify({ errors: [{ message: 'bad a@example.com' }] }) : '';
      expect(await s.send(mail)).toEqual({ ok: false, reason, providerStatus: status });
    }
    // An error body larger than the cap is not buffered.
    reply.status = 400;
    reply.body = 'x'.repeat(100_000);
    expect((await s.send(mail)).ok).toBe(false);
    expect(await new SendGridSender(undefined, 'a@b.co', fetcher).send(mail)).toEqual({ ok: false, reason: 'misconfigured' });
    const down = new SendGridSender('SG.key', 'a@b.co', (async () => Promise.reject(new Error('net'))) as unknown as typeof fetch);
    expect(await down.send(mail)).toEqual({ ok: false, reason: 'unavailable' });
    expect(parseFrom('login@mail.example.com')).toEqual({ email: 'login@mail.example.com' });
  });

  it('the env picks the adapter: sendgrid, or the outbox stub where its binding exists', async () => {
    expect(senderFor({ ...env, EMAIL_SENDER: 'sendgrid' }).name).toBe('sendgrid');
    const outbox = senderFor({ ...env, EMAIL_SENDER: 'outbox' });
    expect(outbox.name).toBe('outbox');
    await env.OUTBOX!.get(env.OUTBOX!.idFromName('outbox')).clear();
    expect(await outbox.send(mail)).toEqual({ ok: true });
    const list = await env.OUTBOX!.get(env.OUTBOX!.idFromName('outbox')).list();
    expect(list.at(-1)).toMatchObject({ to: 'a@example.com', kind: 'code' });
    expect(await new OutboxSender(undefined).send(mail)).toEqual({ ok: false, reason: 'misconfigured' });
  });

  it('mail texts: the app named only when display-safe; the notice links only to authOrigin', () => {
    expect(displayAppName('Wallet')).toBe('Wallet');
    expect(displayAppName('Wal‮let')).toBeNull();
    expect(displayAppName('x'.repeat(65))).toBeNull();
    const unsafe = codeMail({ to: 'a@example.com', code: '654321', appName: 'Evil​', authOrigin: 'https://auth.test', purpose: 'session' });
    expect(unsafe.subject).toBe('Your sign-in code');
    expect(unsafe.text).toContain('sign in to an app');
    const html = codeMail({ to: 'a@example.com', code: '654321', appName: '<b>App</b>', authOrigin: 'https://auth.test', purpose: 'session' });
    expect(html.html).not.toContain('<b>App</b>');
    const n = linkNoticeMail({ to: 'a@example.com', appName: 'Wallet', authOrigin: 'https://auth.test/', pending: false });
    expect([...n.html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1])).toEqual(['https://auth.test/link/cancel']);
  });
});

/** An RS256 JWT signed by `key`, for the Access tests. */
async function jwt(key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const h = base64UrlEncode(utf8(JSON.stringify({ alg: 'RS256', kid })));
  const c = base64UrlEncode(utf8(JSON.stringify(claims)));
  return `${h}.${c}.${base64UrlEncode(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${h}.${c}`))))}`;
}

describe('admin/client-proof behind Cloudflare Access', () => {
  it('refuses a missing, wrong-aud, wrong-iss, expired, unknown-kid, empty-sub or unlisted Access JWT; mints and audits for staff', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const team = 'hana.cloudflareaccess.com';
    const aud = 'a'.repeat(64);
    const certs = (async (url: string) => {
      expect(url).toBe(`https://${team}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [{ ...pub, kid: 'acc-1', alg: 'RS256', use: 'sig' }] }));
    }) as unknown as typeof fetch;
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: `https://${team}`, aud: [aud], sub: 'staff-sub', email: 'staff@example.com', exp: now + 600, iat: now };
    const h = await harness({ access: new AccessVerifier({ teamDomain: team, aud, staffEmails: ['staff@example.com'] }, certs) });
    const ask = (token: string | null, body: unknown = { scopeId: 's7', actionNonce: 3 }) => h.call('/v1/email/admin/client-proof', body, { origin: null, headers: token ? { 'cf-access-jwt-assertion': token } : {} });
    expect((await ask(null)).status).toBe(403);
    for (const over of [{ aud: ['b'.repeat(64)] }, { iss: 'https://other.cloudflareaccess.com' }, { exp: now - 120 }, { sub: '' }, { email: 'other@example.com' }]) {
      expect((await ask(await jwt(pair.privateKey, 'acc-1', { ...good, ...over }))).status).toBe(403);
    }
    expect((await ask(await jwt(pair.privateKey, 'acc-2', good))).status).toBe(403);
    const r = await ask(await jwt(pair.privateKey, 'acc-1', good));
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const { token, client } = (await r.json()) as { token: string; client: [string, string] };
    expect(client).toEqual(['email', 'email:s7']);
    const t = await decodeToken(token);
    expect(t.verified).toBe(true);
    expect(t.claims).toMatchObject({ aud: 'email:s7', sub: 'hana-client-proof', nonce: nonceOf(clientProofPreimage(env.SIGNER_ACCOUNT, 's7', 3)) });
    const audit = await env.DB.prepare('SELECT staff, scope_id, action_nonce, jti FROM email_admin_audit').all();
    expect(audit.results).toEqual([{ staff: 'staff@example.com', scope_id: 's7', action_nonce: 3, jti: t.claims.jti }]);
    expect(await env.DB.prepare('SELECT purpose, app_id FROM email_issuance WHERE jti = ?1').bind(t.claims.jti).first()).toEqual({ purpose: 'client_proof', app_id: null });
    expect((await ask(await jwt(pair.privateKey, 'acc-1', good), { scopeId: 'S7', actionNonce: 3 })).status).toBe(400);
  });

  it('admin/unlock: staff clear a mailbox locked by guessing; audited without the address', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const team = 'hana.cloudflareaccess.com';
    const aud = 'c'.repeat(64);
    const certs = (async () => new Response(JSON.stringify({ keys: [{ ...pub, kid: 'acc-1', alg: 'RS256', use: 'sig' }] }))) as unknown as typeof fetch;
    const h = await harness({ access: new AccessVerifier({ teamDomain: team, aud, staffEmails: ['staff@example.com'] }, certs) });
    h.clock.now = Date.UTC(2027, 0, 20, 8);
    const app = await seedApp(h);
    const victim = `u${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
    // 20 failed checks from four requesters trip the backstop: a new requester is refused.
    for (let i = 0; i < 4; i++) {
      const ip = `203.0.113.${100 + i}`;
      const c = sessionCommitment(app.scope, h.clock.now);
      const s = (await (await h.call('/v1/email/start', { pk: app.pk, email: victim, purpose: 'session', commitment: c.json }, { ip })).json()) as { challengeId: string };
      const wrong = h.sender.codeFor(victim) === '000000' ? '111111' : '000000';
      for (let k = 0; k < 5; k++) await h.call('/v1/email/verify', { challengeId: s.challengeId, code: wrong }, { ip });
    }
    const body = () => ({ pk: app.pk, email: victim, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json });
    expect((await h.call('/v1/email/start', body(), { ip: '198.18.0.9' })).status).toBe(429);
    const now = Math.floor(Date.now() / 1000);
    const token = await jwt(pair.privateKey, 'acc-1', { iss: `https://${team}`, aud: [aud], sub: 'staff-sub', email: 'staff@example.com', exp: now + 600, iat: now });
    expect((await h.call('/v1/email/admin/unlock', { email: victim }, { origin: null })).status).toBe(403);
    const { result, lines } = await captureLogs(() => h.call('/v1/email/admin/unlock', { email: victim }, { origin: null, headers: { 'cf-access-jwt-assertion': token } }));
    expect(result.status).toBe(200);
    expect(((await result.json()) as { cleared: number }).cleared).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(victim);
    const row = await env.DB.prepare("SELECT staff, action, subject FROM email_admin_audit WHERE action = 'unlock'").first<{ staff: string; action: string; subject: string }>();
    expect(row).toMatchObject({ staff: 'staff@example.com', action: 'unlock' });
    expect(row!.subject).toHaveLength(12);
    expect(JSON.stringify(row)).not.toContain(victim);
    expect((await h.call('/v1/email/start', body(), { ip: '198.18.0.9' })).status).toBe(202);
  });

  it('is 404 when the env configures no Access', async () => {
    const h = await harness();
    expect((await h.call('/v1/email/admin/client-proof', { scopeId: 's1', actionNonce: 0 }, { origin: null })).status).toBe(404);
  });
});

describe('SendGrid event webhook → email_suppressions', () => {
  /** Web Crypto's P1363 signature → DER, as SendGrid sends it. */
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

  it('verifies the signature, stores hard bounces and spam reports by email_key only, refuses replays', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = base64Encode(new Uint8Array((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer));
    const h = await harness({ env: { ...env, SENDGRID_WEBHOOK_PUBLIC_KEY: spki } });
    const bounced = `b${uid()}@example.com`;
    const complained = `C${uid()}@Example.com`;
    const blocked = `x${uid()}@example.com`;
    const events = JSON.stringify([
      { event: 'bounce', type: 'bounce', email: bounced },
      { event: 'spamreport', email: complained },
      { event: 'bounce', type: 'blocked', email: blocked },
      { event: 'delivered', email: `d${uid()}@example.com` },
    ]);
    const send = async (body: string, ts: string, sig?: string) => {
      const s = sig ?? base64Encode(toDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(ts + body)))));
      return h.call('/v1/email/webhooks/sendgrid', JSON.parse(body), { origin: null, headers: { 'x-twilio-email-event-webhook-signature': s, 'x-twilio-email-event-webhook-timestamp': ts } });
    };
    const ts = String(Math.floor(h.clock.now / 1000));
    expect((await send(events, ts, base64Encode(new Uint8Array(70)))).status).toBe(401);
    expect((await send(events, String(Number(ts) - 3600))).status).toBe(401);
    const ok = await send(JSON.stringify(JSON.parse(events)), ts);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ stored: 2 });
    const keys = await h.deps.keys();
    const rows = await env.DB.prepare('SELECT email_key, reason FROM email_suppressions ORDER BY reason').all<{ email_key: string; reason: string }>();
    expect(rows.results).toEqual([
      { email_key: await addressKey(keys, bounced), reason: 'bounce' },
      { email_key: await addressKey(keys, complained.toLowerCase()), reason: 'complaint' },
    ]);
    expect(JSON.stringify(rows.results)).not.toContain('@');
    expect(derToP1363(Uint8Array.of(0x31, 0))).toBeNull();
  });
});

describe('NEAR views', () => {
  const rpcAnswer = (v: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: [...utf8(JSON.stringify(v))], logs: [] } }));

  it('parses identity, account, scope and config; falls back to the second RPC; refuses odd shapes', async () => {
    const calls: string[] = [];
    const answers: Record<string, unknown> = {
      get_identity: { key: 'a'.repeat(64), status: 'member', opened: false, root: { provider: 'email', sub: 'e1.x' }, effective_at_ms: 1, account_epoch: 4 },
      get_account: { root: { provider: 'email', sub: 'e1.x' }, members: [{ key: 'a'.repeat(64), provider: 'google', effective_at_ms: 1, active: true, auto: true }], epoch: 4, unlinked: ['b'.repeat(64)] },
      get_scope: { id: 's1', owners: [], clients: [['email', 'email:s1'], ['google', 'g']], allow_shared: true, pending: [] },
      get_config: { shared_clients: [['google', 'sh1']], pending_shared_clients: [{ provider: 'google', aud: 'sh2', effective_at_ms: 0 }], unrecorded_wallets: false },
    };
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes('first')) return new Response('down', { status: 503 });
      const req = JSON.parse(init.body as string) as { params: { method_name: string; args_base64: string; finality: string } };
      expect(req.params.finality).toBe('final');
      return rpcAnswer(answers[req.params.method_name]);
    }) as unknown as typeof fetch;
    const chain = new NearChain(['https://first.test', 'https://second.test'], 'signer.test.near', fetcher);
    expect(await chain.identity('s1', 'google', '1')).toEqual({ key: 'a'.repeat(64), status: 'member', opened: false, root: { provider: 'email', sub: 'e1.x' }, accountEpoch: 4 });
    expect((await chain.account('s1', 'google', '1'))?.unlinked).toEqual(['b'.repeat(64)]);
    expect(await chain.scope('s1')).toEqual({ clients: [['email', 'email:s1'], ['google', 'g']], allowShared: true });
    expect(await chain.sharedGoogleClients()).toEqual(['sh1', 'sh2']);
    expect(await chain.unrecordedWallets()).toBe(false);
    expect(calls.filter((c) => c.includes('second')).length).toBeGreaterThan(0);
    answers.get_identity = { key: 'zz', status: 'own' };
    await expect(chain.identity('s1', 'google', '1')).rejects.toThrow('unexpected');
    answers.get_config = { shared_clients: [] };
    expect(await new NearChain(['https://second.test'], 's', fetcher).unrecordedWallets()).toBe(true);
    const panic = (async () => new Response(JSON.stringify({ result: { error: 'wasm execution failed' } }))) as unknown as typeof fetch;
    await expect(new NearChain(['https://x.test'], 's', panic).scope('s1')).rejects.toThrow('failed');
    const huge = (async () => new Response('x'.repeat(2 * 1024 * 1024))) as unknown as typeof fetch;
    await expect(new NearChain(['https://x.test'], 's', huge).scope('s1')).rejects.toThrow('no RPC answered');
  });
});

describe('Durable Object cleanup', () => {
  it('a challenge deletes itself at expiry; a limiter forgets ended windows', async () => {
    const h = await harness();
    const stub = env.EMAIL_CHALLENGE.get(env.EMAIL_CHALLENGE.idFromName(`cleanup-${uid()}`));
    await stub.create({ appId: 'a', appName: 'A', scopeId: 's', purpose: 'session', nonce: 'n', autoLink: null, silent: false, email: 'x@example.com', mailboxKey: 'k', codeMac: 'AAAA', attempts: 0, createdAtMs: 0, expiresAtMs: Date.now() + 1000, lastSentAtMs: 0, resends: 0 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_o, state) => expect([...state.storage.kv.list()]).toEqual([]));
    const lim = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`cleanup-${uid()}`));
    // A window that ended days ago and one still running: the sweep keeps only the live one, then nothing.
    await lim.hit([{ name: 'old', windowMs: 1000, max: 1 }], Date.now() - 3 * 86_400_000);
    await lim.hit([{ name: 'live', windowMs: 60_000, max: 1 }], Date.now());
    await runInDurableObject(lim, async (o, state) => {
      await o.alarm();
      expect([...state.storage.kv.list()].map(([k]) => k.split('@')[0])).toEqual(['live']);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    void h;
    void fromUtf8;
  });
});

describe('the Worker entry', () => {
  it('serves the JWKS from its own bindings and refuses a browser route from another origin', async () => {
    const ctx = createExecutionContext();
    const j = await worker.fetch(new Request('https://api.test/v1/email/jwks.json'), env, ctx);
    expect(j.status).toBe(200);
    expect(((await j.json()) as { keys: unknown[] }).keys).toHaveLength(2);
    const s = await worker.fetch(new Request('https://api.test/v1/email/start', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }), env, ctx);
    expect(s.status).toBe(403);
    await waitOnExecutionContext(ctx);
  });
});
