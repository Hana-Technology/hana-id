// POST /v1/identity/token, the JWKS and discovery endpoints, the signer, the counts and the cross-use refusals
// (docs/identity-token-spec.md "API endpoints", "Tests"; build steps 1–4, no email claim).
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCachedApps } from '../src/app-cache.ts';
import { hex } from '../src/bytes.ts';
import { limiter } from '../src/handlers.ts';
import { IDENTITY_COUNTS_RETENTION_MS, identityMaintenance } from '../src/identity/maintenance.ts';
import { IDENTITY_GLOBAL_LIMITER, IDENTITY_PER_SESSION_MINUTE, identityProofLimiter } from '../src/identity/limits.ts';
import { JWKS_MAX_AGE_S } from '../src/identity/public.ts';
import { IdentitySignerError, WorkerSecretSigner, clearIdentitySignerCache, identityConfig, publicIdentityConfig, verifyEs256, workerSecretSigner } from '../src/identity/signer.ts';
import { toMintRequest } from '../src/identity/token.ts';
import { clearViewCaches } from '../src/views.ts';
import { GOOGLE_ISS, ORIGIN, appHeaders, call, google, newSessionKey, seedApp, sessionBody, uid, minuteHeadroom } from './helpers.ts';
import { limiterKeys, mint, mintBody, publishedKids, randomPrk, setSlidingBucket, verifyToken } from './identity-helpers.ts';
import { hanaHeaders, loginBody } from './login-helpers.ts';
import { HOUR, VAULT, act, createShare, setSettings, setShare, spentSession, storedShare, vaultHeaders, vaultSetup } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearIdentitySignerCache();
});

const MIN = 60_000;
const [ACTIVE_KID, STANDBY_KID] = publishedKids() as [string, string];

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function expectCode(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const b = await body(res);
  expect({ status: res.status, code: b.code }).toEqual({ status, code });
  return b;
}

/** A 'session'-mode app with a live share for a fresh session key. */
async function sessionSetup(opts: { sub?: string; expiresAtMs?: number } = {}) {
  const { app, near } = await vaultSetup();
  const share = await createShare(app, near, opts);
  return { app, near, share, spk: share.spk };
}

describe('POST /v1/identity/token: a valid mint', () => {
  it('answers a token that verifies against the JWKS, with exactly the spec claims', async () => {
    const { app, share, spk } = await sessionSetup();
    const prk = randomPrk();
    const before = Math.floor(Date.now() / 1000);
    const res = await mint(app, spk, { prk });
    const b = await expectCode(res, 200, undefined as unknown as string);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe(VAULT);
    expect(Object.keys(b).sort()).toEqual(['emailStatus', 'expiresAtMs', 'identityToken', 'requestId']);
    expect(b.emailStatus).toBe('off');
    const { header, claims } = await verifyToken(b.identityToken as string);
    expect(header).toEqual({ alg: 'ES256', kid: ACTIVE_KID, typ: 'hana-identity+jwt' });
    expect(Object.keys(claims)).toEqual(['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'wallets', 'login_methods']);
    expect(claims.iss).toBe('https://api.test/v1/identity');
    expect(claims.aud).toBe(app.id);
    expect(claims.sub).toMatch(/^u1_[A-Za-z0-9_-]{22}$/u);
    expect(claims.sid).toMatch(/^s1_[A-Za-z0-9_-]{22}$/u);
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(claims.login_methods).toEqual(['google']);
    const { deriveAddresses } = await import('@hana-id/core/derivation');
    const addresses = deriveAddresses(prk);
    expect(claims.wallets).toEqual([
      { chain: 'stellar', address: addresses.stellar },
      { chain: 'evm', address: addresses.evm },
    ]);
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    // 'session' mode: capped at the share's idle limit (2 h by default) and its other limits, so 1 h here.
    expect(claims.exp).toBe((claims.iat as number) + 3600);
    expect(b.expiresAtMs).toBe((claims.exp as number) * 1000);
    expect(JSON.stringify(claims)).not.toContain('1234567890');
    expect(JSON.stringify(claims)).not.toContain(app.scope);
    // The share is untouched: a mint is never activity.
    expect((await storedShare(share.shareId))!.counter).toBe(0);
  });

  it('never moves the share: counter and idle_until are the same before and after', async () => {
    const { app, share, spk } = await sessionSetup();
    expect((await act(app, share, 'unlock', 1)).status).toBe(200);
    const before = await storedShare(share.shareId);
    for (let i = 0; i < 3; i++) expect((await mint(app, spk)).status).toBe(200);
    expect(await storedShare(share.shareId)).toEqual(before);
  });

  it('sub is per scope and account root (key_index ignored), sid per session key', async () => {
    const { app, near } = await vaultSetup();
    const a = await createShare(app, near, { sub: '42' });
    const b = await createShare(app, near, { sub: '42' });
    // A key_index move (D8) keeps the person: the same path but #1.
    near.sessions.set(JSON.stringify(b.spk), { ...near.sessions.get(JSON.stringify(b.spk))!, path: `${app.scope}#google#42#1` });
    const other = await createShare(app, near, { sub: '43' });
    const claimsOf = async (spk: number[]) => (await verifyToken((await body(await mint(app, spk))).identityToken as string)).claims;
    const [ca, cb, co, ca2] = [await claimsOf(a.spk), await claimsOf(b.spk), await claimsOf(other.spk), await claimsOf(a.spk)];
    expect(ca.sub).toBe(cb.sub);
    expect(ca.sub).not.toBe(co.sub);
    expect(ca.sid).not.toBe(cb.sid);
    expect(ca.sid).toBe(ca2.sid);
    expect(ca.jti).not.toBe(ca2.jti);
  });

  it('another app on the same scope gets the same sub and a different sid', async () => {
    const { app, near, spk } = await sessionSetup({ sub: '77' });
    const twin = await seedApp({ scope: app.scope });
    const twinShare = await createShare(twin, near, { sub: '77' });
    const one = (await verifyToken((await body(await mint(app, spk))).identityToken as string)).claims;
    const two = (await verifyToken((await body(await mint(twin, twinShare.spk))).identityToken as string)).claims;
    expect(one.sub).toBe(two.sub);
    expect(one.sid).not.toBe(two.sid);
    expect(two.aud).toBe(twin.id);
  });

  it("'none' mode: no share, the chain session alone decides; exp capped at its on-chain expiry", async () => {
    const { app, near } = await vaultSetup();
    await setSettings(app.id, { persistence: 'none' });
    forgetCachedApps();
    const spk = spentSession(near, app.scope, { expiresAtMs: Date.now() + 20 * MIN });
    const res = await mint(app, spk);
    const b = await expectCode(res, 200, undefined as unknown as string);
    const { claims } = await verifyToken(b.identityToken as string);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(20 * 60);
    expect((claims.exp as number) - (claims.iat as number)).toBeGreaterThan(19 * 60);
  });

  it('exp is capped at the share’s idle limit', async () => {
    const { app, share, spk } = await sessionSetup();
    await setShare(share.shareId, { idle_until: Date.now() + 10 * MIN });
    const { claims } = await verifyToken((await body(await mint(app, spk))).identityToken as string);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
    expect((claims.exp as number) - (claims.iat as number)).toBeGreaterThan(590);
  });

  it('a non-EIP-55 EVM address is normalized in the claims', async () => {
    const { app, spk } = await sessionSetup();
    const prk = randomPrk();
    const ok = await expectCode(await mint(app, spk, { prk, lowercaseEvm: true }), 200, undefined as unknown as string);
    const { claims } = await verifyToken(ok.identityToken as string);
    const { deriveAddresses } = await import('@hana-id/core/derivation');
    expect((claims.wallets as { address: string }[])[1]!.address).toBe(deriveAddresses(prk).evm);
  });

  it('counts one token per kid and hour and per app and day, after the response', async () => {
    const { app, spk } = await sessionSetup();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    const before = (await env.DB.prepare('SELECT count FROM identity_issuance_hourly WHERE hour = ?1 AND kid = ?2').bind(hour, ACTIVE_KID).first<{ count: number }>())?.count ?? 0;
    const exec = createExecutionContext();
    expect((await mint(app, spk, { exec })).status).toBe(200);
    await waitOnExecutionContext(exec);
    expect((await mint(app, spk)).status).toBe(200);
    const after = await env.DB.prepare('SELECT count FROM identity_issuance_hourly WHERE hour = ?1 AND kid = ?2').bind(hour, ACTIVE_KID).first<{ count: number }>();
    expect(after!.count).toBe(before + 2);
    const usage = await env.DB.prepare('SELECT tokens FROM identity_usage WHERE app_id = ?1').bind(app.id).first<{ tokens: number }>();
    expect(usage!.tokens).toBe(2);
  });

  it('logs no token, sub, sid, address or session key; the request log has the kid', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((l: unknown) => void lines.push(String(l)));
    const { app, spk } = await sessionSetup();
    const prk = randomPrk();
    const b = await body(await mint(app, spk, { prk }));
    const { claims } = await verifyToken(b.identityToken as string);
    const text = lines.join('\n');
    const { deriveAddresses } = await import('@hana-id/core/derivation');
    const a = deriveAddresses(prk);
    for (const secret of [b.identityToken as string, claims.sub as string, claims.sid as string, claims.jti as string, a.stellar, a.evm, a.evm.toLowerCase(), hex(Uint8Array.from(spk))]) expect(text).not.toContain(secret);
    const request = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'request' && l.endpoint === '/v1/identity/token');
    expect(request).toMatchObject({ outcome: 'ok', status: 200, kid: ACTIVE_KID, appId: app.id });
  });
});

describe('POST /v1/identity/token: refusals, in order', () => {
  it('vault gate: key, Origin = vault, parent allowed', async () => {
    const { app, spk } = await sessionSetup();
    const b = await mintBody(app, spk);
    await expectCode(await call('/v1/identity/token', { headers: { origin: VAULT, 'x-hana-parent-origin': ORIGIN }, body: b }), 401, 'missing_key');
    await expectCode(await call('/v1/identity/token', { headers: vaultHeaders(app, ORIGIN, ORIGIN), body: b }), 403, 'origin_not_allowed');
    await expectCode(await call('/v1/identity/token', { headers: vaultHeaders(app, 'https://evil.example'), body: b }), 403, 'origin_not_allowed');
    await expectCode(await call('/v1/identity/token', { headers: vaultHeaders(app, null), body: b }), 403, 'origin_not_allowed');
  });

  it('preflight: only the vault origin', async () => {
    const ok = await call('/v1/identity/token', { method: 'OPTIONS', headers: { origin: VAULT, 'access-control-request-method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toContain('x-hana-parent-origin');
    expect((await call('/v1/identity/token', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })).status).toBe(403);
    expect((await call('/v1/identity/token', { method: 'GET' })).status).toBe(405);
  });

  it('503 identity_unavailable without the configuration (or with a sub key missing)', async () => {
    const { app, spk } = await sessionSetup();
    await expectCode(await mint(app, spk, { env: { IDENTITY_ISS: undefined } }), 503, 'identity_unavailable');
    await expectCode(await mint(app, spk, { env: { IDENTITY_SUB_KEY: undefined } }), 503, 'identity_unavailable');
    await expectCode(await mint(app, spk, { env: { IDENTITY_SUB_KEY: 'short' } }), 503, 'identity_unavailable');
    await expectCode(await mint(app, spk, { env: { IDENTITY_ACTIVE_KID: 'A'.repeat(43) } }), 503, 'identity_unavailable');
  });

  it('400 bad_request for a malformed body', async () => {
    const { app, spk } = await sessionSetup();
    for (const mutate of [
      (b: Record<string, unknown>) => void (b.extra = 1),
      (b: Record<string, unknown>) => void delete b.nonce,
      (b: Record<string, unknown>) => void (b.sessionPublicKey = (b.sessionPublicKey as number[]).slice(1)),
      (b: Record<string, unknown>) => void (b.issuedAtMs = 'now'),
      (b: Record<string, unknown>) => void ((b.walletProofs as Record<string, unknown>).evm = undefined),
      (b: Record<string, unknown>) => void (((b.walletProofs as Record<string, { signature: number[] }>).evm!.signature = [1, 2, 3])),
      (b: Record<string, unknown>) => void (b.sealedEmail = ''),
    ]) {
      await expectCode(await mint(app, spk, { mutate }), 400, 'bad_request');
    }
    await expectCode(await call('/v1/identity/token', { headers: vaultHeaders(app), rawBody: 'x'.repeat(5000) }), 413, 'bad_request');
  });

  it('400 stale_proof for a proof more than 60 s old or ahead, with the server time', async () => {
    const { app, spk } = await sessionSetup();
    for (const skew of [-61_000, 61_000]) {
      const b = await expectCode(await mint(app, spk, { issuedAtMs: Date.now() + skew }), 400, 'stale_proof');
      expect(typeof b.serverTimeMs).toBe('number');
    }
    expect((await mint(app, spk, { issuedAtMs: Date.now() - 55_000 })).status).toBe(200);
  });

  it('401 invalid_signature: another app, another signer, another parent, another key', async () => {
    const { app, near, spk } = await sessionSetup();
    await expectCode(await mint(app, spk, { signAsApp: 'app_other' }), 401, 'invalid_signature');
    await expectCode(await mint(app, spk, { signAsSigner: 'other.testnet' }), 401, 'invalid_signature');
    // Signed for another parent, sent from this one.
    await expectCode(await mint(app, spk, { headers: { 'x-hana-parent-origin': ORIGIN }, parent: 'https://other.example' }), 401, 'invalid_signature');
    const other = spentSession(near, app.scope);
    await expectCode(await mint(app, spk, { signWith: other }), 401, 'invalid_signature');
    // A proof whose wallet proofs were swapped after signing (the session proof covers them).
    await expectCode(
      await mint(app, spk, {
        mutate: (b) => {
          const p = b.walletProofs as { stellar: { signature: number[] } };
          p.stellar.signature = p.stellar.signature.map((x, i) => (i === 0 ? x ^ 1 : x));
        },
      }),
      401,
      'invalid_signature',
    );
  });

  it('409 proof_replayed: a proof is single use', async () => {
    const { app, spk } = await sessionSetup();
    const b = await mintBody(app, spk);
    expect((await call('/v1/identity/token', { headers: vaultHeaders(app), body: b })).status).toBe(200);
    await expectCode(await call('/v1/identity/token', { headers: vaultHeaders(app), body: b }), 409, 'proof_replayed');
    const marker = await limiter(env, identityProofLimiter(hex(Uint8Array.from(spk)))).reserve('probe', Date.now() + 1000);
    expect(marker).toBe(true);
  });

  it('429 rate_limited after IDENTITY_PER_SESSION_MINUTE mints of one session key in a minute', async () => {
    // A Rate Limiting binding (its own clock): all the mints in one minute window.
    await minuteHeadroom();
    const { app, spk } = await sessionSetup();
    for (let i = 0; i < IDENTITY_PER_SESSION_MINUTE; i++) expect((await mint(app, spk)).status).toBe(200);
    const res = await mint(app, spk);
    await expectCode(res, 429, 'rate_limited');
    expect(res.headers.get('retry-after')).toBe('60');
  }, 20_000);

  it('503 paused while the contract is paused', async () => {
    const { app, near, spk } = await sessionSetup();
    near.paused = true;
    clearViewCaches();
    const res = await mint(app, spk);
    await expectCode(res, 503, 'paused');
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it("'session' mode: 410 session_ended for each share state, without writing the share", async () => {
    const reasonOf = async (res: Response) => (await expectCode(res, 410, 'session_ended')).reason;

    const revoked = await sessionSetup();
    expect((await act(revoked.app, revoked.share, 'revoke', 1)).status).toBe(200);
    expect(await reasonOf(await mint(revoked.app, revoked.spk))).toBe('share_revoked');

    const idle = await sessionSetup();
    await setShare(idle.share.shareId, { idle_until: Date.now() - 1 });
    expect(await reasonOf(await mint(idle.app, idle.spk))).toBe('share_expired');

    const capped = await sessionSetup();
    await setShare(capped.share.shareId, { created_at: Date.now() - 2 * HOUR });
    await setSettings(capped.app.id, { session_ttl_ms: HOUR, idle_ttl_ms: 15 * MIN });
    const cappedBefore = await storedShare(capped.share.shareId);
    expect(await reasonOf(await mint(capped.app, capped.spk))).toBe('share_expired');
    expect(await storedShare(capped.share.shareId)).toEqual(cappedBefore);

    const off = await sessionSetup();
    await setSettings(off.app.id, { persistence: 'none' });
    expect(await reasonOf(await mint(off.app, off.spk))).toBe('persistence_off');
    expect((await storedShare(off.share.shareId))!.revoked_at).toBeNull();

    const removed = await sessionSetup();
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(removed.app.id, 'https://second.example').run();
    forgetCachedApps();
    await env.DB.prepare('UPDATE vault_shares SET partner_origin = ?2 WHERE share_id = ?1').bind(Uint8Array.from(removed.share.shareId), 'https://gone.example').run();
    expect(await reasonOf(await mint(removed.app, removed.spk))).toBe('share_revoked');

    // A share made for another of the app's parents.
    const elsewhere = await sessionSetup();
    await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(elsewhere.app.id, 'https://second.example').run();
    forgetCachedApps();
    expect(await reasonOf(await mint(elsewhere.app, elsewhere.spk, { parent: 'https://second.example' }))).toBe('unknown_share');

    // A session key with no share at all, in an app that keeps logins.
    const { app, near } = await vaultSetup();
    expect(await reasonOf(await mint(app, spentSession(near, app.scope)))).toBe('unknown_share');
  });

  it('410 session_ended no_session: revoked on chain, before sessions_valid_from_ms (null), or expired', async () => {
    const { app, near, spk } = await sessionSetup();
    near.sessions.set(JSON.stringify(spk), { ...near.sessions.get(JSON.stringify(spk))!, revoked: true });
    clearViewCaches();
    expect((await expectCode(await mint(app, spk), 410, 'session_ended')).reason).toBe('no_session');

    const { app: noneApp, near: n2 } = await vaultSetup();
    await setSettings(noneApp.id, { persistence: 'none' });
    expect((await expectCode(await mint(noneApp, newSessionKey()), 410, 'session_ended')).reason).toBe('no_session');
    const expired = spentSession(n2, noneApp.scope, { expiresAtMs: Date.now() - 1 });
    expect((await expectCode(await mint(noneApp, expired), 410, 'session_ended')).reason).toBe('no_session');
  });

  it('a cached session that would refuse is re-read fresh', async () => {
    const { app, near, spk } = await sessionSetup();
    const live = near.sessions.get(JSON.stringify(spk))!;
    near.sessions.set(JSON.stringify(spk), { ...live, scope_id: 'someotherscope' });
    clearViewCaches();
    await expectCode(await mint(app, spk), 403, 'scope_mismatch');
    // The isolate now caches the refusing view; the chain is right again: the next mint re-reads it.
    near.sessions.set(JSON.stringify(spk), live);
    expect((await mint(app, spk)).status).toBe(200);
  });

  it('a session the node doesn’t show yet (a block behind the login) is re-read before refusing', async () => {
    const { app, near } = await vaultSetup();
    await setSettings(app.id, { persistence: 'none' });
    const spk = newSessionKey();
    setTimeout(() => near.sessions.set(JSON.stringify(spk), { path: `${app.scope}#google#9#0`, scope_id: app.scope, expires_at_ms: Date.now() + HOUR, max_uses: 1, used: 1 }), 400);
    expect((await mint(app, spk)).status).toBe(200);
  });

  it('403 scope_mismatch for a session in another scope', async () => {
    const { app, near } = await vaultSetup();
    await setSettings(app.id, { persistence: 'none' });
    const spk = spentSession(near, 'someotherscope');
    await expectCode(await mint(app, spk), 403, 'scope_mismatch');
  });

  it('502 near_unavailable when the chain can’t be read', async () => {
    const { app, near, spk } = await sessionSetup();
    near.views.get_session = () => {
      throw new Error('down');
    };
    clearViewCaches();
    await expectCode(await mint(app, spk), 502, 'near_unavailable');
  });

  it('410 session_ending with less than 30 s left', async () => {
    const { app, share, spk } = await sessionSetup();
    await setShare(share.shareId, { idle_until: Date.now() + 20_000 });
    await expectCode(await mint(app, spk), 410, 'session_ending');
  });

  it('400 bad_wallet_proof: a proof for another session or app, a swapped address', async () => {
    const { app, near, spk } = await sessionSetup();
    expect((await expectCode(await mint(app, spk, { proofSpk: spentSession(near, app.scope) }), 400, 'bad_wallet_proof')).chain).toBe('stellar');
    expect((await expectCode(await mint(app, spk, { proofApp: 'app_other' }), 400, 'bad_wallet_proof')).chain).toBe('stellar');
  });

  it('503 identity_busy once the global hourly ceiling is reached (critical log), and it clears as the window slides', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void errors.push(String(l)));
    const { app, spk } = await sessionSetup();
    await setSlidingBucket(IDENTITY_GLOBAL_LIMITER, 'hour', HOUR, 500);
    try {
      const res = await mint(app, spk, { env: { IDENTITY_GLOBAL_HOURLY_MAX: '400' } });
      await expectCode(res, 503, 'identity_busy');
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(errors.some((l) => l.includes('"identity_ceiling"'))).toBe(true);
      // Raised (as the default is), the same request shape passes.
      expect((await mint(app, spk, { env: { IDENTITY_GLOBAL_HOURLY_MAX: '1000000' } })).status).toBe(200);
    } finally {
      await setSlidingBucket(IDENTITY_GLOBAL_LIMITER, 'hour', HOUR, null);
    }
  });

  it('503 identity_signer_unavailable when no signing key has the active kid, or it is unusable', async () => {
    const { app, spk } = await sessionSetup();
    await expectCode(await mint(app, spk, { env: { IDENTITY_SIGNING_KEY: 'not json' } }), 503, 'identity_signer_unavailable');
    clearIdentitySignerCache();
    await expectCode(await mint(app, spk, { env: { IDENTITY_SIGNING_KEY: env.IDENTITY_SIGNING_KEY_STANDBY } }), 503, 'identity_signer_unavailable');
  });
});

describe('the standby switch (rotation playbook)', () => {
  it('IDENTITY_ACTIVE_KID = the standby kid: the standby secret signs, and the token verifies against the same JWKS', async () => {
    const { app, spk } = await sessionSetup();
    const res = await mint(app, spk, { env: { IDENTITY_ACTIVE_KID: STANDBY_KID } });
    const b = await expectCode(res, 200, undefined as unknown as string);
    const { header } = await verifyToken(b.identityToken as string);
    expect(header.kid).toBe(STANDBY_KID);
  });
});

describe('the Worker-secret signer', () => {
  const config = () => {
    const c = identityConfig(env);
    if (typeof c === 'string') throw new Error(c);
    return c;
  };

  it('ES256 round trip in JOSE form (64 bytes), verified with the published key', async () => {
    const signer = await workerSecretSigner(env, config());
    expect(signer.kid).toBe(ACTIVE_KID);
    const input = new TextEncoder().encode('a.b');
    const sig = await signer.sign(input);
    expect(sig).toHaveLength(64);
    const published = config().keys.find((k) => k.kid === ACTIVE_KID)!;
    expect(await verifyEs256(published, sig, input)).toBe(true);
    expect(await verifyEs256(published, sig, new TextEncoder().encode('a.c'))).toBe(false);
  });

  it('refuses to answer a signature the published key doesn’t verify (self-verify)', async () => {
    const standby = config().keys.find((k) => k.kid === STANDBY_KID)!;
    const jwk = JSON.parse(env.IDENTITY_SIGNING_KEY!) as { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string };
    const mismatched = await WorkerSecretSigner.create(jwk, standby);
    await expect(mismatched.sign(new TextEncoder().encode('x'))).rejects.toBeInstanceOf(IdentitySignerError);
  });

  it('the public configuration refuses keys with a private member, a wrong kid or duplicates', () => {
    const keys = JSON.parse(env.IDENTITY_PUBLIC_KEYS!) as Record<string, unknown>[];
    const pub = (k: unknown) => publicIdentityConfig({ IDENTITY_ISS: 'https://api.test/v1/identity', IDENTITY_PUBLIC_KEYS: JSON.stringify(k), IDENTITY_ACTIVE_KID: ACTIVE_KID });
    expect(typeof pub(keys)).toBe('object');
    expect(pub([{ ...keys[0], d: 'x'.repeat(43) }])).toBe('bad_public_keys');
    expect(pub([{ ...keys[0], kid: STANDBY_KID }])).toBe('bad_public_keys');
    expect(pub([keys[0], keys[0]])).toBe('bad_public_keys');
    expect(pub([keys[1]])).toBe('active_kid_not_published');
    expect(pub('nope')).toBe('bad_public_keys');
  });
});

describe('toMintRequest', () => {
  it('takes exactly the spec fields', async () => {
    const b = await mintBody({ id: 'app_x' }, newSessionKey());
    expect(toMintRequest(b)).not.toBeNull();
    expect(toMintRequest({ ...b, sealedEmail: 'se1.x' })?.sealedEmail).toBe('se1.x');
    expect(toMintRequest({ ...b, x: 1 })).toBeNull();
    expect(toMintRequest({ ...b, walletProofs: { ...(b.walletProofs as object), solana: {} } })).toBeNull();
    expect(toMintRequest(null)).toBeNull();
  });
});

describe('GET /v1/identity/jwks.json and the discovery document', () => {
  it('the JWKS: the manifest keys, public members only, cache 600 s, CORS *', async () => {
    const res = await call('/v1/identity/jwks.json', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${JWKS_MAX_AGE_S}`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('application/json');
    const keys = JSON.parse(env.IDENTITY_PUBLIC_KEYS!) as Record<string, string>[];
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ keys: keys.map((k) => ({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y, kid: k.kid, use: 'sig', alg: 'ES256' })) });
    expect(text).not.toContain('"d"');
    const head = await call('/v1/identity/jwks.json', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await call('/v1/identity/jwks.json', { method: 'OPTIONS' })).status).toBe(204);
    expect((await call('/v1/identity/jwks.json', { body: {} })).status).toBe(405);
  });

  it('kids are RFC 7638 thumbprints', async () => {
    const { jwkThumbprint } = await import('@hana-id/core/identity');
    const { keys } = (await (await call('/v1/identity/jwks.json', { method: 'GET' })).json()) as { keys: { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string }[] };
    for (const k of keys) expect(jwkThumbprint(k)).toBe(k.kid);
  });

  it('the discovery document', async () => {
    const res = await call('/v1/identity/.well-known/openid-configuration', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${JWKS_MAX_AGE_S}`);
    expect(await res.json()).toEqual({
      issuer: 'https://api.test/v1/identity',
      jwks_uri: 'https://api.test/v1/identity/jwks.json',
      id_token_signing_alg_values_supported: ['ES256'],
      subject_types_supported: ['pairwise'],
      claims_supported: ['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti', 'wallets', 'login_methods', 'email', 'email_verified'],
    });
  });

  it('503 identity_unavailable without the configuration', async () => {
    const res = await call('/v1/identity/jwks.json', { method: 'GET', env: { IDENTITY_PUBLIC_KEYS: undefined } });
    await expectCode(res, 503, 'identity_unavailable');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('no Hana API accepts an identity token (400 bad_token)', () => {
  async function aToken(): Promise<string> {
    const { app, spk } = await sessionSetup();
    return (await body(await mint(app, spk))).identityToken as string;
  }

  it('/v1/login and /v1/sessions refuse it before anything else', async () => {
    const token = await aToken();
    const app = await seedApp();
    const aud = `${uid()}.apps.googleusercontent.com`;
    const login = await loginBody(app.scope, aud);
    await expectCode(await call('/v1/login', { headers: hanaHeaders(app), body: { ...login, jwt: token } }), 400, 'bad_token');
    const session = await sessionBody(app.scope, aud);
    await expectCode(await call('/v1/sessions', { headers: appHeaders(app), body: { ...session, jwt: token } }), 400, 'bad_token');
  });

  it('owner actions refuse it as the owner token and as a client proof', async () => {
    const token = await aToken();
    await expectCode(await call('/v1/owner-actions', { body: { method: 'cancel_change', args: { scope_id: 's1', auth: { Oidc: { jwt: token } }, change_id: 0 } } }), 400, 'bad_token');
  });

  it('a token claiming the identity issuer is refused even without the identity typ', async () => {
    // An RS256 token from the test Google key, but with iss = the identity issuer.
    const forged = await google.sign({ iss: env.IDENTITY_ISS, aud: 'x', sub: '1', exp: Math.floor(Date.now() / 1000) + 60 });
    const { verifyIdToken, JwksUnavailableError } = await import('@hana-id/oidc');
    expect(await verifyIdToken(forged, Date.now(), { identityIssuer: env.IDENTITY_ISS })).toMatchObject({ ok: false, code: 'bad_token' });
    expect(await verifyIdToken(forged, Date.now())).toMatchObject({ ok: false, code: 'unsupported_issuer' });
    const real = await google.sign({ iss: GOOGLE_ISS, aud: 'x', sub: '1', exp: Math.floor(Date.now() / 1000) + 60 });
    // Past the identity-issuer refusal it goes on to the key lookup; whether that lookup can reach the JWKS isn't this test's concern.
    const outcome = await verifyIdToken(real, Date.now(), { identityIssuer: env.IDENTITY_ISS }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(JwksUnavailableError);
      return null;
    });
    expect(outcome === null || outcome.ok || outcome.code !== 'bad_token').toBe(true);
  });
});

describe('identity maintenance (hourly cron)', () => {
  it('deletes counts past 24 months, keeps the rest', async () => {
    const app = await seedApp();
    const now = Date.now();
    const old = now - IDENTITY_COUNTS_RETENTION_MS - HOUR;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO identity_issuance_hourly (hour, kid, count) VALUES (?1, ?2, 5)').bind(Math.floor(old / HOUR) * HOUR, 'old-kid'),
      env.DB.prepare('INSERT INTO identity_issuance_hourly (hour, kid, count) VALUES (?1, ?2, 5)').bind(Math.floor(now / HOUR) * HOUR, 'new-kid'),
      env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 1)').bind(app.id, new Date(old - 24 * HOUR).toISOString().slice(0, 10)),
      env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 1)').bind(app.id, new Date(now).toISOString().slice(0, 10)),
    ]);
    const { pruned } = await identityMaintenance(env, now);
    expect(pruned).toBeGreaterThanOrEqual(2);
    expect(await env.DB.prepare("SELECT kid FROM identity_issuance_hourly WHERE kid IN ('old-kid', 'new-kid')").all()).toMatchObject({ results: [{ kid: 'new-kid' }] });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM identity_usage WHERE app_id = ?1').bind(app.id).first<{ n: number }>())!.n).toBe(1);
  });
});
