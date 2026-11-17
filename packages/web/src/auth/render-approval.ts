// What the approval popup shows for a request (docs/batch-b-spec.md "Approval flow" step 4), rendered from the popup's
// own decode of the request bytes (@hana-id/core/decode), never from a summary the vault sent. Every value is text;
// strings the decoders flag as unsafe to show (control, bidi or invisible characters) are shown as hex.
//
// The layout (D808–D812): a plain summary first (`summarizeApproval`: "{App} wants to …", its lines, the network and
// the most the fee can be), then every warning and danger line, the page's notes, the facts a user decides on (the NEAR
// leaving the account, a NEP-413 recipient, a message's text), and last the technical details in a native
// `<details>` the user can always open ("Show details"). The details always start folded, raw signing included (the
// founder's decision, D810): a request Journear can't explain states its risk in plain words above them instead.
// Nothing a partner controls decides what is folded.
import { isDisplaySafeLine } from '@hana-id/core';
import { type ApprovalSummary, type SummaryText, type SummaryWarning, displayUnits, nearDisplay, summarizeApproval } from '@hana-id/core/decode';
import {
  type AbiValue,
  type DecodedApproval,
  type DecodedEvmCallSite,
  type DecodedEvmTx,
  type DecodedMessage,
  type DecodedStellarEnvelope,
  STELLAR_ACCOUNT_FLAGS,
  STELLAR_TRUSTLINE_FLAGS,
  type StellarAuthEntry,
  type StellarHostFunction,
  type StellarInvocation,
  type StellarLedgerKey,
  type StellarOperation,
  type StellarPrice,
  type StellarScVal,
  type StellarText,
  type StellarTransaction,
  type TypedDataNode,
  formatGas,
  formatNear,
  nearArgsView,
  nearCallsOwnContract,
  nearChangesControl,
  nearCodeHash,
  nearDeposits,
  nearGlobalContractBurn,
  nearHash58,
  nearKeyText,
  nearMethodName,
  stellarAccountControl,
  stellarFlagNames,
} from '@hana-id/core/decode';
import { type NearAction, evmChainInfo, toHex } from '@hana-id/core';
import { BRAND } from '@hana-id/brand';
import { type Child, type Dom, dom, row, rows } from './dom.ts';
import { alert } from './ui.ts';

/** `value` with `decimals` decimal places, trailing zeros trimmed: formatUnits(1500000000000000000n, 18) = "1.5". */
export function formatUnits(value: bigint | string, decimals: number): string {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/u, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

const stroops = (s: string) => `${formatUnits(s, 7)} XLM (${s} stroops)`;
const wei = (v: bigint) => `${formatUnits(v, 18)} (${v} wei)`;
const gwei = (v: bigint) => `${formatUnits(v, 9)} gwei`;

/** Unix seconds (decimal) as an ISO date, or the raw value if it is out of range. */
function unixTime(s: string): string {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || n > 8.64e12) return `${s} (unix seconds)`;
  return `${new Date(n * 1000).toISOString()} (${s})`;
}

const mono = (d: Dom, text: string) => d.h('code', { class: 'mono' }, text);

/** A network passphrase (a request may name any): as text when display-safe, else its UTF-8 bytes as hex. */
const passphraseText = (d: Dom, p: string): HTMLElement => (isDisplaySafeLine(p) ? mono(d, p) : mono(d, `(shown as hex) ${toHex(new TextEncoder().encode(p))}`));

/**
 * The facts of a request (D765, the confirm and sign pattern): the design system's key/value rows (`jp-kv`: the key in
 * the body font, muted; the value in mono). Same rows, same order, same values as before: only their look changed.
 */
const facts = (d: Dom, entries: Parameters<typeof rows>[1]): HTMLDListElement => rows(d, entries, 'jp-kv facts');

/** A notice in the system's alert (ui.ts): `warn` lines are warning alerts, `note` lines info, `danger` lines danger. */
const warnLine = (d: Dom, cls: string, ...children: Child[]) => alert(d, 'warning', { class: cls }, ...children);
const noteLine = (d: Dom, cls: string, ...children: Child[]) => alert(d, 'info', { class: cls }, ...children);
const dangerLine = (d: Dom, cls: string, attrs: Record<string, string> | undefined, ...children: Child[]) => alert(d, 'danger', { class: cls, ...(attrs ? { attrs } : {}) }, ...children);

// ---- Stellar ----

function scVal(d: Dom, v: StellarScVal): HTMLElement {
  switch (v.type) {
    case 'bool':
      return mono(d, String(v.value));
    case 'void':
      return mono(d, 'void');
    case 'u32':
    case 'i32':
      return mono(d, `${v.value} (${v.type})`);
    case 'u64':
    case 'i64':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
    case 'timepoint':
    case 'duration':
      return mono(d, `${v.value} (${v.type})`);
    case 'bytes':
      return mono(d, `bytes ${v.hex}`);
    case 'string':
      return v.value === null ? mono(d, `string (shown as hex) ${v.hex}`) : d.h('span', {}, `"${v.value}"`);
    case 'symbol':
      return mono(d, v.value);
    case 'address':
      return d.h('span', {}, mono(d, v.address), ` (${v.addressType})`);
    case 'vec':
      return d.h('ol', { class: 'tree' }, ...v.items.map((i) => d.h('li', {}, scVal(d, i))));
    case 'map':
      return d.h('ul', { class: 'tree' }, ...v.entries.map((e) => d.h('li', {}, scVal(d, e.key), ' → ', scVal(d, e.value))));
    default:
      return mono(d, `${v.type} ${v.xdr}`);
  }
}

function call(d: Dom, contract: string, fn: string, args: readonly StellarScVal[]): HTMLElement {
  return d.h(
    'div',
    { class: 'call' },
    d.h('p', {}, 'Contract ', mono(d, contract)),
    d.h('p', {}, 'Function ', d.h('strong', {}, fn)),
    args.length === 0 ? d.h('p', { class: 'muted' }, 'No arguments') : d.h('ol', { class: 'args' }, ...args.map((a) => d.h('li', {}, scVal(d, a)))),
  );
}

function invocation(d: Dom, inv: StellarInvocation): HTMLElement {
  const f = inv.function;
  const head = f.type === 'contractFn' ? call(d, f.contract, f.function, f.args) : d.h('p', {}, `${f.type} `, mono(d, f.xdr));
  return d.h(
    'div',
    { class: 'invocation' },
    head,
    inv.subInvocations.length > 0 ? d.h('div', { class: 'sub' }, d.h('p', { class: 'muted' }, 'Which also authorizes:'), ...inv.subInvocations.map((s) => invocation(d, s))) : null,
  );
}

function authEntry(d: Dom, a: StellarAuthEntry): HTMLElement {
  const cred =
    a.credentials.type === 'sourceAccount'
      ? d.h('p', {}, 'Authorized by the transaction source')
      : d.h('p', {}, 'Authorized by ', mono(d, a.credentials.address), ` (nonce ${a.credentials.nonce}, until ledger ${a.credentials.signatureExpirationLedger})`);
  return d.h('div', { class: 'auth' }, cred, invocation(d, a.rootInvocation));
}

function hostFunction(d: Dom, f: StellarHostFunction): HTMLElement {
  return f.type === 'invokeContract' ? call(d, f.contract, f.function, f.args) : warnLine(d, 'warn', `${f.type} `, mono(d, f.xdr));
}

function ledgerKey(d: Dom, k: StellarLedgerKey): HTMLElement {
  switch (k.type) {
    case 'contractData':
      return d.h('li', {}, `contract data (${k.durability}) of `, mono(d, k.contract), ': ', scVal(d, k.key));
    case 'contractCode':
      return d.h('li', {}, 'contract code ', mono(d, k.hash));
    case 'account':
      return d.h('li', {}, 'account ', mono(d, k.account));
    default:
      return d.h('li', {}, `${k.type} `, mono(d, k.xdr));
  }
}

/** An amount of `asset` (`native` or `CODE:ISSUER`) in stroops: "1.5 USDC:G… (15000000 stroops)". */
const assetAmount = (d: Dom, s: string, asset: string) => d.h('span', {}, `${formatUnits(s, 7)} `, mono(d, asset === 'native' ? 'XLM' : asset), ` (${s} stroops)`);
const price = (p: StellarPrice) => `${p.n}/${p.d}`;
const flags = (bits: number, names: Parameters<typeof stellarFlagNames>[1]) => (bits === 0 ? 'none' : `${stellarFlagNames(bits, names).join(', ')} (${bits})`);
const shortText = (d: Dom, t: StellarText) => (t.value === null ? mono(d, `(shown as hex) ${t.hex}`) : t.value === '' ? d.h('span', { class: 'muted' }, '(empty: clears it)') : mono(d, t.value));
const path = (d: Dom, p: readonly string[]) => (p.length === 0 ? 'direct' : d.h('span', {}, ...p.flatMap((a, i) => [i > 0 ? ' → ' : '', mono(d, a)])));
const offer = (id: string, amount: string) => (id === '0' ? 'new offer' : amount === '0' ? `deletes offer ${id}` : `changes offer ${id}`);

/**
 * The account-control warnings (docs/decisions.md D110): shown on every setOptions signer, threshold or master-weight
 * change and every accountMerge, in the popup's strongest style. No auto-approve policy covers these operations.
 */
export const ACCOUNT_CONTROL_BANNER =
  `Danger: this transaction changes who controls a Stellar account. Whoever gets control can take everything in it, and ${BRAND.product} can’t undo it. Approve only if you started this change yourself; an app should almost never need it.`;

/**
 * One account-control warning of an operation: its line, its bullet (D814), and whether the bullet says more than the
 * step's own line and so always stays (`keep`): setting the account's own key to weight 0 locks the user out, which
 * the line ("set your own key’s weight to 0") doesn't say, as NEAR's removal of the user's own key.
 */
interface ControlItem {
  readonly full: string;
  readonly short: Child[];
  readonly keep: boolean;
}

function accountControlItems(op: StellarOperation): ControlItem[] {
  const out: ControlItem[] = [];
  for (const c of stellarAccountControl(op)) {
    if (c === 'merge' && op.type === 'accountMerge') {
      out.push({ full: `This closes the account and sends all of its XLM to ${op.destination}. It can’t be undone.`, short: ['Closes the account and sends all its XLM to ', op.destination], keep: false });
    } else if (op.type === 'setOptions') {
      if (c === 'signer' && op.signer) {
        out.push(
          op.signer.weight === 0
            ? { full: `This removes signer ${op.signer.key} from the account.`, short: ['Removes signer ', op.signer.key], keep: false }
            : {
                full: `This adds ${op.signer.key} as a signer with weight ${op.signer.weight}. Whoever holds that key can sign for the account and, with enough weight, move all its funds and lock you out.`,
                short: ['Adds ', op.signer.key, ` as a signer (weight ${op.signer.weight})`],
                keep: false,
              },
        );
      } else if (c === 'thresholds') {
        out.push({ full: 'This changes the account’s signing thresholds, which decide which keys can move funds and change the account. Wrong values let other signers take over or lock you out for good.', short: ['Changes the signing thresholds'], keep: false });
      } else if (c === 'master_weight') {
        out.push(
          op.masterWeight === 0
            ? { full: `This sets the weight of the account’s own key (your ${BRAND.product} key) to 0: it can no longer sign for the account, so you lose control of it.`, short: [`Sets your own ${BRAND.product} key’s weight to 0: you lose control of the account`], keep: true }
            : { full: `This sets the weight of the account’s own key (your ${BRAND.product} key) to ${op.masterWeight}, which changes what it can still do on the account.`, short: [`Sets your own key’s weight to ${op.masterWeight}`], keep: false },
        );
      }
    }
  }
  return out;
}

export function accountControlWarnings(op: StellarOperation): string[] {
  return accountControlItems(op).map((c) => c.full);
}

function classic(d: Dom, op: StellarOperation): Child[] {
  switch (op.type) {
    case 'pathPaymentStrictReceive':
      return [facts(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Pays at most', assetAmount(d, op.sendMax, op.sendAsset)), row(d, 'Receives exactly', assetAmount(d, op.destAmount, op.destAsset)), row(d, 'Through', path(d, op.path))])];
    case 'pathPaymentStrictSend':
      return [facts(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Pays exactly', assetAmount(d, op.sendAmount, op.sendAsset)), row(d, 'Receives at least', assetAmount(d, op.destMin, op.destAsset)), row(d, 'Through', path(d, op.path))])];
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      return [facts(d, [row(d, 'Sells', assetAmount(d, op.amount, op.selling)), row(d, 'For', mono(d, op.buying === 'native' ? 'XLM' : op.buying)), row(d, 'Price', `${price(op.price)} per unit sold`), row(d, 'Offer', op.type === 'createPassiveSellOffer' ? 'new passive offer' : offer(op.offerId, op.amount))])];
    case 'manageBuyOffer':
      return [facts(d, [row(d, 'Buys', assetAmount(d, op.buyAmount, op.buying)), row(d, 'Paying with', mono(d, op.selling === 'native' ? 'XLM' : op.selling)), row(d, 'Price', `${price(op.price)} per unit bought`), row(d, 'Offer', offer(op.offerId, op.buyAmount))])];
    case 'setOptions': {
      const s = op.signer;
      const r = [
        s && row(d, s.weight === 0 ? 'Removes signer' : 'Adds signer', mono(d, s.key), ` (${s.keyType}${s.weight === 0 ? '' : `, weight ${s.weight}`})`),
        op.masterWeight !== null && row(d, 'Own key weight', String(op.masterWeight)),
        op.lowThreshold !== null && row(d, 'Low threshold', String(op.lowThreshold)),
        op.medThreshold !== null && row(d, 'Medium threshold', String(op.medThreshold)),
        op.highThreshold !== null && row(d, 'High threshold', String(op.highThreshold)),
        op.setFlags !== null && row(d, 'Sets flags', flags(op.setFlags, STELLAR_ACCOUNT_FLAGS)),
        op.clearFlags !== null && row(d, 'Clears flags', flags(op.clearFlags, STELLAR_ACCOUNT_FLAGS)),
        op.homeDomain && row(d, 'Home domain', shortText(d, op.homeDomain)),
        op.inflationDest !== null && row(d, 'Inflation destination', mono(d, op.inflationDest)),
      ];
      return r.some(Boolean) ? [facts(d, r)] : [d.h('p', { class: 'muted' }, 'Changes nothing')];
    }
    case 'allowTrust':
      return [facts(d, [row(d, 'Trustor', mono(d, op.trustor)), row(d, 'Asset code', mono(d, op.assetCode)), row(d, 'Authorization', op.authorize === 0 ? 'revoked' : flags(op.authorize, STELLAR_TRUSTLINE_FLAGS))])];
    case 'accountMerge':
      return [facts(d, [row(d, 'Sends all XLM to', mono(d, op.destination))])];
    case 'inflation':
      return [d.h('p', {}, 'Runs inflation (it no longer has any effect on Stellar)')];
    case 'endSponsoringFutureReserves':
      return [d.h('p', {}, 'Ends the reserve sponsorship started earlier in this transaction')];
    case 'manageData':
      return [facts(d, [row(d, 'Name', shortText(d, op.name)), row(d, 'Value', op.value === null ? 'deletes the entry' : mono(d, op.value))])];
    case 'bumpSequence':
      return [facts(d, [row(d, 'Bumps the sequence number to', mono(d, op.bumpTo))])];
    case 'createClaimableBalance':
      return [
        facts(d, [row(d, 'Amount', assetAmount(d, op.amount, op.asset))]),
        d.h('p', {}, 'Who can claim it:'),
        d.h('ul', {}, ...op.claimants.map((c) => d.h('li', {}, mono(d, c.destination), c.unconditional ? ' (at any time)' : ' (with conditions: ', c.unconditional ? null : mono(d, c.predicate), c.unconditional ? null : ')'))),
      ];
    case 'claimClaimableBalance':
    case 'clawbackClaimableBalance':
      return [facts(d, [row(d, 'Balance', mono(d, op.balanceId))])];
    case 'beginSponsoringFutureReserves':
      return [facts(d, [row(d, 'Pays the reserves of', mono(d, op.sponsored))])];
    case 'revokeSponsorship':
      return op.target.type === 'ledgerEntry'
        ? [d.h('p', {}, 'Ends the sponsorship of:'), d.h('ul', {}, ledgerKey(d, op.target.key))]
        : [facts(d, [row(d, 'Ends the sponsorship of signer', mono(d, op.target.signer)), row(d, 'On account', mono(d, op.target.account))])];
    case 'clawback':
      return [facts(d, [row(d, 'Takes back from', mono(d, op.from)), row(d, 'Amount', assetAmount(d, op.amount, op.asset))])];
    case 'setTrustLineFlags':
      return [facts(d, [row(d, 'Trustor', mono(d, op.trustor)), row(d, 'Asset', mono(d, op.asset)), row(d, 'Sets flags', flags(op.setFlags, STELLAR_TRUSTLINE_FLAGS)), row(d, 'Clears flags', flags(op.clearFlags, STELLAR_TRUSTLINE_FLAGS))])];
    case 'liquidityPoolDeposit':
      return [facts(d, [row(d, 'Pool', mono(d, op.poolId)), row(d, 'At most', `${formatUnits(op.maxAmountA, 7)} of asset A and ${formatUnits(op.maxAmountB, 7)} of asset B`), row(d, 'Price between', `${price(op.minPrice)} and ${price(op.maxPrice)}`)])];
    case 'liquidityPoolWithdraw':
      return [facts(d, [row(d, 'Pool', mono(d, op.poolId)), row(d, 'Pool shares', formatUnits(op.amount, 7)), row(d, 'At least', `${formatUnits(op.minAmountA, 7)} of asset A and ${formatUnits(op.minAmountB, 7)} of asset B`)])];
    default:
      // Never reached: every operation type the XDR defines is decoded (the decoder refuses unknown ones).
      return [warnLine(d, 'warn', `${BRAND.product} doesn’t decode this operation. Its raw XDR:`), mono(d, op.xdr)];
  }
}

function operation(d: Dom, op: StellarOperation, index: number): HTMLElement {
  // Its account-control warnings are shown above the details (stellarAlerts); the frame marks the operation here.
  const body: Child[] = [];
  switch (op.type) {
    case 'invokeHostFunction':
      body.push(hostFunction(d, op.hostFunction));
      if (op.auth.length > 0) body.push(d.h('div', { class: 'sub' }, d.h('p', { class: 'muted' }, 'Authorizations:'), ...op.auth.map((a) => authEntry(d, a))));
      break;
    case 'extendFootprintTtl':
      body.push(d.h('p', {}, `Extend the footprint's time to live to ${op.extendTo} ledgers`));
      break;
    case 'restoreFootprint':
      body.push(d.h('p', {}, 'Restore archived contract data in the footprint'));
      break;
    case 'changeTrust':
      body.push(facts(d, [row(d, 'Asset', mono(d, op.asset)), row(d, 'Limit', stroops(op.limit))]));
      break;
    case 'payment':
      body.push(facts(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Asset', mono(d, op.asset)), row(d, 'Amount', `${formatUnits(op.amount, 7)} (${op.amount} stroops)`)]));
      break;
    case 'createAccount':
      body.push(facts(d, [row(d, 'New account', mono(d, op.destination)), row(d, 'Starting balance', stroops(op.startingBalance))]));
      break;
    default:
      body.push(...classic(d, op));
  }
  return d.h(
    'li',
    { class: stellarAccountControl(op).length > 0 ? 'op takeover-op' : 'op' },
    d.h('h3', {}, `${index + 1}. ${op.type}`),
    op.source ? d.h('p', {}, 'Source ', mono(d, op.source)) : null,
    ...body,
  );
}

function stellarTx(d: Dom, passphrase: string, tx: StellarTransaction): HTMLElement[] {
  const memo = tx.memo;
  const memoText = memo.type === 'none' ? 'none' : memo.type === 'text' ? (memo.value ?? `(shown as hex) ${memo.hex}`) : memo.type === 'id' ? memo.value : `${memo.type} ${memo.hex}`;
  return [
    facts(d, [
      row(d, 'Network', passphraseText(d, passphrase)),
      row(d, 'Source', mono(d, tx.source)),
      row(d, 'Sequence', mono(d, tx.sequence)),
      row(d, 'Maximum fee', stroops(tx.fee)),
      row(d, 'Valid', tx.timeBounds ? `from ${unixTime(tx.timeBounds.minTime)} until ${tx.timeBounds.maxTime === '0' ? 'no limit' : unixTime(tx.timeBounds.maxTime)}` : 'no time limit'),
      tx.ledgerBounds && row(d, 'Ledgers', `${tx.ledgerBounds.minLedger} to ${tx.ledgerBounds.maxLedger === 0 ? 'no limit' : tx.ledgerBounds.maxLedger}`),
      row(d, 'Memo', memoText),
      tx.soroban && row(d, 'Resource fee', stroops(tx.soroban.resourceFee)),
    ]),
    d.h('h2', {}, tx.operations.length === 1 ? '1 operation' : `${tx.operations.length} operations`),
    d.h('ol', { class: 'ops' }, ...tx.operations.map((op, i) => operation(d, op, i))),
    tx.soroban && tx.soroban.readWrite.length > 0
      ? d.h('details', {}, d.h('summary', {}, 'Ledger entries it may change'), d.h('ul', {}, ...tx.soroban.readWrite.map((k) => ledgerKey(d, k))))
      : d.h('span'),
  ];
}

/**
 * The Stellar transaction's notices, shown above the details: the account-control banner and each operation's warning
 * (D110), extra preconditions, a fee-bump.
 */
function stellarAlerts(d: Dom, env: DecodedStellarEnvelope): Alerts {
  const ops = env.tx.operations;
  return {
    banners: ops.some((op) => stellarAccountControl(op).length > 0) ? [risk(0, 'danger takeover banner', [ACCOUNT_CONTROL_BANNER], ['Changes who controls a Stellar account'])] : [],
    // A bullet that says more than its step's line (the user's own key set to 0) stays even when that line is in view.
    dangers: ops.flatMap((op, step) => accountControlItems(op).map((c) => ({ ...risk(0, 'danger takeover', [c.full], c.short), ...(c.keep ? {} : { step }) }))),
    warnings: env.tx.otherPreconditions ? [risk(5, 'warn', ['This transaction has extra preconditions (sequence or signer rules).'], ['Has extra preconditions'])] : [],
  };
}

/** The account-control warnings' bullet forms (D814), one per line of accountControlWarnings, in the same order. */
export function accountControlShorts(op: StellarOperation): Child[][] {
  return accountControlItems(op).map((c) => c.short);
}

function envelopeBody(d: Dom, passphrase: string, env: DecodedStellarEnvelope): HTMLElement[] {
  if (env.envelope === 'fee_bump') {
    return [
      facts(d, [row(d, 'Fee paid by', mono(d, env.feeSource)), row(d, 'Fee-bump fee', stroops(env.fee))]),
      d.h('h2', {}, 'Inner transaction'),
      ...stellarTx(d, passphrase, env.tx),
    ];
  }
  return stellarTx(d, passphrase, env.tx);
}

// ---- EVM ----

function abiValue(d: Dom, v: AbiValue): HTMLElement {
  switch (v.kind) {
    case 'uint':
    case 'int':
      return mono(d, `${v.value} (${v.type})`);
    case 'address':
      return mono(d, v.value);
    case 'bool':
      return mono(d, String(v.value));
    case 'bytes':
      return mono(d, `${v.type} ${v.value}`);
    case 'string':
      return v.value === null ? mono(d, `string (shown as hex) ${v.hex}`) : d.h('span', {}, `"${v.value}"`);
    case 'array':
    case 'tuple':
      return d.h('ol', { class: 'tree' }, ...v.items.map((i) => d.h('li', {}, abiValue(d, i))));
  }
}

/** A call's data in the details: the function and its arguments, or the raw bytes of one Journear doesn't know. */
function evmCallData(d: Dom, c: Pick<DecodedEvmCallSite, 'data' | 'selector' | 'call'>): HTMLElement[] {
  if (c.call) {
    return [
      d.h('p', {}, 'Function ', d.h('strong', {}, c.call.signature), ' ', mono(d, c.call.selector)),
      ...(c.call.args.length > 0 ? [d.h('ol', { class: 'args' }, ...c.call.args.map((a) => d.h('li', {}, abiValue(d, a))))] : []),
    ];
  }
  // The summary says Journear doesn't know the function; the bytes are here.
  if (c.data !== '0x') return [d.h('p', {}, c.selector ? `Unknown function ${c.selector}. Its raw data:` : 'Raw data:'), mono(d, c.data)];
  return [];
}

function evmTx(d: Dom, chainId: number, tx: DecodedEvmTx): HTMLElement[] {
  const fees =
    tx.type === 'eip1559'
      ? [row(d, 'Max fee per gas', gwei(tx.maxFeePerGas)), row(d, 'Priority fee per gas', gwei(tx.maxPriorityFeePerGas))]
      : [row(d, 'Gas price', gwei(tx.gasPrice))];
  const data: Child[] = [];
  if (tx.to === null) data.push(d.h('p', {}, 'Creates a contract from this code:'), mono(d, tx.data));
  else data.push(...evmCallData(d, tx));
  return [
    facts(d, [
      row(d, 'Chain ID', String(chainId)),
      row(d, 'To', tx.to === null ? 'New contract' : mono(d, tx.to)),
      row(d, 'Value', wei(tx.value)),
      row(d, 'Gas limit', String(tx.gasLimit)),
      ...fees,
      row(d, 'Maximum network fee', wei(tx.maxFeeWei)),
      row(d, 'Nonce', String(tx.nonce)),
      tx.type === 'eip1559' && tx.accessList.length > 0 && row(d, 'Access list', `${tx.accessList.length} entries`),
    ]),
    ...(data.filter(Boolean) as HTMLElement[]),
  ];
}

// ---- sponsored EVM actions (D831, D850) ----

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * A sponsored batch's deadline (unix seconds) in the user's own time: "14:05", with its date when it isn't today
 * (`nowMs`), and the raw value. Out of the Date range: the raw value only.
 */
export function validUntil(deadline: bigint, nowMs?: number): string {
  if (deadline > 8_640_000_000_000n) return `${deadline} (unix seconds)`;
  const t = new Date(Number(deadline) * 1000);
  const now = nowMs === undefined ? null : new Date(nowMs);
  const today = now !== null && now.getFullYear() === t.getFullYear() && now.getMonth() === t.getMonth() && now.getDate() === t.getDate();
  const day = today ? '' : ` on ${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}${day} (your time; unix ${deadline})`;
}

/**
 * A sponsored action's details: the request's own facts (chain, account, the account helper it uses or sets up, the
 * relayer that pays, until when it can run, its nonce and gas floor), then every call as an EVM transaction's details
 * show one. EIP-7702 is named only here, folded (D831).
 */
function sponsoredDetails(d: Dom, decoded: Extract<DecodedApproval, { kind: 'evm_sponsored' }>, nowMs: number | undefined): HTMLElement[] {
  const s = decoded.subject;
  const helper = `${BRAND.product} account helper v${decoded.helperVersion}`;
  return [
    d.h('h3', {}, `EVM action, network fee paid by ${BRAND.company}`),
    facts(d, [
      row(d, 'Chain ID', String(decoded.chainId)),
      row(d, 'From', mono(d, s.account)),
      s.authNonce !== null
        ? row(d, 'Account setup (EIP-7702)', 'account helper ', mono(d, s.delegate), ` ✓ ${helper}, chain ${decoded.chainId}, account nonce ${s.authNonce}`)
        : row(d, 'Account helper (EIP-7702)', mono(d, s.delegate), ` ✓ ${helper} (no setup in this approval)`),
      row(d, 'Paid by', `${BRAND.company}’s relayer `, mono(d, s.relayer)),
      row(d, 'Valid until', validUntil(s.deadline, nowMs)),
      row(d, 'Action nonce', String(s.executeNonce)),
      row(d, 'Gas floor', `${s.minGas} gas`),
    ]),
    d.h('h2', {}, decoded.calls.length === 1 ? '1 call' : `${decoded.calls.length} calls`),
    d.h(
      'ol',
      { class: 'ops' },
      ...decoded.calls.map((c, i) => d.h('li', { class: 'op' }, d.h('h3', {}, `${i + 1}. Call`), facts(d, [row(d, 'To', mono(d, c.to)), row(d, 'Value', wei(c.value))]), ...evmCallData(d, c))),
    ),
  ];
}

function typedNode(d: Dom, n: TypedDataNode): HTMLElement {
  if ('children' in n) return d.h('li', {}, d.h('span', {}, `${n.name} (${n.type})`), d.h('ul', { class: 'tree' }, ...n.children.map((c) => typedNode(d, c))));
  return d.h('li', {}, `${n.name} (${n.type}): `, n.value === null ? mono(d, `shown as hex ${n.hex ?? ''}`) : mono(d, n.value));
}

function message(d: Dom, m: DecodedMessage): HTMLElement[] {
  return m.text === null
    ? [warnLine(d, 'warn', 'This message is not plain text, so it is shown as hex.'), mono(d, m.hex)]
    : [d.h('pre', { class: 'message' }, m.text)];
}

// ---- NEAR (D723) ----

/**
 * The account-control banner for NEAR (D723, D110's rule): shown on every AddKey, DeleteKey, DeleteAccount,
 * DeployContract and UseGlobalContract of the user's own transaction or delegate action, in the popup's strongest
 * style. No auto-approve policy covers any NEAR request.
 */
export const NEAR_ACCOUNT_CONTROL_BANNER =
  `Danger: this changes who controls a NEAR account. Whoever gets control can take everything in it, and ${BRAND.product} can’t undo it. Approve only if you started this change yourself; an app should almost never need it.`;

/** A delegate action (NEP-366) names no network; a relayer pays its fee. */
export const NEAR_DELEGATE_NOTES = {
  relayer:
    'A relayer sends this for you: it pays the network fee and any NEAR this attaches or sends (if an action fails, that NEAR is refunded to your account). The actions run as your account: a contract they call acts in your name and can move tokens you hold with it.',
  network: 'This authorization doesn’t name a network: it is valid on any NEAR network where your account has this key.',
} as const;

/** NEP-413's guidance: the recipient, prominently, and what the signature proves. */
export const nearMessageWarning = (recipient: string): string => `This proves to ${recipient} that you control this NEAR account. Sign only if you are signing in to ${recipient}.`;

/** The danger lines of one account-control action (`receiver` is the account it acts on, `me` the user's). */
export function nearControlWarnings(a: NearAction, receiver: string, me: string): string[] {
  const own = receiver === me;
  const where = own ? 'your account' : receiver;
  switch (a.type) {
    case 'addKey':
      return a.accessKey.permission.type === 'fullAccess'
        ? [`This adds a full-access key to ${where}. Whoever holds ${nearKeyText(a.publicKey)} can move all its NEAR and tokens and lock you out.`]
        : [`This adds a key to ${where} that can call ${a.accessKey.permission.methodNames.length === 0 ? 'any method' : 'some methods'} of ${a.accessKey.permission.receiverId} and spend NEAR on their fees.`];
    case 'deleteKey':
      return own && a.publicKey.type === 'ed25519' && toHex(a.publicKey.bytes) === me
        ? [`This removes your ${BRAND.product} key from your account: ${BRAND.product} can no longer sign for it, so you lose control of it.`]
        : [`This removes key ${nearKeyText(a.publicKey)} from ${where}.`];
    case 'deleteAccount':
      return [`This deletes ${where} and sends all of its NEAR to ${a.beneficiaryId}. It can’t be undone.`];
    case 'deployContract':
      return [`This deploys a contract to ${where}. A contract runs with the account’s own authority: it can move everything in it.`];
    case 'useGlobalContract':
      return [`This sets ${where}’s contract to a global contract. A contract runs with the account’s own authority: it can move everything in it.`];
    default:
      return [];
  }
}

/**
 * The red warnings of actions that don't change who controls the account but can still cost it dearly: a call to a
 * contract on the user's own account (it runs with the account's full authority), and publishing a global contract
 * (its NEAR is burnt).
 */
export function nearCostWarnings(a: NearAction, receiver: string, me: string): string[] {
  switch (a.type) {
    case 'functionCall':
      return receiver === me ? ['This calls a contract on your own account. A contract there runs with your account’s full authority: it can move everything in it.'] : [];
    case 'deployGlobalContract':
      return [`This publishes a global contract and burns ${nearDisplay(nearGlobalContractBurn(a.code.length))} from ${receiver === me ? 'your account' : receiver} (0.0001 NEAR per byte of code). Burnt NEAR is gone for good.`];
    default:
      return [];
  }
}

/** The line over a box that holds more than it shows (markOverflowing). */
export const overflowNote = (n: number): string => `This box holds more than it shows (${n} characters): scroll through all of it before you approve.`;

/** All of `text`, always (never cut), in the popup's scrolling box; markOverflowing flags it when it overflows. */
function longText(d: Dom, text: string, cls: string): HTMLElement {
  return d.h('pre', { class: cls }, text);
}

/**
 * After layout: every `pre.message` box whose content is taller than the box (scrollHeight > clientHeight) gets the
 * `overflows` class (an always-visible scrollbar and a stronger border, auth.css) and a warning line above it. Decided
 * by what the box shows, not by length: 20 short JSON keys overflow, 1,000 characters on one wrapped line may not.
 * Shared by every request kind (Stellar and EVM messages use the same box). Idempotent; call again after a resize.
 */
export function markOverflowing(root: ParentNode): void {
  for (const box of Array.from(root.querySelectorAll<HTMLElement>('pre.message'))) markOne(box);
}

/**
 * Keeps the mark right as the boxes change size (a width change reflows the text without any resize event): one
 * ResizeObserver over every `pre.message` under `root`, or, where the browser has none, the window's resize event.
 * Returns a function that stops watching.
 */
export function watchOverflowing(root: ParentNode, win: { ResizeObserver?: typeof ResizeObserver; addEventListener(t: 'resize', l: () => void): void; removeEventListener(t: 'resize', l: () => void): void }): () => void {
  markOverflowing(root);
  // A box inside closed details measures zero: measure again whenever the details open or close (D808). `toggle`
  // doesn't bubble, so it is caught on the way down.
  const onToggle = () => markOverflowing(root);
  root.addEventListener('toggle', onToggle, true);
  const RO = win.ResizeObserver;
  if (typeof RO === 'function') {
    const ro = new RO((entries) => {
      for (const e of entries) markOne(e.target as HTMLElement);
    });
    for (const box of Array.from(root.querySelectorAll<HTMLElement>('pre.message'))) ro.observe(box);
    return () => {
      ro.disconnect();
      root.removeEventListener('toggle', onToggle, true);
    };
  }
  const onResize = () => markOverflowing(root);
  win.addEventListener('resize', onResize);
  return () => {
    win.removeEventListener('resize', onResize);
    root.removeEventListener('toggle', onToggle, true);
  };
}

function markOne(box: HTMLElement): void {
  const over = box.scrollHeight > box.clientHeight + 1;
  const note = box.previousElementSibling?.classList.contains('overflow-note') ? (box.previousElementSibling as HTMLElement) : null;
  box.classList.toggle('overflows', over);
  if (over && !note) {
    box.before(alert(dom(box.ownerDocument), 'warning', { class: 'warn overflow-note', attrs: { role: 'note' } }, overflowNote(box.textContent?.length ?? 0)));
  } else if (!over && note) note.remove();
}

function nearArgs(d: Dom, args: Uint8Array): HTMLElement {
  const v = nearArgsView(args);
  if (v.kind === 'empty') return d.h('p', { class: 'muted' }, 'No arguments');
  if (v.kind === 'json') return d.h('div', { class: 'args' }, d.h('p', {}, `Arguments (JSON, ${v.length} bytes)`), longText(d, v.text, 'message mono'));
  return d.h('div', { class: 'args' }, warnLine(d, 'warn', `Arguments (not JSON, shown as hex, ${v.length} bytes)`), longText(d, v.hex, 'message mono'));
}

function nearMethod(d: Dom, name: string): HTMLElement {
  const m = nearMethodName(name);
  return m.text === null ? mono(d, `(shown as hex) ${m.hex}`) : d.h('strong', {}, m.text);
}

function nearPermission(d: Dom, p: Extract<NearAction, { type: 'addKey' }>['accessKey']['permission']): HTMLElement {
  if (p.type === 'fullAccess') return d.h('span', { class: 'danger' }, 'Full access');
  return d.h(
    'span',
    {},
    'Can call ',
    p.methodNames.length === 0 ? 'any method' : d.h('span', {}, ...p.methodNames.flatMap((n, i) => [i > 0 ? ', ' : '', nearMethod(d, n)])),
    ' on ',
    mono(d, p.receiverId),
    `, fee allowance ${p.allowance === null ? 'unlimited' : formatNear(p.allowance)}`,
  );
}

function nearActionBody(d: Dom, a: NearAction, receiver: string, me: string, nested: boolean): Child[] {
  switch (a.type) {
    case 'createAccount':
      return [d.h('p', {}, 'Creates the account ', mono(d, receiver))];
    case 'deployContract':
      return [facts(d, [row(d, 'Deploys a contract to', mono(d, receiver)), row(d, 'Code', `${a.code.length} bytes, hash ${nearCodeHash(a.code)}`)])];
    case 'functionCall':
      return [
        facts(d, [row(d, 'Calls', nearMethod(d, a.methodName), ' on ', mono(d, receiver)), row(d, 'Attached deposit', formatNear(a.deposit)), row(d, 'Gas', formatGas(a.gas))]),
        nearArgs(d, a.args),
      ];
    case 'transfer':
      return [facts(d, [row(d, 'Sends', formatNear(a.deposit)), row(d, 'To', mono(d, receiver))])];
    case 'stake':
      return [facts(d, [row(d, 'Stakes (locks)', formatNear(a.stake)), row(d, 'Validator key', mono(d, nearKeyText(a.publicKey)))])];
    case 'addKey':
      return [facts(d, [row(d, 'Adds key', mono(d, nearKeyText(a.publicKey))), row(d, 'To account', mono(d, receiver)), row(d, 'Permission', nearPermission(d, a.accessKey.permission))])];
    case 'deleteKey':
      return [facts(d, [row(d, 'Removes key', mono(d, nearKeyText(a.publicKey))), row(d, 'From account', mono(d, receiver))])];
    case 'deleteAccount':
      return [facts(d, [row(d, 'Deletes the account', mono(d, receiver)), row(d, 'Sends all its NEAR to', mono(d, a.beneficiaryId))])];
    case 'delegate': {
      const inner = a.signedDelegate.delegateAction;
      return [
        warnLine(d, 'warn', 'Relays a meta transaction signed by ', mono(d, inner.senderId), ': your account pays its network fee.'),
        facts(d, [row(d, 'Sender', mono(d, inner.senderId)), row(d, 'Receiver', mono(d, inner.receiverId)), row(d, 'Valid until block', String(inner.maxBlockHeight))]),
        nested ? null : nearActionList(d, inner.actions, inner.receiverId, inner.senderId, true),
      ];
    }
    case 'deployGlobalContract':
      return [facts(d, [row(d, 'Publishes a global contract', a.deployMode === 'codeHash' ? 'identified by its code hash' : `identified by the account ${receiver}`), row(d, 'Code', `${a.code.length} bytes, hash ${nearCodeHash(a.code)}`)])];
    case 'useGlobalContract':
      return [facts(d, [row(d, 'Sets the contract of', mono(d, receiver)), row(d, 'To the global contract', a.contract.type === 'codeHash' ? mono(d, nearHash58(a.contract.hash)) : mono(d, a.contract.accountId))])];
  }
}

const NEAR_ACTION_NAMES: Readonly<Record<NearAction['type'], string>> = {
  createAccount: 'Create account',
  deployContract: 'Deploy contract',
  functionCall: 'Call a contract',
  transfer: 'Send NEAR',
  stake: 'Stake',
  addKey: 'Add key',
  deleteKey: 'Remove key',
  deleteAccount: 'Delete account',
  delegate: 'Relay a meta transaction',
  deployGlobalContract: 'Publish global contract',
  useGlobalContract: 'Use global contract',
};

/**
 * The actions of a transaction or delegate action on `receiver`, signed by `me`. `nested`: the actions of a delegate
 * action the user's transaction relays (they act on its sender's account, so they carry no warning for the user).
 */
function nearActionList(d: Dom, actions: readonly NearAction[], receiver: string, me: string, nested: boolean): HTMLElement {
  return d.h(
    'div',
    nested ? { class: 'sub' } : {},
    d.h(nested ? 'p' : 'h2', nested ? { class: 'muted' } : {}, actions.length === 1 ? '1 action' : `${actions.length} actions`),
    d.h(
      'ol',
      { class: 'ops' },
      ...actions.map((a, i) => {
        // Its warnings are shown above the details (nearAlerts); the frame marks the action here.
        const warned = !nested && nearControlWarnings(a, receiver, me).length + nearCostWarnings(a, receiver, me).length > 0;
        return d.h(
          'li',
          { class: warned ? 'op takeover-op' : 'op' },
          d.h('h3', {}, `${i + 1}. ${NEAR_ACTION_NAMES[a.type]}`),
          ...nearActionBody(d, a, receiver, me, nested),
        );
      }),
    ),
  );
}

/** The bullet form of an action's control warning (D814). */
/** Whether an action removes the user's own Journear Passport key from their account. */
function ownKeyRemoval(a: NearAction, receiver: string, me: string): boolean {
  return a.type === 'deleteKey' && receiver === me && a.publicKey.type === 'ed25519' && toHex(a.publicKey.bytes) === me;
}

function nearControlShort(a: NearAction, receiver: string, me: string): Child[] {
  const where = receiver === me ? 'your account' : receiver;
  switch (a.type) {
    case 'addKey':
      return a.accessKey.permission.type === 'fullAccess' ? ['Adds a full-access key (', nearKeyText(a.publicKey), ')'] : ['Adds a key (', nearKeyText(a.publicKey), ') that can use ', a.accessKey.permission.receiverId];
    case 'deleteKey':
      return ownKeyRemoval(a, receiver, me) ? [`Removes your ${BRAND.product} key`] : ['Removes key ', nearKeyText(a.publicKey)];
    case 'deleteAccount':
      return [`Deletes ${where} and sends all its NEAR to `, a.beneficiaryId];
    case 'deployContract':
      return [`Deploys a contract to ${where}`];
    case 'useGlobalContract':
      return [`Sets ${where}’s contract`];
    default:
      return [];
  }
}

/** The bullet form of an action's cost warning (D814). */
function nearCostShort(a: NearAction, receiver: string, me: string): Child[] {
  if (a.type === 'deployGlobalContract') return [`Burns ${nearDisplay(nearGlobalContractBurn(a.code.length))}`];
  return receiver === me ? ['Calls a contract on your own account'] : [];
}

/** The NEAR leaving the account: deposits (and stake), and whether a DeleteAccount sends everything. */
/** A transaction's NEAR: deposits and transfers leave the signer's account; Stake locks, a global contract burns. */
/** The total line when the actions call a contract on the user's own account: what that contract moves is its call. */
export const NEAR_OWN_CONTRACT_TOTAL = 'Unknown: the contract on your account decides';

function nearTotal(d: Dom, actions: readonly NearAction[], receiver: string, me: string): HTMLElement {
  const t = nearDeposits(actions);
  const leaving = t.total + t.burned;
  const own = nearCallsOwnContract(actions, receiver, me);
  return facts(d, [
    row(
      d,
      'NEAR leaving your account',
      t.deletesAccount ? d.h('strong', { class: 'danger' }, 'All of it (the account is deleted)') : own ? d.h('strong', { class: 'danger' }, NEAR_OWN_CONTRACT_TOTAL) : d.h('strong', {}, nearDisplay(leaving)),
      ' (plus the network fee for gas)',
    ),
    own && leaving > 0n && row(d, 'NEAR attached or sent', nearDisplay(leaving)),
    t.burned > 0n && row(d, 'NEAR burnt', d.h('strong', { class: 'danger' }, nearDisplay(t.burned)), ' (publishing a global contract)'),
    t.staked > 0n && row(d, 'NEAR staked (locked)', nearDisplay(t.staked)),
  ]);
}

/**
 * A delegate action's NEAR (nearcore): the relayer's transaction prepays every deposit and transfer in it, which go
 * to their receivers on success and back to the user's account (the receipt's predecessor) on failure; gas is the
 * relayer's. What the user's own balance loses is only what acts on the user's account itself: a DeleteAccount
 * (everything), Stake (locked) and a global contract's burn.
 */
/** A delegate action's total when it takes none of the user's NEAR. */
export const NEAR_DELEGATE_NONE = 'None of your NEAR (the relayer pays the fee and the NEAR attached). Tokens the calls move are yours.';

function nearDelegateTotal(d: Dom, actions: readonly NearAction[], receiver: string, me: string): HTMLElement {
  const t = nearDeposits(actions);
  const own = nearCallsOwnContract(actions, receiver, me);
  const leaving = t.deletesAccount
    ? d.h('strong', { class: 'danger' }, 'All of it (the account is deleted)')
    : own
      ? d.h('strong', { class: 'danger' }, NEAR_OWN_CONTRACT_TOTAL)
      : t.burned > 0n
        ? d.h('strong', {}, nearDisplay(t.burned))
        : d.h('strong', {}, NEAR_DELEGATE_NONE);
  return facts(d, [
    row(d, 'NEAR leaving your account', leaving),
    t.total > 0n && row(d, 'NEAR this sends, paid by the relayer', nearDisplay(t.total)),
    t.burned > 0n && row(d, 'NEAR burnt', d.h('strong', { class: 'danger' }, nearDisplay(t.burned)), ' (publishing a global contract)'),
    t.staked > 0n && row(d, 'NEAR staked (locked)', nearDisplay(t.staked)),
  ]);
}

const NEAR_NETWORK_NAMES = { testnet: 'NEAR testnet', mainnet: 'NEAR mainnet' } as const;

/** What the popup knows about the network a NEAR request names (D726). */
export interface NearRenderContext {
  /** This build's env network: the one the vault checks NEAR requests against (its RPC). */
  readonly envNetwork: 'testnet' | 'mainnet';
  /** A pk_test_ app: the vault binds its delegate actions to the env network too. */
  readonly testApp: boolean;
  /** The partner page's origin, as the vault pinned it (a NEP-413 recipient is compared with its host). */
  readonly parentOrigin?: string;
}

/**
 * The network line of a NEAR request (D726). NEAR's bytes name no network, so the popup says what the vault checked:
 * a transaction on the env's network had its block hash found there (the vault refuses it otherwise, failing closed);
 * a test app's delegate action had its key, nonce and expiry checked there; anything else is the app's claim.
 */
export function nearNetworkLine(kind: 'near_tx' | 'near_delegate', network: 'testnet' | 'mainnet', ctx: NearRenderContext): string {
  const name = NEAR_NETWORK_NAMES[network];
  if (network === ctx.envNetwork && kind === 'near_tx') return `${name} (${BRAND.company} found its block hash on ${network})`;
  if (network === ctx.envNetwork && ctx.testApp) return `${name} (${BRAND.company} checked your key, nonce and expiry on ${network})`;
  return `${name}, as the app says: ${BRAND.company} can’t check this`;
}

/** A NEAR request's notices, shown above the details: the account-control banner and each action's red line (D723). */
function nearAlerts(d: Dom, actions: readonly NearAction[], receiver: string, me: string): Alerts {
  return {
    banners: nearChangesControl(actions, receiver, me) ? [risk(0, 'danger takeover banner', [NEAR_ACCOUNT_CONTROL_BANNER], ['Changes who controls a NEAR account'])] : [],
    dangers: actions.flatMap((a, i) => {
      // Removing the user's own Journear Passport key: the line names the key but not whose it is, so the bullet stays.
      const step = ownKeyRemoval(a, receiver, me) ? undefined : i;
      return [
        ...nearControlWarnings(a, receiver, me).map((w) => ({ ...risk(0, 'danger takeover', [w], nearControlShort(a, receiver, me)), step })),
        ...nearCostWarnings(a, receiver, me).map((w) => risk(3, 'danger takeover', [w], nearCostShort(a, receiver, me))),
      ];
    }),
    warnings: [],
  };
}

function nearTx(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_tx' }>, ctx: NearRenderContext): Parts {
  const tx = decoded.tx;
  return {
    alerts: nearAlerts(d, tx.actions, tx.receiverId, tx.signerId),
    network: nearNetworkLine('near_tx', decoded.network, ctx),
    visible: [nearTotal(d, tx.actions, tx.receiverId, tx.signerId)],
    details: [
      d.h('h3', {}, 'NEAR transaction'),
      facts(d, [
        row(d, 'Network', nearNetworkLine('near_tx', decoded.network, ctx)),
        row(d, 'From', mono(d, tx.signerId)),
        row(d, 'To', mono(d, tx.receiverId)),
        row(d, 'Nonce', mono(d, String(tx.nonce))),
        row(d, 'Block hash', mono(d, nearHash58(tx.blockHash))),
        row(d, 'Transaction hash', mono(d, decoded.hash)),
      ]),
      nearActionList(d, tx.actions, tx.receiverId, tx.signerId, false),
    ],
  };
}

function nearDelegate(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_delegate' }>, ctx: NearRenderContext): Parts {
  const da = decoded.delegate;
  return {
    alerts: nearAlerts(d, da.actions, da.receiverId, da.senderId),
    network: nearNetworkLine('near_delegate', decoded.network, ctx),
    visible: [nearDelegateTotal(d, da.actions, da.receiverId, da.senderId), noteLine(d, 'note', NEAR_DELEGATE_NOTES.relayer), noteLine(d, 'note', NEAR_DELEGATE_NOTES.network)],
    details: [
      d.h('h3', {}, 'NEAR transaction, fee paid by a relayer'),
      facts(d, [
        row(d, 'Network', nearNetworkLine('near_delegate', decoded.network, ctx)),
        row(d, 'From', mono(d, da.senderId)),
        row(d, 'To', mono(d, da.receiverId)),
        row(d, 'Valid until block', String(da.maxBlockHeight)),
        row(d, 'Nonce', mono(d, String(da.nonce))),
      ]),
      nearActionList(d, da.actions, da.receiverId, da.senderId, false),
    ],
  };
}

/** The page's host (`https://app.example:8443` → `app.example`), or null for a value that isn't an origin. */
function originHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/** A NEP-413 recipient that isn't the requesting page: whoever holds the signature can use it as proof at `recipient`. */
export const nearRecipientMismatch = (recipient: string, host: string): string =>
  `This app is at ${host}, but the signature is for ${recipient}. Sign only if you are signing in to ${recipient} on purpose.`;

/** A recipient with characters outside printable ASCII, which can imitate another name, written with \u escapes. */
export const nearRecipientLookalike = (escaped: string): string => `The recipient has characters that can imitate another name. Written out: ${escaped}`;

const asciiEscaped = (s: string): string => Array.from(s, (ch) => (/^[\x20-\x7e]$/u.test(ch) ? ch : Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''))).join('');

function nearMessage(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_message' }>, ctx: NearRenderContext): Parts {
  const p = decoded.payload;
  const host = originHost(ctx.parentOrigin);
  const sameSite = host !== null && (p.recipient === host || p.recipient === ctx.parentOrigin);
  const lookalike = /[^\x20-\x7e]/u.test(p.recipient);
  return {
    alerts: {
      banners: [],
      dangers: lookalike ? [risk(5, 'danger lookalike', [nearRecipientLookalike(asciiEscaped(p.recipient))], ['The recipient has characters that imitate another name'])] : [],
      warnings: [
        risk(4, 'warn nep413', [nearMessageWarning(p.recipient)], ['Proves to ', p.recipient, ' that you control this account']),
        // Any recipient that isn't exactly this page's host or origin, whatever its shape (a page picks the recipient, so
        // no shape may soften this): one factual line in the warning style.
        ...(host !== null && !sameSite ? [risk(3, 'warn recipient-mismatch', [nearRecipientMismatch(p.recipient, host)], ['For ', p.recipient, ', not this app’s ', host])] : []),
      ],
    },
    network: null,
    visible: [facts(d, [row(d, 'For', d.h('strong', {}, p.recipient)), p.callbackUrl !== null && row(d, 'Then returns to', mono(d, p.callbackUrl))]), noteLine(d, 'note', NO_NETWORK_NOTE), ...message(d, decoded.message)],
    details: [d.h('h3', {}, 'Sign in with your NEAR account'), facts(d, [row(d, 'Recipient', mono(d, p.recipient)), row(d, 'Nonce', mono(d, toHex(p.nonce)))])],
  };
}


/**
 * Shown on message and raw requests: their approval binds no network (an empty context in the approval digest; user
 * decision 2026-10-28, docs/decisions.md). Typed data shows its domain's chain instead.
 */
export const NO_NETWORK_NOTE = 'This signature isn’t tied to one network.';

/** The confirm and sign pattern's headline (D765): what a plain transfer sends, in one number and its unit. */
export interface AmountHeadline {
  readonly value: string;
  readonly unit: string;
}

/**
 * The amount to put first, or null. Only where one number says what the request sends and nothing else moves value:
 * an EVM transfer with no call data on a chain Journear names; a Stellar transaction of one native XLM payment or one
 * account creation (no operation source of its own); a NEAR transaction of transfers only. Never for a contract call, whose
 * native value says nothing about the tokens it moves, nor a message, typed data or an authorization. It repeats a
 * fact the rows show (the same decoded value), never replaces one.
 */
export function amountHeadline(decoded: DecodedApproval): AmountHeadline | null {
  switch (decoded.kind) {
    case 'evm_tx': {
      const { tx } = decoded;
      const info = evmChainInfo(decoded.chainId);
      return tx.to !== null && tx.data === '0x' && info ? { value: displayUnits(tx.value, 18), unit: info.nativeSymbol } : null;
    }
    case 'stellar_tx': {
      const ops = decoded.envelope.tx.operations;
      const op = ops.length === 1 ? ops[0] : undefined;
      if (!op || op.source) return null;
      if (op.type === 'createAccount') return { value: displayUnits(BigInt(op.startingBalance), 7), unit: 'XLM' };
      // Native XLM only. A credit asset's code is chosen by its issuer, so any account can issue "USDC" or even
      // "XLM": a bare code in the headline would vouch for an asset the popup can't verify. The rows show it in full,
      // code and issuer, as before.
      return op.type === 'payment' && op.asset === 'native' ? { value: displayUnits(BigInt(op.amount), 7), unit: 'XLM' } : null;
    }
    case 'near_tx': {
      const actions = decoded.tx.actions;
      if (actions.length === 0 || !actions.every((a) => a.type === 'transfer')) return null;
      return { value: displayUnits(nearDeposits(actions).total, 24), unit: 'NEAR' };
    }
    default:
      return null;
  }
}

/** The headline's markup: "Sends", then the number in the system's large figure with its unit beside it. */
function amountView(d: Dom, a: AmountHeadline): HTMLElement {
  return d.h('div', { class: 'headline' }, d.h('p', { class: 'headline-label' }, 'Sends'), d.h('p', { class: 'amt amount' }, d.h('span', { class: 'amt-value' }, a.value), d.h('small', {}, a.unit)));
}

/**
 * One notice of a request (D814): its rank in its box (0 the most serious), the page's classes for it, its full text
 * (the box's lead) and its bullet (one short line, when another item leads).
 */
interface RiskItem {
  readonly rank: number;
  readonly cls: string;
  readonly full: readonly Child[];
  readonly short: readonly Child[];
  /** For a control change's line: its step (operation or action index), dropped when that step's own line is in view. */
  readonly step?: number;
}

const risk = (rank: number, cls: string, full: readonly Child[], short: readonly Child[]): RiskItem => ({ rank, cls, full, short: short.length > 0 ? short : full });

/** The notices of a request: banners, red lines, amber lines. */
interface Alerts {
  readonly banners: readonly RiskItem[];
  readonly dangers: readonly RiskItem[];
  readonly warnings: readonly RiskItem[];
}

/** One request kind's screen: its notices, its network line (NEAR's, D726), what stays visible and what folds. */
interface Parts {
  readonly alerts: Alerts;
  readonly network: string | null;
  readonly visible: readonly HTMLElement[];
  readonly details: readonly HTMLElement[];
}

const NO_ALERTS: Alerts = { banners: [], dangers: [], warnings: [] };

/** A summary text as nodes: the app's name in bold (bidi-isolated by the page's CSS), codes in mono, all text. */
function summaryNodes(d: Dom, t: SummaryText, appName: string): Child[] {
  return t.map((p) => (typeof p === 'string' ? p : p.kind === 'app' ? d.h('strong', { class: 'app-name' }, appName) : p.kind === 'code' ? mono(d, p.text) : d.h('strong', {}, p.text)));
}

/** Ranks in the boxes (D814): control, unreadable, unlimited spend, own-contract or burn, left-out steps, the rest. */
const RED_RANK: Partial<Record<SummaryWarning['code'], number>> = { raw_signing: 1, cannot_explain: 1, summary_failed: 1, unlimited_spend: 2, collection_operator: 2, permit_lookalike: 2, steps_not_listed: 4 };
const AMBER_RANK: Partial<Record<SummaryWarning['code'], number>> = { cannot_explain: 1, contract_creation: 1, steps_not_listed: 2, spend_permission: 3, may_move_tokens: 3, sign_in_mismatch: 4, account_setup: 4 };

/** A warning of the summary as a box item, classes keyed on its code. */
function summaryItem(d: Dom, w: SummaryWarning, appName: string): RiskItem {
  const cls = `summary-warning ${w.code.replace(/_/gu, '-')} ${w.level === 'danger' ? 'danger takeover' : 'warn'}`;
  const rank = (w.level === 'danger' ? RED_RANK : AMBER_RANK)[w.code] ?? 5;
  return risk(rank, cls, summaryNodes(d, w.text, appName), w.short ? summaryNodes(d, w.short, appName) : []);
}

/**
 * At most one box per colour (D814): the most serious item in full, then every other item as one short bullet, the
 * same bullet said once with its count. No item is dropped. Red boxes are announced (role alert).
 */
function riskBox(d: Dom, tone: 'danger' | 'warning', items: readonly RiskItem[]): HTMLElement | null {
  if (items.length === 0) return null;
  const sorted = items.map((x, i) => ({ x, i })).sort((a, b) => a.x.rank - b.x.rank || a.i - b.i).map((e) => e.x);
  const [lead, ...rest] = sorted as [RiskItem, ...RiskItem[]];
  const bullets: { item: RiskItem; key: string; count: number }[] = [];
  for (const item of rest) {
    // Merged only when their FULL texts are the same: two items whose bullets read alike stay two bullets.
    const key = d.h('span', {}, ...item.full.map((c) => (c instanceof Node ? c.cloneNode(true) : c))).textContent ?? '';
    const same = bullets.find((b) => b.key === key);
    if (same) same.count++;
    else bullets.push({ item, key, count: 1 });
  }
  return alert(
    d,
    tone,
    { tag: 'div', class: `risk-box ${tone === 'danger' ? 'danger-box' : 'warning-box'}`, ...(tone === 'danger' ? { attrs: { role: 'alert' } } : {}) },
    d.h('p', { class: `risk-lead ${lead.cls}` }, ...lead.full),
    bullets.length > 0 ? d.h('ul', { class: 'risk-more' }, ...bullets.map((b) => d.h('li', { class: b.item.cls }, ...b.item.short, b.count > 1 ? ` (${b.count} times)` : ''))) : null,
  );
}

/** The words on the details' toggle. */
export const DETAILS_LABELS = { show: 'Show details', hide: 'Hide details' } as const;

/**
 * The technical details: a native `<details>` the user opens and closes (keyboard and screen readers get its
 * expanded state from the browser). Always folded at first, for every request, raw signing included (the founder's
 * decision, D810): the risks are stated in plain words above it. Nothing a partner controls changes that, and the user
 * can always open it. Opening or closing it never touches the Approve guard: it is ordinary content.
 */
function detailsSection(d: Dom, body: readonly Child[]): HTMLElement {
  const label = d.h('span', { class: 'details-label' }, DETAILS_LABELS.show);
  const el = d.h('details', { class: 'request-details' }, d.h('summary', { class: 'details-toggle' }, label), d.h('div', { class: 'details-body' }, ...body));
  el.addEventListener('toggle', () => {
    label.textContent = el.open ? DETAILS_LABELS.hide : DETAILS_LABELS.show;
  });
  return el;
}

/** Everything the popup knows besides the request: the network context (D726), the user's address, the page's notes. */
export interface ApprovalRenderContext extends NearRenderContext {
  /** The user's address on the request's chain (the vault's), so the summary can say "your account". */
  readonly address?: string;
  /** The page's own notices (the test-app note or the mainnet demo's banner, the out-of-policy line): after the request's. */
  readonly notes?: readonly (HTMLElement | null)[];
  /** First in the details (the Support ID). */
  readonly detailsExtra?: readonly (HTMLElement | null)[];
  /** The page's clock (ms): a sponsored action's "Valid until" names its date when it isn't today. */
  readonly nowMs?: number;
}

function kindParts(d: Dom, decoded: DecodedApproval, appName: string, near: NearRenderContext, nowMs?: number): Parts {
  switch (decoded.kind) {
    case 'stellar_tx': {
      const memo = decoded.envelope.tx.memo;
      return {
        alerts: stellarAlerts(d, decoded.envelope),
        network: null,
        // A memo is how an exchange or a payee tells deposits apart: changing it can send funds to someone else's credit.
        visible: memo.type === 'none' ? [] : [facts(d, [row(d, 'Memo', memo.type === 'text' ? (memo.value === null ? mono(d, `(shown as hex) ${memo.hex}`) : mono(d, memo.value)) : mono(d, memo.type === 'id' ? memo.value : `${memo.type} ${memo.hex}`))])],
        details: [d.h('h3', {}, 'Stellar transaction'), ...envelopeBody(d, decoded.networkPassphrase, decoded.envelope)],
      };
    }
    case 'stellar_auth_entry':
      return {
        alerts: NO_ALERTS,
        network: null,
        visible: [],
        details: [
          d.h('h3', {}, 'Stellar authorization'),
          facts(d, [
            row(d, 'Network', passphraseText(d, decoded.networkPassphrase)),
            row(d, 'Network ID', mono(d, decoded.preimage.networkId)),
            row(d, 'Nonce', mono(d, decoded.preimage.nonce)),
            row(d, 'Valid until ledger', String(decoded.preimage.signatureExpirationLedger)),
          ]),
          invocation(d, decoded.preimage.invocation),
        ],
      };
    case 'stellar_message':
    case 'personal_sign':
      return {
        alerts: NO_ALERTS,
        network: null,
        visible: [noteLine(d, 'note', NO_NETWORK_NOTE), ...message(d, decoded.message)],
        details: [d.h('h3', {}, decoded.kind === 'personal_sign' ? 'Sign a message' : 'Sign a Stellar message'), facts(d, [row(d, 'Size', `${decoded.message.length} bytes`)]), d.h('p', {}, 'The message’s bytes:'), mono(d, decoded.message.hex)],
      };
    case 'evm_tx':
      return { alerts: NO_ALERTS, network: null, visible: [], details: [d.h('h3', {}, 'EVM transaction'), ...evmTx(d, decoded.chainId, decoded.tx)] };
    case 'evm_sponsored':
      // Every risk line is the summary's: the same per-call warnings as an EVM transaction's, and the setup note.
      return { alerts: NO_ALERTS, network: null, visible: [], details: sponsoredDetails(d, decoded, nowMs) };
    case 'eip712':
      return {
        alerts: { banners: [], dangers: [], warnings: decoded.chainId === null ? [risk(5, 'warn no-chain', [TYPED_DATA_NO_CHAIN], ['Isn’t tied to one chain'])] : [] },
        network: null,
        visible: [],
        details: [
          d.h('h3', {}, 'Sign typed data'),
          decoded.chainId === null ? d.h('p', {}, 'No chain ID') : d.h('p', {}, `Chain ID ${decoded.chainId}`),
          d.h('h3', {}, 'Domain'),
          d.h('ul', { class: 'tree' }, ...decoded.view.domain.map((n) => typedNode(d, n))),
          d.h('h3', {}, decoded.view.primaryType),
          d.h('ul', { class: 'tree' }, typedNode(d, decoded.view.message)),
        ],
      };
    case 'raw':
      return {
        // The red risk line is the summary's (raw_signing).
        alerts: NO_ALERTS,
        network: null,
        visible: [noteLine(d, 'note', NO_NETWORK_NOTE)],
        details: [d.h('h3', {}, 'Raw signature'), mono(d, decoded.hex)],
      };
    case 'near_tx':
      return nearTx(d, decoded, near);
    case 'near_delegate':
      return nearDelegate(d, decoded, near);
    case 'near_message':
      return nearMessage(d, decoded, near);
  }
}

/** Typed data whose domain names no chain (D35). */
export const TYPED_DATA_NO_CHAIN = 'This signature isn’t tied to one chain: it may be valid on any of them.';

/** The body of the approval screen for a decoded request. */
export function renderApproval(d: Dom, decoded: DecodedApproval, appName: string, ctx: ApprovalRenderContext = { envNetwork: 'testnet', testApp: false }): HTMLElement {
  const summary: ApprovalSummary = summarizeApproval(decoded, { address: ctx.address ?? '', ...(ctx.parentOrigin ? { parentOrigin: ctx.parentOrigin } : {}) });
  const k = kindParts(d, decoded, appName, ctx, ctx.nowMs);
  // A control change's bullet repeats nothing: when its step's own line is in view (the headline of a single step, or a
  // grouped line, which names the whole key, signer or address), the bullet is dropped. The banner always stays, and
  // steps left out of the lines keep their bullets (the summary's step_left_out).
  const shown = new Set(summary.shownSteps ?? []);
  const dangers = k.alerts.dangers.filter((it) => it.step === undefined || !shown.has(it.step));
  const redBox = riskBox(d, 'danger', [...k.alerts.banners, ...dangers, ...summary.warnings.filter((w) => w.level === 'danger').map((w) => summaryItem(d, w, appName))]);
  const amberBox = riskBox(d, 'warning', [...summary.warnings.filter((w) => w.level === 'warning').map((w) => summaryItem(d, w, appName)), ...k.alerts.warnings]);
  const network = summary.network ? summaryNodes(d, summary.network, appName) : k.network ? [k.network] : null;
  const headline = amountHeadline(decoded);
  const keyFacts = [network && row(d, 'Network', ...network), summary.fee && row(d, 'Network fee', ...summaryNodes(d, summary.fee, appName))];
  return d.h(
    'div',
    { class: 'request jp-confirm', attrs: { 'data-explainable': String(summary.explainable) } },
    d.h('h2', { class: 'summary-headline' }, ...summaryNodes(d, summary.headline, appName)),
    // The red banners and lines right under the headline: nothing a partner sizes (the summary's lines, the number of
    // operations) can push them down (review M2).
    redBox,
    // The amount (the confirm and sign pattern), where there is one to show.
    headline ? amountView(d, headline) : null,
    ...summary.lines.map((l) => d.h('p', { class: 'summary-line' }, ...summaryNodes(d, l, appName))),
    keyFacts.some(Boolean) ? rows(d, keyFacts, 'jp-kv facts summary-facts') : null,
    amberBox,
    ...k.visible,
    ...(ctx.notes ?? []),
    detailsSection(d, [...(ctx.detailsExtra ?? []), ...k.details]),
  );
}
