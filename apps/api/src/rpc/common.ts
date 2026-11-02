// What every RPC method does around its work (docs/batch-c-spec.md "RPC interfaces"): validate the input with its
// console-core zod schema (`bad_request`), check the actor's kind for the entrypoint, admit a ConsoleRpc call (the
// per-org and global budget, the breaker, or for an emailed-link cancel its own per-IP and global limits) and hold it
// to its two reads and one batch, then answer `{ok: true, …}` or `{ok: false, code, error?}`. Nothing an RPC throws
// escapes: an unexpected error is logged (method, request id, org and actor kind only) and is `internal`.
import { type Actor, LEGACY_ORG_ID, type RpcCode, type RpcFail } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { RpcRefusal, type Writer } from '../changes/cas.ts';
import { CONSOLE_DB_LIMITS, HotDb } from '../changes/db.ts';
import { admitLinkCall, admitMemberCall, settleMemberCall } from '../changes/guard.ts';

export type Answer<T extends object> = ({ ok: true } & T) | RpcFail;

export interface CallSetup {
  /** The actor kinds this method accepts. */
  actors: readonly Actor['kind'][];
  /** ConsoleRpc only: the call's cost in hot-DB statements (its ceiling), charged before it runs. */
  cost?: number;
  /** ConsoleRpc only: a kill switch, which may spend the budget's reserves. */
  killSwitch?: boolean;
  /** ConsoleRpc only: a destructive call, counted by the breaker for this org (refunded when it changed nothing). */
  breaker?: boolean;
  /** ConsoleRpc.cancelChangeByLink: the link limits (per IP, then global) instead of the members' budget. */
  link?: boolean;
}

export interface Call<I> {
  input: I;
  db: HotDb;
  w: Writer;
}

/** A console-core input schema (zod), seen only through `safeParse`, so the API needs no zod import of its own. */
export interface InputSchema<I> {
  safeParse(v: unknown): { success: true; data: I } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

/** Outcomes after which a call is settled (breaker slot and reserve tokens back): it found nothing it could destroy. */
const REFUNDED: ReadonlySet<RpcCode> = new Set(['not_found', 'conflict', 'version_conflict', 'already_applied', 'bad_request']);

export async function runRpc<I extends { actor: Actor; requestId: string; clientIp: string }, T extends object>(
  env: Env,
  method: string,
  schema: InputSchema<I>,
  raw: unknown,
  setup: CallSetup,
  work: (c: Call<I>) => Promise<T>,
): Promise<Answer<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: 'bad_request', error: issue ? `${issue.path.join('.') || 'input'}: ${issue.message}`.slice(0, 500) : 'Invalid input' };
  }
  const input = parsed.data;
  const orgId = (input as { orgId?: string }).orgId;
  const fields = { method, requestId: input.requestId, actorKind: input.actor.kind, ...(orgId ? { orgId } : {}) };
  if (!setup.actors.includes(input.actor.kind)) return { ok: false, code: 'forbidden', error: `This method doesn't take a ${input.actor.kind} actor` };
  const consoleCall = setup.cost !== undefined;
  // The console never acts for the legacy org: its scopes belong to no partner until Hana assigns them.
  if (consoleCall && orgId === LEGACY_ORG_ID) return { ok: false, code: 'forbidden', error: `The console can't act for ${LEGACY_ORG_ID}` };
  const now = Date.now();
  const w: Writer = { actor: input.actor, requestId: input.requestId, now };
  let breakerTaken = false;
  let reserveUsed = 0;
  let code: RpcCode | null = null;
  try {
    if (setup.link) await admitLinkCall(env, input.clientIp, now);
    else if (consoleCall) {
      ({ reserveUsed } = await admitMemberCall(env, { org: orgId!, cost: setup.cost!, ...(setup.killSwitch ? { killSwitch: true } : {}), ...(setup.breaker ? { breaker: true } : {}) }, now));
      breakerTaken = !!setup.breaker;
    }
    const db = new HotDb(env.DB, consoleCall ? CONSOLE_DB_LIMITS : undefined);
    const result = await work({ input, db, w });
    log({ event: 'rpc', ...fields, outcome: 'ok' });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof RpcRefusal) {
      code = err.code;
      log({ event: 'rpc', ...fields, outcome: 'rejected', code: err.code });
      return { ok: false, code: err.code, error: err.message.slice(0, 500) };
    }
    code = 'internal';
    log({ event: 'rpc', ...fields, outcome: 'error', code: 'internal' }, 'error');
    return { ok: false, code: 'internal' };
  } finally {
    const changedNothing = (code === null && !w.wrote) || (code !== null && REFUNDED.has(code));
    if (changedNothing && (breakerTaken || reserveUsed > 0)) await settleMemberCall(env, { org: orgId!, at: now, breaker: breakerTaken, reserveUsed });
  }
}
