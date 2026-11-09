// IssuerRpc (D434, readiness row 7.1d): the API's entrypoint for the email issuer Worker, bound only by it (`API`,
// apps/email-issuer/scripts/gen-wrangler.ts) and reachable through no route. It replaces the issuer's read-write
// `APP_DB` binding of this Worker's D1 (D251): the issuer now has no D1 binding but its own, so a compromised issuer
// can't write the API's tables, and can read only these three lookups' answers (console-core issuer-apps.ts), not the
// rest of the database (keys, origins, sessions, the wallet directory).
//
// Each method validates its input (strict console-core schemas: `bad_request`), runs one read (two before migration
// 0010) in issuer-apps.ts, and answers `{ok: true, …}` or `{ok: false, code}`; nothing it throws escapes (`internal`).
// It takes no clock from the caller: a key's rotation grace is judged on the API's own time. Only refusals and errors
// are logged (method and code; never the key, app or scope), so the issuer's every email request doesn't add a line
// here. No hot-DB budget: the issuer's own per-IP and per-app limits run before its lookups, as they did over APP_DB.
import { type IssuerAnswer, type IssuerApp, issuerAppByIdInput, issuerAppByKeyInput, issuerScopeInput } from '@hana-id/console-core';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../env.ts';
import { issuerAppById, issuerAppByKey, issuerScopeHasEmailApp } from '../issuer-apps.ts';
import { log } from '../log.ts';
import type { InputSchema } from './common.ts';

async function answer<I, T extends object>(method: string, schema: InputSchema<I>, raw: unknown, work: (input: I) => Promise<T>): Promise<IssuerAnswer<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    log({ event: 'rpc', method, outcome: 'rejected', code: 'bad_request' }, 'warn');
    return { ok: false, code: 'bad_request', error: 'Invalid input' };
  }
  try {
    return { ok: true, ...(await work(parsed.data)) };
  } catch {
    log({ event: 'rpc', method, outcome: 'error', code: 'internal' }, 'error');
    return { ok: false, code: 'internal' };
  }
}

export class IssuerRpc extends WorkerEntrypoint<Env> {
  /** The app behind a publishable key (null: unknown, revoked past its grace, or deleted). */
  appByKey(c: unknown): Promise<IssuerAnswer<{ app: IssuerApp | null }>> {
    return answer('issuer.appByKey', issuerAppByKeyInput, c, async ({ pk }) => ({ app: await issuerAppByKey(this.env.DB, pk, Date.now()) }));
  }

  /** An undeleted app by id (null otherwise). */
  appById(c: unknown): Promise<IssuerAnswer<{ app: IssuerApp | null }>> {
    return answer('issuer.appById', issuerAppByIdInput, c, async ({ appId }) => ({ app: await issuerAppById(this.env.DB, appId) }));
  }

  /** Whether the scope has an active, undeleted app with email on. */
  scopeHasEmailApp(c: unknown): Promise<IssuerAnswer<{ hasEmailApp: boolean }>> {
    return answer('issuer.scopeHasEmailApp', issuerScopeInput, c, async ({ scopeId }) => ({ hasEmailApp: await issuerScopeHasEmailApp(this.env.DB, scopeId) }));
  }
}
