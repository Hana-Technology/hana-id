// One collector per stamp, over one NEAR session (D800): how each stamp's transaction is built, approved and sent.
// The flow is the hosted demo's guestbook write (apps/demo/src/near-card.ts, D750, D751, D788), with `collect` in
// place of `add_message`:
//
// - arrival, sponsored, postcard, layover: `hana.near.activate()` for a new account (once per account and page
//   session, retried while the API answers `near_account_unrecorded`), a NEP-366 delegate action calling
//   `collect({ stamp, note? })`, `hana.near.signDelegateAction`, `hana.near.relay` (Journear's relayer pays the gas);
// - signature: `hana.near.signMessage` first (NEP-413, the message and recipient the contract rebuilds), then the
//   same relayed `collect` with the proof: two approvals, the second in the same Journear window;
// - own_fare: `hana.near.signTransaction` of an ordinary `collect` transaction, sent with the RPC's `send_tx`: the
//   user's own testnet NEAR pays the fee.
//
// The popup rule (docs/integration.md section 8, D751): the click must reach the first signing call before any await.
// Everything a request needs from NEAR (the account's existence, the key's nonce, the latest final block, the balance)
// is read before the click, in the background (`prepare`); a click with a fresh read signs synchronously. Without one,
// it calls `hana.prepareApproval()` first (the window opens in the click), then reads, then signs into that window.
// `signature` needs no read before its first approval, so it always opens the window itself.
import type { ApprovalTicket, HanaClient, NearActivateResult } from '@hana-id/web';
import { base64Encode } from '@hana-id/core';
import { type AccessKeyState, NearRpc, delegateNonce, transactionNonce } from '../../demo/src/near.ts';
import type { StampsConfig } from './config.ts';
import { errorInfo, pageError, relayTransaction } from './messages.ts';
import { type CollectArgs, OWN_FARE_MIN_YOCTO, type StampId, checkNote, collectArgs, collectDelegate, collectTransaction, contractErrorCode, isImplicitAccount, signatureMessage } from './stamps.ts';

/** The part of the partner client the collectors use. */
export type CollectorClient = Pick<HanaClient, 'near' | 'prepareApproval'>;

/** How old a read of the key and block may be for a click to sign at once (the demo's). */
export const PREP_MAX_AGE_MS = 60_000;
/** How long activate and relay are retried while the account isn't in Journear's wallet directory yet. */
export const UNRECORDED_WAIT_MS = 20_000;
const UNRECORDED_REASON = 'near_account_unrecorded';
/** Refusals that mean the last read of the key or the height is behind (the vault's and the relayer's). */
const STALE_READ_REASONS: ReadonlySet<string> = new Set(['near_delegate_nonce_used', 'near_delegate_nonce_stale', 'near_delegate_nonce_too_large', 'near_delegate_expiry', 'delegate_nonce_used', 'delegate_nonce_too_large', 'delegate_expired', 'block_height_too_far']);
const BUSY_RETRIES = 2;
const ACTIVATION_TRIES = 10;
/** At most one background preparation start per this long (focus and pointer moves come in bursts). */
export const BACKGROUND_GAP_MS = 5_000;

/** What the UI shows while a stamp is being collected. */
export const STAGES = {
  reading: 'Reading your NEAR account on testnet…',
  activating: 'Preparing your NEAR account…',
  signMessage: 'Approve the signature in the Journear Passport window…',
  approving: 'Waiting for your approval in the Journear Passport window…',
  relaying: 'Sending it through Journear’s relayer, which pays the fee…',
  retrying: 'That request’s number was already used. Approve a fresh one in the Journear Passport window…',
  sending: 'Sending your transaction to NEAR testnet (your NEAR pays the fee)…',
} as const;

/** What the collectors read from NEAR for one account. */
export interface Prep {
  accountId: string;
  /** null: the account (or its key) isn't on testnet yet. */
  key: AccessKeyState | null;
  height: bigint;
  hash: string;
  /** yoctoNEAR. */
  balance: bigint;
  at: number;
}

export interface CollectRequest {
  accountId: string;
  stamp: StampId;
  /** The postcard's note (raw: checked here as the contract checks it). */
  note?: string;
}

/**
 * A collect that ran: `done` (the transaction executed; `created` when this page's activation created the account for
 * it), or `sent` (D788: it went out but NEAR hasn't confirmed it yet, so it may still land).
 */
export type CollectOutcome = { status: 'done'; txHash: string; created: boolean; note?: string } | { status: 'sent'; txHash: string };

export interface CollectorDeps {
  config: StampsConfig;
  client: CollectorClient;
  rpc: NearRpc;
  /** Wall-clock ms. */
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  random: (n: number) => Uint8Array;
}

export interface Collector {
  /** The latest read for `accountId` (whatever its age), or null. */
  latest(accountId: string): Prep | null;
  /** Reads the account's key, the latest block and the balance (one read at a time). */
  refresh(accountId: string): Promise<Prep>;
  /** Background preparation (interest): reads, and with `activate` creates a new account. Failures wait for the click. */
  prepare(accountId: string, activate: boolean): void;
  /** Collects a stamp. Synchronous up to the first signing call or `prepareApproval` (call it from the click). */
  collect(req: CollectRequest, stage: (text: string) => void): Promise<CollectOutcome>;
  /** Forgets everything (sign-out). */
  reset(): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function newRpc(config: StampsConfig, fetchFn: (url: string, init: RequestInit) => Promise<Response>): NearRpc {
  return new NearRpc([config.near.rpcUrl, ...(config.near.rpcFallbackUrl ? [config.near.rpcFallbackUrl] : [])], fetchFn);
}

/**
 * Sends a signed own-fare transaction (`send_tx`, executed optimistically) and reads its outcome: the contract's
 * panic as `stamps_contract_refused` (the ERR_* code only), NEAR's balance refusal as `near_not_enough_balance`, any
 * other refusal as `near_send_failed`. An RPC that gave no answer leaves the transaction possibly sent: `sent`.
 */
export async function sendOwnFare(rpc: NearRpc, signedTxBase64: string): Promise<'done' | 'sent'> {
  let body: Record<string, unknown>;
  try {
    body = await rpc.call('send_tx', { signed_tx_base64: signedTxBase64, wait_until: 'EXECUTED_OPTIMISTIC' }, (b) => isObj(b.result) || isObj(b.error));
  } catch (e) {
    if (errorInfo(e).code === 'near_page_rpc_failed') return 'sent';
    throw e;
  }
  if (isObj(body.error)) {
    const text = JSON.stringify(body.error).slice(0, 4000);
    if (/TIMEOUT_ERROR|timeout/u.test(text)) return 'sent';
    if (/NotEnoughBalance|LackBalanceForState|NotEnoughAllowance/u.test(text)) throw pageError('near_not_enough_balance', 'Not enough NEAR for the fee');
    throw pageError('near_send_failed', 'NEAR testnet refused the transaction');
  }
  const status = isObj(body.result) ? body.result.status : undefined;
  if (isObj(status) && 'Failure' in status) {
    const code = contractErrorCode(JSON.stringify(status.Failure).slice(0, 4000));
    if (code) throw pageError('stamps_contract_refused', code);
    if (/NotEnoughBalance|LackBalanceForState/u.test(JSON.stringify(status.Failure).slice(0, 4000))) throw pageError('near_not_enough_balance', 'Not enough NEAR for the fee');
    throw pageError('near_send_failed', 'NEAR testnet failed the transaction');
  }
  if (!isObj(status)) throw pageError('near_send_failed', 'NEAR testnet gave no outcome');
  return 'done';
}

export function createCollector(deps: CollectorDeps): Collector {
  const { config, client: c, rpc, clock } = deps;
  const contract = config.near.stamps;
  const tgas = config.near.collectTgas;

  let prep: Prep | null = null;
  let reading: { accountId: string; promise: Promise<Prep> } | null = null;
  const activating = new Map<string, Promise<NearActivateResult>>();
  const justCreated = new Set<string>();
  /** The highest nonce this page signed per account, so a second request before the next read still goes up. */
  const lastNonce = new Map<string, bigint>();
  let backgroundAt = -Infinity;
  let generation = 0;

  async function read(accountId: string): Promise<Prep> {
    const publicKey = c.near.publicKey;
    if (publicKey === null || c.near.accountId !== accountId) throw pageError('near_page_rpc_failed', 'No NEAR key for this account');
    const gen = generation;
    const [key, block, balance] = await Promise.all([rpc.accessKey(accountId, publicKey), rpc.finalBlock(), rpc.balance(accountId)]);
    const p: Prep = { accountId, key, height: block.height, hash: block.hash, balance, at: clock() };
    if (gen === generation) prep = p;
    return p;
  }

  function refresh(accountId: string): Promise<Prep> {
    if (reading?.accountId === accountId) return reading.promise;
    const promise = read(accountId).finally(() => {
      if (reading?.promise === promise) reading = null;
    });
    reading = { accountId, promise };
    return promise;
  }

  const fresh = (accountId: string): Prep | null => (prep !== null && prep.accountId === accountId && clock() - prep.at < PREP_MAX_AGE_MS ? prep : null);

  /** Retries `call` while the API answers `near_account_unrecorded` (409, for about UNRECORDED_WAIT_MS) or `relayer_busy`. */
  async function whileUnrecorded<T>(call: () => Promise<T>): Promise<T> {
    let waited = 0;
    let busy = 0;
    for (let pause = 500; ; pause = Math.min(pause * 2, 4000)) {
      try {
        return await call();
      } catch (e) {
        const reason = errorInfo(e).reason;
        const retry = reason === 'relayer_busy' ? busy++ < BUSY_RETRIES : reason === UNRECORDED_REASON && waited + pause <= UNRECORDED_WAIT_MS;
        if (!retry) throw e;
        waited += pause;
        await deps.sleep(pause);
      }
    }
  }

  /** hana.near.activate once per account and session (a failure is forgotten, so the next try asks again). */
  function activateOnce(accountId: string): Promise<NearActivateResult> {
    let p = activating.get(accountId);
    if (!p) {
      p = whileUnrecorded(() => c.near.activate()).then(
        (r) => {
          if (r.created) justCreated.add(accountId);
          return r;
        },
        (e: unknown) => {
          activating.delete(accountId);
          throw e;
        },
      );
      activating.set(accountId, p);
    }
    return p;
  }

  /**
   * A read showing the account's key: activates a new account first. The relayer's answer carries the key's nonce and
   * the height it read them at, which serve as the read (the RPC may lag the new account); without them, the RPC is
   * read until the key shows.
   */
  async function ensureReady(accountId: string, stage: (text: string) => void): Promise<Prep> {
    let p = fresh(accountId) ?? (await refresh(accountId));
    if (p.key) return p;
    stage(STAGES.activating);
    const a = await activateOnce(accountId);
    if (typeof a.accessKeyNonce === 'string' && a.blockHeight !== undefined) {
      const height = BigInt(a.blockHeight);
      p = { ...p, key: { nonce: BigInt(a.accessKeyNonce), blockHeight: height, blockHash: p.hash }, height: height > p.height ? height : p.height, at: clock() };
      prep = p;
      return p;
    }
    for (let i = 0; i < ACTIVATION_TRIES && !p.key; i++) {
      if (i > 0 || !a.created) await deps.sleep(1000);
      p = await refresh(accountId);
    }
    if (!p.key) throw pageError('near_account_pending', 'The account has no key on testnet yet');
    return p;
  }

  /** Builds, signs (the approval window) and relays one delegate action from `r`; synchronous up to the signing call. */
  async function signAndRelay(accountId: string, args: CollectArgs, r: Prep, stage: (text: string) => void): Promise<string> {
    const nonce = delegateNonce({ keyNonce: r.key!.nonce, blockHeight: r.height, lastSigned: lastNonce.get(accountId) });
    const delegateAction = collectDelegate({ accountId, contract, args, tgas, nonce, blockHeight: r.height });
    stage(STAGES.approving);
    const { signedDelegateAction } = await c.near.signDelegateAction({ network: 'testnet', delegateAction });
    lastNonce.set(accountId, nonce);
    stage(STAGES.relaying);
    return (await whileUnrecorded(() => c.near.relay({ network: 'testnet', signedDelegateAction }))).transactionHash;
  }

  /** signAndRelay, once more after a `delegate_nonce_used` (another tab, a read behind the relayer): a second approval. */
  async function relayWithRetry(accountId: string, args: CollectArgs, r: Prep, stage: (text: string) => void): Promise<string> {
    try {
      return await signAndRelay(accountId, args, r, stage);
    } catch (e) {
      const info = errorInfo(e);
      if (info.reason !== 'delegate_nonce_used') throw e;
      const held = isObj(e) && isObj(e.data) && typeof e.data.accessKeyNonce === 'string' && /^\d{1,20}$/u.test(e.data.accessKeyNonce) ? BigInt(e.data.accessKeyNonce) : null;
      if (held !== null && held > (lastNonce.get(accountId) ?? 0n)) lastNonce.set(accountId, held);
      stage(STAGES.retrying);
      return signAndRelay(accountId, args, await refresh(accountId), stage);
    }
  }

  /** The relayed stamps. With a fresh read the signing call is made synchronously; else prepareApproval first. */
  async function relayed(req: CollectRequest, args: CollectArgs, stage: (text: string) => void): Promise<string> {
    let ready = fresh(req.accountId);
    if (ready === null || ready.key === null) {
      // Not prepared: the Journear Passport window opens now, in the click, and the next signing call uses it.
      const ticket: ApprovalTicket = c.prepareApproval();
      try {
        stage(STAGES.reading);
        ready = await ensureReady(req.accountId, stage);
      } catch (e) {
        ticket.cancel();
        throw e;
      }
    }
    return relayWithRetry(req.accountId, args, ready, stage);
  }

  /** `signature`: NEP-413 first (opens the window in the click: it needs no read), then the relayed collect. */
  async function signature(req: CollectRequest, stage: (text: string) => void): Promise<string> {
    const { accountId } = req;
    if (!isImplicitAccount(accountId)) throw pageError('stamps_contract_refused', 'ERR_NOT_IMPLICIT');
    const nonce = deps.random(32);
    const message = signatureMessage(accountId);
    stage(STAGES.signMessage);
    const signed = await c.near.signMessage({ message, recipient: contract, nonce });
    if (signed.accountId !== accountId) throw pageError('near_send_failed', 'The signature is for another account');
    const proof = { message, nonce: base64Encode(nonce), recipient: contract, signature: signed.signature };
    stage(STAGES.reading);
    const ready = await ensureReady(accountId, stage);
    return relayWithRetry(accountId, collectArgs('signature', { proof }), ready, stage);
  }

  /** `own_fare`: an ordinary transaction the account pays for, sent from the page. */
  async function ownFare(req: CollectRequest, stage: (text: string) => void): Promise<CollectOutcome> {
    const { accountId } = req;
    let ready = fresh(accountId);
    let ticket: ApprovalTicket | null = null;
    if (ready === null) {
      ticket = c.prepareApproval();
      try {
        stage(STAGES.reading);
        ready = await refresh(accountId);
      } catch (e) {
        ticket.cancel();
        throw e;
      }
    }
    if (ready.key === null || ready.balance < OWN_FARE_MIN_YOCTO) {
      ticket?.cancel();
      throw pageError('near_not_enough_balance', 'Not enough NEAR for the fee');
    }
    const nonce = transactionNonce({ keyNonce: ready.key.nonce, lastSigned: lastNonce.get(accountId) });
    const transaction = collectTransaction({ accountId, contract, args: collectArgs('own_fare'), tgas, nonce, blockHash: ready.hash });
    stage(STAGES.approving);
    const r = await c.near.signTransaction({ network: 'testnet', transaction });
    lastNonce.set(accountId, nonce);
    stage(STAGES.sending);
    const sent = await sendOwnFare(rpc, r.signedTransaction);
    return sent === 'done' ? { status: 'done', txHash: r.hash, created: false } : { status: 'sent', txHash: r.hash };
  }

  return {
    latest: (accountId) => (prep !== null && prep.accountId === accountId ? prep : null),
    refresh,
    prepare(accountId, activate) {
      if (clock() - backgroundAt < BACKGROUND_GAP_MS) return;
      backgroundAt = clock();
      const task = activate ? ensureReady(accountId, () => {}) : refresh(accountId);
      task.catch(() => {});
    },
    async collect(req, stage) {
      let note: string | undefined;
      if (req.stamp === 'postcard') {
        const check = checkNote(req.note ?? '');
        if (!check.ok) throw pageError('stamps_contract_refused', 'ERR_BAD_NOTE');
        note = check.text;
      }
      try {
        if (req.stamp === 'own_fare') return await ownFare(req, stage);
        const txHash = req.stamp === 'signature' ? await signature(req, stage) : await relayed(req, collectArgs(req.stamp, note !== undefined ? { note } : {}), stage);
        // The first stamp after this page's activation says so.
        const created = justCreated.delete(req.accountId);
        return { status: 'done', txHash, created, ...(note !== undefined ? { note } : {}) };
      } catch (e) {
        // The relayer gave up waiting (504 `timeout`) with the transaction sent: no error, it may still land (D788).
        const reason = errorInfo(e).reason;
        if (reason === 'timeout') {
          const sent = relayTransaction(e);
          if (sent !== null) return { status: 'sent', txHash: sent };
        }
        // A nonce or expiry refusal: the read this page holds is behind, so the next click must not reuse it.
        if (reason !== null && STALE_READ_REASONS.has(reason)) {
          prep = null;
          refresh(req.accountId).catch(() => {});
        }
        throw e;
      }
    },
    reset() {
      generation++;
      prep = null;
      reading = null;
      activating.clear();
      justCreated.clear();
      lastNonce.clear();
      backgroundAt = -Infinity;
    },
  };
}
