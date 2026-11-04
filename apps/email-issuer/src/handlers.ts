// The issuer's endpoints (docs/email-login-spec.md "Endpoints"; docs/api.md "Email issuer"). POST JSON, CORS for one
// Hana origin each (start, resend, verify: authOrigin; google-match: the vault's origin, D199), no cookies, every
// response `Cache-Control: no-store`; of the browser routes only `start` carries an address. Enumeration-safe: `start`
// answers 202 with the same body for every valid address (suppressed included) and the same generic 429, with one
// `retry-after`, for every mailbox-level limit; the provider's send happens after the response, in waitUntil. Every
// limit decision is one atomic Durable Object call, and the checks run so that a requester pays before a partner's
// quota or the global budget is touched (D198).
import { base64UrlDecode, base64UrlEncode, sha256, toHex, utf8 } from './bytes.ts';
import { emailSub, isDisposableDomain, isGoogleHosted, normalizeEmail } from '@hana-id/email';
import { type IssuerApp, appById, appByKey, isPublishableKey, scopeHasEmailApp } from './apps.ts';
import type { ChallengeRecord, TicketRecord } from './challenge.ts';
import { type ChallengeId, decryptEmail, encryptEmail, newChallengeId, parseChallengeId } from './challenge-id.ts';
import { ChainUnavailable } from './chain.ts';
import { type Purpose, commitmentNonce, isScopeId, parseSessionCommitment } from './commitment.ts';
import { type Judgement, type Side, judge } from './decide.ts';
import type { Deps } from './deps.ts';
import { recordUserEmailLater } from './directory.ts';
import { isExemptDomain, registrableDomain } from './domain.ts';
import { dailySendBudget } from './env.ts';
import { GoogleUnavailable } from './google.ts';
import { corsHeaders, error, isObj, json, onlyKeys, readJson } from './http.ts';
import { ipAggregates, ipSubject, isClientIp } from './ip.ts';
import { type EmailClaims, TOKEN_LIFETIME_S, mintJws } from './jws.ts';
import { CODE_RE, KeysUnavailable, codeMac, domainKey, issueDeviceTicket, mailboxKey, newCode, randomId, readDeviceTicket, requesterKey, suppressionKey } from './keys.ts';
import { CLIENT_PROOF_SUB, clientProofNonce, emailClient } from './client-proof.ts';
import { autoLinkPreimage, EMAIL_PROVIDER, identityKey, nonceOf, sessionPreimage, type SessionCommitment } from './layouts.ts';
import {
  CHALLENGE_TTL_MS,
  CONFIRM_TTL_MS,
  HINT_PRUNE_BATCH,
  OWNER_AGED_TICKET_MS,
  NON_HOSTED_HINT_TTL_MS,
  IP_AGGREGATE_START_LIMITS,
  IP_MATCH_LIMITS,
  IP_RESEND_LIMITS,
  IP_START_LIMITS,
  IP_VERIFY_LIMITS,
  IP_WEBHOOK_LIMITS,
  LINK_TICKET_TTL_MS,
  MAILBOX_RETRY_AFTER_S,
  RESEND_SPACING_MS,
  STAFF_LIMITS,
  appBudgetShare,
  appStartLimits,
} from './limits.ts';
import { log } from './log.ts';
import { codeMail, confirmMail, linkNoticeMail, unlockMail } from './mail.ts';
import type { BudgetKind, Limit, OwnerClaim, OwnerRef, Reservation } from './rate-limiter.ts';
import { SignerUnavailable } from './signer.ts';
import { readWebhookBody, SIGNATURE_HEADER, suppressionsOf, TIMESTAMP_HEADER, verifyWebhook, webhookHeadersOk } from './webhook.ts';

export const MAX_BODY = 8 * 1024;
/** The `sub` of a staff client proof (client-proof.ts): not an `e1.` sub, so it can never be an email user's identity. */
export { CLIENT_PROOF_SUB } from './client-proof.ts';
/** Hints read per verify (one address can be reported by a few Google accounts). */
const MAX_HINTS = 4;
/** A bounce suppresses for 30 days; a complaint until a staff unsuppress (M3). */
export const BOUNCE_SUPPRESSION_MS = 30 * 86_400_000;
/** `email_complaint_rate` is logged when the complaints of the last 24 h pass this (M4). */
export const COMPLAINT_ALERT_PER_DAY = 5;
/** A staff unlock's one-time token: "ug1." + 32 random bytes, b64url. */
const UNLOCK_TOKEN_PREFIX = 'ug1.';
const UNLOCK_TOKEN_RE = /^ug1\.[A-Za-z0-9_-]{43}$/u;
/** A staff unsuppress's mailed confirmation token: "uc1." + 32 random bytes, b64url. */
const CONFIRM_TOKEN_PREFIX = 'uc1.';
const CONFIRM_TOKEN_RE = /^uc1\.[A-Za-z0-9_-]{43}$/u;
const confirmName = (token: string): string => `u:${base64UrlEncode(sha256(utf8(token)))}`;
const SUPPORT_TICKET_RE = /^[A-Za-z0-9._#:-]{1,64}$/u;

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
const rawIp = (request: Request): string | null => request.headers.get('cf-connecting-ip');
const ipOf = (request: Request): string => ipSubject(rawIp(request));
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(v);
const retryHeader = (ms: number): Record<string, string> => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });
const tooMany = (ctx: Ctx, ms: number): Response => fail(ctx, 429, 'rate_limited', 'Too many requests, try again later', undefined, retryHeader(ms));

async function ipLimit(ctx: Ctx, request: Request, limits: Limit[]): Promise<Response | null> {
  const r = await limiter(ctx.deps, `ip:${ipOf(request)}`).hit(limits, ctx.deps.now());
  if (r.ok) return null;
  log({ event: 'limit', requestId: ctx.requestId, endpoint: ctx.endpoint, limit: r.limit });
  return tooMany(ctx, r.retryAfterMs);
}

/** `start`'s aggregate prefix limits (IPv4 /24, IPv6 /56 and /48); skipped for a valid ticket or grant (abuse review M2). */
async function aggregateLimits(ctx: Ctx, request: Request): Promise<Response | null> {
  for (const agg of ipAggregates(rawIp(request))) {
    const r = await limiter(ctx.deps, `ip:${agg}`).hit(IP_AGGREGATE_START_LIMITS, ctx.deps.now());
    if (!r.ok) {
      log({ event: 'limit', requestId: ctx.requestId, endpoint: ctx.endpoint, limit: `${agg.split(':')[0]}:${r.limit}` });
      return tooMany(ctx, r.retryAfterMs);
    }
  }
  return null;
}

/**
 * The generic refusal for a mailbox-level limit (the mailbox's limits and locks, the recipient domain's cap): the same
 * body as every other 429 and one fixed `retry-after`, so neither says which limit refused (D198, L1).
 */
const tryLater = (ctx: Ctx, why: string): Response => {
  log({ event: 'limit', requestId: ctx.requestId, endpoint: ctx.endpoint, limit: `mailbox:${why}` });
  return fail(ctx, 429, 'rate_limited', 'Too many requests, try again later', undefined, { 'retry-after': String(MAILBOX_RETRY_AFTER_S) });
};

/**
 * The app behind `pk` (an unrevoked or in-grace key of an undeleted app, apps.ts), with email on: active (no
 * suspension bit), `login_methods` lists email, and its scope holds the email client
 * `("email", "email:" + scope_id)` on chain (cached 60 s).
 */
async function emailApp(ctx: Ctx, pk: unknown): Promise<{ ok: true; app: IssuerApp } | { ok: false; response: Response }> {
  if (!isPublishableKey(pk)) return { ok: false, response: fail(ctx, 401, 'invalid_key', 'Unknown publishable key') };
  const app = await appByKey(ctx.deps.env.APP_DB, pk, ctx.deps.now());
  if (!app) return { ok: false, response: fail(ctx, 401, 'invalid_key', 'Unknown publishable key') };
  if (!app.active) return { ok: false, response: fail(ctx, 403, 'app_suspended', 'The app is suspended') };
  if (!app.emailOn) return { ok: false, response: fail(ctx, 403, 'email_not_enabled', 'Email login is not enabled for this app') };
  const scope = await ctx.deps.chain.scope(app.scopeId);
  if (!scope?.clients.some(([p, a]) => p === EMAIL_PROVIDER && a === `email:${app.scopeId}`)) return { ok: false, response: fail(ctx, 409, 'no_email_client', 'The app’s scope has no email client on chain') };
  return { ok: true, app };
}

/** Mints one email token: the issuance row first (so every signature has a row), then the JWS with its self-check. */
async function mint(ctx: Ctx, app: { id: string } | null, scopeId: string, sub: string, nonce: string, purpose: Purpose | 'client_proof', jti: string = randomId(16)): Promise<{ token: string; jti: string }> {
  const { deps } = ctx;
  const signers = await deps.signers();
  const iat = Math.floor(deps.now() / 1000);
  const claims: EmailClaims = { iss: deps.env.EMAIL_ISS, aud: `email:${scopeId}`, sub, iat, exp: iat + TOKEN_LIFETIME_S, nonce, jti };
  const kid = signers[0]!.kid;
  await deps.env.DB.prepare('INSERT INTO email_issuance (jti, app_id, purpose, kid, iat) VALUES (?1, ?2, ?3, ?4, ?5)').bind(jti, app?.id ?? null, purpose, kid, iat).run();
  const token = await mintJws(claims, signers, await deps.publicKeys());
  log({ event: 'token_minted', requestId: ctx.requestId, endpoint: ctx.endpoint, jti, purpose, ...(app ? { appId: app.id } : {}), scopeId, kid });
  return { token, jti };
}

// ---- sending ----

/** A bounce suppresses for 30 days, a complaint until a staff unsuppress (M3). */
const isSuppressed = async (deps: Deps, key: string): Promise<boolean> =>
  !!(await deps.env.DB.prepare("SELECT 1 AS x FROM email_suppressions WHERE email_key = ?1 AND (reason = 'complaint' OR at_ms > ?2)").bind(key, deps.now() - BOUNCE_SUPPRESSION_MS).first());

/**
 * One user mail against the global budget (H1, abuse review H1): an owner's (`owner`: a valid ticket's or grant's
 * challenge, a staff unlock/unsuppress mail) from the owner pool, whatever the app's share; any other from the general
 * pool within the app's `share`. Logs `email_budget` when this mail reached 50% or 80% of a pool or of the app's share,
 * and `send_budget_exhausted` when refused (`unconfigured`: no `dailySendBudget` outside `local*`, every mail refused).
 */
async function reserveBudget(ctx: Ctx, appId: string | null, share: number, kind: BudgetKind): Promise<Reservation | null> {
  const budget = dailySendBudget(ctx.deps.env);
  const r = await limiter(ctx.deps, 'global').reserveBudget(appId, budget, share, kind, ctx.deps.now());
  const appField = appId ? { appId } : {};
  if (!r.ok) {
    log({ event: 'send_budget_exhausted', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: budget > 0 ? r.limit : 'unconfigured', ...appField }, 'error');
    return null;
  }
  for (const c of r.crossed) log({ event: c.startsWith('owner_') ? 'email_owner_pool' : 'email_budget', requestId: ctx.requestId, endpoint: ctx.endpoint, code: c, ...appField }, 'warn');
  return r.reservation;
}

/** The pool an owner's mail draws on: a grant or a ticket ≥ 7 days old is `owner_aged` (final check M1). */
const ownerBudgetKind = (owner: OwnerRef | null, now: number): BudgetKind =>
  !owner ? 'user' : owner.kind === 'grant' || now - owner.issuedAtMs >= OWNER_AGED_TICKET_MS ? 'owner_aged' : 'owner';

/** The app's share of the general pool (its plan's `per_day`, D198). */
const shareOf = (ctx: Ctx, app: { perDay: number }): number => appBudgetShare(app.perDay, dailySendBudget(ctx.deps.env));

/**
 * One staff-triggered mail to the address itself (unlock, unsuppress confirmation): from the owner pool, never the
 * address in a log. Returns whether the provider accepted it.
 */
async function mailOwner(ctx: Ctx, message: ReturnType<typeof unlockMail>): Promise<boolean> {
  const budget = await reserveBudget(ctx, null, 0, 'staff');
  if (!budget) return false;
  try {
    const res = await ctx.deps.sender.send(message);
    if (!res.ok) await limiter(ctx.deps, 'global').refund(budget);
    log({ event: 'staff_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: res.ok ? 'ok' : 'error', code: res.ok ? message.kind : res.reason }, res.ok ? 'info' : 'error');
    return res.ok;
  } catch {
    await limiter(ctx.deps, 'global').refund(budget);
    log({ event: 'staff_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: 'internal' }, 'error');
    return false;
  }
}

/**
 * One code mail to a recipient domain, within its day and the requester prefixes' shares of it (scan finding 2).
 * Nothing is counted for an exempt provider (`key` ''), or a ticketed (or unlock-grant) challenge: the owner's mail
 * never waits on a domain someone else filled. `ok: false` when refused; logs `email_domain_cap` when this mail
 * filled the domain's day.
 */
async function reserveDomain(ctx: Ctx, key: string, request: Request, now: number, owner: boolean): Promise<{ ok: boolean; r: Reservation | null }> {
  if (!key || owner) return { ok: true, r: null };
  const prefixes = ipAggregates(rawIp(request)).map(requesterKey);
  const d = await limiter(ctx.deps, `dom:${key}`).reserveDomain(prefixes, now);
  if (!d.ok) return { ok: false, r: null };
  if (d.filled) log({ event: 'email_domain_cap', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'rejected', subject: key.slice(0, 12) }, 'warn');
  return { ok: true, r: d.reservation };
}
const releaseDomain = async (deps: Deps, key: string, r: Reservation | null): Promise<void> => {
  if (key && r) await limiter(deps, `dom:${key}`).refund(r);
};

/** The domain cap's subject of a normalized address's domain: '' for an exempt provider. */
async function domainSubject(deps: Deps, domain: string): Promise<string> {
  const reg = registrableDomain(domain);
  return isExemptDomain(reg) ? '' : domainKey(await deps.keys(), reg);
}

/**
 * Sends one code mail whose send was already reserved (mailbox, domain, budget, in the response path); after the
 * response, so the provider's latency never shows. A provider refusal takes the reservations back. Never throws.
 */
async function deliver(ctx: Ctx, rec: ChallengeRecord, to: string, code: string, undo: () => Promise<void>): Promise<void> {
  const { deps } = ctx;
  try {
    const res = await deps.sender.send(codeMail({ to, code, appName: rec.appName, authOrigin: deps.env.AUTH_ORIGIN, purpose: rec.purpose }));
    if (!res.ok) {
      await undo();
      log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: res.reason, appId: rec.appId, ...(res.providerStatus ? { providerStatus: res.providerStatus } : {}) }, 'error');
      return;
    }
    log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'ok', appId: rec.appId, purpose: rec.purpose });
  } catch {
    log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: 'internal', appId: rec.appId }, 'error');
  }
}

/** The mailbox's limiter. */
const mailboxLimiter = (deps: Deps, key: string) => limiter(deps, `mbx:${key}`);

/** A link notice to the joining address (spec "Notices"); against the budget only (the app's share). Never throws. */
async function notify(ctx: Ctx, to: string, appName: string, pending: boolean, appId: string, share: number): Promise<void> {
  const { deps } = ctx;
  try {
    if (await isSuppressed(deps, await suppressionKey(await deps.keys(), to))) return;
    const budget = await reserveBudget(ctx, appId, share, 'user');
    if (!budget) return;
    const res = await deps.sender.send(linkNoticeMail({ to, appName, authOrigin: deps.env.AUTH_ORIGIN, pending }));
    if (!res.ok) await limiter(deps, 'global').refund(budget);
    log({ event: 'link_notice', requestId: ctx.requestId, outcome: res.ok ? 'ok' : 'error', appId, ...(res.ok ? {} : { code: res.reason }) }, res.ok ? 'info' : 'error');
  } catch {
    log({ event: 'link_notice', requestId: ctx.requestId, outcome: 'error', code: 'internal', appId }, 'error');
  }
}

// ---- start ----

export async function handleStart(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['pk', 'email', 'purpose', 'commitment'], ['deviceTicket', 'unlockToken'])) return fail(ctx, 400, 'bad_request', 'Body must be {pk, email, purpose, commitment, deviceTicket?, unlockToken?}');
  // The requester pays first: its IP subject's limits count before anything else.
  const limited = await ipLimit(ctx, request, IP_START_LIMITS);
  if (limited) return limited;
  if (typeof b.email !== 'string' || b.email.length > 1024) return fail(ctx, 400, 'invalid_email', 'Not a valid email address');
  const r = normalizeEmail(b.email);
  if (!r.ok) return fail(ctx, 400, 'invalid_email', 'Not a valid email address');
  const now = deps.now();
  const keys = await deps.keys();
  const mbx = await mailboxKey(keys, r.mailbox);
  const addrKey = await suppressionKey(keys, r.email);
  const box = mailboxLimiter(deps, mbx);
  // The owner's proof, checked before the prefix limits (abuse review M2): a device ticket for this exact address (D198),
  // or a mailed unlock token. A valid one never waits on a pool an attacker fills cheaply: it skips the prefix limits,
  // the app's quota, the domain cap and the general budget pool. An invalid one is ignored, never an error.
  const ticket = await readDeviceTicket(keys, b.deviceTicket, addrKey, now);
  const grantHash = typeof b.unlockToken === 'string' && UNLOCK_TOKEN_RE.test(b.unlockToken) ? base64UrlEncode(sha256(utf8(b.unlockToken))) : null;
  const claim: OwnerClaim | null = ticket ? { kind: 'ticket', id: ticket.id, addrKey, issuedAtMs: ticket.issuedAtMs, untagged: r.email === r.mailbox } : grantHash ? { kind: 'grant', hash: grantHash } : null;
  const claimOk = claim !== null && (await box.checkOwner(claim, now));
  if (!claimOk) {
    const agg = await aggregateLimits(ctx, request);
    if (agg) return agg;
  }
  const gate = await emailApp(ctx, b.pk);
  if (!gate.ok) return gate.response;
  const { app } = gate;
  if (b.purpose === 'auto_link') return fail(ctx, 400, 'bad_request', 'auto_link codes are started by google-match');
  const c = commitmentNonce(deps.env.SIGNER_ACCOUNT, b.purpose, b.commitment, now);
  if (!c.ok) return fail(ctx, 400, 'bad_request', c.message);
  if (c.value.scopeId !== app.scopeId) return fail(ctx, 400, 'scope_mismatch', 'The commitment is for another app’s scope');
  if (isDisposableDomain(r.domain)) return fail(ctx, 400, 'email_domain_not_allowed', 'Addresses on this domain can’t be used to sign in');

  const ip = requesterKey(ipOf(request));
  const expiresAtMs = now + CHALLENGE_TTL_MS;
  // A suppressed address takes exactly the same path, limits counted and never refunded, so no limiter answer tells it
  // apart (D198); only the provider call is skipped, and its challenge holds no address and no code.
  const suppressed = await isSuppressed(deps, addrKey);
  const dKey = await domainSubject(deps, r.domain);
  const share = shareOf(ctx, app);

  // 1. The mailbox (one atomic call): locks, live challenges, the day's challenge cap, the first code's limits (an
  // owner's: its ticket's allowance; a grant is used up here and given back if the start fails later).
  const adm = await box.admit(ip, expiresAtMs, true, now, claimOk ? claim : null);
  if (!adm.ok) return tryLater(ctx, adm.reason);
  const owner = adm.owner;
  const undoMailbox = async (alsoLive: boolean) => {
    if (adm.send) await box.refund(adm.send);
    await box.unadmit(adm.created, alsoLive ? expiresAtMs : null, now, owner);
  };
  // 2. The recipient domain's day (an owner's start skips it).
  const dom = await reserveDomain(ctx, dKey, request, now, owner !== null);
  if (!dom.ok) {
    await undoMailbox(true);
    return tryLater(ctx, 'domain');
  }
  // 3. The partner's quota, only for a start every requester-side limit accepted (an owner's start skips it).
  const appLimits = appStartLimits(app);
  const appLimit = owner ? ({ ok: true } as const) : await limiter(deps, `app:${app.id}`).hit(appLimits, now);
  if (!appLimit.ok) {
    await undoMailbox(true);
    await releaseDomain(deps, dKey, dom.r);
    log({ event: 'limit', requestId: ctx.requestId, endpoint: ctx.endpoint, appId: app.id, limit: appLimit.limit });
    return tooMany(ctx, appLimit.retryAfterMs);
  }
  const undoApp = async () => {
    if (!owner) await limiter(deps, `app:${app.id}`).unhit(appLimits, now);
  };
  // 4. The global budget: the owner pool for an owner's start, else the app's share of the general pool.
  const budget = await reserveBudget(ctx, app.id, share, ownerBudgetKind(owner, now));
  if (!budget) {
    await undoMailbox(true);
    await releaseDomain(deps, dKey, dom.r);
    await undoApp();
    return tooMany(ctx, 60_000);
  }

  const id = newChallengeId();
  const code = newCode();
  const rec: ChallengeRecord = {
    appId: app.id,
    appName: app.name,
    scopeId: app.scopeId,
    purpose: c.value.purpose,
    nonce: c.value.nonce,
    autoLink: null,
    silent: suppressed,
    emailEnc: suppressed ? '' : await encryptEmail(id, r.email),
    mailboxKey: mbx,
    domainKey: dKey,
    owner,
    budgetShare: share,
    domainRes: dom.r ? [dom.r] : [],
    // A suppressed challenge's MAC is of a random value nobody holds: every code is wrong.
    codeMac: await codeMac(keys, id.id, suppressed ? randomId() : code),
    attempts: 0,
    createdAtMs: now,
    expiresAtMs,
    lastSentAtMs: now,
    resends: 0,
  };
  if (!(await challengeStub(deps, id.name).create(rec))) {
    await undoMailbox(true);
    await releaseDomain(deps, dKey, dom.r);
    await undoApp();
    await limiter(deps, 'global').refund(budget);
    return fail(ctx, 500, 'internal', 'Could not start the challenge');
  }
  if (!suppressed) {
    deps.waitUntil(
      deliver(ctx, rec, r.email, code, async () => {
        // The challenge stays (a resend may still deliver), but its first code's places are taken back.
        await undoMailbox(false);
        await releaseDomain(deps, dKey, dom.r);
        if (dom.r) await challengeStub(deps, id.name).forgetDomain(dom.r);
        await limiter(deps, 'global').refund(budget);
      }),
    );
  } else log({ event: 'code_mail', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'suppressed', code: 'suppressed', appId: app.id, purpose: rec.purpose });
  return ok(ctx, 202, { challengeId: id.id, expiresAtMs, resendAfterMs: now + RESEND_SPACING_MS }, { appId: app.id, purpose: rec.purpose });
}

// ---- resend ----

export async function handleResend(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  const cid = isObj(b) && onlyKeys(b, ['challengeId']) ? parseChallengeId(b.challengeId) : null;
  if (!cid) return fail(ctx, 400, 'bad_request', 'Body must be {challengeId}');
  const limited = await ipLimit(ctx, request, IP_RESEND_LIMITS);
  if (limited) return limited;
  const now = deps.now();
  const stub = challengeStub(deps, cid.name);
  const gone = () => fail(ctx, 410, 'challenge_expired', 'The code expired, was used or ran out of attempts: start again');
  const st = await stub.peek(now);
  if (!st) return gone();
  if (st.send.result === 'limit') return fail(ctx, 429, 'resend_limit', 'No more codes for this challenge: start again');
  if (st.send.result === 'too_soon') return fail(ctx, 429, 'rate_limited', 'Wait before asking for another code', { resendAfterMs: now + st.send.retryAfterMs }, retryHeader(st.send.retryAfterMs));
  // Reserved before the code changes, in the order start uses; a silent (suppressed) challenge takes the same path.
  const box = mailboxLimiter(deps, st.mailboxKey);
  const res = await box.reserveSend(requesterKey(ipOf(request)), now, st.owner);
  if (!res.ok) return tryLater(ctx, res.reason);
  const send = res.reservation;
  // What the challenge's owner proof counts as now (a ticket revoked since counts as nothing), for every later step.
  const isOwner = res.owner !== null;
  const dom = await reserveDomain(ctx, st.domainKey, request, now, isOwner);
  if (!dom.ok) {
    await box.refund(send);
    return tryLater(ctx, 'domain');
  }
  const budget = await reserveBudget(ctx, st.appId, st.budgetShare, isOwner ? ownerBudgetKind(st.owner, now) : 'user');
  if (!budget) {
    await box.refund(send);
    await releaseDomain(deps, st.domainKey, dom.r);
    return tooMany(ctx, 60_000);
  }
  const undoAll = async () => {
    await box.refund(send);
    await releaseDomain(deps, st.domainKey, dom.r);
    await limiter(deps, 'global').refund(budget);
  };
  const keys = await deps.keys();
  const code = newCode();
  const r = await stub.newCode(await codeMac(keys, cid.id, code), now, dom.r);
  if (r.result !== 'ok') {
    await undoAll();
    if (r.result === 'gone') return gone();
    if (r.result === 'limit') return fail(ctx, 429, 'resend_limit', 'No more codes for this challenge: start again');
    return fail(ctx, 429, 'rate_limited', 'Wait before asking for another code', { resendAfterMs: now + r.retryAfterMs }, retryHeader(r.retryAfterMs));
  }
  if (!st.silent) {
    const to = await decryptEmail(cid, r.record.emailEnc);
    if (to === null) {
      await undoAll();
      return gone();
    }
    const previous = r.previous;
    deps.waitUntil(
      deliver(ctx, r.record, to, code, async () => {
        await undoAll();
        await stub.undoSend(previous, dom.r);
      }),
    );
  }
  return ok(ctx, 202, { challengeId: cid.id, expiresAtMs: r.record.expiresAtMs, resendAfterMs: now + RESEND_SPACING_MS }, { appId: r.record.appId, purpose: r.record.purpose });
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
  const cid = isObj(b) && onlyKeys(b, ['challengeId', 'code']) ? parseChallengeId(b.challengeId) : null;
  if (!cid || !isObj(b) || typeof b.code !== 'string' || !CODE_RE.test(b.code)) return fail(ctx, 400, 'bad_request', 'Body must be {challengeId, code} with a 6-digit code');
  const limited = await ipLimit(ctx, request, IP_VERIFY_LIMITS);
  if (limited) return limited;
  const now = deps.now();
  const stub = challengeStub(deps, cid.name);
  const gone = () => fail(ctx, 410, 'challenge_expired', 'The code expired, was used or ran out of attempts: start again');
  const live = await stub.peek(now);
  if (!live) return gone();
  // The check is reserved in the mailbox limiter before the code is compared (one atomic call), so concurrent guesses
  // can't all pass a lock check before any is counted; it is refunded when the code was right. The challenge counts
  // its own attempts atomically too.
  const ip = requesterKey(ipOf(request));
  const box = mailboxLimiter(deps, live.mailboxKey);
  const guess = await box.reserveGuess(ip, now, live.owner);
  if (!guess.ok) return tryLater(ctx, guess.reason);
  // A mailbox whose backstop tripped or that reached its ceiling is being guessed at: logged at error level, once per
  // trip, with a pseudonymous prefix of its key (an HMAC under K_rl, never the address) so staff can see targeted
  // mailboxes. Until the UTC day ends it answers "try again later" (D198).
  if (guess.tripped) log({ event: 'mailbox_guess_limit', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: guess.tripped, subject: live.mailboxKey.slice(0, 12) }, 'error');
  const keys = await deps.keys();
  const v = await stub.verify(await codeMac(keys, cid.id, b.code), now);
  if (v.result === 'gone') {
    await box.refundGuess(ip, guess.reservation, now);
    return gone();
  }
  if (v.result === 'wrong') {
    if (v.attemptsLeft === 0) await box.releaseLive(v.expiresAtMs, now);
    return fail(ctx, 400, 'code_invalid', 'Wrong code', { attemptsLeft: v.attemptsLeft });
  }
  await box.refundGuess(ip, guess.reservation, now);
  await box.releaseLive(v.record.expiresAtMs, now);
  // The code was right: the challenge is gone (single use). At most one token is minted from it.
  const rec = v.record;
  // A verified login at a capped domain gives its mails' places back and raises the domain's cap (abuse review M1).
  if (rec.domainKey) await limiter(deps, `dom:${rec.domainKey}`).domainVerified(rec.domainRes, rec.mailboxKey, now);
  const app = await appById(deps.env.APP_DB, rec.appId);
  if (!app?.active || !app.emailOn || app.scopeId !== rec.scopeId) return fail(ctx, 403, 'email_not_enabled', 'Email login is not enabled for this app');
  const email = await decryptEmail(cid, rec.emailEnc);
  if (email === null) return gone();
  const sub = await emailSub(keys.sub, email);
  // Proof that this browser read a code at this exact address: the owner's way past a code drain (D198). Registered in
  // the mailbox object: at most 5 live per address, a newer one revoking the oldest.
  const addrKey = await suppressionKey(keys, email);
  const issued = await issueDeviceTicket(keys, addrKey, now);
  await box.registerTicket(addrKey, issued.id, issued.issuedAtMs, now);
  const owner = issued.ticket;
  // The user directory (D269): every answer below that carries a 200 proved control of this address for this app and
  // scope (case B included: no token, but the code was right), so each records the email identity, after the answer
  // (waitUntil) and never failing or slowing it. Refusals (`409 links_unavailable`, `409 link_refused`) and errors
  // record nothing.
  const recorded = (res: Response): Response => {
    recordUserEmailLater(deps.env.DB, deps.waitUntil, { provider: 'email', sub, email, emailVerified: true, hosted: null, appId: app.id, scopeId: rec.scopeId, nowMs: now });
    return res;
  };

  if (rec.purpose === 'session') {
    // Case B lookup: a Google identity that reported this address as verified has the wallet here (D119). A hint for a
    // non-Google-hosted address counts only if that Google identity logged in with it within 180 days (D199).
    const staleBefore = now - NON_HOSTED_HINT_TTL_MS;
    await deps.env.DB.prepare('DELETE FROM email_hints WHERE scope_id = ?1 AND email_sub = ?2 AND hosted = 0 AND updated_at_ms <= ?3').bind(rec.scopeId, sub, staleBefore).run();
    const hints = await deps.env.DB.prepare('SELECT google_sub FROM email_hints WHERE scope_id = ?1 AND email_sub = ?2 AND (hosted = 1 OR updated_at_ms > ?4) ORDER BY updated_at_ms DESC LIMIT ?3')
      .bind(rec.scopeId, sub, MAX_HINTS, staleBefore)
      .all<{ google_sub: string }>();
    const caseB: string[] = [];
    let googleWallet = false;
    for (const h of hints.results) {
      const j = await judgeChain(deps, rec.scopeId, h.google_sub, sub);
      if (j.decision === 'case_b') {
        googleWallet = true;
        if (j.linkable) caseB.push(h.google_sub);
      }
    }
    if (googleWallet) {
      // No session token for the identity without a wallet (D122, tokens review L1): "no case D" holds on the server.
      // The popup continues with Google; a ticket, bound to this address and to the hinted Google identities, lets
      // that Google step join the email identity.
      let linkTicket: string | undefined;
      if (caseB.length > 0) {
        linkTicket = randomId();
        const t: TicketRecord = { appId: app.id, scopeId: rec.scopeId, sub, googleSubs: caseB, expiresAtMs: now + LINK_TICKET_TTL_MS };
        if (!(await challengeStub(deps, ticketName(linkTicket)).putTicket(t))) linkTicket = undefined;
      }
      // With the ticket goes this address's `sub` (a pseudonym, never the address): the vault signs the case-B link
      // only for a link token of this `sub`, so it needs this popup's own email step (D139, D256).
      return recorded(ok(ctx, 200, { googleWallet: true, deviceTicket: owner, ...(linkTicket ? { linkTicket, sub } : {}) }, { appId: app.id, purpose: rec.purpose, decision: 'case_b' }));
    }
    const { token: idToken } = await mint(ctx, app, rec.scopeId, sub, rec.nonce!, 'session');
    return recorded(ok(ctx, 200, { idToken, googleWallet: false, deviceTicket: owner }, { appId: app.id, purpose: rec.purpose }));
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
    deps.waitUntil(notify(ctx, email, app.name, false, app.id, rec.budgetShare));
    return recorded(ok(ctx, 200, { idToken, googleWallet: false, decision: 'case_a', linkImmediate: true, deviceTicket: owner }, { appId: app.id, purpose: rec.purpose, decision: 'case_a' }));
  }

  const { token: idToken } = await mint(ctx, app, rec.scopeId, sub, rec.nonce!, rec.purpose);
  return recorded(ok(ctx, 200, { idToken, googleWallet: false, deviceTicket: owner }, { appId: app.id, purpose: rec.purpose }));
}

// ---- google-match ----

/** "a…@domain": what the popup shows of the address a case-A code goes to. */
export const maskEmail = (normalized: string): string => {
  const at = normalized.lastIndexOf('@');
  return `${normalized.slice(0, 1)}…${normalized.slice(at)}`;
};

/**
 * The access token is never revoked here (D265, amending D254): Google's revocation ends the user's whole grant to the
 * client, so the email consent would come back at every login, and on Hana's shared client it would cancel the grant
 * other apps of that client rely on (and two logins at once would revoke each other's token). The token is
 * email-scope only, expires within the hour, is never stored or logged, and reaches the issuer once per login through
 * a single-use relay slot.
 */
export async function handleGoogleMatch(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['pk', 'accessToken', 'googleIdToken', 'commitment', 'link'], ['linkTicket'])) {
    return fail(ctx, 400, 'bad_request', 'Body must be {pk, accessToken, googleIdToken, commitment, linkTicket?, link}');
  }
  const accessToken = typeof b.accessToken === 'string' && b.accessToken.length > 0 && b.accessToken.length <= 4096 ? b.accessToken : null;
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
  if (id.value.nonce !== sessionNonceOf(deps, sc.value)) return fail(ctx, 400, 'nonce_mismatch', 'The Google ID token nonce does not commit to this session');
  const ti = await deps.google.checkAccessToken(accessToken, id.value.aud, id.value.sub);
  // Another Google account's token (the user picked another account on Google's permission screen): its own code,
  // so the popup can say so (D264).
  if (!ti.ok && ti.reason === 'tokeninfo_sub') return fail(ctx, 400, 'google_account_mismatch', 'The Google access token is another Google account’s');
  if (!ti.ok) return fail(ctx, 400, 'google_token_invalid', 'The Google access token is not for this sign-in');
  const ui = await deps.google.userInfo(accessToken, id.value.sub);
  if (!ui.ok && ui.reason === 'userinfo_sub') return fail(ctx, 400, 'google_account_mismatch', 'The Google access token is another Google account’s');
  if (!ui.ok) return fail(ctx, 400, 'google_token_invalid', 'Google did not return the account’s address');

  // Only a Google-verified address can match (D119); the address lives in this call only.
  const r = ui.value.emailVerified ? normalizeEmail(ui.value.email) : null;
  if (!r?.ok) return ok(ctx, 200, { decision: 'none', googleHosted: false, linkable: false }, { appId: app.id, decision: 'none' });
  const googleHosted = isGoogleHosted({ email: r.email, emailVerified: ui.value.emailVerified, hd: ui.value.hd });
  const keys = await deps.keys();
  const sub = await emailSub(keys.sub, r.email);
  const googleSub = id.value.sub;
  // The hint a Google login writes for every Google-verified address (D119, D122: a hosted one kept while the scope
  // exists). A non-hosted one counts for 180 days after this login, then is pruned, and its case B links only after
  // 24 h (mode 0 below), with link notices (D199's residual risk).
  await deps.env.DB.batch([
    deps.env.DB.prepare(
      'INSERT INTO email_hints (scope_id, email_sub, google_sub, hosted, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (scope_id, email_sub, google_sub) DO UPDATE SET hosted = excluded.hosted, updated_at_ms = excluded.updated_at_ms',
    ).bind(app.scopeId, sub, googleSub, googleHosted ? 1 : 0, now),
    deps.env.DB.prepare('DELETE FROM email_hints WHERE rowid IN (SELECT rowid FROM email_hints WHERE hosted = 0 AND updated_at_ms <= ?1 LIMIT ?2)').bind(now - NON_HOSTED_HINT_TTL_MS, HINT_PRUNE_BATCH),
  ]);

  const j = await judgeChain(deps, app.scopeId, googleSub, sub);
  // A ticket is single use: any google-match that presents it spends it. It counts only for this address and for one
  // of the Google identities the email step found (tokens review L2).
  let ticketValid = false;
  if (b.linkTicket !== undefined) {
    const t = await challengeStub(deps, ticketName(b.linkTicket)).takeTicket(app.id, now);
    ticketValid = !!t && t.scopeId === app.scopeId && t.sub === sub && t.googleSubs.includes(googleSub);
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
      deps.waitUntil(notify(ctx, r.email, app.name, false, app.id, shareOf(ctx, app)));
      return ok(ctx, 200, { ...base, emailToken, linkImmediate: true }, { appId: app.id, decision: j.decision });
    }
    // Not Google-hosted: a code to that address first (D195). The challenge is prepared here, where the verified
    // address is known; its first code goes out when the popup calls `resend` after "Link and continue".
    // Admitted like any challenge (the live cap, the requester's lock); a suppressed or limited mailbox gets none.
    const mbx = await mailboxKey(keys, r.mailbox);
    const expiresAtMs = now + CHALLENGE_TTL_MS;
    const adm = (await isSuppressed(deps, await suppressionKey(keys, r.email))) ? null : await mailboxLimiter(deps, mbx).admit(requesterKey(ipOf(request)), expiresAtMs, false, now);
    if (!adm?.ok) return ok(ctx, 200, base, { appId: app.id, decision: j.decision, code: 'challenge_unavailable' });
    const cid = newChallengeId();
    const rec: ChallengeRecord = {
      appId: app.id,
      appName: app.name,
      scopeId: app.scopeId,
      purpose: 'auto_link',
      nonce: null,
      autoLink: { googleSub, sessionHash: base64UrlEncode(sessionHash) },
      silent: false,
      emailEnc: await encryptEmail(cid, r.email),
      mailboxKey: mbx,
      domainKey: await domainSubject(deps, r.domain),
      owner: null,
      budgetShare: shareOf(ctx, app),
      domainRes: [],
      codeMac: null,
      attempts: 0,
      createdAtMs: now,
      expiresAtMs,
      lastSentAtMs: null,
      resends: 0,
    };
    if (!(await challengeStub(deps, cid.name).create(rec))) {
      await mailboxLimiter(deps, mbx).unadmit(adm.created, expiresAtMs, now);
      return fail(ctx, 500, 'internal', 'Could not prepare the challenge');
    }
    return ok(ctx, 200, { ...base, challenge: { challengeId: cid.id, expiresAtMs: rec.expiresAtMs, to: maskEmail(r.email) } }, { appId: app.id, decision: j.decision });
  }

  if (j.decision === 'case_b' && linkable && j.join && b.link && ticketValid) {
    const mode = googleHosted ? 1 : 0;
    const nonce = nonceOf(autoLinkPreimage(deps.env.SIGNER_ACCOUNT, app.scopeId, sessionHash, sessionIk, { ...j.join, mode }));
    const { token: emailToken } = await mint(ctx, app, app.scopeId, sub, nonce, 'auto_link');
    deps.waitUntil(notify(ctx, r.email, app.name, !googleHosted, app.id, shareOf(ctx, app)));
    return ok(ctx, 200, { ...base, emailToken, linkImmediate: mode === 1 }, { appId: app.id, decision: j.decision });
  }
  return ok(ctx, 200, base, { appId: app.id, decision: j.decision });
}

const sessionNonceOf = (deps: Deps, c: SessionCommitment): string => nonceOf(sessionPreimage(deps.env.SIGNER_ACCOUNT, c));

// ---- staff (admin/*) ----

/**
 * Every staff route: Cloudflare Access plus the issuer's staff allowlist (D88), the shared staff bucket (20 actions an
 * hour each), a support reference (`ticket`) in the body; the router has already refused an `Origin` header and a
 * non-JSON body (M2).
 */
async function staffGate(request: Request, ctx: Ctx, fields: string[]): Promise<{ ok: true; staff: string; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const { deps } = ctx;
  if (!deps.access) return { ok: false, response: fail(ctx, 404, 'not_found', 'Not found') };
  const staff = await deps.access.staff(request);
  if (!staff) return { ok: false, response: fail(ctx, 403, 'forbidden', 'Staff access required') };
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return { ok: false, response: fail(ctx, parsed.status, 'bad_request', parsed.message) };
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, [...fields, 'ticket']) || typeof b.ticket !== 'string' || !SUPPORT_TICKET_RE.test(b.ticket)) {
    return { ok: false, response: fail(ctx, 400, 'bad_request', `Body must be {${[...fields, 'ticket'].join(', ')}} (ticket: the support reference)`) };
  }
  const staffKey = toHex(sha256(new TextEncoder().encode(staff)));
  const lim = await limiter(deps, `staff:${staffKey}`).hit(STAFF_LIMITS, deps.now());
  if (!lim.ok) return { ok: false, response: tooMany(ctx, lim.retryAfterMs) };
  return { ok: true, staff, body: b };
}

/** The audit row, written before the action it records (M2). */
const audit = (deps: Deps, row: { staff: string; action: string; ticket: string; scopeId?: string; actionNonce?: number; jti?: string; subject?: string }) =>
  deps.env.DB.prepare('INSERT INTO email_admin_audit (at_ms, staff, action, ticket, scope_id, action_nonce, jti, subject) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(deps.now(), row.staff, row.action, row.ticket, row.scopeId ?? null, row.actionNonce ?? null, row.jti ?? null, row.subject ?? null)
    .run();

/**
 * `{scopeId, actionNonce, ticket}` → a client proof for `("email", "email:" + scopeId)`: only for a registered scope
 * whose current `action_nonce` is `actionNonce` and that has an active app with email on (tokens review L6).
 */
export async function handleClientProof(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const gate = await staffGate(request, ctx, ['scopeId', 'actionNonce']);
  if (!gate.ok) return gate.response;
  const { scopeId, actionNonce, ticket } = gate.body as { scopeId: unknown; actionNonce: unknown; ticket: string };
  if (!isScopeId(scopeId) || !Number.isSafeInteger(actionNonce) || (actionNonce as number) < 0) return fail(ctx, 400, 'bad_request', 'scopeId and actionNonce are malformed');
  const scope = await deps.chain.scope(scopeId, true);
  if (!scope) return fail(ctx, 404, 'unknown_scope', 'The scope is not registered on chain');
  if (scope.actionNonce !== actionNonce) return fail(ctx, 409, 'stale_action_nonce', 'actionNonce is not the scope’s current action_nonce', { actionNonce: scope.actionNonce });
  if (!(await scopeHasEmailApp(deps.env.APP_DB, scopeId))) return fail(ctx, 409, 'email_not_enabled', 'No active app of this scope has email on');
  const jti = randomId(16);
  await audit(deps, { staff: gate.staff, action: 'client_proof', ticket, scopeId, actionNonce: actionNonce as number, jti });
  const { token } = await mint(ctx, null, scopeId, CLIENT_PROOF_SUB, clientProofNonce(deps.env.SIGNER_ACCOUNT, scopeId, actionNonce as number), 'client_proof', jti);
  return ok(ctx, 200, { token, client: emailClient(scopeId) }, { scopeId, purpose: 'client_proof', jti });
}

/**
 * `{email, ticket}` (the address the user gave support) → a one-time unlock grant for the mailbox, its token **mailed to
 * the address** (abuse review M3): only the mailbox's holder gets it, never staff, never whoever asks. The start that
 * presents it counts as an owner's (D198). Clears nothing: the shared guess counters and every lock stay. At most 1 a
 * day and 3 in 30 days per mailbox. Audited first (staff, ticket, a 12-character prefix of the mailbox key).
 */
export async function handleUnlock(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const gate = await staffGate(request, ctx, ['email']);
  if (!gate.ok) return gate.response;
  const r = typeof gate.body.email === 'string' ? normalizeEmail(gate.body.email) : null;
  if (!r?.ok) return fail(ctx, 400, 'invalid_email', 'Not a valid email address');
  const keys = await deps.keys();
  const mbx = await mailboxKey(keys, r.mailbox);
  const box = mailboxLimiter(deps, mbx);
  if (!(await box.staffAction('unlock', deps.now()))) return fail(ctx, 429, 'staff_cap', 'This mailbox was unlocked already today, or 3 times in 30 days');
  await audit(deps, { staff: gate.staff, action: 'unlock', ticket: gate.body.ticket as string, subject: mbx.slice(0, 12) });
  // A suppressed address gets no mail (unsuppress first, with its own mailed confirmation).
  if (await isSuppressed(deps, await suppressionKey(keys, r.email))) return ok(ctx, 200, { mailed: false, reason: 'suppressed' }, { code: 'suppressed' });
  const token = `${UNLOCK_TOKEN_PREFIX}${randomId(32)}`;
  await box.issueGrant(base64UrlEncode(sha256(utf8(token))), deps.now());
  const mailed = await mailOwner(ctx, unlockMail({ to: r.email, token, authOrigin: deps.env.AUTH_ORIGIN }));
  log({ event: 'mailbox_unlocked', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: mailed ? 'ok' : 'error', subject: mbx.slice(0, 12) }, 'warn');
  return ok(ctx, 200, { mailed }, { code: mailed ? 'mailed' : 'not_mailed' });
}

/**
 * `{email, ticket}` → mails the address a one-time confirmation (abuse review M3); its suppression (a bounce, or a
 * complaint the user withdrew) is removed only when the mailbox's holder confirms it (`POST /v1/email/confirm`).
 * Capped and audited as unlock. SendGrid keeps its own suppression list: the runbook removes the address there first.
 */
export async function handleUnsuppress(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const gate = await staffGate(request, ctx, ['email']);
  if (!gate.ok) return gate.response;
  const r = typeof gate.body.email === 'string' ? normalizeEmail(gate.body.email) : null;
  if (!r?.ok) return fail(ctx, 400, 'invalid_email', 'Not a valid email address');
  const keys = await deps.keys();
  const box = mailboxLimiter(deps, await mailboxKey(keys, r.mailbox));
  if (!(await box.staffAction('unsuppress', deps.now()))) return fail(ctx, 429, 'staff_cap', 'This mailbox was unsuppressed already today, or 3 times in 30 days');
  const key = await suppressionKey(keys, r.email);
  await audit(deps, { staff: gate.staff, action: 'unsuppress', ticket: gate.body.ticket as string, subject: key.slice(0, 12) });
  const row = await deps.env.DB.prepare('SELECT 1 AS x FROM email_suppressions WHERE email_key = ?1').bind(key).first();
  if (!row) return ok(ctx, 200, { mailed: false, reason: 'not_suppressed' }, { code: 'not_suppressed' });
  const token = `${CONFIRM_TOKEN_PREFIX}${randomId(32)}`;
  if (!(await challengeStub(deps, confirmName(token)).putConfirm({ action: 'unsuppress', emailKey: key, expiresAtMs: deps.now() + CONFIRM_TTL_MS }))) return fail(ctx, 500, 'internal', 'Could not store the confirmation');
  const mailed = await mailOwner(ctx, confirmMail({ to: r.email, token, authOrigin: deps.env.AUTH_ORIGIN }));
  return ok(ctx, 200, { mailed }, { code: mailed ? 'mailed' : 'not_mailed' });
}

/**
 * `{email, ticket}` → revokes every device ticket of that exact address issued until now (a lost or shared device).
 * Capped and audited as unlock.
 */
export async function handleRevokeTickets(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const gate = await staffGate(request, ctx, ['email']);
  if (!gate.ok) return gate.response;
  const r = typeof gate.body.email === 'string' ? normalizeEmail(gate.body.email) : null;
  if (!r?.ok) return fail(ctx, 400, 'invalid_email', 'Not a valid email address');
  const keys = await deps.keys();
  const box = mailboxLimiter(deps, await mailboxKey(keys, r.mailbox));
  if (!(await box.staffAction('revoke', deps.now()))) return fail(ctx, 429, 'staff_cap', 'This mailbox’s tickets were revoked already today, or 3 times in 30 days');
  const key = await suppressionKey(keys, r.email);
  await audit(deps, { staff: gate.staff, action: 'revoke_tickets', ticket: gate.body.ticket as string, subject: key.slice(0, 12) });
  await box.revokeTickets(key, deps.now());
  log({ event: 'device_tickets_revoked', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'ok', subject: key.slice(0, 12) }, 'warn');
  return ok(ctx, 200, { revoked: true });
}

/** `{token}` (from a mailed confirmation, on `authOrigin`) → does what staff asked once the mailbox's holder confirms. */
export async function handleConfirm(request: Request, ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return fail(ctx, parsed.status, 'bad_request', parsed.message);
  const b = parsed.body;
  if (!isObj(b) || !onlyKeys(b, ['token']) || typeof b.token !== 'string' || !CONFIRM_TOKEN_RE.test(b.token)) return fail(ctx, 400, 'bad_request', 'Body must be {token}');
  const limited = await ipLimit(ctx, request, IP_RESEND_LIMITS);
  if (limited) return limited;
  const c = await challengeStub(deps, confirmName(b.token)).takeConfirm(deps.now());
  if (!c) return fail(ctx, 410, 'confirm_expired', 'The link expired or was used');
  const res = await deps.env.DB.prepare('DELETE FROM email_suppressions WHERE email_key = ?1').bind(c.emailKey).run();
  const removed = (res.meta.changes ?? 0) > 0;
  log({ event: 'suppression_removed', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'ok', subject: c.emailKey.slice(0, 12), count: removed ? 1 : 0 }, 'warn');
  return ok(ctx, 200, { confirmed: c.action }, { count: removed ? 1 : 0 });
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
  const limited = await ipLimit(ctx, request, IP_WEBHOOK_LIMITS);
  if (limited) return limited;
  const sig = request.headers.get(SIGNATURE_HEADER) ?? '';
  const ts = request.headers.get(TIMESTAMP_HEADER) ?? '';
  const nowS = Math.floor(deps.now() / 1000);
  // The headers are checked before a byte of the body is read (L5).
  if (!webhookHeadersOk(ts, sig, nowS)) return fail(ctx, 401, 'bad_signature', 'Invalid webhook signature');
  const body = await readWebhookBody(request);
  if (!body) return fail(ctx, 413, 'bad_request', 'Body too large');
  if (!(await verifyWebhook(key, ts, body, sig, nowS))) return fail(ctx, 401, 'bad_signature', 'Invalid webhook signature');
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
  if (list.some((s) => s.reason === 'complaint')) {
    const n = await deps.env.DB.prepare("SELECT COUNT(*) AS n FROM email_suppressions WHERE reason = 'complaint' AND at_ms > ?1").bind(now - 86_400_000).first<number>('n');
    if ((n ?? 0) > COMPLAINT_ALERT_PER_DAY) log({ event: 'email_complaint_rate', requestId: ctx.requestId, endpoint: ctx.endpoint, outcome: 'error', code: 'complaints_24h', count: n ?? 0 }, 'error');
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
  unlock: '/v1/email/admin/unlock',
  unsuppress: '/v1/email/admin/unsuppress',
  revokeTickets: '/v1/email/admin/revoke-tickets',
  confirm: '/v1/email/confirm',
  jwks: '/v1/email/jwks.json',
  openid: '/v1/email/.well-known/openid-configuration',
  sendgridWebhook: '/v1/email/webhooks/sendgrid',
} as const;

/** Routes whose limits key on the client's IP: refused without a usable `cf-connecting-ip` (L4). */
const IP_ROUTES: ReadonlySet<string> = new Set([ROUTES.start, ROUTES.resend, ROUTES.verify, ROUTES.confirm, ROUTES.googleMatch, ROUTES.sendgridWebhook]);
const isStaffRoute = (path: string): boolean => path.startsWith('/v1/email/admin/');

/** Which browser origin may call a POST route (null: no browser caller, no CORS). */
function allowedOrigin(deps: Deps, path: string): string | null {
  if (path === ROUTES.start || path === ROUTES.resend || path === ROUTES.verify || path === ROUTES.confirm) return deps.env.AUTH_ORIGIN;
  if (path === ROUTES.googleMatch) return deps.env.VAULT_ORIGIN;
  return null;
}

const isJson = (request: Request): boolean => (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');

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
      [ROUTES.unlock]: handleUnlock,
      [ROUTES.unsuppress]: handleUnsuppress,
      [ROUTES.revokeTickets]: handleRevokeTickets,
      [ROUTES.confirm]: handleConfirm,
      [ROUTES.sendgridWebhook]: handleSendgridWebhook,
    };
    const handler = handlers[path];
    if (!handler) return fail(base, 404, 'not_found', 'Not found');
    const allowed = allowedOrigin(deps, path);
    const origin = request.headers.get('origin');
    let ctx = base;
    if (allowed !== null) {
      // Browser routes: only the one Hana origin, and only with an Origin header (no cookie-less script relays).
      if (origin !== allowed) return fail(base, 403, 'origin_not_allowed', 'Origin not allowed');
      ctx = { ...base, cors: corsHeaders(allowed) };
      if (request.method === 'OPTIONS') return respond(ctx, new Response(null, { status: 204 }));
    } else if (isStaffRoute(path) && origin !== null) {
      // Staff routes are called by staff tooling, never by a page: any Origin (a cross-site request) is refused (M2).
      return fail(base, 403, 'origin_not_allowed', 'Staff routes take no browser requests');
    }
    if (request.method !== 'POST') return fail(ctx, 405, 'method_not_allowed', 'POST only');
    if ((allowed !== null || isStaffRoute(path)) && !isJson(request)) return fail(ctx, 415, 'bad_request', 'Content-Type must be application/json');
    if (IP_ROUTES.has(path) && !isClientIp(rawIp(request))) {
      log({ event: 'missing_client_ip', requestId, endpoint: path, outcome: 'rejected' }, 'warn');
      return fail(ctx, 400, 'missing_client_ip', 'The request has no client address');
    }
    return await handler(request, ctx);
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

/** Exported for tests. */
export type { ChallengeId };
