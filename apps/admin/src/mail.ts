// Sending one notice to many people, and the per-run budget of outbound calls the 5-minute cron shares between its
// steps (D280): every email is one message per recipient, the run stops sending when the budget is spent, and whatever
// is left waits for the next run.
import { b64url, fromB64url, sha256, utf8 } from '@hana-id/console-core';
import type { EmailSender } from './email/sender.ts';
import type { Rendered } from './email/render.ts';

/**
 * Outbound calls (emails and NEAR views) one cron run may make. Below the Workers free plan's 50 subrequests per
 * invocation, with room for the RPC calls between them; a backlog drains over the next runs.
 */
export const RUN_BUDGET = 40;

export class Budget {
  constructor(private left: number = RUN_BUDGET) {}
  get remaining(): number {
    return this.left;
  }
  /** Takes `n` calls if that many are left. */
  take(n = 1): boolean {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }
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

/** The provider's idempotency key for one message: sha256 of its purpose and recipient (no address in the header). */
export async function idempotencyKey(purpose: string, to: string): Promise<string> {
  return b64url(await sha256(utf8(`${purpose}\n${to}`)));
}

export interface SendOutcome {
  /** Every recipient's send was accepted by the provider. */
  allAccepted: boolean;
  sent: number;
  failed: number;
  /** The budget ran out before every recipient was tried. */
  outOfBudget: boolean;
}

/**
 * Sends `message` to each of `to`, one message each. Every send is tried (a failure doesn't stop the others: the
 * provider's idempotency key makes the next run's repeat of an accepted one a no-op), unless the budget runs out first.
 * The caller acks a blocking notice only when `allAccepted`.
 */
export async function sendToAll(sender: EmailSender, budget: Budget, to: readonly string[], message: Rendered, purpose: string): Promise<SendOutcome> {
  if (to.length === 0) return { allAccepted: false, sent: 0, failed: 0, outOfBudget: false };
  if (!sender.configured) return { allAccepted: false, sent: 0, failed: to.length, outOfBudget: false };
  if (budget.remaining < to.length) return { allAccepted: false, sent: 0, failed: 0, outOfBudget: true };
  let sent = 0;
  let failed = 0;
  for (const addr of to) {
    budget.take();
    const r = await sender.send({ to: addr, subject: message.subject, text: message.text, html: message.html, idempotencyKey: await idempotencyKey(purpose, addr) });
    if (r.ok) sent++;
    else failed++;
  }
  return { allAccepted: failed === 0, sent, failed, outOfBudget: false };
}

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
