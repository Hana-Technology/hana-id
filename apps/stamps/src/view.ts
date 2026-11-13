// The passport as the UI shows it (`PassportView`, src/ui's contract), computed from the site's state: a pure
// function, so every rule is tested without a page. Which stamps are available is decided here from what NEAR holds
// (D800): Arrival first, Own fare once the account holds testnet NEAR for the fee, Signature for an implicit account,
// the Layover 2 minutes after the Arrival's block time. The contract stays the authority: a stamp shown available that
// the contract refuses comes back as `failed` with its ERR_* in plain words.
import type { PassportView, StampState } from './ui/index.ts';
import { explorerAccountUrl, explorerTxUrl, isViewableAccount, passportPath } from './routes.ts';
import { type ChainStamp, LAYOVER_MS, OWN_FARE_MIN_YOCTO, type Passport, type RecentStamp, STAMP_IDS, type StampId, isImplicitAccount } from './stamps.ts';
import { formatNear } from '../../demo/src/near.ts';

/** A little longer than the contract's 120 s, so a click at zero isn't refused for a block's worth of clock skew. */
export const LAYOVER_MARGIN_MS = 3_000;

export const LOCKED = {
  signIn: 'Sign in to collect',
  reading: 'Reading your passport…',
  arrivalFirst: 'Collect Arrival first',
  needsNear: 'Needs testnet NEAR',
  checkingBalance: 'Checking your balance…',
  notImplicit: 'Needs a Journear Passport account',
  notCollected: 'Not collected yet',
} as const;

export const SENT_STAGE = 'Sent, still confirming on NEAR testnet…';

/** The notice for a NEAR account id this site can't show or link (neither a 64-hex implicit account nor `.testnet`). */
export const UNVIEWABLE_NOTICE = 'This NEAR account id isn’t one this site can show. Sign out and in again; if it stays, tell the Journear team.';

/**
 * The faucet's notice, shown while Own fare waits for testnet NEAR and nothing else is said (the UI's locked state
 * carries a reason only, so the link goes here).
 */
export const FAUCET_NOTICE = 'Own fare is a transaction you pay for yourself: it needs 0.01 testnet NEAR in your account. Get some free from a faucet (paste your account id), then come back.';

/** "In 1 min 40 s" / "In 45 s". */
export function countdownText(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  const min = Math.floor(s / 60);
  const sec = s % 60;
  if (min === 0) return `In ${sec} s`;
  return sec === 0 ? `In ${min} min` : `In ${min} min ${sec} s`;
}

export interface ViewInput {
  mode: 'cover' | 'mine' | 'public';
  /** The passport's account (mine: the signed-in user's; public: the route's). */
  accountId: string | null;
  /** undefined: not read yet; null: no passport on chain. */
  passport: Passport | null | undefined;
  /** Stamps this page collected that the chain read doesn't show yet (optimistic, until it does). */
  local: ReadonlyMap<StampId, ChainStamp>;
  /** Transactions of stamps collected in this session. */
  txs: ReadonlyMap<StampId, string>;
  /** Stamps sent but not confirmed (D788). */
  sent: ReadonlyMap<StampId, string>;
  working: { id: StampId; stage: string } | null;
  failed: ReadonlyMap<StampId, string>;
  /** Stamps to mark `fresh` in this view (once). */
  fresh: ReadonlySet<StampId>;
  /** mine: the account's balance (yoctoNEAR) and whether its key is on chain, or null before the first read. */
  balance: { yocto: bigint; activated: boolean } | null;
  recent: readonly RecentStamp[];
  totals: { passports: number; stamps: number } | null;
  notice: PassportView['notice'] | null;
  busy: boolean;
  explorer: string | null;
  faucet: string | null;
  /** The page's origin, for the share link. */
  origin: string;
}

/** The passport's stamps: the chain's, with this page's optimistic ones added. */
export function heldStamps(passport: Passport | null | undefined, local: ReadonlyMap<StampId, ChainStamp>): Map<StampId, ChainStamp> {
  const held = new Map<StampId, ChainStamp>();
  for (const s of passport?.stamps ?? []) held.set(s.stamp, s);
  for (const [id, s] of local) if (!held.has(id)) held.set(id, s);
  return held;
}

function stampState(id: StampId, v: ViewInput, held: Map<StampId, ChainStamp>, now: number): StampState {
  const have = held.get(id);
  if (have) {
    const tx = v.txs.get(id);
    const txUrl = (tx !== undefined ? explorerTxUrl(v.explorer, tx) : null) ?? (v.accountId !== null ? explorerAccountUrl(v.explorer, v.accountId) : null);
    return { id, status: 'collected', atMs: have.atMs, sponsored: have.sponsored, ...(have.note !== undefined ? { note: have.note } : {}), ...(txUrl ? { txUrl } : {}), ...(v.fresh.has(id) ? { fresh: true } : {}) };
  }
  if (v.mode === 'cover') return { id, status: 'locked', reason: LOCKED.signIn };
  if (v.mode === 'public') return { id, status: 'locked', reason: v.passport === undefined ? LOCKED.reading : LOCKED.notCollected };
  if (v.working?.id === id) return { id, status: 'working', stage: v.working.stage };
  if (v.sent.has(id)) return { id, status: 'working', stage: SENT_STAGE };
  if (v.passport === undefined && v.local.size === 0) return { id, status: 'locked', reason: LOCKED.reading };
  const failed = v.failed.get(id);
  const available: StampState = failed !== undefined ? { id, status: 'failed', message: failed } : { id, status: 'available' };
  if (id === 'arrival') return available;
  const arrival = held.get('arrival');
  if (!arrival) return { id, status: 'locked', reason: LOCKED.arrivalFirst };
  switch (id) {
    case 'own_fare': {
      if (v.balance === null) return { id, status: 'locked', reason: LOCKED.checkingBalance };
      if (!v.balance.activated || v.balance.yocto < OWN_FARE_MIN_YOCTO) {
        return { id, status: 'locked', reason: LOCKED.needsNear };
      }
      return available;
    }
    case 'signature':
      return v.accountId !== null && isImplicitAccount(v.accountId) ? available : { id, status: 'locked', reason: LOCKED.notImplicit };
    case 'layover': {
      const left = arrival.atMs + LAYOVER_MS + LAYOVER_MARGIN_MS - now;
      return left > 0 ? { id, status: 'locked', reason: countdownText(left) } : available;
    }
    default:
      return available;
  }
}

/** Whether the view holds a running layover countdown (the page then renders every second). */
export function layoverCounting(v: ViewInput, now: number): boolean {
  if (v.mode !== 'mine') return false;
  const held = heldStamps(v.passport, v.local);
  const arrival = held.get('arrival');
  return arrival !== undefined && !held.has('layover') && arrival.atMs + LAYOVER_MS + LAYOVER_MARGIN_MS > now;
}

export function buildView(v: ViewInput, now: number): PassportView {
  const held = heldStamps(v.passport, v.local);
  const view: PassportView = {
    mode: v.mode,
    stamps: STAMP_IDS.map((id) => stampState(id, v, held, now)),
    recent: v.recent.filter((r) => isViewableAccount(r.accountId)).map((r) => ({ accountId: r.accountId, stamp: r.stamp, atMs: r.atMs, href: passportPath(r.accountId) })),
  };
  if (v.mode !== 'cover' && v.accountId !== null) {
    view.accountId = v.accountId;
    const explorerUrl = explorerAccountUrl(v.explorer, v.accountId);
    if (explorerUrl) view.explorerUrl = explorerUrl;
    // An id the site can't route (neither 64-hex nor `.testnet`: the SDK should never give one) gets no share link,
    // and the page says so instead of failing to render.
    if (isViewableAccount(v.accountId)) view.shareUrl = `${v.origin}${passportPath(v.accountId)}`;
  }
  if (v.mode === 'mine' && v.balance !== null) view.balanceNear = formatNear(v.balance.yocto);
  if (v.totals) view.totals = { ...v.totals };
  if (v.mode !== 'cover' && v.accountId !== null && !isViewableAccount(v.accountId)) view.notice = { kind: 'error', text: UNVIEWABLE_NOTICE };
  else if (v.notice) view.notice = { ...v.notice };
  else if (v.mode === 'mine' && v.faucet !== null && view.stamps.some((s) => s.id === 'own_fare' && s.status === 'locked' && s.reason === LOCKED.needsNear)) {
    view.notice = { kind: 'info', text: FAUCET_NOTICE, href: v.faucet, hrefLabel: 'Get testnet NEAR' };
  }
  if (v.busy) view.busy = true;
  return view;
}
