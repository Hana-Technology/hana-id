// What every RPC method does around its work (docs/batch-c-spec.md "RPC interfaces"): validate the input with its
// console-core zod schema (`bad_request`), check the actor's kind for the entrypoint, admit a ConsoleRpc call (breaker
// and hot-DB budget) and hold it to its two reads and one batch, then answer `{ok: true, …}` or `{ok: false, code,
// error?}`. Nothing an RPC throws escapes: an unexpected error is logged (method and request id only) and is
// `internal`.
import type { Actor, RpcFail } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { RpcRefusal, type Writer } from '../changes/cas.ts';
import { CONSOLE_LIMITS, HotDb } from '../changes/db.ts';
import { admitConsoleCall } from '../changes/guard.ts';

export type Answer<T extends object> = ({ ok: true } & T) | RpcFail;

export interface CallSetup {
  /** The actor kinds this method accepts. */
  actors: readonly Actor['kind'][];
  /** ConsoleRpc only: the call's cost in hot-DB statements (its ceiling), charged to the budget before it runs. */
  cost?: number;
  /** ConsoleRpc only: a destructive call, counted by the breaker for this org. */
  breaker?: boolean;
}

export interface Call<I> {
  input: I;
  db: HotDb;
  w: Writer;
}

/** Test hook: every HotDb an RPC call creates (to count its statements, or to inject a fault). */
export const rpcHooks: { onDb?: (db: HotDb, method: string) => void } = {};

/** A console-core input schema (zod), seen only through `safeParse`, so the API needs no zod import of its own. */
export interface InputSchema<I> {
  safeParse(v: unknown): { success: true; data: I } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

export async function runRpc<I extends { actor: Actor; requestId: string }, T extends object>(
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
  if (!setup.actors.includes(input.actor.kind)) return { ok: false, code: 'forbidden', error: `This method doesn't take a ${input.actor.kind} actor` };
  const now = Date.now();
  try {
    const consoleCall = setup.cost !== undefined;
    if (consoleCall) await admitConsoleCall(env, setup.cost!, setup.breaker ? orgId : undefined, now);
    const db = new HotDb(env.DB, consoleCall ? CONSOLE_LIMITS : undefined);
    rpcHooks.onDb?.(db, method);
    const result = await work({ input, db, w: { actor: input.actor, requestId: input.requestId, now } });
    log({ event: 'rpc', method, requestId: input.requestId, outcome: 'ok' });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof RpcRefusal) {
      log({ event: 'rpc', method, requestId: input.requestId, outcome: 'rejected', code: err.code });
      return { ok: false, code: err.code, error: err.message.slice(0, 500) };
    }
    log({ event: 'rpc', method, requestId: input.requestId, outcome: 'error', code: 'internal' }, 'error');
    return { ok: false, code: 'internal' };
  }
}
