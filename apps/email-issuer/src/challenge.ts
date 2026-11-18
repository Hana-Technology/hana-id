// The `EmailChallenge` Durable Object (spec "Codes, attempts, expiry, replay"): one object per challenge (named by
// sha256 of its id's public half, challenge-id.ts), per link ticket (named `t:` + sha256 of the ticket) or per support
// link (D866: `g:` or `u:` + sha256 of a mailed unlock or confirm token, support-link.ts). For a challenge it holds the
// normalized address only encrypted under a key only the client holds (the id's secret half), only for resends and
// only until the challenge ends (≤ 10 min, D197), the code only as HMAC-SHA256(K_code, challengeId ‖ code)
// (compared in constant time), the purpose and its nonce (or, for auto_link, what the nonce needs at minting), for a
// `session` challenge the session's public key and expiry (what the address is sealed for, D438), and the attempts. Each method's checks and writes run synchronously before any await, so concurrent calls are serialized:
// at most MAX_ATTEMPTS codes are ever compared per challenge, and a correct code is used once (the record is deleted
// before the worker mints the token). An alarm at expiry deletes whatever is left.
import { DurableObject } from 'cloudflare:workers';
import { base64UrlDecode, bytesEqual } from './bytes.ts';
import type { Purpose } from './commitment.ts';
import type { Env } from './env.ts';
import { LINK_TOMBSTONE_MS, MAX_ATTEMPTS, MAX_RESENDS, RESEND_SPACING_MS } from './limits.ts';
import type { SupportAction } from './support-link.ts';
import type { OwnerRef, Reservation } from './rate-limiter.ts';

export interface ChallengeRecord {
  appId: string;
  appName: string;
  scopeId: string;
  purpose: Purpose;
  /** The token's nonce (every purpose but auto_link). */
  nonce: string | null;
  /** auto_link (created by google-match, D195): the Google identity and sha256(session nonce preimage), b64url. */
  autoLink: { googleSub: string; sessionHash: string } | null;
  /**
   * `session` purpose only (D438): the session commitment's public key and expiry, which the verified address is sealed
   * for (`sealedEmail`); null for every other purpose. Absent in a record created before it existed: read as null (that
   * login's answer carries no `sealedEmail`).
   */
  seal?: { sessionPublicKey: number[]; expiresAtMs: number } | null;
  /**
   * A suppressed address's challenge (D198): no address and no code are stored, nothing is ever sent, every code is
   * wrong. It exists so `start` answers alike for every valid address.
   */
  silent: boolean;
  /**
   * The normalized address (byte for byte what the mail goes to, packages/email README), AES-GCM-encrypted under the
   * challenge id's secret half (challenge-id.ts); '' when silent.
   */
  emailEnc: string;
  /** HMAC under K_rl of the mailbox (the address without its `+tag`, D159): the mailbox limiter's subject. */
  mailboxKey: string;
  /** HMAC under K_rl of the recipient's registrable domain: the per-domain cap's subject. */
  domainKey: string;
  /**
   * Started with a valid owner device ticket or unlock grant (D198): its sends use that ticket's own allowance (a
   * grant's are free), the owner budget pool, no domain cap, and its checks the ticket slot (a grant's also its own).
   */
  owner: OwnerRef | null;
  /** The app's daily share of the general budget pool, from its plan, at start. */
  budgetShare: number;
  /** The recipient domain's places this challenge's mails took: given back when it verifies (abuse review M1). */
  domainRes: Reservation[];
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
  /** The Google identities (hinted, with the wallet in case B) whose google-match may use the ticket. */
  googleSubs: string[];
  expiresAtMs: number;
}

/**
 * A support link (D866, support-link.ts): a staff action that waits for the mailbox holder's press on the support page
 * (abuse review M3). `emailEnc` is the address under the token's key; `mailboxKey` an unlock's limiter subject.
 */
export interface SupportLinkRecord {
  action: SupportAction;
  /** The suppression key (K_sup HMAC) of the exact address the mail went to. */
  emailKey: string;
  /** An unlock: the mailbox limiter's subject (HMAC under K_rl of the mailbox), where the grant is. */
  mailboxKey: string | null;
  emailEnc: string;
  /** The support reference staff gave (for the audit row of the press); not secret. */
  ticket: string;
  expiresAtMs: number;
  /** The first press (an unlock may be pressed again while its grant is unused; a confirm once). */
  pressedAtMs: number | null;
}

/** What is left of a support link once it was used or expired: no address, no keys, no reference. */
interface SupportTombstone {
  action: SupportAction;
  expiresAtMs: number;
  usedAtMs: number | null;
}

export type SupportLinkState =
  | { state: 'live'; record: SupportLinkRecord; firstPress: boolean }
  | { state: 'used' }
  | { state: 'expired' }
  | { state: 'unknown' };

export type VerifyOutcome = { result: 'ok'; record: ChallengeRecord } | { result: 'wrong'; attemptsLeft: number; expiresAtMs: number } | { result: 'gone' };

export type SendCheck = { result: 'ok' } | { result: 'too_soon'; retryAfterMs: number } | { result: 'limit' };
export type SendOutcome = { result: 'ok'; record: ChallengeRecord; previous: { lastSentAtMs: number | null; resends: number } } | Exclude<SendCheck, { result: 'ok' }> | { result: 'gone' };

const RECORD = 'challenge';
const TICKET = 'ticket';
const SUPPORT = 'support';

const without = (list: Reservation[], r: Reservation | null): Reservation[] => {
  if (!r) return list;
  const i = list.findIndex((x) => x.keys.join('\n') === r.keys.join('\n'));
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
};

function sendCheck(rec: ChallengeRecord, now: number): SendCheck {
  if (rec.lastSentAtMs === null) return { result: 'ok' };
  if (rec.resends >= MAX_RESENDS) return { result: 'limit' };
  const wait = rec.lastSentAtMs + RESEND_SPACING_MS - now;
  return wait > 0 ? { result: 'too_soon', retryAfterMs: wait } : { result: 'ok' };
}

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

  /** A live challenge's limiter subjects and flags, and whether another code may go out now; null when gone. */
  peek(now: number = Date.now()): { mailboxKey: string; domainKey: string; appId: string; scopeId: string; purpose: Purpose; silent: boolean; owner: OwnerRef | null; budgetShare: number; send: SendCheck } | null {
    const rec = this.load(now);
    return rec ? { mailboxKey: rec.mailboxKey, domainKey: rec.domainKey, appId: rec.appId, scopeId: rec.scopeId, purpose: rec.purpose, silent: rec.silent, owner: rec.owner, budgetShare: rec.budgetShare, send: sendCheck(rec, now) } : null;
  }

  /**
   * A new code (`resend`; for a prepared auto_link challenge, its first code): ≥ 30 s after the last send, ≤ 2
   * resends. The old code dies. Returns the record for the mail, and what to restore if the provider refuses it.
   */
  newCode(codeMac: string, now: number = Date.now(), domainRes: Reservation | null = null): SendOutcome {
    const rec = this.load(now);
    if (!rec) return { result: 'gone' };
    const check = sendCheck(rec, now);
    if (check.result !== 'ok') return check;
    const first = rec.lastSentAtMs === null;
    const next: ChallengeRecord = {
      ...rec,
      codeMac: rec.silent ? rec.codeMac : codeMac,
      lastSentAtMs: now,
      resends: first ? rec.resends : rec.resends + 1,
      domainRes: domainRes ? [...rec.domainRes, domainRes] : rec.domainRes,
    };
    this.ctx.storage.kv.put(RECORD, next);
    return { result: 'ok', record: next, previous: { lastSentAtMs: rec.lastSentAtMs, resends: rec.resends } };
  }

  /**
   * Takes back the count of a send the provider refused (the code was never delivered), so the user's next resend
   * isn't spent on it. Silent non-sends are never taken back: they must look alike.
   */
  undoSend(previous: { lastSentAtMs: number | null; resends: number }, domainRes: Reservation | null = null): void {
    const rec = this.ctx.storage.kv.get<ChallengeRecord>(RECORD);
    if (rec) this.ctx.storage.kv.put(RECORD, { ...rec, lastSentAtMs: previous.lastSentAtMs, resends: previous.resends, domainRes: without(rec.domainRes, domainRes) });
  }

  /** A send whose domain place was given back (the provider refused it): it is no longer this challenge's. */
  forgetDomain(domainRes: Reservation): void {
    const rec = this.ctx.storage.kv.get<ChallengeRecord>(RECORD);
    if (rec) this.ctx.storage.kv.put(RECORD, { ...rec, domainRes: without(rec.domainRes, domainRes) });
  }

  /**
   * Checks a code's MAC, atomically: the attempt is counted (and, at the fifth, the challenge killed) before anything
   * awaits. Right: the record is deleted (single use) and returned, so the worker mints exactly one token.
   */
  async verify(mac: string, now: number = Date.now()): Promise<VerifyOutcome> {
    const kv = this.ctx.storage.kv;
    const rec = this.load(now);
    if (!rec) return { result: 'gone' };
    const ok = !rec.silent && rec.codeMac !== null && bytesEqual(base64UrlDecode(rec.codeMac), base64UrlDecode(mac));
    if (ok) {
      kv.delete(RECORD);
      await this.ctx.storage.deleteAll();
      return { result: 'ok', record: rec };
    }
    const attempts = rec.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      kv.delete(RECORD);
      await this.ctx.storage.deleteAll();
    } else kv.put(RECORD, { ...rec, attempts });
    return { result: 'wrong', attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts), expiresAtMs: rec.expiresAtMs };
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
    this.ctx.storage.kv.delete(TICKET);
    await this.ctx.storage.deleteAll();
    return t.expiresAtMs > now && t.appId === appId ? t : null;
  }

  // ---- support links (admin/unlock, admin/unsuppress → the support pages' presses, D866) ----

  async putSupportLink(c: SupportLinkRecord): Promise<boolean> {
    const kv = this.ctx.storage.kv;
    if (kv.get(RECORD) !== undefined || kv.get(TICKET) !== undefined || kv.get(SUPPORT) !== undefined) return false;
    kv.put(SUPPORT, c);
    await this.ctx.storage.setAlarm(c.expiresAtMs + 1);
    return true;
  }

  /** The link's state now; an expired live record becomes its tombstone. */
  private support(now: number): { live: SupportLinkRecord } | { gone: 'used' | 'expired' } | null {
    const kv = this.ctx.storage.kv;
    const v = kv.get<SupportLinkRecord | SupportTombstone>(SUPPORT);
    if (!v) return null;
    if (!('emailEnc' in v)) return { gone: v.usedAtMs !== null ? 'used' : 'expired' };
    if (v.expiresAtMs <= now) {
      kv.put(SUPPORT, { action: v.action, expiresAtMs: v.expiresAtMs, usedAtMs: null } satisfies SupportTombstone);
      return { gone: 'expired' };
    }
    return { live: v };
  }

  /**
   * A press of the link's button (atomic): the live record, and whether this is its first press (recorded now). A
   * confirm (`once`) is used up by it: the record becomes its tombstone, so a second press finds `used`. An unlock is
   * used up by the start its grant lets through (the mailbox object knows), `markSupportUsed` then.
   */
  async pressSupportLink(once: boolean, now: number = Date.now()): Promise<SupportLinkState> {
    const s = this.support(now);
    if (!s) return { state: 'unknown' };
    if ('gone' in s) return { state: s.gone };
    const firstPress = s.live.pressedAtMs === null;
    const kv = this.ctx.storage.kv;
    if (once) kv.put(SUPPORT, { action: s.live.action, expiresAtMs: s.live.expiresAtMs, usedAtMs: now } satisfies SupportTombstone);
    else if (firstPress) kv.put(SUPPORT, { ...s.live, pressedAtMs: now });
    return { state: 'live', record: s.live, firstPress };
  }

  /** A confirm whose action then failed: the record is live again (its first press kept), so the user can retry. */
  restoreSupportLink(c: SupportLinkRecord): void {
    const v = this.ctx.storage.kv.get<SupportLinkRecord | SupportTombstone>(SUPPORT);
    if (v && !('emailEnc' in v) && v.usedAtMs !== null) this.ctx.storage.kv.put(SUPPORT, c);
  }

  /** The link was used (an unlock's grant was spent): only its tombstone stays. */
  markSupportUsed(now: number = Date.now()): void {
    const v = this.ctx.storage.kv.get<SupportLinkRecord | SupportTombstone>(SUPPORT);
    if (v) this.ctx.storage.kv.put(SUPPORT, { action: v.action, expiresAtMs: v.expiresAtMs, usedAtMs: 'emailEnc' in v ? now : v.usedAtMs } satisfies SupportTombstone);
  }

  /**
   * At expiry: a support link keeps only its tombstone, for LINK_TOMBSTONE_MS more (the page can still say "expired" or
   * "already used"); everything else, and a tombstone past that, is deleted.
   */
  override async alarm(): Promise<void> {
    const v = this.ctx.storage.kv.get<SupportLinkRecord | SupportTombstone>(SUPPORT);
    const until = v ? v.expiresAtMs + LINK_TOMBSTONE_MS : 0;
    if (v && Date.now() < until) {
      if ('emailEnc' in v) this.ctx.storage.kv.put(SUPPORT, { action: v.action, expiresAtMs: v.expiresAtMs, usedAtMs: null } satisfies SupportTombstone);
      await this.ctx.storage.setAlarm(until + 1);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
