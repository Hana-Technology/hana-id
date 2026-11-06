// The email issuer calls /login/email makes (docs/api.md "Email issuer"; apps/email-issuer): `start`, `resend` and
// `verify`, POST JSON from authOrigin only, no cookies (D70). The issuer is reached at its own URL (D230), never
// through the API, so an address or a code never passes through the API Worker.
//
// SECURITY: `start` carries the address, `verify` the code, and `verify` answers the email token and a device ticket.
// Nothing here logs a body or puts one in an error message; errors carry the issuer's code only.
import { ApiError, type CaseBProof, isSealedEmailText, parseApiResponse } from '@hana-id/core';
import { CHALLENGE_ID_RE, DEVICE_TICKET_RE } from './email-storage.ts';

export type Fetch = typeof fetch;

/** The `session` purpose's commitment: the session nonce's inputs (the issuer computes the nonce itself). */
export interface SessionCommitment {
  scopeId: string;
  sessionPublicKey: Uint8Array;
  expiresAtMs: number;
  keyIndex: number;
  maxUses: number;
  salt: Uint8Array;
}

export interface Challenge {
  challengeId: string;
  expiresAtMs: number;
  resendAfterMs: number;
}

export type Verified =
  /**
   * The address's email token (JWS JSON) and this device's ticket for it; `sealedEmail` (D420), a `session` token's
   * sealed address for the API, relayed beside the token (opaque here), when the issuer sent one.
   */
  | { kind: 'token'; idToken: string; deviceTicket: string | null; sealedEmail?: string }
  /**
   * Case B (D119): a Google identity that reported this address has the wallet in this scope, the email identity has
   * none, so no token is minted: the popup continues with Google (batch 8a: a plain Google login, no link).
   */
  | { kind: 'google_wallet'; deviceTicket: string | null; link?: CaseBProof };

/** A link purpose's commitment, as the vault prepared it (the issuer computes the nonce, D195). */
export type LinkPurpose = 'link_new' | 'link_account' | 'link_change';

export interface EmailApi {
  start(pk: string, email: string, commitment: SessionCommitment, deviceTicket: string | null): Promise<Challenge>;
  /** `start` for a link purpose (build plan batch 8b), with the commitment the vault sent. */
  startLink(pk: string, email: string, purpose: LinkPurpose, commitment: Record<string, unknown>, deviceTicket: string | null): Promise<Challenge>;
  resend(challengeId: string): Promise<Challenge>;
  verify(challengeId: string, code: string): Promise<Verified>;
}

const bad = (what: string): ApiError => new ApiError(502, 'bad_response', `Unexpected ${what} response`, null, null);
const isMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function challenge(body: Record<string, unknown>, what: string): Challenge {
  const { challengeId, expiresAtMs, resendAfterMs } = body;
  if (typeof challengeId !== 'string' || !CHALLENGE_ID_RE.test(challengeId) || !isMs(expiresAtMs) || !isMs(resendAfterMs)) throw bad(what);
  return { challengeId, expiresAtMs, resendAfterMs };
}

const ticketOf = (v: unknown): string | null => (typeof v === 'string' && DEVICE_TICKET_RE.test(v) ? v : null);

export function emailApi(issuerUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): EmailApi {
  const base = `${new URL(issuerUrl).origin}/v1/email`;
  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    parseApiResponse(
      await fetchFn(`${base}/${path}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  return {
    async start(pk, email, c, deviceTicket) {
      const commitment = {
        scopeId: c.scopeId,
        sessionPublicKey: Array.from(c.sessionPublicKey),
        expiresAtMs: c.expiresAtMs,
        keyIndex: c.keyIndex,
        maxUses: c.maxUses,
        salt: Array.from(c.salt),
      };
      return challenge(await post('start', { pk, email, purpose: 'session', commitment, ...(deviceTicket ? { deviceTicket } : {}) }), 'start');
    },

    async startLink(pk, email, purpose, commitment, deviceTicket) {
      return challenge(await post('start', { pk, email, purpose, commitment, ...(deviceTicket ? { deviceTicket } : {}) }), 'start');
    },

    async resend(challengeId) {
      return challenge(await post('resend', { challengeId }), 'resend');
    },

    async verify(challengeId, code) {
      const body = await post('verify', { challengeId, code });
      const deviceTicket = ticketOf(body.deviceTicket);
      if (body.googleWallet === true) {
        // Case B with a ticket: the address's `sub` comes with it, for the vault's D139 check (batch 8b).
        const { linkTicket, sub } = body;
        const link = typeof linkTicket === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(linkTicket) && typeof sub === 'string' && /^e1\.[A-Za-z0-9_-]{43}$/u.test(sub) ? { linkTicket, emailSub: sub } : null;
        return link ? { kind: 'google_wallet', deviceTicket, link } : { kind: 'google_wallet', deviceTicket };
      }
      if (body.googleWallet !== false || typeof body.idToken !== 'string' || !body.idToken.startsWith('{')) throw bad('verify');
      return { kind: 'token', idToken: body.idToken, deviceTicket, ...(isSealedEmailText(body.sealedEmail) ? { sealedEmail: body.sealedEmail } : {}) };
    },
  };
}
