// Usage capture (docs/batch-c-spec.md "Usage capture and reporting"): one UsageEvent v1 for every request that passed
// the gate of /v1/login, /v1/sessions, /v1/derive, /v1/sessions/revoke and /v1/vault/unlock, and for /v1/owner-actions
// after the owner check. A handler opens a draft once its gate passed (`beginUsage`), the relay fills in what it sent
// (`noteRelay`), and the response (`handlers.ts` `done`) closes it (`finishUsage`): the event goes to the ledger after
// the response (`waitUntil`, usage/record.ts) and never decides or delays the answer. Gate rejections and GET /v1/app
// are logged only.
//
// Never in an event: a sub, JWT, email, IP, session key or share id. The derivation path a request already holds is
// kept in memory only, for the uid (a keyed pseudonym, D96), computed after the response.
import type { UsageEventV1 } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import type { RelayResult } from '../relayer-key.ts';
import { recordUsage } from './record.ts';

export type UsageEndpoint = UsageEventV1['endpoint'];

/** The ledger's endpoint name of each API path that is captured. */
export const USAGE_ENDPOINT: Readonly<Record<string, UsageEndpoint>> = {
  '/v1/login': 'login',
  '/v1/sessions': 'session',
  '/v1/derive': 'derive',
  '/v1/sessions/revoke': 'revoke',
  '/v1/vault/unlock': 'unlock',
  '/v1/owner-actions': 'owner_action',
};

/** What a relay sent, as the ledger records it. */
export interface RelayFacts {
  relayed: boolean;
  near_tx?: string;
  relayer_pk?: string;
  relayer_nonce?: string;
  relay_gas_burnt?: string;
  relay_tokens_burnt_yocto?: string;
}

/** An open event: everything but the outcome, filled while the request runs. */
export interface UsageDraft {
  endpoint: UsageEndpoint;
  /** Request start (unix ms). */
  atMs: number;
  /** The gate row's org; for an owner action, resolved from the scope after the response (record.ts). */
  orgId: string | null;
  /** null only for owner actions. */
  appId: string | null;
  scopeId: string;
  /** The request's derivation path `scope#provider#sub#key_index`, in memory only: the uid's input, never sent. */
  path?: string;
  relay?: RelayFacts;
  exec?: ExecutionContext;
}

/** What a request context needs for capture (handlers.ts Ctx has these). */
export interface UsageCtx {
  env: Env;
  requestId: string;
  endpoint: string;
  started: number;
  usage?: UsageDraft;
}

/**
 * Relay results whose transaction can have executed (gas may be burnt), besides `ok`: a contract rejection, and a
 * timeout or RPC error after the broadcast. Never `relayer_busy` (an invalid nonce, or dropped twice: it can never
 * execute) nor `near_rejected` (a definite validation refusal), and nothing that never reached NEAR.
 */
const RELAYED_FAILURES: ReadonlySet<string> = new Set(['contract_rejected', 'timeout', 'near_error']);

/** `relayed` for a relay result (docs/batch-c-spec.md "Gas": the relay code → relayed table). */
export function wasRelayed(result: RelayResult): boolean {
  if (result.ok) return true;
  return result.nearTx !== undefined && RELAYED_FAILURES.has(result.code);
}

const I64_MAX = (1n << 63n) - 1n;
const YOCTO_MAX = 10n ** 39n - 1n;
/** A decimal string within 0..max (the event's bounds for its gas fields). */
const withinBounds = (v: string, max: bigint): boolean => /^(0|[1-9]\d{0,38})$/u.test(v) && BigInt(v) <= max;

/**
 * The ledger's view of a relay result: whether it was relayed, the transaction, its key and nonce, its gas. The
 * provisional gas pair is left out when either figure is past the event's bounds (gas ≤ 2^63 − 1, tokens < 10^39; a
 * sum of u64 receipts can pass the first), so the rest of the event is still recorded: settlement reads the billed
 * figure from chain anyway.
 */
export function relayFacts(result: RelayResult): RelayFacts {
  const facts: RelayFacts = { relayed: wasRelayed(result) };
  if (result.nearTx !== undefined) facts.near_tx = result.nearTx;
  if (result.relayerPk !== undefined) facts.relayer_pk = result.relayerPk;
  if (result.relayerNonce !== undefined) facts.relayer_nonce = result.relayerNonce;
  const gas = result.relayGasBurnt;
  const tokens = result.relayTokensBurnt;
  if (gas !== undefined && tokens !== undefined && withinBounds(gas, I64_MAX) && withinBounds(tokens, YOCTO_MAX)) {
    facts.relay_gas_burnt = gas;
    facts.relay_tokens_burnt_yocto = tokens;
  }
  return facts;
}

/** Opens the request's event once its gate (or, for owner actions, the owner check) passed. */
export function beginUsage(ctx: UsageCtx, d: { orgId: string | null; appId: string | null; scopeId: string; exec?: ExecutionContext }): void {
  const endpoint = USAGE_ENDPOINT[ctx.endpoint];
  if (!endpoint) return;
  ctx.usage = { endpoint, atMs: ctx.started, orgId: d.orgId, appId: d.appId, scopeId: d.scopeId, exec: d.exec };
}

/** Records the request's derivation path for the uid (only ok login, session and derive events carry one). */
export function notePath(ctx: UsageCtx, path: string): void {
  if (ctx.usage) ctx.usage.path = path;
}

/** Records what the relay sent. */
export function noteRelay(ctx: UsageCtx, result: RelayResult): void {
  if (ctx.usage) ctx.usage.relay = relayFacts(result);
}

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * The event for a response, from the draft: `ok` below 400, `error` from 500, else `rejected`; the response's code for
 * anything but ok. Pure: the uid and an owner action's org are added after the response (record.ts).
 */
export function eventFor(requestId: string, d: UsageDraft, status: number, code: unknown, now: number): Omit<UsageEventV1, 'org_id'> & { org_id: string | null } {
  const outcome = status < 400 ? 'ok' : status >= 500 ? 'error' : 'rejected';
  return {
    v: 1,
    request_id: requestId,
    at_ms: d.atMs,
    org_id: d.orgId,
    app_id: d.appId,
    scope_id: d.scopeId,
    endpoint: d.endpoint,
    outcome,
    code: outcome === 'ok' ? null : typeof code === 'string' && CODE_RE.test(code) ? code : 'internal',
    status,
    latency_ms: Math.max(0, now - d.atMs),
    ...(d.relay ?? { relayed: false }),
  };
}

/**
 * Closes the request's event with its response and hands it to the ledger writer after the response (`waitUntil`
 * when the runtime gives an execution context; otherwise it runs unawaited). Once per request: a second call is a
 * no-op. Never throws and never waits.
 */
export function finishUsage(ctx: UsageCtx, status: number, code: unknown): void {
  const d = ctx.usage;
  if (!d) return;
  ctx.usage = undefined;
  // Without the binding nothing is built or sent (capture off: logins as before).
  if (!ctx.env.USAGE_DB) return;
  const pending = recordUsage(ctx.env, eventFor(ctx.requestId, d, status, code, Date.now()), { path: d.path, logEndpoint: ctx.endpoint });
  if (d.exec) d.exec.waitUntil(pending);
}

/**
 * For a handler that threw after its gate: the router answers 500 `internal`, which the event records (a relayed
 * transaction is never left out of the ledger by an exception after it).
 */
export function finishUsageOnThrow(ctx: UsageCtx): void {
  finishUsage(ctx, 500, 'internal');
}
