// Errors the partner client raises (docs/batch-b-spec.md "Envelope" error table, "EIP-1193", "Stellar Wallets Kit
// module"). The vault's replies carry a numeric (EIP-1193 style) or string code; `hana.*` methods reject with a
// HanaError holding that code as is. The EIP-1193 provider must reject with numeric codes only, so string codes are
// mapped there (toProviderRpcError), and the SWK module maps to SWK's `{code, message, ext}` shape (toSwkError).
import { ErrorCode, type HanaErrorCode, type ProtocolError } from '@hana-id/core';

/** JSON-RPC codes the client itself uses (EIP-1474): bad arguments, an internal fault, a rate limit. */
export const RpcCode = {
  invalidParams: -32602,
  internal: -32603,
  limitExceeded: -32005,
} as const;

export type ClientErrorCode = HanaErrorCode | (typeof RpcCode)[keyof typeof RpcCode];

/** What `hana.*` methods reject with. `code` is the vault's code, or one of RpcCode for a client-side check. */
export class HanaError extends Error {
  override readonly name = 'HanaError';
  readonly code: ClientErrorCode;
  readonly data?: unknown;

  constructor(code: ClientErrorCode, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  static from(e: ProtocolError): HanaError {
    return new HanaError(e.code, e.message, e.data);
  }
}

/** Default messages for the codes the client raises itself. */
const MESSAGES: Partial<Record<ClientErrorCode, string>> = {
  [ErrorCode.disconnected]: 'The Hana vault is disconnected',
  [ErrorCode.chainNotConfigured]: 'This EVM chain is not configured',
  [ErrorCode.unsupportedMethod]: 'Unsupported method',
  [ErrorCode.unauthorized]: 'Not logged in to Hana ID',
  vault_unavailable: "The Hana vault didn't load (check the page's CSP frame-src and the network)",
  popup_blocked: 'The browser blocked the Hana sign-in window',
  coop_blocks_popup: "The Hana sign-in window closed before it connected (the page's Cross-Origin-Opener-Policy may be same-origin)",
  login_timeout: "The Hana sign-in window didn't connect in time",
  login_cancelled: 'The sign-in was cancelled',
};

export const hanaError = (code: ClientErrorCode, message?: string, data?: unknown): HanaError =>
  new HanaError(code, message ?? MESSAGES[code] ?? String(code), data);

/** Any thrown value as a HanaError (a non-HanaError becomes an internal error; its message is kept, nothing else). */
export function asHanaError(e: unknown): HanaError {
  if (e instanceof HanaError) return e;
  return new HanaError(RpcCode.internal, e instanceof Error ? e.message : 'Internal error');
}

// ---- EIP-1193 ----

/** EIP-1193 `ProviderRpcError`: always a numeric code. */
export class ProviderRpcError extends Error {
  override readonly name = 'ProviderRpcError';
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * The numeric code an EIP-1193 caller sees for a Hana string code. A sign-in that didn't complete (cancelled, timed
 * out, blocked, closed) is 4001, which wagmi, viem and ethers treat as "user rejected"; a dead vault is 4900; a rate
 * limit is -32005; anything else is -32603. The Hana code is kept in `data.code`.
 */
const STRING_TO_NUMERIC: Partial<Record<string, number>> = {
  login_cancelled: ErrorCode.userRejected,
  login_timeout: ErrorCode.userRejected,
  popup_blocked: ErrorCode.userRejected,
  coop_blocks_popup: ErrorCode.userRejected,
  vault_unavailable: ErrorCode.disconnected,
  rate_limited: RpcCode.limitExceeded,
};

export function toProviderRpcError(e: unknown): ProviderRpcError {
  if (e instanceof ProviderRpcError) return e;
  const h = asHanaError(e);
  if (typeof h.code === 'number') return new ProviderRpcError(h.code, h.message, h.data);
  const data = h.data === undefined ? { code: h.code } : { code: h.code, data: h.data };
  return new ProviderRpcError(STRING_TO_NUMERIC[h.code] ?? RpcCode.internal, h.message, data);
}

// ---- Stellar Wallets Kit ----

/** SWK's error shape (`{code, message, ext?}`): a number code, with the Hana string code in `ext`. 4001 is a rejection. */
export interface SwkError {
  code: number;
  message: string;
  ext?: string[];
}

export function toSwkError(e: unknown): SwkError {
  const p = toProviderRpcError(e);
  const hanaCode = (p.data as { code?: unknown } | undefined)?.code;
  return typeof hanaCode === 'string' ? { code: p.code, message: p.message, ext: [hanaCode] } : { code: p.code, message: p.message };
}
