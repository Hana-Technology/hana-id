// The outbox stub (spec "Playwright": `EMAIL_SENDER=outbox`, `local*` envs only, refused by gen and by the manifest
// elsewhere): messages go to a test-only Durable Object that a suite reads through the binding, never a public route.
// One object (`outbox`) per env; it keeps the last 200 messages.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import type { EmailSender, MailMessage, SendResult } from './sender.ts';

const MAX_MESSAGES = 200;

export class Outbox extends DurableObject<Env> {
  put(m: MailMessage & { atMs: number }): void {
    const kv = this.ctx.storage.kv;
    const seq = (kv.get<number>('seq') ?? 0) + 1;
    kv.put('seq', seq);
    kv.put(`m:${String(seq).padStart(12, '0')}`, m);
    if (seq > MAX_MESSAGES) kv.delete(`m:${String(seq - MAX_MESSAGES).padStart(12, '0')}`);
  }

  /** Every stored message, oldest first (tests only). */
  list(): (MailMessage & { atMs: number })[] {
    return [...this.ctx.storage.kv.list<MailMessage & { atMs: number }>({ prefix: 'm:' })].map(([, v]) => v);
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export class OutboxSender implements EmailSender {
  readonly name = 'outbox';

  constructor(
    private readonly ns: DurableObjectNamespace<Outbox> | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async send(m: MailMessage): Promise<SendResult> {
    if (!this.ns) return { ok: false, reason: 'misconfigured' };
    await this.ns.get(this.ns.idFromName('outbox')).put({ ...m, atMs: this.now() });
    return { ok: true };
  }
}
