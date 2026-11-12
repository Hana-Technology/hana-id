// "Copy diagnostics": a JSON bug report reviewers can paste. It is built field by field from values that are public by
// design (env, the app key's prefix, addresses, the Support ID, the failed requests' API request IDs, timings, status, the browser) and never from an object the SDK hands
// over, so nothing the page doesn't name can slip in. The page never holds keys, Google tokens or relay ids (the vault
// and the Hana windows do), but error messages are free text, so they are scrubbed of anything shaped like a secret
// and cut short.

import { isApiRequestId, isNearImplicitAccountId, isSupportId } from '@hana-id/core';

export interface LoginTiming {
  at: string;
  /** The button the user clicked (each names its method, so the popup shows no chooser). */
  method: 'google' | 'email';
  /** Click to addresses on this page. */
  totalMs: number;
  /** The vault's per-stage ms (pk_test_ apps), or null. */
  stages: Record<string, number> | null;
}

export interface ErrorRecord {
  at: string;
  action: string;
  code: string | number | null;
  reason: string | null;
  message: string;
  /** The Hana API request the error came from (`data.requestId`, D405), or null. */
  requestId: string | null;
}

export interface DiagnosticsInput {
  environment: string;
  publishableKey: string;
  pageOrigin: string;
  vaultOrigin: string;
  sdkVersion: string;
  evmChainId: number;
  status: string;
  persistence: string | null;
  warning: string | null;
  expiresAtMs: number | null;
  /** `near`: the implicit account id (public, 64 hex), when the vault has one. */
  addresses: { stellar: string; evm: string; near?: string | undefined } | null;
  /** The user's Support ID (`hana.supportId`, batch C15): the code Hana's staff look the user up by. Null without one. */
  supportId: string | null;
  /** createHana → ready, when the page loaded logged in (an unlock). */
  unlockMs: number | null;
  logins: readonly LoginTiming[];
  errors: readonly ErrorRecord[];
  userAgent: string;
}

/** At most this many of each list, the latest. */
export const MAX_ENTRIES = 20;
/** `requestIds`: the latest this many distinct API request IDs of the errors, newest last (D405). */
export const MAX_REQUEST_IDS = 5;
const MAX_MESSAGE = 200;

/** `pk_test_85gd…`: enough to tell apps apart. */
export const keyPrefix = (pk: string): string => (pk.length > 12 ? `${pk.slice(0, 12)}…` : pk);

/** An EVM address, or a Stellar account (G…) or contract (C…) address: public, and useful in a report. */
const PUBLIC_ADDRESS = /^(?:0x[0-9a-fA-F]{40}|[GC][A-Z2-7]{55})$/u;

const SCRUB: readonly [RegExp, string | ((m: string) => string)][] = [
  // Publishable keys: kept as their prefix.
  [/\bpk_(?:test|live)_[1-9A-HJ-NP-Za-km-z]+/gu, keyPrefix],
  // Anything else with a secret-key or token prefix.
  [/\b(?:sk|rk|whsec)_[A-Za-z0-9_]{8,}/gu, '[redacted]'],
  // JWTs (Google ID tokens): header.payload[.signature].
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/gu, '[redacted token]'],
  // Stellar secret seeds.
  [/\bS[A-Z2-7]{55}\b/gu, '[redacted]'],
  // Hex of 32 bytes or more (private keys, CKD outputs, signatures); 20-byte EVM addresses are shorter and stay.
  [/\b(?:0x)?[0-9a-fA-F]{64,}\b/gu, '[redacted hex]'],
  // Long base64 / base64url runs (relay ids are 43 characters, session keys, encrypted blobs), except public addresses.
  [/[A-Za-z0-9+/_-]{32,}={0,2}/gu, (m) => (PUBLIC_ADDRESS.test(m) ? m : '[redacted]')],
];

/** `text` with secret-shaped substrings replaced, cut to 200 characters. */
export function scrub(text: string): string {
  let out = text;
  for (const [re, by] of SCRUB) out = out.replace(re, by as (m: string) => string);
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

const requestIdOrNull = (v: unknown): string | null => (isApiRequestId(v) ? v : null);

/** The latest MAX_REQUEST_IDS distinct request IDs of `errors`, oldest first. */
function latestRequestIds(errors: readonly ErrorRecord[]): string[] {
  const out: string[] = [];
  for (let i = errors.length - 1; i >= 0 && out.length < MAX_REQUEST_IDS; i--) {
    const id = requestIdOrNull(errors[i]!.requestId);
    if (id !== null && !out.includes(id)) out.unshift(id);
  }
  return out;
}

const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);

function stages(s: Record<string, number> | null): Record<string, number> | null {
  if (!s) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(s)) {
    const n = finite(v);
    if (/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u.test(k) && n !== null) out[k] = n;
  }
  return out;
}

/** The report as a plain object (only the fields listed here, each re-typed). */
export function diagnostics(input: DiagnosticsInput, nowMs: number): Record<string, unknown> {
  return {
    v: 1,
    at: new Date(nowMs).toISOString(),
    environment: input.environment,
    appKey: keyPrefix(input.publishableKey),
    pageOrigin: input.pageOrigin,
    vaultOrigin: input.vaultOrigin,
    sdkVersion: input.sdkVersion,
    evmChainId: input.evmChainId,
    status: input.status,
    persistence: input.persistence,
    warning: input.warning,
    sessionExpiresAt: input.expiresAtMs === null ? null : new Date(input.expiresAtMs).toISOString(),
    addresses: input.addresses
      ? { stellar: input.addresses.stellar, evm: input.addresses.evm, ...(isNearImplicitAccountId(input.addresses.near) ? { near: input.addresses.near } : {}) }
      : null,
    // Only a well-formed `HANA-XXXX-XXXX`: anything else is left out of the report.
    supportId: isSupportId(input.supportId) ? input.supportId : null,
    // What Hana's staff look a failed request up by, with the Support ID (the errors below carry theirs too).
    requestIds: latestRequestIds(input.errors),
    unlockMs: finite(input.unlockMs),
    logins: input.logins.slice(-MAX_ENTRIES).map((l) => ({ at: l.at, method: l.method === 'email' ? 'email' : 'google', totalMs: finite(l.totalMs), stages: stages(l.stages) })),
    errors: input.errors.slice(-MAX_ENTRIES).map((e) => ({
      at: e.at,
      action: e.action,
      code: e.code,
      reason: e.reason,
      message: scrub(e.message),
      requestId: requestIdOrNull(e.requestId),
    })),
    userAgent: scrub(input.userAgent),
  };
}

export const diagnosticsJson = (input: DiagnosticsInput, nowMs: number): string => JSON.stringify(diagnostics(input, nowMs), null, 2);
