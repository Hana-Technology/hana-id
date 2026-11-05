// Sending one notice to many people, and the per-run budget of outbound calls each cron run shares between its steps
// (D280, D380): every email is one message per recipient, every outbound call of a run takes one of its budget, a step
// stops before a unit of work (a notice, a digest, a scope, a statement) that doesn't fit what is left, and whatever is
// left waits for the next run.
//
// What an outbound call is (Cloudflare's docs, read 2026-11-04):
//   - https://developers.cloudflare.com/workers/platform/limits/#subrequests: "A subrequest is any request a Worker
//     makes using the Fetch API or to Cloudflare services like R2, KV, or D1"; the free plan allows 50 per invocation.
//     Here: every email (SendGrid), every NEAR RPC read and every rate fetch (CoinGecko). The crons touch no R2, KV or D1.
//   - https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits: "Each request to a
//     Worker via a Service binding counts toward your subrequest limit", and "A single request has a maximum of 32
//     Worker invocations, and each call to a Service binding counts towards this limit". Here: every AdminRpc call on
//     `API` and every StaffRpc call on `CONSOLE`, each one call of the budget and one of RPC_BUDGET (`metered` below).
//   - Hyperdrive: neither https://developers.cloudflare.com/hyperdrive/platform/limits/ nor the Workers limits page
//     names it as a subrequest. `pg` reaches it over one TCP socket per run (`connect()`, which the limits page counts
//     toward the six simultaneous open connections only), and the queries travel on that socket. Charged
//     conservatively: opening the run's connection takes one call; its queries take none.
import { b64url, fromB64url, sha256, utf8 } from '@hana-id/console-core';
import type { EmailSender } from './email/sender.ts';
import type { Rendered } from './email/render.ts';

/**
 * Outbound calls one cron run may make, every kind above counted. Below the Workers free plan's 50 subrequests per
 * invocation, with room for what the docs leave open (D380); a backlog drains over the next runs.
 */
export const RUN_BUDGET = 40;
/**
 * Service-binding calls one run may make, inside RUN_BUDGET: a request has at most 32 Worker invocations, the cron's
 * own among them, and a call past that throws.
 */
export const RPC_BUDGET = 30;

/** A metered call found the budget spent. Jobs check `fits` before each unit of work, so this is the backstop. */
export class OutOfBudget extends Error {
  constructor(what: string) {
    super(`out of budget: ${what}`);
    this.name = 'OutOfBudget';
  }
}

/**
 * One run's budget. Every outbound call takes one (`take`; a service-binding call through `metered` takes one of both
 * counts), recorded under the job running it (`as`), so a run's summary shows each job's share.
 */
export class Budget {
  private left: number;
  private rpcLeft: number;
  private job = 'run';
  /** Calls taken per job. */
  readonly used: Record<string, number> = {};

  constructor(left: number = RUN_BUDGET, rpc: number = Math.min(left, RPC_BUDGET)) {
    this.left = left;
    this.rpcLeft = rpc;
  }
  get remaining(): number {
    return this.left;
  }
  get rpcRemaining(): number {
    return this.rpcLeft;
  }
  /** Calls taken so far. */
  get spent(): number {
    return Object.values(this.used).reduce((a, b) => a + b, 0);
  }
  /** Whether `n` more calls fit, `rpc` of them service-binding calls. */
  fits(n: number, rpc = 0): boolean {
    return this.left >= n && this.rpcLeft >= rpc;
  }
  /** Takes `n` calls (fetches: emails, NEAR reads, rates; the run's connection) if that many are left. */
  take(n = 1): boolean {
    if (this.left < n) return false;
    this.left -= n;
    this.used[this.job] = (this.used[this.job] ?? 0) + n;
    return true;
  }
  /** Takes one service-binding call, if one is left of both counts. */
  takeRpc(): boolean {
    if (!this.fits(1, 1)) return false;
    this.rpcLeft--;
    return this.take(1);
  }
  /** Runs `fn` with the calls it takes counted under `job`. */
  async as<T>(job: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.job;
    this.job = job;
    try {
      return await fn();
    } finally {
      this.job = prev;
    }
  }
}

const meteredBy = new WeakMap<object, Budget>();

/**
 * A service binding (`API`, `CONSOLE`) whose every method call first takes one call of `budget` (`takeRpc`), and
 * throws OutOfBudget instead of calling when none is left. Every job meters the bindings it is given (`meteredEnv`),
 * so no RPC of a run goes uncounted; metering a binding already metered by the same budget returns it as it is, so a
 * call is never counted twice.
 */
export function metered<T extends object>(binding: T, budget: Budget): T {
  // An absent binding (a config without it) stays absent: its calls fail as they would unmetered.
  if (typeof binding !== 'object' || binding === null || meteredBy.get(binding) === budget) return binding;
  const proxy = new Proxy(binding, {
    // Every string property is a method on an RPC stub (a JS RPC property is callable whatever `typeof` says of it);
    // `then` stays as it is, so the binding is never taken for a promise.
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return (target as Record<string | symbol, unknown>)[prop];
      return (...args: unknown[]) => {
        // Rejected, not thrown: every RPC answers a promise, and a caller's `.catch` must see this as it sees a failure.
        if (!budget.takeRpc()) return Promise.reject(new OutOfBudget(prop));
        return (target as Record<string, (...a: unknown[]) => unknown>)[prop]!(...args);
      };
    },
  });
  meteredBy.set(proxy, budget);
  return proxy;
}

/** The env with both service bindings metered against `budget`. */
export function meteredEnv<E extends { API: object; CONSOLE: object }>(env: E, budget: Budget): E {
  return { ...env, API: metered(env.API, budget), CONSOLE: metered(env.CONSOLE, budget) };
}

/** Lowercased, trimmed, distinct, in order; empty strings dropped. */
export function recipients(...lists: (readonly string[] | string | undefined)[]): string[] {
  const out: string[] = [];
  for (const l of lists) for (const e of typeof l === 'string' ? [l] : (l ?? [])) {
    const v = e.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * One message's identity: sha256 of its purpose and recipient (no address kept in clear). SendGrid has no idempotency
 * key (D401), so this isolate remembers which of these it saw accepted, for `ACCEPTED_MEMO_MS` (the window Resend's
 * key had), and doesn't send them again: the retry of a notice that failed for one recipient goes to that recipient
 * only. The memo is per isolate and lost on eviction, so a repeat can still go out twice; it never holds back a
 * message that was not accepted.
 */
export async function messageKey(purpose: string, to: string): Promise<string> {
  return b64url(await sha256(utf8(`${purpose}\n${to}`)));
}

export const ACCEPTED_MEMO_MS = 24 * 60 * 60_000;
/** At most this many remembered messages; the oldest are forgotten first. */
export const ACCEPTED_MEMO_MAX = 5000;
const acceptedAt = new Map<string, number>();

function wasAccepted(key: string, now: number): boolean {
  const at = acceptedAt.get(key);
  if (at === undefined) return false;
  if (at <= now && now - at < ACCEPTED_MEMO_MS) return true;
  acceptedAt.delete(key);
  return false;
}

function rememberAccepted(key: string, now: number): void {
  acceptedAt.delete(key);
  acceptedAt.set(key, now);
  for (const oldest of acceptedAt.keys()) {
    if (acceptedAt.size <= ACCEPTED_MEMO_MAX) break;
    acceptedAt.delete(oldest);
  }
}

/** Test hook: forget every accepted message (as a fresh isolate would). */
export function forgetAccepted(): void {
  acceptedAt.clear();
}

export interface SendOutcome {
  /** Every recipient's message was accepted by the provider (in this call, or earlier in this isolate). */
  allAccepted: boolean;
  sent: number;
  failed: number;
  /** Recipients not sent to again: this isolate already saw this message accepted for them. */
  skipped: number;
  /** The budget ran out before every recipient was tried. */
  outOfBudget: boolean;
}

/**
 * Sends `message` to each of `to`, one message each. Every send is tried (a failure doesn't stop the others; the next
 * run retries, skipping the recipients this isolate saw accepted), unless the budget runs out first. The caller acks a
 * blocking notice only when `allAccepted`: a send counts only when the provider accepted it, so a lost answer leads to
 * a repeat at worst, never to a notice acked that nobody was sent. Accepted is not delivered: a blocking notice or an
 * alert bypasses the provider's suppression lists (`bypassesSuppressions`), so it isn't dropped after the 202.
 */
export async function sendToAll(sender: EmailSender, budget: Budget, to: readonly string[], message: Rendered, purpose: string, now: number = Date.now()): Promise<SendOutcome> {
  if (to.length === 0) return { allAccepted: false, sent: 0, failed: 0, skipped: 0, outOfBudget: false };
  if (!sender.configured) return { allAccepted: false, sent: 0, failed: to.length, skipped: 0, outOfBudget: false };
  const keyed = await Promise.all(to.map(async (addr) => ({ addr, key: await messageKey(purpose, addr) })));
  const pending = keyed.filter((k) => !wasAccepted(k.key, now));
  const skipped = keyed.length - pending.length;
  if (budget.remaining < pending.length) return { allAccepted: false, sent: 0, failed: 0, skipped, outOfBudget: true };
  const bypass = bypassesSuppressions(purpose);
  let sent = 0;
  let failed = 0;
  for (const { addr, key } of pending) {
    budget.take();
    const r = await sender.send({ to: addr, subject: message.subject, text: message.text, html: message.html, messageKey: key, bypassSuppressions: bypass });
    if (r.ok) {
      sent++;
      rememberAccepted(key, now);
    } else failed++;
  }
  return { allAccepted: failed === 0, sent, failed, skipped, outOfBudget: false };
}

/**
 * Which admin mail bypasses SendGrid's bounce, spam-report and unsubscribe lists (D401 as amended). SendGrid answers
 * 202 and then silently drops a message to a suppressed address, and `sendToAll` acks a blocking notice on that 202:
 * so every alert and every notice an action or a cursor waits on is sent whatever the lists say. Routine mail keeps
 * them: an invitation to an address a partner typed (the most likely to bounce or be reported, and nothing waits on
 * its delivery but the invitee), a statement's notice, and the org audit digest. Keyed by the purpose's kind (its text
 * before the first `:`, or `feed:<source>`); a kind in neither list bypasses (fail towards delivery), and a source
 * test holds every purpose in the code to one of the two.
 */
export const BYPASS_PURPOSES: ReadonlySet<string> = new Set([
  'change_pending',
  'invite_notice',
  'owner_grant',
  'watch_pending',
  'watch_changed',
  'feed:security_events',
  'feed:app_changes',
  'nonce_unexplained',
  'rejection_rate',
  'settlement_mismatch',
  'retention_failed',
  'retention_overdue',
  'retention_skipped',
  'directory_budget',
]);
export const ROUTINE_PURPOSES: ReadonlySet<string> = new Set(['invite_link', 'statement_issued', 'feed:audit_log']);

/** A purpose's kind: `feed:<source>` for the feed's digests, else the text before the first `:`. */
export const purposeKind = (purpose: string): string => {
  const [a, b] = purpose.split(':');
  return a === 'feed' && b ? `feed:${b}` : (a ?? '');
};
export const bypassesSuppressions = (purpose: string): boolean => !ROUTINE_PURPOSES.has(purposeKind(purpose));

/** A 32-byte key from a secret (standard base64 with padding, or b64url), or null when missing or malformed. */
export function linkKey(raw: string | undefined): Uint8Array | null {
  const v = raw?.trim() ?? '';
  try {
    if (/^[A-Za-z0-9+/]{43}=$/u.test(v)) {
      const bytes = Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
      return bytes.length === 32 ? bytes : null;
    }
    if (/^[A-Za-z0-9_-]{43}$/u.test(v)) {
      const bytes = fromB64url(v);
      return bytes.length === 32 ? bytes : null;
    }
  } catch {
    return null;
  }
  return null;
}
