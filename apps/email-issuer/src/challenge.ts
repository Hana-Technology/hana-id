// The `EmailChallenge` Durable Object (spec "Codes, attempts, expiry, replay"): one object per challenge (named by
// its challengeId) or per link ticket (named `t:` + sha256 of the ticket). It holds the normalized address only for
// resends and only until the challenge ends (≤ 10 min, D197), the code only as HMAC-SHA256(K_code, challengeId ‖ code)
// (compared in constant time), the purpose and its nonce (or, for auto_link, what the nonce needs at minting), and the
// attempts. A correct code is single use: the object deletes everything before the worker mints the token. An alarm at
// expiry deletes whatever is left.
import { DurableObject } from 'cloudflare:workers';
import { base64UrlDecode, bytesEqual } from './bytes.ts';
import type { Purpose } from './commitment.ts';
import type { Env } from './env.ts';
import { MAX_ATTEMPTS, MAX_RESENDS, RESEND_SPACING_MS } from './limits.ts';

export interface ChallengeRecord {
  appId: string;
  appName: string;
  scopeId: string;
  purpose: Purpose;
  /** The token's nonce (every purpose but auto_link). */
  nonce: string | null;
  /** auto_link (created by google-match, D195): the Google identity and sha256(session nonce preimage), b64url. */
  autoLink: { googleSub: string; sessionHash: string } | null;
  /** The normalized address, byte for byte what the mail goes to (packages/email README). */
  email: string;
  /** HMAC-SHA256(K_rl, normalized), b64url: the limiter subject. */
  emailKey: string;
  /** b64url MAC of the live code; null for a prepared auto_link challenge whose first code isn't sent yet. */
  codeMac: string | null;
  attempts: number;
  createdAtMs: number;
  expiresAtMs: number;
  lastSentAtMs: number | null;
  /** Codes sent after the first. */
  resends: number;
}

export interface TicketRecord {
  appId: string;
  scopeId: string;
  /** The email identity's `sub` the ticket was issued for. */
  sub: string;
  expiresAtMs: number;
}

export type VerifyOutcome =
  | { result: 'ok'; record: ChallengeRecord }
  | { result: 'wrong'; attemptsLeft: number; emailKey: string }
  | { result: 'gone' };

export type SendOutcome =
  | { result: 'ok'; record: ChallengeRecord; first: boolean; previous: { lastSentAtMs: number | null; resends: number } }
  | { result: 'too_soon'; retryAfterMs: number }
  | { result: 'limit' }
  | { result: 'gone' };

const RECORD = 'challenge';
const TICKET = 'ticket';

export class Challenge extends DurableObject<Env> {
  private load(now: number): ChallengeRecord | null {
    const rec = this.ctx.storage.kv.get<ChallengeRecord>(RECORD);
    if (!rec) return null;
    if (rec.expiresAtMs <= now || rec.attempts >= MAX_ATTEMPTS) {
      this.ctx.storage.kv.delete(RECORD);
      return null;
    }
    return rec;
  }

  /** Stores a new challenge; refuses to overwrite one (a challengeId is 32 random bytes, so a clash is a bug). */
  async create(rec: ChallengeRecord): Promise<boolean> {
    if (this.ctx.storage.kv.get(RECORD) !== undefined || this.ctx.storage.kv.get(TICKET) !== undefined) return false;
    this.ctx.storage.kv.put(RECORD, rec);
    await this.ctx.storage.setAlarm(rec.expiresAtMs + 1);
    return true;
  }

  /** The limiter subject of a live challenge (for the lock check before verify), or null. */
  peek(now: number = Date.now()): { emailKey: string; appId: string } | null {
    const rec = this.load(now);
    return rec ? { emailKey: rec.emailKey, appId: rec.appId } : null;
  }

  /**
   * A new code for the challenge (`resend`; for a prepared auto_link challenge, its first code): ≥ 30 s after the last
   * send, ≤ 2 resends. The old code dies. Returns the record for the mail.
   */
  newCode(codeMac: string, now: number = Date.now()): SendOutcome {
    const rec = this.load(now);
    if (!rec) return { result: 'gone' };
    const first = rec.lastSentAtMs === null;
    if (!first) {
      if (rec.resends >= MAX_RESENDS) return { result: 'limit' };
      const wait = rec.lastSentAtMs! + RESEND_SPACING_MS - now;
      if (wait > 0) return { result: 'too_soon', retryAfterMs: wait };
    }
    const next: ChallengeRecord = { ...rec, codeMac, lastSentAtMs: now, resends: first ? rec.resends : rec.resends + 1 };
    this.ctx.storage.kv.put(RECORD, next);
    return { result: 'ok', record: next, first, previous: { lastSentAtMs: rec.lastSentAtMs, resends: rec.resends } };
  }

  /**
   * Takes back the count of a send the provider refused (the code was never delivered), so the user's next resend
   * isn't spent on it. Silent non-sends (suppressed, locked, over a limit) are never taken back: they must look alike.
   */
  undoSend(previous: { lastSentAtMs: number | null; resends: number }): void {
    const rec = this.ctx.storage.kv.get<ChallengeRecord>(RECORD);
    if (rec) this.ctx.storage.kv.put(RECORD, { ...rec, lastSentAtMs: previous.lastSentAtMs, resends: previous.resends });
  }

  /**
   * Checks a code's MAC. Wrong: one attempt used, and the fifth kills the challenge. Right: the challenge is deleted
   * (single use) and returned, so the worker can mint exactly one token.
   */
  async verify(mac: string, now: number = Date.now()): Promise<VerifyOutcome> {
    const rec = this.load(now);
    if (!rec) return { result: 'gone' };
    const ok = rec.codeMac !== null && bytesEqual(base64UrlDecode(rec.codeMac), base64UrlDecode(mac));
    if (ok) {
      await this.ctx.storage.deleteAll();
      return { result: 'ok', record: rec };
    }
    const attempts = rec.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) await this.ctx.storage.deleteAll();
    else this.ctx.storage.kv.put(RECORD, { ...rec, attempts });
    return { result: 'wrong', attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts), emailKey: rec.emailKey };
  }

  // ---- link tickets (verify → google-match, case B) ----

  async putTicket(t: TicketRecord): Promise<boolean> {
    if (this.ctx.storage.kv.get(RECORD) !== undefined || this.ctx.storage.kv.get(TICKET) !== undefined) return false;
    this.ctx.storage.kv.put(TICKET, t);
    await this.ctx.storage.setAlarm(t.expiresAtMs + 1);
    return true;
  }

  /** Single use: returns the ticket (and deletes it) when it is live and for `appId`; any use deletes it. */
  async takeTicket(appId: string, now: number = Date.now()): Promise<TicketRecord | null> {
    const t = this.ctx.storage.kv.get<TicketRecord>(TICKET);
    if (!t) return null;
    await this.ctx.storage.deleteAll();
    return t.expiresAtMs > now && t.appId === appId ? t : null;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
