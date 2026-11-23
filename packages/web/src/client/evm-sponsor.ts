// `hana.evm`, gas sponsorship for EVM actions (docs/decisions.md D838, D855; docs/integration.md "Gas sponsorship"): a batch of
// calls Journear's relayer sends for the user, the network fee paid by Journear. Not live: no deployed environment
// sponsors a chain yet.
//
// - sponsoredChains: the chains the vault said it sponsors (its `ready`, from SDK 0.5.0), [] otherwise.
// - sendSponsored({ chainId, calls }): Journear Passport's approval window (never automatic), then the vault sends the
//   batch itself and answers `{ transactionHash, status: 'executed' }` once the batch ran. The signatures never reach
//   this page. Call it synchronously in the click, as login(): the window opens in that click (D99).
// - sponsorship(chainId): `{ available, reason?, remainingToday? }` from GET {apiUrl}/v1/evm/sponsor/status, so a page
//   can say before the click whether the action is free today.
//
// A refusal is a HanaSponsorError: the vault's code (4001 the user rejected, 4100 refused, `busy`, `rate_limited`,
// `session_ended`, `api_unavailable`), the developer's `message`, `userMessage` (the plain sentence a page shows its
// users, from `code` and `data.reason`: user-messages.ts SPONSOR_REASONS), and `data` (EvmSponsorErrorData) with only
// fields of exact shapes (D788). Ordinary `eth_sendTransaction` is never sponsored:
// a page asks for a gas-free action by name (D838).
import { ErrorCode, type PortMethod, type PortParamsMap, type PortResultMap, isApiRequestId, isEvmAddress } from '@hana-id/core';
import { HanaError, RpcCode, asHanaError, markSponsored } from './errors.ts';
import { type SponsorReason, type SponsorshipReason } from './user-messages.ts';
import type { FetchLike } from './rpc.ts';

export interface EvmSponsorHost {
  /** The vault's EVM address while logged in, else null. */
  evmAddress(): string | null;
  /** The chains the vault reported in `sponsoredChains`, or [] (an older vault, a build without sponsorship). */
  sponsoredChains(): readonly number[];
  request<M extends PortMethod>(method: M, params?: PortParamsMap[M]): Promise<PortResultMap[M]>;
  /** The client's `ready` (it rejects as `hana.ready` does, after the client's own timeouts), for `sponsorship`. */
  ready?(): Promise<unknown>;
  /** The Journear API of this env (`apiUrl`), for `sponsorship`; null when the build doesn't know it. */
  apiUrl: string | null;
  publishableKey: string;
  fetch: FetchLike;
}

/** One call of a gas-free action: a contract and its calldata. `value` must be 0 (or left out). */
export interface SponsoredCall {
  to: string;
  data: string;
  value?: string | number | bigint;
}

export interface SendSponsoredParams {
  chainId: number;
  /** 1 to 8 calls, run in order, all or nothing. */
  calls: readonly SponsoredCall[];
}

export interface SendSponsoredResult {
  /** The relayer's transaction (lowercase `0x` hex): look it up on the chain's explorer. */
  transactionHash: `0x${string}`;
  status: 'executed';
}

export interface SponsorshipStatus {
  available: boolean;
  /** Why not, when `available` is false: `chain_not_enabled`, `app_not_sponsored`, `paused`, `budget_exhausted`, `not_available`. */
  reason?: SponsorshipReason;
  /** This app's own budget left today, in wei (decimal), when the API says. */
  remainingToday?: string;
}

/**
 * `data` of a HanaSponsorError. Every field is optional and copied only in its exact shape; anything else is left out.
 */
export interface EvmSponsorErrorData {
  /** The HTTP status of Journear's API answer, when the refusal came from it. */
  status?: number;
  /** Why (`delegated_elsewhere`, `sponsor_in_flight`, `reverted`, `budget_exhausted`, …), at most 64 characters. */
  reason?: SponsorReason;
  /** The API's request ID: quote it to Journear with the user's Support ID. */
  requestId?: string;
  /** Wait at least this long (seconds, 0 to 86,400) before asking again. */
  retryAfterS?: number;
  /** The transaction that was sent: a `timeout` may still run (look it up before asking again); a `reverted` ran and failed. */
  transactionHash?: `0x${string}`;
  /** The call (0-based) that failed, for a `simulation_reverted`. */
  callIndex?: number;
  /** The API's own word that asking again is worth it. */
  retryable?: true;
  /** The chain the request named, for a chain this build doesn't sponsor. */
  chainId?: number;
}

/** What `hana.evm.sendSponsored` and `sponsorship` reject with: a HanaError with typed `data`. Show `userMessage`. */
export class HanaSponsorError extends HanaError {
  declare readonly data?: EvmSponsorErrorData;

  constructor(code: ConstructorParameters<typeof HanaError>[0], message: string, data?: unknown) {
    super(code, message, data);
    markSponsored(this);
  }
}

/**
 * `data` of the `ProviderRpcError` that `hana.ethereum`'s `wallet_sendCalls` rejects with when the gas-free action
 * fails: the HanaSponsorError's own `data` for a numeric code (4001, 4100), or, for a string code (`busy`,
 * `rate_limited`, `session_ended`, `api_unavailable`), that code with the request ID and the `data` inside.
 */
export type EvmSponsorProviderErrorData = EvmSponsorErrorData | { code: string; requestId?: string; data?: EvmSponsorErrorData };

export const isHanaSponsorError = (e: unknown): e is HanaSponsorError => e instanceof HanaSponsorError;

/** The plain words for a chain the build doesn't sponsor (the vault says the same). */
export const NOT_OFFERED = 'Free network fees aren’t offered on this network.';

/** How long `sponsorship` waits for the API. */
export const SPONSORSHIP_TIMEOUT_MS = 15_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CODE_WORD = /^[a-z][a-z0-9_]{0,63}$/u;
const invalid = (message: string): HanaSponsorError => new HanaSponsorError(RpcCode.invalidParams, message);

/** Only the fields of EvmSponsorErrorData in their exact shapes. */
export function sponsorErrorData(v: unknown): EvmSponsorErrorData | undefined {
  if (!isObj(v)) return undefined;
  const out: EvmSponsorErrorData = {
    ...(Number.isSafeInteger(v.status) && (v.status as number) >= 100 && (v.status as number) <= 599 ? { status: v.status as number } : {}),
    ...(typeof v.reason === 'string' && CODE_WORD.test(v.reason) ? { reason: v.reason } : {}),
    ...(isApiRequestId(v.requestId) ? { requestId: v.requestId } : {}),
    ...(Number.isSafeInteger(v.retryAfterS) && (v.retryAfterS as number) >= 0 && (v.retryAfterS as number) <= 86_400 ? { retryAfterS: v.retryAfterS as number } : {}),
    ...(typeof v.transactionHash === 'string' && /^0x[0-9a-f]{64}$/u.test(v.transactionHash) ? { transactionHash: v.transactionHash as `0x${string}` } : {}),
    ...(Number.isSafeInteger(v.callIndex) && (v.callIndex as number) >= 0 && (v.callIndex as number) < 8 ? { callIndex: v.callIndex as number } : {}),
    ...(v.retryable === true ? { retryable: true as const } : {}),
    ...(Number.isSafeInteger(v.chainId) && (v.chainId as number) > 0 ? { chainId: v.chainId as number } : {}),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

const asSponsorError = (e: unknown): HanaSponsorError => {
  if (e instanceof HanaSponsorError) return e;
  const h = asHanaError(e);
  return new HanaSponsorError(h.code, h.message, sponsorErrorData(h.data));
};

const isZeroValue = (v: unknown): boolean =>
  v === undefined || v === 0 || v === 0n || (typeof v === 'string' && (/^0x0*$/iu.test(v) ? v.length > 2 : /^0+$/u.test(v)));

/**
 * The calls as the port takes them: fresh `{to, value: '0x0', data}` objects (never the caller's own, which could
 * change after the check or be shared). Throws HanaSponsorError -32602 for anything else.
 */
export function sponsoredCalls(calls: unknown): PortParamsMap['evm_sendSponsored']['calls'] {
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 8) throw invalid('calls must hold 1 to 8 calls');
  return calls.map((c: unknown, i) => {
    if (!isObj(c)) throw invalid(`calls[${i}] must be an object`);
    const { to, data, value } = c;
    if (typeof to !== 'string' || !isEvmAddress(to)) throw invalid(`calls[${i}].to must be an EVM address`);
    if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,8192}$/u.test(data)) throw invalid(`calls[${i}].data must be 0x hex of 4 to 8192 bytes (a function call)`);
    if (!isZeroValue(value)) throw invalid(`calls[${i}].value must be 0: Journear pays network fees only for calls that send no ETH`);
    for (const k of Object.keys(c)) if (k !== 'to' && k !== 'data' && k !== 'value') throw invalid(`calls[${i}] has an unknown field ${k.slice(0, 32)}`);
    return { to, value: '0x0' as const, data: data as `0x${string}` };
  });
}

export class HanaEvm {
  readonly #host: EvmSponsorHost;
  /** The host's `ready`, asked once: every `sponsorship()` before it shares the one wait. */
  #ready: Promise<unknown> | null = null;

  constructor(host: EvmSponsorHost) {
    this.#host = host;
  }

  /** The chains Journear Passport pays network fees on for this app's environment (empty when none, or before `ready`). */
  get sponsoredChains(): number[] {
    return [...this.#host.sponsoredChains()];
  }

  /**
   * Runs `calls` on `chainId` with Journear paying the network fee, after the user approves them in Journear
   * Passport's window. Resolves `{ transactionHash, status: 'executed' }` once the batch ran on the chain. Call it
   * synchronously in a click handler (the window opens in the click). Rejects with HanaSponsorError: 4001 when the user
   * rejects, 4100 when Journear refuses (`data.reason`), `busy` while another of the user's actions is still going
   * through, `rate_limited`, `session_ended` or `api_unavailable` (with `data.transactionHash` when a batch was sent).
   */
  sendSponsored(p: SendSponsoredParams): Promise<SendSponsoredResult> {
    try {
      if (!isObj(p)) throw invalid('sendSponsored takes { chainId, calls }');
      const { chainId, calls: raw } = p as unknown as Record<string, unknown>;
      if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw invalid('chainId must be a positive integer');
      const calls = sponsoredCalls(raw);
      if (this.#host.evmAddress() === null) throw new HanaSponsorError(ErrorCode.unauthorized, 'Not logged in to Journear Passport');
      if (!this.#host.sponsoredChains().includes(chainId)) throw new HanaSponsorError(ErrorCode.unauthorized, NOT_OFFERED, { reason: 'chain_not_sponsored', chainId });
      // Synchronously, before any await: the approval window opens in the caller's click.
      return this.#host.request('evm_sendSponsored', { chainId, calls }).then(
        (r) => ({ transactionHash: r.transactionHash.toLowerCase() as `0x${string}`, status: r.status }),
        (e: unknown) => {
          throw asSponsorError(e);
        },
      );
    } catch (e) {
      return Promise.reject(asSponsorError(e));
    }
  }

  /**
   * Whether Journear pays network fees for this app on `chainId` right now (GET /v1/evm/sponsor/status): `{ available,
   * reason?, remainingToday? }`. A chain the vault didn't report answers `{ available: false, reason:
   * 'chain_not_enabled' }` without a request. Called before `hana.ready`, it waits for it first (the vault reports its
   * chains there; bounded by the client's own ready timeouts). Rejects with HanaSponsorError (`api_unavailable`,
   * `rate_limited`, 4100, or `hana.ready`'s `vault_unavailable`).
   */
  async sponsorship(chainId: number): Promise<SponsorshipStatus> {
    if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw invalid('chainId must be a positive integer');
    if (this.#host.ready) {
      try {
        await (this.#ready ??= this.#host.ready());
      } catch (e) {
        throw asSponsorError(e);
      }
    }
    if (!this.#host.sponsoredChains().includes(chainId)) return { available: false, reason: 'chain_not_enabled' };
    const apiUrl = this.#host.apiUrl;
    if (!apiUrl) throw new HanaSponsorError('api_unavailable', 'This build of the Journear Passport SDK has no API URL for its environment');
    const ctl = new AbortController();
    const timer = globalThis.setTimeout(() => ctl.abort(), SPONSORSHIP_TIMEOUT_MS);
    let res: Response;
    let body: unknown = null;
    try {
      try {
        res = await this.#host.fetch(`${apiUrl}/v1/evm/sponsor/status?chainId=${chainId}`, {
          method: 'GET',
          headers: { 'x-hana-key': this.#host.publishableKey },
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: ctl.signal,
        });
      } catch {
        throw new HanaSponsorError('api_unavailable', 'Journear Passport could not be reached');
      }
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
    const b = isObj(body) ? body : {};
    if (!res.ok) {
      const data = sponsorErrorData({ status: res.status, reason: b.code, requestId: b.requestId, retryAfterS: retryAfter(res) });
      if (res.status === 429) throw new HanaSponsorError('rate_limited', 'Too many requests. Wait a moment and try again.', data);
      if (res.status >= 400 && res.status < 500) throw new HanaSponsorError(ErrorCode.unauthorized, 'Journear Passport refused the request', data);
      throw new HanaSponsorError('api_unavailable', 'Journear Passport could not answer right now', data);
    }
    if (typeof b.available !== 'boolean') throw new HanaSponsorError('api_unavailable', 'Journear Passport gave an answer the SDK can’t read');
    return {
      available: b.available,
      ...(typeof b.reason === 'string' && CODE_WORD.test(b.reason) ? { reason: b.reason } : !b.available ? { reason: 'not_available' } : {}),
      ...(typeof b.remainingToday === 'string' && /^(?:0|[1-9][0-9]{0,77})$/u.test(b.remainingToday) ? { remainingToday: b.remainingToday } : {}),
    };
  }
}

function retryAfter(res: Response): number | undefined {
  try {
    const h = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
    return h !== null && /^(?:0|[1-9][0-9]{0,4})$/u.test(h) ? Number(h) : undefined;
  } catch {
    return undefined;
  }
}
