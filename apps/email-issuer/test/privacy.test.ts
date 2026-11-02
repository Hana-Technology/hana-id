// The log-capture test (spec "Tests" → "Issuer": "nothing logged (a log-capture test greps for the address, code, sub
// and token)"): every line of every flow, errors included, is grepped for the address (raw and normalized), the code,
// the sub, every token, the Google access token and every secret binding.
import { describe, expect, it } from 'vitest';
import { emailSub } from '@hana-id/email';
import { SECRET_NAMES } from '../src/env.ts';
import { GOOGLE_CLIENT, captureLogs, env, harness, nonceFor, seedApp, sessionCommitment, uid } from './helpers.ts';

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
});
