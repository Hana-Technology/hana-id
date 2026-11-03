// The vault's one call to the email issuer (docs/email-login-spec.md "How the popup gets Google's verified email";
// build plan batch 8b): `POST {issuer}/v1/email/google-match`, CORS for vaultOrigin only (D199), no cookies. The vault
// sends Google's access token (which the issuer uses for tokeninfo and userinfo, and never stores or revokes: it is
// email-scope only and expires within the hour, D265) with the login's Google ID token and session commitment; the
// issuer answers the case it judged from the chain and, when the case and `link` allow it, an `auto_link` email token.
// The vault re-judges everything from its own RPC before it uses that token (D133), but which email identity the
// Google address matches is the issuer's word alone (K_sub is the issuer's): see D266.
//
// A 429 or 503 is MatchBusy (with the `retry-after`, when sent): the login retries it (G-M3). The request gives up after
// MATCH_TIMEOUT_MS (G-L5).
//
// SECURITY: the body carries Google's ID and access tokens; the answer may carry an email token. Nothing here logs a
// body or puts one in an error; the address never reaches the vault (the issuer reads it from Google and drops it).
import { ApiError, parseApiResponse } from '@hana-id/core';

type Fetch = typeof fetch;

export const MATCH_DECISIONS = ['none', 'linked', 'pending', 'both_wallets', 'unlinked', 'case_a', 'case_b'] as const;
export type MatchDecision = (typeof MATCH_DECISIONS)[number];

export interface GoogleMatch {
  decision: MatchDecision;
  googleHosted: boolean;
  /** False when the account is full, has the joiner's provider, the joiner is linked elsewhere, or links are closed. */
  linkable: boolean;
  /** An `auto_link` email token (Google-hosted case A; case B with this popup's ticket). */
  emailToken: string | null;
  linkImmediate: boolean | null;
  /** Case A, not Google-hosted: the code challenge google-match prepared (its first code goes out with `resend`). */
  challenge: { challengeId: string; expiresAtMs: number; to: string } | null;
}

export interface MatchRequest {
  pk: string;
  accessToken: string;
  googleIdToken: string;
  commitment: { scopeId: string; sessionPublicKey: number[]; expiresAtMs: number; keyIndex: number; maxUses: number; salt: number[] };
  link: boolean;
  linkTicket?: string;
}

/** How long google-match gets before the vault gives up on it (it calls Google twice and the chain a few times). */
export const MATCH_TIMEOUT_MS = 30_000;

/** google-match answered 429 or 503: try again after `retryAfterMs` (its `retry-after` header), when it said. */
export class MatchBusy extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`google-match is busy (${status})`);
  }
}

/** `retry-after` in seconds (1..3600) as ms; null when absent or not a number of seconds. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null || !/^\d{1,4}$/u.test(raw.trim())) return null;
  const s = Number(raw.trim());
  return s >= 1 && s <= 3600 ? s * 1000 : null;
}

const bad = (): ApiError => new ApiError(502, 'bad_response', 'Unexpected google-match response', null, null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseGoogleMatch(body: Record<string, unknown>): GoogleMatch {
  const { decision, googleHosted, linkable, emailToken, linkImmediate, challenge } = body;
  if (!(MATCH_DECISIONS as readonly unknown[]).includes(decision) || typeof googleHosted !== 'boolean' || typeof linkable !== 'boolean') throw bad();
  if (emailToken !== undefined && (typeof emailToken !== 'string' || !emailToken.startsWith('{') || emailToken.length > 7168)) throw bad();
  if (linkImmediate !== undefined && typeof linkImmediate !== 'boolean') throw bad();
  if ((emailToken === undefined) !== (linkImmediate === undefined)) throw bad();
  let c: GoogleMatch['challenge'] = null;
  if (challenge !== undefined) {
    if (
      !isObj(challenge) ||
      typeof challenge.challengeId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(challenge.challengeId) ||
      !Number.isSafeInteger(challenge.expiresAtMs) ||
      typeof challenge.to !== 'string' ||
      challenge.to.length > 260 ||
      !/^.…@[^\s@]+$/u.test(challenge.to)
    ) {
      throw bad();
    }
    c = { challengeId: challenge.challengeId, expiresAtMs: challenge.expiresAtMs as number, to: challenge.to };
  }
  return { decision: decision as MatchDecision, googleHosted, linkable, emailToken: (emailToken as string | undefined) ?? null, linkImmediate: (linkImmediate as boolean | undefined) ?? null, challenge: c };
}

export interface IssuerApi {
  googleMatch(r: MatchRequest): Promise<GoogleMatch>;
}

export function issuerApi(issuerUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): IssuerApi {
  const base = `${new URL(issuerUrl).origin}/v1/email`;
  return {
    async googleMatch(r) {
      const res = await fetchFn(`${base}/google-match`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(r),
        signal: AbortSignal.timeout(MATCH_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status === 503) {
        const after = retryAfterMs(res);
        await res.body?.cancel().catch(() => undefined);
        throw new MatchBusy(res.status, after);
      }
      return parseGoogleMatch(await parseApiResponse(res));
    },
  };
}
