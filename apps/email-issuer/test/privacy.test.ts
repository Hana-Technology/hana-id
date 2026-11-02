// The log-capture test (spec "Tests" → "Issuer": "nothing logged (a log-capture test greps for the address, code, sub
// and token)"): every line of every flow, errors included, is grepped for the address (raw and normalized), the code,
// the sub, every token, the Google access token and every secret binding.
import { describe, expect, it } from 'vitest';
import { emailSub } from '@hana-id/email';
import { SECRET_NAMES } from '../src/env.ts';
import { AccessVerifier } from '../src/access.ts';
import { base64Encode, base64UrlEncode, utf8 } from '../src/bytes.ts';
import { suppressionKey } from '../src/keys.ts';
import { GOOGLE_CLIENT, captureLogs, env, harness, nonceFor, seedApp, sessionCommitment, uid } from './helpers.ts';

const jwt = async (key: CryptoKey, claims: Record<string, unknown>): Promise<string> => {
  const h = base64UrlEncode(utf8(JSON.stringify({ alg: 'RS256', kid: 'acc-1' })));
  const c = base64UrlEncode(utf8(JSON.stringify(claims)));
  return `${h}.${c}.${base64UrlEncode(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${h}.${c}`))))}`;
};
const derOf = (p1363: Uint8Array): Uint8Array => {
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

describe('nothing personal or secret is ever logged', () => {
  it('start, resend, wrong and right codes, google-match (case A and B), provider failures', async () => {
    const h = await harness();
    const app = await seedApp(h);
    const local = `Priv.Acy${uid().replace(/[^a-z0-9]/gu, '')}`;
    const raw = ` ${local}@GMAIL.com `;
    const normalized = `${local.toLowerCase().replace(/\./gu, '')}@gmail.com`;
    const secrets: string[] = [];
    const { lines } = await captureLogs(async () => {
      const c = sessionCommitment(app.scope, h.clock.now);
      const s = await h.call('/v1/email/start', { pk: app.pk, email: raw, purpose: 'session', commitment: c.json });
      const { challengeId } = (await s.json()) as { challengeId: string };
      h.clock.now += 30_000;
      h.sender.next = { ok: false, reason: 'rejected', providerStatus: 400 };
      await h.call('/v1/email/resend', { challengeId });
      h.sender.next = { ok: true };
      h.clock.now += 30_000;
      await h.call('/v1/email/resend', { challengeId });
      const code = h.sender.codeFor(normalized);
      secrets.push(code, challengeId);
      await h.call('/v1/email/verify', { challengeId, code: code === '000000' ? '000001' : '000000' });
      const v = await h.call('/v1/email/verify', { challengeId, code });
      const { idToken } = (await v.json()) as { idToken: string };
      secrets.push(idToken, ...JSON.parse(idToken).signatures.map((x: { signature: string }) => x.signature));
      const sub = await emailSub((await h.deps.keys()).sub, normalized);
      secrets.push(sub);
      // google-match: case A, Google-hosted, with a token minted.
      h.chain.open(app.scope, 'email', sub);
      const acc = { sub: `1${Math.floor(Math.random() * 1e15)}`, email: raw.trim() };
      const c2 = sessionCommitment(app.scope, h.clock.now);
      const accessToken = h.google.accessToken(acc, GOOGLE_CLIENT);
      const googleIdToken = await h.google.idToken(acc, GOOGLE_CLIENT, nonceFor(c2));
      secrets.push(accessToken, googleIdToken);
      const m = await h.call('/v1/email/google-match', { pk: app.pk, accessToken, googleIdToken, commitment: c2.json, link: true });
      const { emailToken } = (await m.json()) as { emailToken: string };
      secrets.push(emailToken);
      // A refused google-match (tokeninfo mismatch) and a Google outage.
      const bad = h.google.accessToken({ ...acc, tokenAud: 'x' }, GOOGLE_CLIENT);
      secrets.push(bad);
      await h.call('/v1/email/google-match', { pk: app.pk, accessToken: bad, googleIdToken, commitment: c2.json, link: true });
      h.google.userinfoStatus = 503;
      const down = h.google.accessToken(acc, GOOGLE_CLIENT);
      secrets.push(down);
      expect((await h.call('/v1/email/google-match', { pk: app.pk, accessToken: down, googleIdToken, commitment: c2.json, link: true })).status).toBe(502);
      h.google.userinfoStatus = 200;
      // Invalid and disposable addresses are refused without echoing them.
      await h.call('/v1/email/start', { pk: app.pk, email: `${local}@mailinator.com`, purpose: 'session', commitment: c.json });
      await h.call('/v1/email/start', { pk: app.pk, email: `${local}@@x`, purpose: 'session', commitment: c.json });
    });
    expect(lines.length).toBeGreaterThan(10);
    const all = lines.join('\n');
    for (const needle of [raw.trim(), normalized, local, local.toLowerCase(), ...secrets]) expect(all).not.toContain(needle);
    for (const name of SECRET_NAMES) {
      const value = env[name];
      if (value) expect(all).not.toContain(value);
    }
    // And the lines are the structured ones only.
    for (const l of lines) expect(l.startsWith('{"level"')).toBe(true);
  });

  it('the staff routes, the webhook, the suppressed path, a guessing trip, case A with a code and its link notice (L7)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const team = 'hana.cloudflareaccess.com';
    const aud = 'd'.repeat(64);
    const certs = (async () => new Response(JSON.stringify({ keys: [{ ...pub, kid: 'acc-1', alg: 'RS256', use: 'sig' }] }))) as unknown as typeof fetch;
    const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = base64Encode(new Uint8Array((await crypto.subtle.exportKey('spki', ec.publicKey)) as ArrayBuffer));
    const h0 = await harness({ access: new AccessVerifier({ teamDomain: team, aud, staffEmails: ['staff@example.com'] }, certs) });
    const h = { ...h0, deps: { ...h0.deps, env: { ...h0.deps.env, SENDGRID_WEBHOOK_PUBLIC_KEY: spki } } } as typeof h0;
    // Rebind call to the new deps.
    const { route } = await import('../src/handlers.ts');
    const call = async (path: string, body: unknown, opts: { origin?: string | null; ip?: string; headers?: Record<string, string> } = {}) => {
      const headers = new Headers({ 'content-type': 'application/json', 'cf-connecting-ip': opts.ip ?? '198.51.100.20', ...(opts.headers ?? {}) });
      const origin = opts.origin === undefined ? (path.endsWith('/google-match') ? 'https://vault.test' : 'https://auth.test') : opts.origin;
      if (origin) headers.set('origin', origin);
      const pending: Promise<unknown>[] = [];
      const res = await route(new Request(`https://api.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), { ...h.deps, waitUntil: (p) => void pending.push(p) });
      await Promise.all(pending);
      return res;
    };
    const app = await seedApp(h0);
    const now = Math.floor(Date.now() / 1000);
    const access = await jwt(pair.privateKey, { iss: `https://${team}`, aud: [aud], sub: 'staff-sub', email: 'staff@example.com', exp: now + 600, iat: now });
    const victim = `Vi.Ctim${uid().replace(/[^a-z0-9]/gu, '')}`;
    const vAddr = `${victim.toLowerCase()}@example.com`;
    const supp = `sup${uid().replace(/[^a-z0-9]/gu, '')}@example.com`;
    const corp = `corp${uid().replace(/[^a-z0-9]/gu, '')}@corp.example`;
    const secrets: string[] = [];
    const { lines } = await captureLogs(async () => {
      // A suppressed address (start and resend take the same path, no mail).
      await h.deps.env.DB.prepare('INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3)').bind(await suppressionKey(await h.deps.keys(), supp), 'complaint', h.clock.now).run();
      const sp = (await (await call('/v1/email/start', { pk: app.pk, email: supp, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json })).json()) as { challengeId: string };
      secrets.push(sp.challengeId);
      // A guessing trip on the victim's mailbox (18 failures from four requesters).
      for (const [i, n] of [5, 5, 5, 3].entries()) {
        const ip = `203.0.113.${50 + i}`;
        const s = (await (await call('/v1/email/start', { pk: app.pk, email: `${victim}@example.com`, purpose: 'session', commitment: sessionCommitment(app.scope, h.clock.now).json }, { ip })).json()) as { challengeId: string };
        secrets.push(s.challengeId, h0.sender.codeFor(vAddr));
        for (let k = 0; k < n; k++) await call('/v1/email/verify', { challengeId: s.challengeId, code: h0.sender.codeFor(vAddr) === '000000' ? '111111' : '000000' }, { ip });
      }
      // Staff: unlock and unsuppress (the address is in the body, never in a line).
      await call('/v1/email/admin/unlock', { email: `${victim}@example.com`, ticket: 'SUP-1' }, { origin: null, headers: { 'cf-access-jwt-assertion': access } });
      await call('/v1/email/admin/unsuppress', { email: supp, ticket: 'SUP-2' }, { origin: null, headers: { 'cf-access-jwt-assertion': access } });
      // Case A, not Google-hosted: a prepared challenge, its first code by resend, verify mints auto_link and notifies.
      const eSub = await emailSub((await h.deps.keys()).sub, corp);
      secrets.push(eSub);
      h0.chain.open(app.scope, 'email', eSub);
      const acc = { sub: `1${Math.floor(Math.random() * 1e15)}`, email: corp };
      const c = sessionCommitment(app.scope, h.clock.now);
      const accessToken = h0.google.accessToken(acc, GOOGLE_CLIENT);
      const googleIdToken = await h0.google.idToken(acc, GOOGLE_CLIENT, nonceFor(c));
      secrets.push(accessToken, googleIdToken);
      const m = (await (await call('/v1/email/google-match', { pk: app.pk, accessToken, googleIdToken, commitment: c.json, link: true })).json()) as { challenge: { challengeId: string } };
      secrets.push(m.challenge.challengeId);
      await call('/v1/email/resend', { challengeId: m.challenge.challengeId });
      const code = h0.sender.codeFor(corp);
      secrets.push(code);
      const v = (await (await call('/v1/email/verify', { challengeId: m.challenge.challengeId, code })).json()) as { idToken: string; deviceTicket: string };
      secrets.push(v.idToken, v.deviceTicket);
      // The webhook: a bounce for the victim.
      const body = JSON.stringify([{ event: 'bounce', type: 'bounce', email: vAddr, category: ['hana-id-code'] }]);
      const ts = String(Math.floor(h.clock.now / 1000));
      const sig = base64Encode(derOf(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ec.privateKey, utf8(ts + body)))));
      await route(new Request('https://api.test/v1/email/webhooks/sendgrid', { method: 'POST', body, headers: { 'cf-connecting-ip': '198.51.100.30', 'x-twilio-email-event-webhook-timestamp': ts, 'x-twilio-email-event-webhook-signature': sig } }), h.deps);
    });
    const all = lines.join('\n');
    expect(all).toContain('"mailbox_guess_limit"');
    expect(all).toContain('"mailbox_unlocked"');
    expect(all).toContain('"suppression_removed"');
    expect(all).toContain('"link_notice"');
    expect(h0.sender.to(corp).some((x) => x.kind === 'link_notice')).toBe(true);
    for (const needle of [victim, vAddr, victim.toLowerCase(), supp, corp, ...secrets]) expect(all).not.toContain(needle);
    for (const l of lines) expect(l.startsWith('{"level"')).toBe(true);
  });
});
