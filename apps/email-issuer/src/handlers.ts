// The issuer's endpoints (docs/email-login-spec.md "Endpoints"; docs/api.md "Email issuer"). POST JSON, CORS for one
// Hana origin each (start, resend, verify: authOrigin; google-match: the vault's origin, D199), no cookies, every
// response `Cache-Control: no-store`; only `start` carries an address. Enumeration-safe: `start` answers 202 with the
// same body for every valid address and does every address-dependent step (suppression, lock, per-address limits, the
// send) after the response, in waitUntil.
import { base64UrlDecode, base64UrlEncode, sha256, toHex } from './bytes.ts';
import { emailSub, isDisposableDomain, isGoogleHosted, normalizeEmail } from '@hana-id/email';
import { type IssuerApp, appById, appByKey, isPublishableKey } from './apps.ts';
import { type ChallengeRecord, type TicketRecord } from './challenge.ts';
import { ChainUnavailable } from './chain.ts';
import { type Purpose, commitmentNonce, isScopeId, parseSessionCommitment } from './commitment.ts';
import { type Judgement, type Side, judge } from './decide.ts';
import type { Deps } from './deps.ts';
import { dailySendBudget } from './env.ts';
import { GoogleUnavailable } from './google.ts';
import { corsHeaders, error, isObj, json, onlyKeys, readJson } from './http.ts';
import { ipSubject } from './ip.ts';
import { type EmailClaims, TOKEN_LIFETIME_S, mintJws } from './jws.ts';
import { CODE_RE, KeysUnavailable, codeMac, emailKey, newCode, randomId } from './keys.ts';
import { autoLinkPreimage, clientProofPreimage, EMAIL_PROVIDER, identityKey, nonceOf, sessionPreimage, type SessionCommitment } from './layouts.ts';
import {
  ADDRESS_CODE_LIMITS,
  ADDRESS_LOCK_MS,
  ADDRESS_WRONG_LIMIT,
  CHALLENGE_TTL_MS,
  IP_MATCH_LIMITS,
  IP_RESEND_LIMITS,
  IP_START_LIMITS,
  IP_VERIFY_LIMITS,
  LINK_TICKET_TTL_MS,
  RESEND_SPACING_MS,
  STAFF_PROOF_LIMITS,
  appStartLimits,
  globalSendLimits,
} from './limits.ts';
import { log } from './log.ts';
import { codeMail, linkNoticeMail } from './mail.ts';
import type { Limit } from './rate-limiter.ts';
import { SignerUnavailable } from './signer.ts';
import { readWebhookBody, SIGNATURE_HEADER, suppressionsOf, TIMESTAMP_HEADER, verifyWebhook } from './webhook.ts';

export const MAX_BODY = 8 * 1024;
/** The `sub` of a staff client proof: not an `e1.` sub, so it can never be an email user's identity. */
export const CLIENT_PROOF_SUB = 'hana-client-proof';
/** Hints read per verify (one address can be reported by a few Google accounts). */
const MAX_HINTS = 4;

type Ctx = { deps: Deps; requestId: string; endpoint: string; cors: Record<string, string> };

const respond = (ctx: Ctx, res: Response): Response => {
  for (const [k, v] of Object.entries(ctx.cors)) res.headers.set(k, v);
  return res;
};
const fail = (ctx: Ctx, status: number, code: string, message: string, data?: Record<string, unknown>, extra: Record<string, string> = {}): Response => {
  log({ event: 'request', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: status >= 500 ? 'error' : 'rejected', status, code }, status >= 500 ? 'error' : 'info');
  return respond(ctx, error(status, code, message, data, extra));
};
const ok = (ctx: Ctx, status: number, body: unknown, fields: Record<string, string | number | undefined> = {}): Response => {
  log({ event: 'request', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'ok', status, ...fields });
  return respond(ctx, json(status, body));
};

const limiter = (deps: Deps, subject: string) => deps.env.RATE_LIMITER.get(deps.env.RATE_LIMITER.idFromName(`${deps.env.ENV_NAME}:${subject}`));
const challengeStub = (deps: Deps, name: string) => deps.env.EMAIL_CHALLENGE.get(deps.env.EMAIL_CHALLENGE.idFromName(name));
const ticketName = (ticket: string): string => `t:${base64UrlEncode(sha256(new TextEncoder().encode(ticket)))}`;
const ipOf = (request: Request): string => ipSubject(request.headers.get('cf-connecting-ip'));
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(v);
const retryHeader = (ms: number): Record<string, string> => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });

async function ipLimit(ctx: Ctx, request: Request, limits: Limit[]): Promise<Response | null> {
  const r = await limiter(ctx.deps, `ip:${ipOf(request)}`).hit(limits, ctx.deps.now());
  if (r.ok) return null;
  log({ event: 'limit', requestId: ctx.requestId, endpoint: ctx.endpoint, limit: r.limit });
  return fail(ctx, 429, 'rate_limited', 'Too many requests, try again later', undefined, retryHeader(r.retryAfterMs));
}

/**
 * The app behind `pk`, with email on: active, `login_methods` lists email, and its scope holds the email client
 * `("email", "email:" + scope_id)` on chain (cached 60 s).
 */
async function emailApp(ctx: Ctx, pk: unknown): Promise<{ ok: true; app: IssuerApp } | { ok: false; response: Response }> {
  if (!isPublishableKey(pk)) return { ok: false, response: fail(ctx, 401, 'invalid_key', 'Unknown publishable key') };
  const app = await appByKey(ctx.deps.env.APP_DB, pk);
  if (!app) return { ok: false, response: fail(ctx, 401, 'invalid_key', 'Unknown publishable key') };
  if (!app.active) return { ok: false, response: fail(ctx, 403, 'app_suspended', 'The app is suspended') };
  if (!app.emailOn) return { ok: false, response: fail(ctx, 403, 'email_not_enabled', 'Email login is not enabled for this app') };
  const scope = await ctx.deps.chain.scope(app.scopeId);
  if (!scope?.clients.some(([p, a]) => p === EMAIL_PROVIDER && a === `email:${app.scopeId}`)) return { ok: false, response: fail(ctx, 409, 'no_email_client', 'The app’s scope has no email client on chain') };
  return { ok: true, app };
}

/** Mints one email token: the issuance row first (so every signature has a row), then the JWS with its self-check. */
async function mint(ctx: Ctx, app: { id: string; scopeId: string } | null, scopeId: string, sub: string, nonce: string, purpose: Purpose | 'client_proof'): Promise<{ token: string; jti: string }> {
  const { deps } = ctx;
  const signers = await deps.signers();
  const iat = Math.floor(deps.now() / 1000);
  const claims: EmailClaims = { iss: deps.env.EMAIL_ISS, aud: `email:${scopeId}`, sub, iat, exp: iat + TOKEN_LIFETIME_S, nonce, jti: randomId(16) };
  const kid = signers[0]!.kid;
  await deps.env.DB.prepare('INSERT INTO email_issuance (jti, app_id, purpose, kid, iat) VALUES (?1, ?2, ?3, ?4, ?5)').bind(claims.jti, app?.id ?? null, purpose, kid, iat).run();
  const token = await mintJws(claims, signers, await deps.publicKeys());
  log({ event: 'token_minted', requestId: ctx.requestId, endpoint: ctx.endpoint, jti: claims.jti, purpose, ...(app ? { appId: app.id } : {}), scopeId, kid });
  return { token, jti: claims.jti };
}

/**
 * Delivers one code mail, after the response: nothing for a suppressed or locked address or one over its code limits
 * (silent, spec "Enumeration resistance"); the send counts only when the provider accepted it. Never throws.
 */
async function deliver(ctx: Ctx, rec: ChallengeRecord, code: string, undelivered?: () => Promise<void>): Promise<void> {
  const { deps } = ctx;
  const now = deps.now();
  const silent = (code_: string) => log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'suppressed', code: code_, appId: rec.appId, purpose: rec.purpose });
  try {
    const suppressed = await deps.env.DB.prepare('SELECT 1 AS x FROM email_suppressions WHERE email_key = ?1').bind(rec.emailKey).first();
    if (suppressed) return silent('suppressed');
    const addr = limiter(deps, `addr:${rec.emailKey}`);
    if (await addr.locked(now)) return silent('locked');
    const a = await addr.hit(ADDRESS_CODE_LIMITS, now);
    if (!a.ok) return silent('address_limit');
    const global = limiter(deps, 'global');
    const g = await global.hit(globalSendLimits(dailySendBudget(deps.env)), now);
    if (!g.ok) {
      await addr.unhit(ADDRESS_CODE_LIMITS, now);
      log({ event: 'send_budget_exhausted', requestId: ctx.requestId, outcome: 'error', code: 'send_budget_exhausted' }, 'error');
      return silent('budget');
    }
    const res = await deps.sender.send(codeMail({ to: rec.email, code, appName: rec.appName, authOrigin: deps.env.AUTH_ORIGIN, purpose: rec.purpose }));
    if (!res.ok) {
      await addr.unhit(ADDRESS_CODE_LIMITS, now);
      await global.unhit(globalSendLimits(dailySendBudget(deps.env)), now);
      await undelivered?.();
      log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: res.reason, appId: rec.appId, ...(res.providerStatus ? { providerStatus: res.providerStatus } : {}) }, 'error');
      return;
    }
    log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'ok', appId: rec.appId, purpose: rec.purpose });
  } catch {
    log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: 'internal', appId: rec.appId }, 'error');
  }
}

/** A link notice to the joining address (spec "Notices"); counted against the global budget only. Never throws. */
async function notify(ctx: Ctx, to: string, appName: string, pending: boolean, appId: string): Promise<void> {
  const { deps } = ctx;
  const now = deps.now();
  try {
    const key = await emailKey(await deps.keys(), to);
    if (await deps.env.DB.prepare('SELECT 1 AS x FROM email_suppressions WHERE email_key = ?1').bind(key).first()) return;
    const global = limiter(deps, 'global');
    const limits = globalSendLimits(dailySendBudget(deps.env));
    if (!(await global.hit(limits, now)).ok) return;
    const res = await deps.sender.send(linkNoticeMail({ to, appName, authOrigin: deps.env.AUTH_ORIGIN, pending }));
    if (!res.ok) await global.unhit(limits, now);
    log({ event: 'link_notice', requestId: ctx.requestId, outcome: res.ok ? 'ok' : 'error', appId, ...(res.ok ? {} : { code: res.reason }) }, res.ok ? 'info' : 'error');
  } catch {
    log({ event: 'link_notice', requestId: ctx.requestId, outcome: 'error', code: 'internal', appId }, 'error');
  }
}

/** Global breaker: refuse a new code mail at the day's cap (a critical log line; the admin view and alerts read it). */
async function budgetOpen(ctx: Ctx): Promise<boolean> {
  const r = await limiter(ctx.deps, 'global').peek(globalSendLimits(dailySendBudget(ctx.deps.env)), ctx.deps.now());
  if (!r.ok) log({ event: 'send_budget_exhausted', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: 'send_budget_exhausted' }, 'error');
  return r.ok;
}

// ---- start ----

export async function handleStart(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['pk', 'email', 'purpose', 'commitment'])) return fail(ctx, 400, 'bad_request', 'Body must be {pk, email, purpose, commitment}');
  const limited = await ipLimit(ctx, request, IP_START_LIMITS);
  if (limited) return limited;
  const gate = await emailApp(ctx, b.pk);
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const now = deps.now();
  if (b.purpose === 'auto_link') return fail(ctx, 400, 'bad_request', 'auto_link codes are started by google-match');
  const c = commitmentNonce(deps.env.SIGNER_ACCOUNT, b.purpose, b.commitment, now);
  if (!c.ok) return fail(ctx, 400, 'bad_request', c.message);
  if (c.value.scopeId !== app.scopeId) return fail(ctx, 400, 'scope_mismatch', 'The commitment is for another app’s scope');
  if (typeof b.email !== 'string' || b.email.length > 1024) return fail(ctx, 400, 'invalid_email', 'Not a valid email address');
  const r = normalizeEmail(b.email);
  if (!r.ok) return fail(ctx, 400, 'invalid_email', 'Not a valid email address');
  if (isDisposableDomain(r.domain)) return fail(ctx, 400, 'email_domain_not_allowed', 'Addresses on this domain can’t be used to sign in');
  const appLimit = await limiter(deps, `app:${app.id}`).hit(appStartLimits(app), now);
  if (!appLimit.ok) {
    log({ event: 'limit', requestId: ctx.requestId, endpoint: ctx.endpoint, appId: app.id, limit: appLimit.limit });
    return fail(ctx, 429, 'rate_limited', 'Too many requests, try again later', undefined, retryHeader(appLimit.retryAfterMs));
  }
  if (!(await budgetOpen(ctx))) return fail(ctx, 429, 'rate_limited', 'Too many requests, try again later', undefined, retryHeader(60_000));

  const keys = await deps.keys();
  const challengeId = randomId();
  const code = newCode();
  const rec: ChallengeRecord = {
    appId: app.id,
    appName: app.name,
    scopeId: app.scopeId,
    purpose: c.value.purpose,
    nonce: c.value.nonce,
    autoLink: null,
    email: r.email,
    emailKey: await emailKey(keys, r.email),
    codeMac: await codeMac(keys, challengeId, code),
    attempts: 0,
    createdAtMs: now,
    expiresAtMs: now + CHALLENGE_TTL_MS,
    lastSentAtMs: now,
    resends: 0,
  };
  if (!(await challengeStub(deps, challengeId).create(rec))) return fail(ctx, 500, 'internal', 'Could not start the challenge');
  deps.waitUntil(deliver(ctx, rec, code));
  return ok(ctx, 202, { challengeId, expiresAtMs: rec.expiresAtMs, resendAfterMs: now + RESEND_SPACING_MS }, { appId: app.id, purpose: rec.purpose });
}

// ---- resend ----

export async function handleResend(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['challengeId']) || !isId(b.challengeId)) return fail(ctx, 400, 'bad_request', 'Body must be {challengeId}');
  const limited = await ipLimit(ctx, request, IP_RESEND_LIMITS);
  if (limited) return limited;
  if (!(await budgetOpen(ctx))) return fail(ctx, 429, 'rate_limited', 'Too many requests, try again later', undefined, retryHeader(60_000));
  const keys = await deps.keys();
  const code = newCode();
  const stub = challengeStub(deps, b.challengeId);
  const r = await stub.newCode(await codeMac(keys, b.challengeId, code), deps.now());
  if (r.result === 'gone') return fail(ctx, 410, 'challenge_expired', 'The code expired, was used or ran out of attempts: start again');
  if (r.result === 'limit') return fail(ctx, 429, 'resend_limit', 'No more codes for this challenge: start again');
  if (r.result === 'too_soon') return fail(ctx, 429, 'rate_limited', 'Wait before asking for another code', { resendAfterMs: deps.now() + r.retryAfterMs }, retryHeader(r.retryAfterMs));
  const previous = r.previous;
  deps.waitUntil(deliver(ctx, r.record, code, () => stub.undoSend(previous)));
  return ok(ctx, 202, { challengeId: b.challengeId, expiresAtMs: r.record.expiresAtMs, resendAfterMs: r.record.lastSentAtMs! + RESEND_SPACING_MS }, { appId: r.record.appId, purpose: r.record.purpose });
}

// ---- verify ----

/** Reads G, E and their accounts and judges the case (spec "The four cases"). */
async function judgeChain(deps: Deps, scopeId: string, googleSub: string, emailSubValue: string): Promise<Judgement> {
  const [gi, ei, ga, ea] = await Promise.all([
    deps.chain.identity(scopeId, 'google', googleSub),
    deps.chain.identity(scopeId, EMAIL_PROVIDER, emailSubValue),
    deps.chain.account(scopeId, 'google', googleSub),
    deps.chain.account(scopeId, EMAIL_PROVIDER, emailSubValue),
  ]);
  const google: Side = { sub: googleSub, identity: gi, account: ga };
  const email: Side = { sub: emailSubValue, identity: ei, account: ea };
  return judge(scopeId, google, email);
}

export async function handleVerify(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['challengeId', 'code']) || !isId(b.challengeId) || typeof b.code !== 'string' || !CODE_RE.test(b.code)) {
    return fail(ctx, 400, 'bad_request', 'Body must be {challengeId, code} with a 6-digit code');
  }
  const limited = await ipLimit(ctx, request, IP_VERIFY_LIMITS);
  if (limited) return limited;
  const now = deps.now();
  const stub = challengeStub(deps, b.challengeId);
  const live = await stub.peek(now);
  if (!live) return fail(ctx, 410, 'challenge_expired', 'The code expired, was used or ran out of attempts: start again');
  const addr = limiter(deps, `addr:${live.emailKey}`);
  if (await addr.locked(now)) return fail(ctx, 429, 'rate_limited', 'Too many wrong codes for this address, try again later', undefined, retryHeader(ADDRESS_LOCK_MS));
  const keys = await deps.keys();
  const v = await stub.verify(await codeMac(keys, b.challengeId, b.code), now);
  if (v.result === 'gone') return fail(ctx, 410, 'challenge_expired', 'The code expired, was used or ran out of attempts: start again');
  if (v.result === 'wrong') {
    await addr.wrongCode(ADDRESS_WRONG_LIMIT, ADDRESS_LOCK_MS, now);
    return fail(ctx, 400, 'code_invalid', 'Wrong code', { attemptsLeft: v.attemptsLeft });
  }
  // The code was right: the challenge is gone (single use). Exactly one token is minted from it.
  const rec = v.record;
  const app = await appById(deps.env.APP_DB, rec.appId);
  if (!app?.active || !app.emailOn || app.scopeId !== rec.scopeId) return fail(ctx, 403, 'email_not_enabled', 'Email login is not enabled for this app');
  const sub = await emailSub(keys.sub, rec.email);

  if (rec.purpose === 'session') {
    // Case B lookup: a Google identity that reported this address has a wallet here (spec "The four cases").
    const hints = await deps.env.DB.prepare('SELECT google_sub FROM email_hints WHERE scope_id = ?1 AND email_sub = ?2 ORDER BY updated_at_ms DESC LIMIT ?3')
      .bind(rec.scopeId, sub, MAX_HINTS)
      .all<{ google_sub: string }>();
    let googleWallet = false;
    let linkable = false;
    for (const h of hints.results) {
      const j = await judgeChain(deps, rec.scopeId, h.google_sub, sub);
      if (j.decision === 'case_b') {
        googleWallet = true;
        linkable ||= j.linkable;
      }
    }
    const { token: idToken } = await mint(ctx, app, rec.scopeId, sub, rec.nonce!, 'session');
    let linkTicket: string | undefined;
    if (googleWallet && linkable) {
      linkTicket = randomId();
      const t: TicketRecord = { appId: app.id, scopeId: rec.scopeId, sub, expiresAtMs: now + LINK_TICKET_TTL_MS };
      if (!(await challengeStub(deps, ticketName(linkTicket)).putTicket(t))) linkTicket = undefined;
    }
    return ok(ctx, 200, { idToken, googleWallet, ...(linkTicket ? { linkTicket } : {}) }, { appId: app.id, purpose: rec.purpose });
  }

  if (await deps.chain.unrecordedWallets()) return fail(ctx, 409, 'links_unavailable', 'Links wait until the owner accepts the wallets opened before v3');

  if (rec.purpose === 'auto_link') {
    // Case A, not Google-hosted, after the code (D195): re-read the chain at minting (D133).
    const a = rec.autoLink!;
    const j = await judgeChain(deps, rec.scopeId, a.googleSub, sub);
    if (j.decision !== 'case_a' || !j.join) return fail(ctx, 409, 'link_refused', 'The sign-in methods can no longer be linked', { decision: j.decision });
    const sessionIk = identityKey(rec.scopeId, 'google', a.googleSub);
    const nonce = nonceOf(autoLinkPreimage(deps.env.SIGNER_ACCOUNT, rec.scopeId, base64UrlDecode(a.sessionHash), sessionIk, { ...j.join, mode: 1 }));
    const { token: idToken } = await mint(ctx, app, rec.scopeId, sub, nonce, 'auto_link');
    deps.waitUntil(notify(ctx, rec.email, app.name, false, app.id));
    return ok(ctx, 200, { idToken, googleWallet: false, decision: 'case_a', linkImmediate: true }, { appId: app.id, purpose: rec.purpose, decision: 'case_a' });
  }

  const { token: idToken } = await mint(ctx, app, rec.scopeId, sub, rec.nonce!, rec.purpose);
  return ok(ctx, 200, { idToken, googleWallet: false }, { appId: app.id, purpose: rec.purpose });
}

// ---- google-match ----

/** "a…@domain": what the popup shows of the address a case-A code goes to. */
export const maskEmail = (normalized: string): string => {
  const at = normalized.lastIndexOf('@');
  return `${normalized.slice(0, 1)}…${normalized.slice(at)}`;
};

export async function handleGoogleMatch(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['pk', 'accessToken', 'googleIdToken', 'commitment', 'link'], ['linkTicket'])) {
    return fail(ctx, 400, 'bad_request', 'Body must be {pk, accessToken, googleIdToken, commitment, linkTicket?, link}');
  }
  const accessToken = typeof b.accessToken === 'string' && b.accessToken.length > 0 && b.accessToken.length <= 4096 ? b.accessToken : null;
  try {
    if (!accessToken || typeof b.googleIdToken !== 'string' || typeof b.link !== 'boolean' || (b.linkTicket !== undefined && !isId(b.linkTicket))) {
      return fail(ctx, 400, 'bad_request', 'Malformed google-match request');
    }
    const limited = await ipLimit(ctx, request, IP_MATCH_LIMITS);
    if (limited) return limited;
    const gate = await emailApp(ctx, b.pk);
    if (!gate.ok) return gate.response;
    const { app } = gate;
    const now = deps.now();
    const sc = parseSessionCommitment(b.commitment, now);
    if (!sc.ok) return fail(ctx, 400, 'bad_request', sc.message);
    if (sc.value.scopeId !== app.scopeId) return fail(ctx, 400, 'scope_mismatch', 'The commitment is for another app’s scope');

    // The app's Google clients: its scope's own (only its web client when it set one), shared ones when allowed.
    const scope = await deps.chain.scope(app.scopeId);
    const own = (scope?.clients ?? []).filter(([p, a]) => p === 'google' && (app.googleWebClientId === null || a === app.googleWebClientId)).map(([, a]) => a);
    const audiences = [...own, ...(scope?.allowShared ? await deps.chain.sharedGoogleClients() : [])];
    if (audiences.length === 0) return fail(ctx, 409, 'no_google_client', 'The app has no Google client');

    const id = await deps.google.verifyIdToken(b.googleIdToken, audiences);
    if (!id.ok) return fail(ctx, 400, 'google_token_invalid', 'The Google ID token is not valid for this app');
    if (id.value.nonce !== sessionNoncePreimageNonce(deps, sc.value)) return fail(ctx, 400, 'nonce_mismatch', 'The Google ID token nonce does not commit to this session');
    const ti = await deps.google.checkAccessToken(accessToken, id.value.aud, id.value.sub);
    if (!ti.ok) return fail(ctx, 400, 'google_token_invalid', 'The Google access token is not for this sign-in');
    const ui = await deps.google.userInfo(accessToken, id.value.sub);
    if (!ui.ok) return fail(ctx, 400, 'google_token_invalid', 'Google did not return the account’s address');

    // Only a Google-verified address can match (D119); the address lives in this call only.
    const r = ui.value.emailVerified ? normalizeEmail(ui.value.email) : null;
    if (!r?.ok) return ok(ctx, 200, { decision: 'none', googleHosted: false, linkable: false }, { appId: app.id, decision: 'none' });
    const googleHosted = isGoogleHosted({ email: r.email, emailVerified: ui.value.emailVerified, hd: ui.value.hd });
    const keys = await deps.keys();
    const sub = await emailSub(keys.sub, r.email);
    const googleSub = id.value.sub;
    // The hint every Google login writes (D122: kept while the scope exists).
    await deps.env.DB.prepare(
      'INSERT INTO email_hints (scope_id, email_sub, google_sub, updated_at_ms) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (scope_id, email_sub, google_sub) DO UPDATE SET updated_at_ms = excluded.updated_at_ms',
    )
      .bind(app.scopeId, sub, googleSub, now)
      .run();

    const j = await judgeChain(deps, app.scopeId, googleSub, sub);
    // A ticket is single use: any google-match that presents it spends it.
    let ticketValid = false;
    if (b.linkTicket !== undefined) {
      const t = await challengeStub(deps, ticketName(b.linkTicket)).takeTicket(app.id, now);
      ticketValid = !!t && t.scopeId === app.scopeId && t.sub === sub;
    }
    let linkable = j.linkable;
    if (linkable && (j.decision === 'case_a' || j.decision === 'case_b') && (await deps.chain.unrecordedWallets())) linkable = false;
    const base = { decision: j.decision, googleHosted, linkable };
    const sessionHash = sha256(sessionPreimage(deps.env.SIGNER_ACCOUNT, sc.value));
    const sessionIk = identityKey(app.scopeId, 'google', googleSub);

    if (j.decision === 'case_a' && linkable && j.join) {
      if (googleHosted) {
        if (!b.link) return ok(ctx, 200, base, { appId: app.id, decision: j.decision });
        const nonce = nonceOf(autoLinkPreimage(deps.env.SIGNER_ACCOUNT, app.scopeId, sessionHash, sessionIk, { ...j.join, mode: 1 }));
        const { token: emailToken } = await mint(ctx, app, app.scopeId, sub, nonce, 'auto_link');
        deps.waitUntil(notify(ctx, r.email, app.name, false, app.id));
        return ok(ctx, 200, { ...base, emailToken, linkImmediate: true }, { appId: app.id, decision: j.decision });
      }
      // Not Google-hosted: a code to that address first (D195). The challenge is prepared here, where the verified
      // address is known; its first code goes out when the popup calls `resend` after "Link and continue".
      const challengeId = randomId();
      const rec: ChallengeRecord = {
        appId: app.id,
        appName: app.name,
        scopeId: app.scopeId,
        purpose: 'auto_link',
        nonce: null,
        autoLink: { googleSub, sessionHash: base64UrlEncode(sessionHash) },
        email: r.email,
        emailKey: await emailKey(keys, r.email),
        codeMac: null,
        attempts: 0,
        createdAtMs: now,
        expiresAtMs: now + CHALLENGE_TTL_MS,
        lastSentAtMs: null,
        resends: 0,
      };
      if (!(await challengeStub(deps, challengeId).create(rec))) return fail(ctx, 500, 'internal', 'Could not prepare the challenge');
      return ok(ctx, 200, { ...base, challenge: { challengeId, expiresAtMs: rec.expiresAtMs, to: maskEmail(r.email) } }, { appId: app.id, decision: j.decision });
    }

    if (j.decision === 'case_b' && linkable && j.join && b.link && ticketValid) {
      const mode = googleHosted ? 1 : 0;
      const nonce = nonceOf(autoLinkPreimage(deps.env.SIGNER_ACCOUNT, app.scopeId, sessionHash, sessionIk, { ...j.join, mode }));
      const { token: emailToken } = await mint(ctx, app, app.scopeId, sub, nonce, 'auto_link');
      deps.waitUntil(notify(ctx, r.email, app.name, !googleHosted, app.id));
      return ok(ctx, 200, { ...base, emailToken, linkImmediate: mode === 1 }, { appId: app.id, decision: j.decision });
    }
    return ok(ctx, 200, base, { appId: app.id, decision: j.decision });
  } finally {
    // The access token is revoked whatever the outcome (spec: "then revokes the access token").
    if (accessToken) {
      deps.waitUntil(
        deps.google.revoke(accessToken).then((revoked) => {
          if (!revoked) log({ event: 'google_revoke', requestId: ctx.requestId, outcome: 'error', code: 'revoke_failed' }, 'warn');
        }),
      );
    }
  }
}

const sessionNoncePreimageNonce = (deps: Deps, c: SessionCommitment): string => nonceOf(sessionPreimage(deps.env.SIGNER_ACCOUNT, c));

// ---- admin/client-proof ----

export async function handleClientProof(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  if (!deps.access) return fail(ctx, 404, 'not_found', 'Not found');
  const staff = await deps.access.staff(request);
  if (!staff) return fail(ctx, 403, 'forbidden', 'Staff access required');
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['scopeId', 'actionNonce']) || !isScopeId(b.scopeId) || !Number.isSafeInteger(b.actionNonce) || (b.actionNonce as number) < 0) {
    return fail(ctx, 400, 'bad_request', 'Body must be {scopeId, actionNonce}');
  }
  const staffKey = toHex(sha256(new TextEncoder().encode(staff)));
  const r = await limiter(deps, `staff:${staffKey}`).hit(STAFF_PROOF_LIMITS, deps.now());
  if (!r.ok) return fail(ctx, 429, 'rate_limited', 'Too many client proofs, try again later', undefined, retryHeader(r.retryAfterMs));
  const scopeId = b.scopeId;
  const actionNonce = b.actionNonce as number;
  const { token, jti } = await mint(ctx, null, scopeId, CLIENT_PROOF_SUB, nonceOf(clientProofPreimage(deps.env.SIGNER_ACCOUNT, scopeId, actionNonce)), 'client_proof');
  await deps.env.DB.prepare('INSERT INTO email_admin_audit (at_ms, staff, scope_id, action_nonce, jti) VALUES (?1, ?2, ?3, ?4, ?5)').bind(deps.now(), staff, scopeId, actionNonce, jti).run();
  return ok(ctx, 200, { token, client: [EMAIL_PROVIDER, `email:${scopeId}`] }, { scopeId, purpose: 'client_proof', jti });
}

// ---- JWKS and discovery ----

export async function handleJwks(ctx: Ctx): Promise<Response> {
  return ok(ctx, 200, { keys: await ctx.deps.publicKeys() });
}

export function handleOpenIdConfiguration(ctx: Ctx): Response {
  const iss = ctx.deps.env.EMAIL_ISS;
  return ok(ctx, 200, {
    issuer: iss,
    jwks_uri: `${iss}/jwks.json`,
    id_token_signing_alg_values_supported: ['RS256'],
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    claims_supported: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'jti'],
  });
}

// ---- SendGrid event webhook ----

export async function handleSendgridWebhook(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const key = deps.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  if (!key) return fail(ctx, 404, 'not_found', 'Not found');
  const body = await readWebhookBody(request);
  if (!body) return fail(ctx, 413, 'bad_request', 'Body too large');
  const sig = request.headers.get(SIGNATURE_HEADER) ?? '';
  const ts = request.headers.get(TIMESTAMP_HEADER) ?? '';
  if (!(await verifyWebhook(key, ts, body, sig, Math.floor(deps.now() / 1000)))) return fail(ctx, 401, 'bad_signature', 'Invalid webhook signature');
  let events: unknown;
  try {
    events = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return fail(ctx, 400, 'bad_request', 'Body must be JSON');
  }
  const list = await suppressionsOf(await deps.keys(), events);
  if (!list) return fail(ctx, 400, 'bad_request', 'Body must be an array of at most 1000 events');
  const now = deps.now();
  if (list.length > 0) {
    await deps.env.DB.batch(
      list.map((s) =>
        deps.env.DB.prepare(
          "INSERT INTO email_suppressions (email_key, reason, at_ms) VALUES (?1, ?2, ?3) ON CONFLICT (email_key) DO UPDATE SET reason = CASE WHEN excluded.reason = 'complaint' THEN 'complaint' ELSE email_suppressions.reason END, at_ms = excluded.at_ms",
        ).bind(s.emailKey, s.reason, now),
      ),
    );
  }
  return ok(ctx, 200, { stored: list.length }, { count: list.length });
}

// ---- router ----

export const ROUTES = {
  start: '/v1/email/start',
  resend: '/v1/email/resend',
  verify: '/v1/email/verify',
  googleMatch: '/v1/email/google-match',
  clientProof: '/v1/email/admin/client-proof',
  jwks: '/v1/email/jwks.json',
  openid: '/v1/email/.well-known/openid-configuration',
  sendgridWebhook: '/v1/email/webhooks/sendgrid',
} as const;

/** Which browser origin may call a POST route (null: no browser caller, no CORS). */
function allowedOrigin(deps: Deps, path: string): string | null {
  if (path === ROUTES.start || path === ROUTES.resend || path === ROUTES.verify) return deps.env.AUTH_ORIGIN;
  if (path === ROUTES.googleMatch) return deps.env.VAULT_ORIGIN;
  return null;
}

export async function route(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const requestId = randomId(12);
  const base: Ctx = { deps, requestId, endpoint: path, cors: {} };
  try {
    if (path === ROUTES.jwks || path === ROUTES.openid) {
      const ctx = { ...base, cors: corsHeaders('*') };
      if (request.method === 'OPTIONS') return respond(ctx, new Response(null, { status: 204 }));
      if (request.method !== 'GET') return fail(ctx, 405, 'method_not_allowed', 'GET only');
      return path === ROUTES.jwks ? await handleJwks(ctx) : handleOpenIdConfiguration(ctx);
    }
    const handlers: Record<string, (r: Request, c: Ctx) => Promise<Response>> = {
      [ROUTES.start]: handleStart,
      [ROUTES.resend]: handleResend,
      [ROUTES.verify]: handleVerify,
      [ROUTES.googleMatch]: handleGoogleMatch,
      [ROUTES.clientProof]: handleClientProof,
      [ROUTES.sendgridWebhook]: handleSendgridWebhook,
    };
    const handler = handlers[path];
    if (!handler) return fail(base, 404, 'not_found', 'Not found');
    const allowed = allowedOrigin(deps, path);
    const origin = request.headers.get('origin');
    if (allowed !== null) {
      // Browser routes: only the one Hana origin, and only with an Origin header (no cookie-less script relays).
      if (origin !== allowed) return fail(base, 403, 'origin_not_allowed', 'Origin not allowed');
      const ctx = { ...base, cors: corsHeaders(allowed) };
      if (request.method === 'OPTIONS') return respond(ctx, new Response(null, { status: 204 }));
      if (request.method !== 'POST') return fail(ctx, 405, 'method_not_allowed', 'POST only');
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail(ctx, 415, 'bad_request', 'Content-Type must be application/json');
      return await handler(request, ctx);
    }
    if (request.method !== 'POST') return fail(base, 405, 'method_not_allowed', 'POST only');
    return await handler(request, base);
  } catch (err) {
    if (err instanceof SignerUnavailable) return failSafe(base, 503, 'signer_unavailable', 'The email issuer can’t sign right now', err.reason);
    if (err instanceof KeysUnavailable) return failSafe(base, 503, 'issuer_unavailable', 'The email issuer is not configured', 'keys');
    if (err instanceof ChainUnavailable) return failSafe(base, 502, 'near_unavailable', 'Could not read the chain, try again', 'chain');
    if (err instanceof GoogleUnavailable) return failSafe(base, 502, 'google_unavailable', 'Could not reach Google, try again', 'google');
    return failSafe(base, 500, 'internal', 'Internal error', 'internal');
  }
}

/** An error response for a thrown failure: logs only a fixed reason word, never the error's message. */
function failSafe(ctx: Ctx, status: number, code: string, message: string, reason: string): Response {
  log({ event: 'request', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', status, code: `${code}:${reason}` }, 'error');
  const origin = allowedOriginSafe(ctx);
  return origin ? respond({ ...ctx, cors: corsHeaders(origin) }, error(status, code, message)) : error(status, code, message);
}

const allowedOriginSafe = (ctx: Ctx): string | null => {
  try {
    return allowedOrigin(ctx.deps, ctx.endpoint);
  } catch {
    return null;
  }
};

