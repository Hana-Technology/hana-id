// What the approval popup shows for a request (docs/batch-b-spec.md "Approval flow" step 4), rendered from the popup's
// own decode of the request bytes (@hana-id/core/decode), never from a summary the vault sent. Every value is text;
// strings the decoders flag as unsafe to show (control, bidi or invisible characters) are shown as hex.
//
// The layout (D808–D812): a plain summary first (`summarizeApproval`: "{App} wants to …", its lines, the network and
// the most the fee can be), then every warning and danger line, the page's notes, the facts a user decides on (the NEAR
// leaving the account, a NEP-413 recipient, a message's text), and last the technical details in a native
// `<details>` the user can always open ("Show details"). The details always start folded, raw signing included (the
// Tech Lead's decision, D810): a request Journear can't explain states its risk in plain words above them instead.
// Nothing a partner controls decides what is folded.
import { isDisplaySafeLine } from '@hana-id/core';
import { type ApprovalSummary, type IdRole, type SummaryPart, type SummaryText, type SummaryWarning, displayUnits, isLongId, nearDisplay, shortId, summarizeApproval, summaryString } from '@hana-id/core/decode';
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
import { DEMO_CHECK_IN_CALLDATA, EVM_NATIVE_DECIMALS, type NearAction, type ReviewedNearAccounts, evmChainInfo, evmNativeUnits, isDemoCheckInCall, toHex } from '@hana-id/core';
import { BRAND } from '@hana-id/brand';
import type { LabelDocument } from '@hana-id/core/partner-labels';
import { type Child, type Dom, dom, row, rows, withoutEmptyLists } from './dom.ts';
import { LABEL_MISMATCH, LABEL_NOT_LISTED, type LabelOutcome, type WindowLabelFacts, labelBox, labelOutcome } from './render-labels.ts';
import { alert, icon } from './ui.ts';

import { formatUnits } from './format-units.ts';

export { formatUnits };

const stroops = (s: string) => `${formatUnits(s, 7)} XLM (${s} stroops)`;
/**
 * A raw native amount in the details, in the chain's own smallest unit (D922): "1.5 (1500000000000000000 wei)", on
 * Hedera "1.5 (1500000000000000000 weibars)". The units come from `evmNativeUnits`, as the consent screen's do.
 */
const nativeRaw = (chainId: number, v: bigint) => {
  const u = evmNativeUnits(chainId);
  return `${formatUnits(v, u.decimals)} (${v} ${u.smallest})`;
};
/** A gas price: "0.5 gwei"; on a chain whose smallest unit has its own name, raw in that unit ("710000000000 weibars"). */
const gasPrice = (chainId: number, v: bigint) => {
  const g = evmNativeUnits(chainId).gasPrice;
  return `${formatUnits(v, g.decimals)} ${g.name}`;
};

const mono = (d: Dom, text: string) => d.h('code', { class: 'mono' }, text);

/** Unix seconds (decimal) as an ISO date and the raw value, or the raw value alone when out of range; the raw value in mono (D877). */
function unixView(d: Dom, s: string): Child[] {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || n > 8.64e12) return [mono(d, s), ' (unix seconds)'];
  return [`${new Date(n * 1000).toISOString()} (`, mono(d, s), ')'];
}

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
const assetAmount = (d: Dom, s: string, asset: string) => d.h('span', { class: 'mono' }, `${formatUnits(s, 7)} `, mono(d, asset === 'native' ? 'XLM' : asset), ` (${s} stroops)`);
const price = (d: Dom, p: StellarPrice) => mono(d, `${p.n}/${p.d}`);
/** Flag names in words, their bits as an exact number (D877). */
const flags = (d: Dom, bits: number, names: Parameters<typeof stellarFlagNames>[1]): Child[] => (bits === 0 ? ['none'] : [`${stellarFlagNames(bits, names).join(', ')} (`, mono(d, String(bits)), ')']);
const shortText = (d: Dom, t: StellarText) => (t.value === null ? mono(d, `(shown as hex) ${t.hex}`) : t.value === '' ? d.h('span', { class: 'muted' }, '(empty: clears it)') : mono(d, t.value));
const path = (d: Dom, p: readonly string[]) => (p.length === 0 ? 'direct' : d.h('span', {}, ...p.flatMap((a, i) => [i > 0 ? ' → ' : '', mono(d, a)])));
const offer = (d: Dom, id: string, amount: string): Child[] => (id === '0' ? ['new offer'] : [amount === '0' ? 'deletes offer ' : 'changes offer ', mono(d, id)]);

/**
 * The account-control warnings (docs/decisions.md D110): shown on every setOptions signer, threshold or master-weight
 * change and every accountMerge, in the popup's strongest style. No auto-approve policy covers these operations.
 */
export const ACCOUNT_CONTROL_BANNER =
  `Danger: this changes who controls a Stellar account. Whoever gets control can take everything in it, and ${BRAND.product} can’t undo it. Approve only if you started this change yourself. An app should almost never need it.`;

/**
 * One account-control warning of an operation: its line, its bullet (D814), and whether the bullet says more than the
 * step's own line and so always stays (`keep`): setting the account's own key to weight 0 locks the user out, which
 * the line ("set your own key’s weight to 0") doesn't say, as NEAR's removal of the user's own key; and any threshold
 * change may lock them out, which the request alone can't rule out.
 */
interface ControlItem {
  readonly full: SummaryText;
  readonly short: SummaryText;
  readonly keep: boolean;
}

/** A value in a sentence with what it is (D859): the page shows a long one short, and whole in its own row. */
const idp = (text: string, role: IdRole): SummaryPart => ({ kind: 'code', text, role });

function accountControlItems(op: StellarOperation): ControlItem[] {
  const out: ControlItem[] = [];
  for (const c of stellarAccountControl(op)) {
    if (c === 'merge' && op.type === 'accountMerge') {
      out.push({ full: ['This closes the account and sends all of its XLM to ', idp(op.destination, 'to'), '. It can’t be undone.'], short: ['Closes the account and sends all its XLM to ', idp(op.destination, 'to')], keep: false });
    } else if (op.type === 'setOptions') {
      if (c === 'signer' && op.signer) {
        const key = idp(op.signer.key, 'key');
        out.push(
          op.signer.weight === 0
            ? { full: ['This stops the key ', key, ' acting for the account.'], short: ['Stops the key ', key, ' acting for the account'], keep: false }
            : {
                full: ['This lets another key, ', key, `, act for the account (strength ${op.signer.weight}). With enough strength, whoever holds that key can take everything in the account and lock you out.`],
                short: ['Lets the key ', key, ` act for the account (strength ${op.signer.weight})`],
                keep: false,
              },
        );
      } else if (c === 'thresholds') {
        // Whether the new thresholds lock the user out depends on the account's signers and weights, which the request
        // doesn't carry: the bullet says the risk the line doesn't, so it always stays.
        out.push({ full: ['This changes how many approvals the account needs before its keys can move money or change it. Wrong numbers can let other keys take over, or lock you out for good.'], short: ['Changes how many approvals the account needs: wrong numbers can lock you out'], keep: true });
      } else if (c === 'master_weight') {
        out.push(
          op.masterWeight === 0
            ? { full: [`This sets the strength of your own ${BRAND.product} key to 0. It can then no longer approve for the account, so you lose control of it.`], short: [`Sets your own ${BRAND.product} key’s strength to 0: you lose control of the account`], keep: true }
            : { full: [`This sets the strength of your own ${BRAND.product} key to ${op.masterWeight}, which changes what it can still do on the account.`], short: [`Sets your own key’s strength to ${op.masterWeight}`], keep: false },
        );
      }
    }
  }
  return out;
}

/** The account-control warnings of an operation, as plain strings with every value whole (the data, for tests and logs). */
export function accountControlWarnings(op: StellarOperation): string[] {
  return accountControlItems(op).map((c) => summaryString(c.full, ''));
}

function classic(d: Dom, op: StellarOperation): Child[] {
  switch (op.type) {
    case 'pathPaymentStrictReceive':
      return [facts(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Pays at most', assetAmount(d, op.sendMax, op.sendAsset)), row(d, 'Receives exactly', assetAmount(d, op.destAmount, op.destAsset)), row(d, 'Through', path(d, op.path))])];
    case 'pathPaymentStrictSend':
      return [facts(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Pays exactly', assetAmount(d, op.sendAmount, op.sendAsset)), row(d, 'Receives at least', assetAmount(d, op.destMin, op.destAsset)), row(d, 'Through', path(d, op.path))])];
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      return [facts(d, [row(d, 'Sells', assetAmount(d, op.amount, op.selling)), row(d, 'For', mono(d, op.buying === 'native' ? 'XLM' : op.buying)), row(d, 'Price', price(d, op.price), ' per unit sold'), row(d, 'Offer', ...(op.type === 'createPassiveSellOffer' ? ['new passive offer'] : offer(d, op.offerId, op.amount)))])];
    case 'manageBuyOffer':
      return [facts(d, [row(d, 'Buys', assetAmount(d, op.buyAmount, op.buying)), row(d, 'Paying with', mono(d, op.selling === 'native' ? 'XLM' : op.selling)), row(d, 'Price', price(d, op.price), ' per unit bought'), row(d, 'Offer', ...offer(d, op.offerId, op.buyAmount))])];
    case 'setOptions': {
      const s = op.signer;
      const r = [
        s && row(d, s.weight === 0 ? 'Removes signer' : 'Adds signer', mono(d, s.key), ` (${s.keyType}`, ...(s.weight === 0 ? [] : [', weight ', mono(d, String(s.weight))]), ')'),
        op.masterWeight !== null && row(d, 'Own key weight', mono(d, String(op.masterWeight))),
        op.lowThreshold !== null && row(d, 'Low threshold', mono(d, String(op.lowThreshold))),
        op.medThreshold !== null && row(d, 'Medium threshold', mono(d, String(op.medThreshold))),
        op.highThreshold !== null && row(d, 'High threshold', mono(d, String(op.highThreshold))),
        op.setFlags !== null && row(d, 'Sets flags', ...flags(d, op.setFlags, STELLAR_ACCOUNT_FLAGS)),
        op.clearFlags !== null && row(d, 'Clears flags', ...flags(d, op.clearFlags, STELLAR_ACCOUNT_FLAGS)),
        op.homeDomain && row(d, 'Home domain', shortText(d, op.homeDomain)),
        op.inflationDest !== null && row(d, 'Inflation destination', mono(d, op.inflationDest)),
      ];
      return r.some(Boolean) ? [facts(d, r)] : [d.h('p', { class: 'muted' }, 'Changes nothing')];
    }
    case 'allowTrust':
      return [facts(d, [row(d, 'Trustor', mono(d, op.trustor)), row(d, 'Asset code', mono(d, op.assetCode)), row(d, 'Authorization', ...(op.authorize === 0 ? ['revoked'] : flags(d, op.authorize, STELLAR_TRUSTLINE_FLAGS)))])];
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
      return [facts(d, [row(d, 'Trustor', mono(d, op.trustor)), row(d, 'Asset', mono(d, op.asset)), row(d, 'Sets flags', ...flags(d, op.setFlags, STELLAR_TRUSTLINE_FLAGS)), row(d, 'Clears flags', ...flags(d, op.clearFlags, STELLAR_TRUSTLINE_FLAGS))])];
    case 'liquidityPoolDeposit':
      return [facts(d, [row(d, 'Pool', mono(d, op.poolId)), row(d, 'At most', mono(d, formatUnits(op.maxAmountA, 7)), ' of asset A and ', mono(d, formatUnits(op.maxAmountB, 7)), ' of asset B'), row(d, 'Price between', price(d, op.minPrice), ' and ', price(d, op.maxPrice))])];
    case 'liquidityPoolWithdraw':
      return [facts(d, [row(d, 'Pool', mono(d, op.poolId)), row(d, 'Pool shares', mono(d, formatUnits(op.amount, 7))), row(d, 'At least', mono(d, formatUnits(op.minAmountA, 7)), ' of asset A and ', mono(d, formatUnits(op.minAmountB, 7)), ' of asset B')])];
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
      body.push(facts(d, [row(d, 'Asset', mono(d, op.asset)), row(d, 'Limit', mono(d, stroops(op.limit)))]));
      break;
    case 'payment':
      body.push(facts(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Asset', mono(d, op.asset)), row(d, 'Amount', mono(d, `${formatUnits(op.amount, 7)} (${op.amount} stroops)`))]));
      break;
    case 'createAccount':
      body.push(facts(d, [row(d, 'New account', mono(d, op.destination)), row(d, 'Starting balance', mono(d, stroops(op.startingBalance)))]));
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
      row(d, 'Maximum fee', mono(d, stroops(tx.fee))),
      row(d, 'Valid', ...(tx.timeBounds ? ['from ', ...unixView(d, tx.timeBounds.minTime), ' until ', ...(tx.timeBounds.maxTime === '0' ? ['no limit'] : unixView(d, tx.timeBounds.maxTime))] : ['no time limit'])),
      tx.ledgerBounds && row(d, 'Ledgers', mono(d, String(tx.ledgerBounds.minLedger)), ' to ', tx.ledgerBounds.maxLedger === 0 ? 'no limit' : mono(d, String(tx.ledgerBounds.maxLedger))),
      row(d, 'Memo', memo.type === 'none' ? 'none' : mono(d, memoText)),
      tx.soroban && row(d, 'Resource fee', mono(d, stroops(tx.soroban.resourceFee))),
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
    dangers: ops.flatMap((op, step) => accountControlItems(op).map((c) => ({ ...risk(0, 'danger takeover', c.full, c.short), ...(c.keep ? {} : { step }) }))),
    warnings: env.tx.otherPreconditions ? [risk(5, 'warn', ['This has extra conditions on when it can run (about the account’s request counter or its keys).'], ['Has extra conditions on when it can run'])] : [],
  };
}

/** The account-control warnings' bullet forms (D814), one per line of accountControlWarnings, in the same order. */
export function accountControlShorts(op: StellarOperation): string[][] {
  return accountControlItems(op).map((c) => c.short.map((p) => summaryString([p], '')));
}

function envelopeBody(d: Dom, passphrase: string, env: DecodedStellarEnvelope): HTMLElement[] {
  if (env.envelope === 'fee_bump') {
    return [
      facts(d, [row(d, 'Fee paid by', mono(d, env.feeSource)), row(d, 'Fee-bump fee', mono(d, stroops(env.fee)))]),
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

/**
 * A call's data in the details: the function and its arguments, or the raw bytes of one Journear doesn't know. The
 * pinned demo check-in on its chain (D854) is named as its one function.
 */
function evmCallData(d: Dom, chainId: number, c: Pick<DecodedEvmCallSite, 'to' | 'value' | 'data' | 'selector' | 'call'> | (Pick<DecodedEvmTx, 'to' | 'value' | 'data' | 'selector' | 'call'>)): HTMLElement[] {
  if (isDemoCheckInCall(chainId, c.to, c.data, c.value)) return [d.h('p', {}, 'Function ', d.h('strong', {}, 'checkIn()'), ' ', mono(d, DEMO_CHECK_IN_CALLDATA))];
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
      ? [row(d, 'Max fee per gas', mono(d, gasPrice(chainId, tx.maxFeePerGas))), row(d, 'Priority fee per gas', mono(d, gasPrice(chainId, tx.maxPriorityFeePerGas)))]
      : [row(d, 'Gas price', mono(d, gasPrice(chainId, tx.gasPrice)))];
  const data: Child[] = [];
  if (tx.to === null) data.push(d.h('p', {}, 'Creates a contract from this code:'), mono(d, tx.data));
  else data.push(...evmCallData(d, chainId, tx));
  return [
    facts(d, [
      row(d, 'Chain ID', mono(d, String(chainId))),
      row(d, 'To', tx.to === null ? 'New contract' : mono(d, tx.to)),
      row(d, 'Value', mono(d, nativeRaw(chainId, tx.value))),
      row(d, 'Gas limit', mono(d, String(tx.gasLimit))),
      ...fees,
      row(d, 'Maximum network fee', mono(d, nativeRaw(chainId, tx.maxFeeWei))),
      row(d, 'Nonce', mono(d, String(tx.nonce))),
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

/** `validUntil` as nodes: the time in words, the unix seconds exact, in mono (D877). The same text. */
function validUntilView(d: Dom, deadline: bigint, nowMs?: number): Child[] {
  const text = validUntil(deadline, nowMs);
  const raw = String(deadline);
  if (text === `${raw} (unix seconds)`) return [mono(d, raw), ' (unix seconds)'];
  const cut = text.lastIndexOf(`unix ${raw})`);
  return [text.slice(0, cut + 'unix '.length), mono(d, raw), ')'];
}

/**
 * A sponsored action's details: the request's own facts (chain, account, the account helper it uses or sets up, the
 * relayer that sends it, until when it can run, its nonce and gas floor), then every call as an EVM transaction's
 * details show one. EIP-7702 is named only here, folded (D831). Who the fee is free thanks to is the fee row's, first
 * in the details (D884): these say only who sends it.
 */
function sponsoredDetails(d: Dom, decoded: Extract<DecodedApproval, { kind: 'evm_sponsored' }>, nowMs: number | undefined): HTMLElement[] {
  const s = decoded.subject;
  const helper = `${BRAND.product} account helper v${decoded.helperVersion}`;
  return [
    d.h('h3', {}, `EVM action, sent for you by ${BRAND.company}`),
    facts(d, [
      row(d, 'Chain ID', mono(d, String(decoded.chainId))),
      row(d, 'From', mono(d, s.account)),
      s.authNonce !== null
        ? row(d, 'Account setup (EIP-7702)', 'account helper ', mono(d, s.delegate), ` ✓ ${helper}, chain `, mono(d, String(decoded.chainId)), ', account nonce ', mono(d, String(s.authNonce)))
        : row(d, 'Account helper (EIP-7702)', mono(d, s.delegate), ` ✓ ${helper} (no setup in this approval)`),
      row(d, 'Sent by', `${BRAND.company}’s relayer `, mono(d, s.relayer)),
      row(d, 'Valid until', ...validUntilView(d, s.deadline, nowMs)),
      row(d, 'Action nonce', mono(d, String(s.executeNonce))),
      row(d, 'Gas floor', mono(d, `${s.minGas} gas`)),
    ]),
    d.h('h2', {}, decoded.calls.length === 1 ? '1 call' : `${decoded.calls.length} calls`),
    d.h(
      'ol',
      { class: 'ops' },
      ...decoded.calls.map((c, i) => d.h('li', { class: 'op' }, d.h('h3', {}, `${i + 1}. Call`), facts(d, [row(d, 'To', mono(d, c.to)), row(d, 'Value', mono(d, nativeRaw(decoded.chainId, c.value)))]), ...evmCallData(d, decoded.chainId, c))),
    ),
  ];
}

function typedNode(d: Dom, n: TypedDataNode): HTMLElement {
  if ('children' in n) return d.h('li', {}, d.h('span', {}, `${n.name} (${n.type})`), d.h('ul', { class: 'tree' }, ...n.children.map((c) => typedNode(d, c))));
  return d.h('li', {}, `${n.name} (${n.type}): `, n.value === null ? mono(d, `shown as hex ${n.hex ?? ''}`) : mono(d, n.value));
}

/** The words above a message being signed (D886): what the box below is. */
export const MESSAGE_LABEL = 'The message';

/**
 * A message being signed: its label, then the message itself (D886: right after the headline and the facts). One that
 * isn't readable text: the label right above its raw form. That it isn't readable is said once, in the amber box
 * above (the summary's line, "Journear can’t read this message, so it’s shown below in its raw form. …"; the
 * Tech Lead's decision 2026-11-23, D886's note: it replaced a second amber line here).
 */
function message(d: Dom, m: DecodedMessage): HTMLElement[] {
  const label = d.h('p', { class: 'message-label' }, MESSAGE_LABEL);
  return m.text === null ? [label, mono(d, m.hex)] : [label, d.h('pre', { class: 'message' }, m.text)];
}

// ---- NEAR (D723) ----

/**
 * The account-control banner for NEAR (D723, D110's rule): shown on every AddKey, DeleteKey, DeleteAccount,
 * DeployContract and UseGlobalContract of the user's own transaction or delegate action, in the popup's strongest
 * style. No auto-approve policy covers any NEAR request.
 */
export const NEAR_ACCOUNT_CONTROL_BANNER =
  `Danger: this changes who controls a NEAR account. Whoever gets control can take everything in it, and ${BRAND.product} can’t undo it. Approve only if you started this change yourself. An app should almost never need it.`;

/**
 * A delegate action (NEP-366): who sends it and pays, in the details (D858, D884: the app is named as the sponsor, as
 * the fee row names it; the amber "acts as you" line is above the fold); and, for a live app only, that it names no
 * network (amber, D858: a test app's delegate actions are bound to the test network by the vault, D726, D729).
 * `relayer` names the app as every sentence does (its app part: the header's name, bold and bidi-isolated).
 */
export const NEAR_DELEGATE_NOTES = {
  relayer: Object.freeze([
    'Someone else sends this for you, sponsored by ',
    { kind: 'app' },
    '. They pay the network fee and any NEAR it attaches or sends. If an action fails, that NEAR comes back to your account. The actions run as your account.',
  ]) as SummaryText,
  network: (network: 'testnet' | 'mainnet'): string => `This approval could also be used on the ${network === 'testnet' ? 'real NEAR network' : 'NEAR test network'} if your account exists there.`,
} as const;

/** NEP-413's guidance: the recipient, prominently, and what the signature proves. */
export const nearMessageWarning = (recipient: string): string => `This proves to ${recipient} that this account is yours. Only sign if you trust ${recipient}.`;

/** The danger lines of one account-control action (`receiver` is the account it acts on, `me` the user's). */
function nearControlItems(a: NearAction, receiver: string, me: string): SummaryText[] {
  const own = receiver === me;
  const where: SummaryText = own ? ['your account'] : [idp(receiver, 'account')];
  switch (a.type) {
    case 'addKey':
      return a.accessKey.permission.type === 'fullAccess'
        ? [['This gives full control of ', ...where, ' to another key, ', idp(nearKeyText(a.publicKey), 'key'), '. Whoever holds that key can take all its NEAR and tokens and lock you out.']]
        : [['This lets another device or app act for ', ...(own ? ['you'] : where), ' on ', idp(a.accessKey.permission.receiverId, 'program'), ` without asking. It can do ${a.accessKey.permission.methodNames.length === 0 ? 'anything' : 'some things'} there and spend NEAR from `, ...where, ' on fees.']];
    case 'deleteKey':
      return own && a.publicKey.type === 'ed25519' && toHex(a.publicKey.bytes) === me
        ? [[`This removes your ${BRAND.product} key from your account. ${BRAND.product} can then no longer approve for it, so you lose control of it.`]]
        : [['This removes the key ', idp(nearKeyText(a.publicKey), 'key'), ' from ', ...where, '.']];
    case 'deleteAccount':
      return [['This deletes ', ...where, ' and sends all of its NEAR to ', idp(a.beneficiaryId, 'to'), '. It can’t be undone.']];
    case 'deployContract':
      return [['This puts a program on ', ...where, '. The program can do anything the account can, including moving everything in it.']];
    case 'useGlobalContract':
      return [['This puts a shared program on ', ...where, '. The program can do anything the account can, including moving everything in it.']];
    default:
      return [];
  }
}

/** The danger lines of one account-control action, as plain strings with every value whole (for tests and logs). */
export function nearControlWarnings(a: NearAction, receiver: string, me: string): string[] {
  return nearControlItems(a, receiver, me).map((t) => summaryString(t, ''));
}

/**
 * The red warnings of actions that don't change who controls the account but can still cost it dearly: a call to a
 * contract on the user's own account (it runs with the account's full authority), and publishing a global contract
 * (its NEAR is burnt).
 */
export function nearCostWarnings(a: NearAction, receiver: string, me: string): string[] {
  switch (a.type) {
    case 'functionCall':
      return receiver === me ? ['This uses a program on your own account. It can do anything your account can, including moving everything in it.'] : [];
    case 'deployGlobalContract':
      return [`This publishes a shared program. It destroys ${nearDisplay(nearGlobalContractBurn(a.code.length))} from ${receiver === me ? 'your account' : receiver} (0.0001 NEAR for each byte of the program). That NEAR is gone for good.`];
    default:
      return [];
  }
}

/** The line over a box that holds more than it shows (markOverflowing). */
export const overflowNote = (n: number): string => `There’s more in this box (${n} characters) than you can see. Scroll through all of it before you approve.`;

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
    ', fee allowance ',
    p.allowance === null ? 'unlimited' : mono(d, formatNear(p.allowance)),
  );
}

function nearActionBody(d: Dom, a: NearAction, receiver: string, me: string, nested: boolean): Child[] {
  switch (a.type) {
    case 'createAccount':
      return [d.h('p', {}, 'Creates the account ', mono(d, receiver))];
    case 'deployContract':
      return [facts(d, [row(d, 'Deploys a contract to', mono(d, receiver)), row(d, 'Code', `${a.code.length} bytes, hash `, mono(d, nearCodeHash(a.code)))])];
    case 'functionCall':
      return [
        facts(d, [row(d, 'Calls', nearMethod(d, a.methodName), ' on ', mono(d, receiver)), row(d, 'Attached deposit', mono(d, formatNear(a.deposit))), row(d, 'Gas', mono(d, formatGas(a.gas)))]),
        nearArgs(d, a.args),
      ];
    case 'transfer':
      return [facts(d, [row(d, 'Sends', mono(d, formatNear(a.deposit))), row(d, 'To', mono(d, receiver))])];
    case 'stake':
      return [facts(d, [row(d, 'Stakes (locks)', mono(d, formatNear(a.stake))), row(d, 'Validator key', mono(d, nearKeyText(a.publicKey)))])];
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
        facts(d, [row(d, 'Sender', mono(d, inner.senderId)), row(d, 'Receiver', mono(d, inner.receiverId)), row(d, 'Valid until block', mono(d, String(inner.maxBlockHeight)))]),
        nested ? null : nearActionList(d, inner.actions, inner.receiverId, inner.senderId, true),
      ];
    }
    case 'deployGlobalContract':
      return [facts(d, [row(d, 'Publishes a global contract', ...(a.deployMode === 'codeHash' ? ['identified by its code hash'] : ['identified by the account ', mono(d, receiver)])), row(d, 'Code', `${a.code.length} bytes, hash `, mono(d, nearCodeHash(a.code)))])];
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
    { class: nested ? 'action-list sub' : 'action-list' },
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

function nearControlShort(a: NearAction, receiver: string, me: string): SummaryText {
  const where: SummaryText = receiver === me ? ['your account'] : [idp(receiver, 'account')];
  switch (a.type) {
    case 'addKey':
      return a.accessKey.permission.type === 'fullAccess'
        ? ['Gives full control to another key (', idp(nearKeyText(a.publicKey), 'key'), ')']
        : ['Lets another device or app (key ', idp(nearKeyText(a.publicKey), 'key'), ') act for you on ', idp(a.accessKey.permission.receiverId, 'program')];
    case 'deleteKey':
      return ownKeyRemoval(a, receiver, me) ? [`Removes your ${BRAND.product} key`] : ['Removes the key ', idp(nearKeyText(a.publicKey), 'key')];
    case 'deleteAccount':
      return ['Deletes ', ...where, ' and sends all its NEAR to ', idp(a.beneficiaryId, 'to')];
    case 'deployContract':
      return ['Puts a program on ', ...where];
    case 'useGlobalContract':
      return ['Puts a shared program on ', ...where];
    default:
      return [];
  }
}

/** The bullet form of an action's cost warning (D814). */
function nearCostShort(a: NearAction, receiver: string, me: string): SummaryText {
  if (a.type === 'deployGlobalContract') return [`Destroys ${nearDisplay(nearGlobalContractBurn(a.code.length))} for good`];
  return receiver === me ? ['Uses a program on your own account'] : [];
}

/** The NEAR leaving the account: deposits (and stake), and whether a DeleteAccount sends everything. */
/** A transaction's NEAR: deposits and transfers leave the signer's account; Stake locks, a global contract burns. */
/** The total line when the actions call a contract on the user's own account: what that contract moves is its call. */
export const NEAR_OWN_CONTRACT_TOTAL = 'Unknown: the program on your account decides';

function nearTotal(d: Dom, actions: readonly NearAction[], receiver: string, me: string): HTMLElement {
  const t = nearDeposits(actions);
  const leaving = t.total + t.burned;
  const own = nearCallsOwnContract(actions, receiver, me);
  return facts(d, [
    row(
      d,
      'NEAR leaving your account',
      t.deletesAccount ? d.h('strong', { class: 'danger words' }, 'All of it (the account is deleted)') : own ? d.h('strong', { class: 'danger words' }, NEAR_OWN_CONTRACT_TOTAL) : d.h('strong', {}, nearDisplay(leaving)),
      ' (plus the network fee)',
    ),
    own && leaving > 0n && row(d, 'NEAR it sends', mono(d, nearDisplay(leaving))),
    t.burned > 0n && row(d, 'NEAR destroyed', d.h('strong', { class: 'danger' }, nearDisplay(t.burned)), ' (gone for good: publishing a shared program)'),
    t.staked > 0n && row(d, 'NEAR locked up for staking', mono(d, nearDisplay(t.staked))),
  ]);
}

/**
 * A delegate action's NEAR (nearcore): the relayer's transaction prepays every deposit and transfer in it, which go
 * to their receivers on success and back to the user's account (the receipt's predecessor) on failure; gas is the
 * relayer's. What the user's own balance loses is only what acts on the user's account itself: a DeleteAccount
 * (everything), Stake (locked) and a global contract's burn.
 */
/**
 * A delegate action's total when it takes none of the user's NEAR (D884: who pays the fee and the NEAR it sends is in
 * the details). With a contract call in it, the call can move tokens the user holds at that contract: said, as a
 * warning, never as "tokens it moves are yours" (which reads as "you get them"); with no call, nothing about tokens.
 */
export const NEAR_DELEGATE_NONE = 'None of your NEAR.';
export const NEAR_DELEGATE_NONE_TOKENS = 'None of your NEAR. It can move tokens you hold.';

/**
 * The label of the NEAR a delegate action attaches or sends: the sender's, never the user's (nearcore). Who that is
 * (the app, as the fee row names it) is in the details (D884); Journear's relay refuses such a deposit (D732).
 */
export const NEAR_SENT_FOR_YOU = 'NEAR it sends, not from your account';

function nearDelegateTotal(d: Dom, actions: readonly NearAction[], receiver: string, me: string): HTMLElement {
  const t = nearDeposits(actions);
  const own = nearCallsOwnContract(actions, receiver, me);
  const leaving = t.deletesAccount
    ? d.h('strong', { class: 'danger words' }, 'All of it (the account is deleted)')
    : own
      ? d.h('strong', { class: 'danger words' }, NEAR_OWN_CONTRACT_TOTAL)
      : t.burned > 0n
        ? d.h('strong', {}, nearDisplay(t.burned))
        : d.h('strong', { class: 'words' }, actions.some((a) => a.type === 'functionCall') ? NEAR_DELEGATE_NONE_TOKENS : NEAR_DELEGATE_NONE);
  return facts(d, [
    row(d, 'NEAR leaving your account', leaving),
    t.total > 0n && row(d, NEAR_SENT_FOR_YOU, mono(d, nearDisplay(t.total))),
    t.burned > 0n && row(d, 'NEAR destroyed', d.h('strong', { class: 'danger' }, nearDisplay(t.burned)), ' (gone for good: publishing a shared program)'),
    t.staked > 0n && row(d, 'NEAR locked up for staking', mono(d, nearDisplay(t.staked))),
  ]);
}

const NEAR_NETWORK_NAMES = { testnet: 'NEAR test network', mainnet: 'NEAR real network' } as const;

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
 * The network line of a NEAR request (D726, in plain words under D853). NEAR's bytes name no network, so the popup says
 * whether the vault checked it: a transaction on the env's network had its block hash found there (the vault refuses it
 * otherwise, failing closed); a test app's delegate action had its key, nonce and expiry checked there; anything else is
 * the app's claim. How it was checked is in the details (nearNetworkDetail).
 */
export function nearNetworkLine(kind: 'near_tx' | 'near_delegate', network: 'testnet' | 'mainnet', ctx: NearRenderContext): string {
  const name = NEAR_NETWORK_NAMES[network];
  if (nearNetworkChecked(kind, network, ctx)) return `${name} (checked by ${BRAND.company})`;
  return `${name}. Only the app says so; ${BRAND.company} couldn’t check.`;
}

const nearNetworkChecked = (kind: 'near_tx' | 'near_delegate', network: 'testnet' | 'mainnet', ctx: NearRenderContext): boolean => network === ctx.envNetwork && (kind === 'near_tx' || ctx.testApp);

/** The details' network row: the technical facts of the check (D726's wording). */
export function nearNetworkDetail(kind: 'near_tx' | 'near_delegate', network: 'testnet' | 'mainnet', ctx: NearRenderContext): string {
  if (nearNetworkChecked(kind, network, ctx)) return kind === 'near_tx' ? `${network} (${BRAND.company} found its block hash on ${network})` : `${network} (${BRAND.company} checked your key, nonce and expiry on ${network})`;
  return `${network}, as the app says (${BRAND.company} can’t check this)`;
}

/** A NEAR request's notices, shown above the details: the account-control banner and each action's red line (D723). */
function nearAlerts(d: Dom, actions: readonly NearAction[], receiver: string, me: string): Alerts {
  return {
    banners: nearChangesControl(actions, receiver, me) ? [risk(0, 'danger takeover banner', [NEAR_ACCOUNT_CONTROL_BANNER], ['Changes who controls a NEAR account'])] : [],
    dangers: actions.flatMap((a, i) => {
      // Removing the user's own Journear Passport key: the line names the key but not whose it is, so the bullet stays.
      const step = ownKeyRemoval(a, receiver, me) ? undefined : i;
      return [
        ...nearControlItems(a, receiver, me).map((w) => ({ ...risk(0, 'danger takeover', w, nearControlShort(a, receiver, me)), step })),
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
        row(d, 'Network', nearNetworkDetail('near_tx', decoded.network, ctx)),
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

/** The details' heading of a relayed NEAR action (D884: who it is sponsored by is the fee row's and the note's). */
export const NEAR_DELEGATE_HEADING = 'NEAR transaction, sent for you';

/**
 * D858 (as corrected 2026-11-18): a relayed NEAR action. The fee row (in the details, D884) says only that the fee is
 * free, sponsored by the app. When no NEAR of the user's leaves (`summary.noNearLeaves`), the "NEAR leaving your
 * account: None of your NEAR…" row is dropped (NEAR it sends is someone else's, in its own row); otherwise the total
 * stays as decided (D723, D729). The acts-as-you risk is the summary's amber line. For a live app only, the amber line that the
 * approval names no network; a test app's is bound to the test network by the vault (D726, D729).
 */
function nearDelegate(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_delegate' }>, ctx: NearRenderContext, summary: ApprovalSummary, appName: string): Parts {
  const da = decoded.delegate;
  const alerts = nearAlerts(d, da.actions, da.receiverId, da.senderId);
  const sent = nearDeposits(da.actions).total;
  return {
    alerts: ctx.testApp ? alerts : { ...alerts, warnings: [...alerts.warnings, risk(5, 'warn no-network', [NEAR_DELEGATE_NOTES.network(decoded.network)], [])] },
    network: nearNetworkLine('near_delegate', decoded.network, ctx),
    // D884 (as amended by its review): with the fee row gone from the main view, a plain relayed call still says what
    // it costs: "None of your NEAR." (no word about tokens: the summary sees none move; the amber line says the call
    // can use what the user keeps with the contract).
    // D885: a reviewed call's own lines say it moves no money or tokens: no "None of your NEAR" row to repeat it (it
    // attaches no NEAR, so there is no "sent for you" row either).
    visible: summary.reviewed
      ? []
      : summary.noNearLeaves
      ? [facts(d, [row(d, 'NEAR leaving your account', d.h('strong', { class: 'words' }, NEAR_DELEGATE_NONE)), sent > 0n && row(d, NEAR_SENT_FOR_YOU, mono(d, nearDisplay(sent)))])]
      : [nearDelegateTotal(d, da.actions, da.receiverId, da.senderId)],
    details: [
      d.h('h3', {}, NEAR_DELEGATE_HEADING),
      d.h('p', { class: 'muted relayer-note' }, ...summaryNodes(d, sponsorText(NEAR_DELEGATE_NOTES.relayer, appName), appName)),
      facts(d, [
        row(d, 'Network', nearNetworkDetail('near_delegate', decoded.network, ctx)),
        row(d, 'From', mono(d, da.senderId)),
        row(d, 'To', mono(d, da.receiverId)),
        row(d, 'Valid until block', mono(d, String(da.maxBlockHeight))),
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
export const nearRecipientMismatch = (recipient: string, host: string): string => `This app is at ${host}, but the proof is for ${recipient}. Only sign if you expected that.`;

/** A recipient with characters outside printable ASCII, which can imitate another name, written with \u escapes. */
export const nearRecipientLookalike = (escaped: string): string => `The name it’s for has characters that can imitate another name. Written out: ${escaped}`;

const asciiEscaped = (s: string): string => Array.from(s, (ch) => (/^[\x20-\x7e]$/u.test(ch) ? ch : Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''))).join('');

/**
 * A NEP-413 message. The signature stamp's own message, exactly (`summary.reviewed`, D885: for the build's reviewed
 * stamps account, naming the user's own account, no callback), has no "proves to" or recipient lines and, in place of
 * the note that a signature counts on every network, one that says what this one is bound to: the reviewed contract
 * only checks it to collect that stamp, and the summary names it as checked by Journear.
 */
function nearMessage(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_message' }>, ctx: ApprovalRenderContext, summary: ApprovalSummary): Parts {
  const p = decoded.payload;
  const host = originHost(ctx.parentOrigin);
  const sameSite = host !== null && (p.recipient === host || p.recipient === ctx.parentOrigin);
  const lookalike = /[^\x20-\x7e]/u.test(p.recipient);
  return {
    alerts: {
      banners: [],
      dangers: lookalike ? [risk(5, 'danger lookalike', [nearRecipientLookalike(asciiEscaped(p.recipient))], ['The name it’s for can imitate another name'])] : [],
      warnings: summary.reviewed ? [] : [
        risk(4, 'warn nep413', [nearMessageWarning(p.recipient)], ['Proves to ', p.recipient, ' that this account is yours']),
        // Any recipient that isn't exactly this page's host or origin, whatever its shape (a page picks the recipient, so
        // no shape may soften this): one factual line in the warning style.
        ...(host !== null && !sameSite ? [risk(3, 'warn recipient-mismatch', [nearRecipientMismatch(p.recipient, host)], ['For ', p.recipient, ', not this app’s ', host])] : []),
      ],
    },
    network: null,
    // D886: the message first, then the blue note about networks.
    visible: [
      facts(d, [row(d, 'For', d.h('strong', {}, p.recipient)), p.callbackUrl !== null && row(d, 'Then returns to', mono(d, p.callbackUrl))]),
      ...message(d, decoded.message),
      summary.reviewed ? noteLine(d, ctx.testAppNoteHere === true ? 'note reviewed-signature test-app' : 'note reviewed-signature', ctx.testAppNoteHere === true ? REVIEWED_SIGNATURE_TEST_APP_NOTE : REVIEWED_SIGNATURE_NOTE) : noNetworkNote(d, decoded.message.text === null ? 'unreadable' : 'message', ctx),
    ],
    details: [d.h('h3', {}, 'Prove this NEAR account is yours (NEP-413)'), facts(d, [row(d, 'Recipient', mono(d, p.recipient)), row(d, 'Nonce', mono(d, toHex(p.nonce)))])],
  };
}


/**
 * Shown on message and raw requests: their approval binds no network (an empty context in the approval digest; user
 * decision 2026-10-28, docs/decisions.md). Typed data shows its domain's chain instead.
 */
/**
 * A signature that names no network (a message or raw signing, D35) counts on every network the key is used on, test
 * or real (D886). Said after the message, in blue: what it means for the user and what to do, never "isn't tied to one
 * network" alone. For a test app (without the real-money demo) one box says it with the test-app note's advice, which
 * would otherwise read "works only with test money", untrue for such a signature: the page leaves its own note out.
 */
export const NO_NETWORK_NOTE = 'Your signature counts on every network, real-money ones included. Sign only if you agree with what the message says.';
export const NO_NETWORK_TEST_APP_NOTE =
  'This app is a test version, but your signature counts on every network, real-money ones included. Sign only if you agree with what the message says, and don’t keep real money in this account.';
/**
 * A message Journear can't read (D884 review): the user can't agree with hex, so the advice is raw signing's, and the
 * box is amber like the line above it that says Journear can't read the message (never calmer than it).
 */
export const UNREADABLE_NO_NETWORK_NOTE = 'Your signature counts on every network, real-money ones included. Sign only if you know why you’re signing it.';
export const UNREADABLE_NO_NETWORK_TEST_APP_NOTE =
  'This app is a test version, but your signature counts on every network, real-money ones included. Sign only if you know why you’re signing it, and don’t keep real money in this account.';
/** Raw signing's (no message to agree with; its red line says to reject it unless the user is sure). */
export const RAW_NO_NETWORK_NOTE = 'Your signature counts on every network, real-money ones included.';
export const RAW_NO_NETWORK_TEST_APP_NOTE = 'This app is a test version, but your signature counts on every network, real-money ones included. Don’t keep real money in this account.';
/**
 * The Signature stamp's own message, exactly (D885): in place of the "counts on every network" note, what this signature
 * is bound to. It names the user's account and Journear's reviewed stamps program as its recipient, and that program
 * accepts it only from this account and only to collect this stamp, once (its reviewed code). For a test app the
 * test-app note's advice too (the page leaves its own note out on a message).
 */
export const REVIEWED_SIGNATURE_NOTE = 'This signature names your account and the stamps program. The program accepts it only from your account, to collect this one stamp.';
export const REVIEWED_SIGNATURE_TEST_APP_NOTE =
  'This app is a test version, so don’t keep real money in this account. This signature names your account and the stamps program, which accepts it only from your account, to collect this one stamp.';

function noNetworkNote(d: Dom, kind: 'message' | 'unreadable' | 'raw', ctx: ApprovalRenderContext): HTMLElement {
  const test = ctx.testAppNoteHere === true;
  const cls = test ? 'note no-network test-app' : 'note no-network';
  if (kind === 'unreadable') return warnLine(d, cls, test ? UNREADABLE_NO_NETWORK_TEST_APP_NOTE : UNREADABLE_NO_NETWORK_NOTE);
  return noteLine(d, cls, kind === 'message' ? (test ? NO_NETWORK_TEST_APP_NOTE : NO_NETWORK_NOTE) : test ? RAW_NO_NETWORK_TEST_APP_NOTE : RAW_NO_NETWORK_NOTE);
}

/**
 * Which test-app note a request gets (D886): `here`, the window's own network note says it (a message or raw signing);
 * `not_only_test`, typed data that names no network (its amber line says it may work anywhere), so the plain note's
 * "works only with test money" would be untrue; `plain` otherwise.
 */
export function testAppNoteKind(decoded: DecodedApproval): 'here' | 'not_only_test' | 'plain' {
  switch (decoded.kind) {
    case 'personal_sign':
    case 'stellar_message':
    case 'near_message':
    case 'raw':
      return 'here';
    case 'eip712':
      return decoded.chainId === null ? 'not_only_test' : 'plain';
    default:
      return 'plain';
  }
}

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
      return tx.to !== null && tx.data === '0x' && info ? { value: displayUnits(tx.value, EVM_NATIVE_DECIMALS), unit: info.nativeSymbol } : null;
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
  readonly full: SummaryText;
  readonly short: SummaryText;
  /** For a control change's line: its step (operation or action index), dropped when that step's own line is in view. */
  readonly step?: number;
}

const risk = (rank: number, cls: string, full: SummaryText, short: SummaryText): RiskItem => ({ rank, cls, full, short: short.length > 0 ? short : full });

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

// ---- addresses and keys in sentences (D859) ----

/** The label of a value's own row, by what it is. */
export const ID_LABELS: Readonly<Record<IdRole, string>> = Object.freeze({
  to: 'To',
  from: 'From',
  token: 'Token',
  collection: 'Collection',
  spender: 'Who gets the permission',
  permission: 'Whose permission',
  owner: 'Owner',
  key: 'Key',
  program: 'Program',
  account: 'Account',
  pool: 'Pool',
  payer: 'Fee paid by',
});

/** One long value a sentence names: what it is and its whole text. */
interface IdRef {
  readonly role: IdRole;
  readonly full: string;
}

/** Two spellings of one EVM address (any letter case) are one value; anything else is compared as written. */
const idKey = (v: string): string => (/^0x[0-9a-fA-F]{40}$/u.test(v) ? v.toLowerCase() : v);

/**
 * The long values of one window (D859). Each is shown short in its sentence and whole once, in its own row right under
 * the first sentence that names it. Two different values with the same short form (or one with the user's own
 * address's short form, which the account line shows) are never told apart by it: each is numbered ("account 1",
 * "key 2") in the sentence and its row.
 */
class IdBook {
  private readonly seen = new Set<string>();
  /** Values whose row is already on the page above the sentence being built. */
  private readonly placed = new Set<string>();
  /** Values a sentence has already named. */
  private readonly mentioned = new Set<string>();
  private readonly numbers = new Map<string, string>();

  constructor(texts: readonly SummaryText[], me: string) {
    const order: string[] = [];
    const role = new Map<string, IdRole>();
    for (const t of texts)
      for (const p of t)
        if (typeof p !== 'string' && p.kind === 'code' && p.role && isLongId(p.text)) {
          const k = idKey(p.text);
          if (!role.has(k)) {
            role.set(k, p.role);
            order.push(k);
          }
        }
    const byShort = new Map<string, Set<string>>();
    const add = (k: string) => {
      const s = idKey(shortId(k));
      byShort.set(s, (byShort.get(s) ?? new Set()).add(k));
    };
    for (const k of order) add(k);
    if (me) add(idKey(me));
    const count = { key: 0, account: 0 };
    for (const k of order) {
      if (k === idKey(me) || (byShort.get(idKey(shortId(k)))?.size ?? 0) < 2) continue;
      const noun = role.get(k) === 'key' ? 'key' : 'account';
      this.numbers.set(k, `${noun} ${++count[noun]}`);
    }
  }

  /**
   * What screen readers hear after a short form: "(written out below)" at the first mention, "(written out above)" once
   * its row is on the page above, nothing for a later mention before its row.
   */
  hint(full: string): string | null {
    const k = idKey(full);
    const first = !this.mentioned.has(k);
    this.mentioned.add(k);
    if (this.placed.has(k)) return ' (written out above)';
    return first ? ' (written out below)' : null;
  }

  /** The rows of `refs` are now on the page: later sentences come after them. */
  place(refs: readonly IdRef[]): void {
    for (const r of refs) this.placed.add(idKey(r.full));
  }

  /** "account 1" when the value is numbered, else null (it is shown by its short form). */
  number(full: string): string | null {
    return this.numbers.get(idKey(full)) ?? null;
  }

  /** The rows of the values `refs` names that no earlier sentence gave a row, or null when there are none. */
  rows(d: Dom, refs: readonly IdRef[]): HTMLElement | null {
    const fresh = refs.filter((r) => {
      const k = idKey(r.full);
      if (this.seen.has(k)) return false;
      this.seen.add(k);
      return true;
    });
    if (fresh.length === 0) return null;
    return rows(
      d,
      fresh.map((r) => {
        const n = this.number(r.full);
        return row(d, n ? `${ID_LABELS[r.role]} (${n})` : ID_LABELS[r.role], fullId(d, r.full, COUNTERPARTY_GROUPS));
      }),
      'jp-kv id-rows',
    );
  }
}

/**
 * Whether the rows under the sentences ("To", "Key", "Program", …) space their whole values in groups of four (D876:
 * off: the Tech Lead chose one piece for them too, 2026-11-19; kept as a switch). The user's own account never is.
 */
export const COUNTERPARTY_GROUPS = false;

/**
 * A value whole, as code (D876): nothing added to its text, so its text (and a selection or copy of it) is the value
 * exactly. It is built of four-character spans (`.grp`, after a "0x" or "ed25519:"-style prefix) with a line-break
 * opportunity (`<wbr>`) between them, so a line breaks only between two of them and the lines come out nearly even
 * (auth.css `code.id-full`, `text-wrap: balance`): never a lone character on a line. The spans are never spaced unless
 * `grouped` (class `grouped`: CSS spacing between spans, the text unchanged), which is how the groups of four come back.
 */
export function fullId(d: Dom, full: string, grouped = false): HTMLElement {
  const m = /^(0x|[A-Za-z0-9]{1,12}:)/u.exec(full);
  const head = m ? (m[1] as string) : '';
  const parts = [...(head ? [head] : []), ...(full.slice(head.length).match(/.{1,4}/gsu) ?? [])];
  const el = d.h('code', { class: grouped ? 'mono id-full grouped' : 'mono id-full' });
  parts.forEach((p, i) => {
    if (i > 0) el.append(d.h('wbr'));
    el.append(d.h('span', { class: 'grp' }, p));
  });
  return el;
}

/**
 * A summary text as nodes: the app's name in bold (bidi-isolated by the page's CSS), codes in mono, all text. A long
 * value with a role (D859) is its short form, hidden from screen readers (they read it whole in its row), or its
 * number when its short form is shared; each such value goes to `refs` for its row.
 */
function summaryNodes(d: Dom, t: SummaryText, appName: string, book?: IdBook, refs?: IdRef[]): Child[] {
  return t.flatMap((p): Child[] => {
    if (typeof p === 'string') return [p];
    if (p.kind === 'app') return [d.h('strong', { class: 'app-name' }, appName)];
    if (p.kind === 'strong') return [d.h('strong', {}, p.text)];
    // A reviewed call's quoted words (D885): never inline; renderApproval puts each in its own box (quoteBox).
    if (p.kind === 'quote') return [quoteBox(d, p.text)];
    if (!p.role || !book || !isLongId(p.text)) return [mono(d, p.text)];
    refs?.push({ role: p.role, full: p.text });
    const n = book.number(p.text);
    if (n) return [d.h('span', { class: 'id-number' }, n)];
    const hint = book.hint(p.text);
    return [d.h('code', { class: 'mono short-id', attrs: { 'aria-hidden': 'true' } }, shortId(p.text)), ...(hint ? [d.h('span', { class: 'sr-only' }, hint)] : [])];
  });
}

/**
 * A reviewed call's quoted words (D885): the text alone, in a box of its own under its label, apart from Journear's
 * sentences, clipped to the box (approval.css `div.summary-quote`), its direction isolated. Set as text, never markup.
 */
const quoteBox = (d: Dom, text: string): HTMLElement => d.h('div', { class: 'summary-quote', attrs: { dir: 'auto' } }, text);

/** What a sentence that names the app as its sponsor says when the app has no name to show (D884). */
export const NO_APP_NAME = 'the app';

/**
 * A sentence naming the app as a free fee's sponsor (D884), with "the app" in place of the name when there is none to
 * show (the window always has a registered name today, D686: this only keeps such a sentence true and whole).
 */
function sponsorText(t: SummaryText, appName: string): SummaryText {
  return appName.trim() === '' ? t.map((p) => (typeof p !== 'string' && p.kind === 'app' ? NO_APP_NAME : p)) : t;
}

/** A sentence and, right under it, the rows of the long values it names first (D859). */
function withRows(d: Dom, book: IdBook, el: HTMLElement, refs: readonly IdRef[]): HTMLElement[] {
  const r = book.rows(d, refs);
  book.place(refs);
  return r ? [el, r] : [el];
}

/** Ranks in the boxes (D814): control, unreadable, unlimited spend, own-contract or burn, left-out steps, the rest. */
const RED_RANK: Partial<Record<SummaryWarning['code'], number>> = { raw_signing: 1, cannot_explain: 1, summary_failed: 1, unlimited_spend: 2, collection_operator: 2, permit_lookalike: 2, steps_not_listed: 4 };
const AMBER_RANK: Partial<Record<SummaryWarning['code'], number>> = { cannot_explain: 1, contract_creation: 1, steps_not_listed: 2, spend_permission: 3, may_move_tokens: 3, acts_as_you: 3, sign_in_mismatch: 4, account_setup: 4 };

/** A warning of the summary as a box item, classes keyed on its code. */
function summaryItem(w: SummaryWarning): RiskItem {
  const cls = `summary-warning ${w.code.replace(/_/gu, '-')} ${w.level === 'danger' ? 'danger takeover' : 'warn'}`;
  const rank = (w.level === 'danger' ? RED_RANK : AMBER_RANK)[w.code] ?? 5;
  return risk(rank, cls, w.text, w.short ?? []);
}

/**
 * At most one box per colour (D814): the most serious item in full, then every other item as one short bullet, the
 * same bullet said once with its count. No item is dropped. Red boxes are announced (role alert).
 */
function riskBox(d: Dom, tone: 'danger' | 'warning', items: readonly RiskItem[], appName: string, book: IdBook): HTMLElement | null {
  if (items.length === 0) return null;
  const sorted = items.map((x, i) => ({ x, i })).sort((a, b) => a.x.rank - b.x.rank || a.i - b.i).map((e) => e.x);
  const [lead, ...rest] = sorted as [RiskItem, ...RiskItem[]];
  const bullets: { item: RiskItem; key: string; count: number }[] = [];
  for (const item of rest) {
    // Merged only when their FULL texts are the same: two items whose bullets read alike stay two bullets.
    const key = summaryString(item.full, appName);
    const same = bullets.find((b) => b.key === key);
    if (same) same.count++;
    else bullets.push({ item, key, count: 1 });
  }
  // Each sentence, then the rows of the values it names first (D859), inside the box.
  const leadRefs: IdRef[] = [];
  const leadEl = d.h('p', { class: `risk-lead ${lead.cls}` }, ...summaryNodes(d, lead.full, appName, book, leadRefs));
  const leadRows = book.rows(d, leadRefs);
  book.place(leadRefs);
  const lis = bullets.map((b) => {
    const refs: IdRef[] = [];
    const li = d.h('li', { class: b.item.cls }, ...summaryNodes(d, b.item.short, appName, book, refs), b.count > 1 ? ` (${b.count} times)` : '');
    const r = book.rows(d, refs);
    book.place(refs);
    if (r) li.append(r);
    return li;
  });
  return alert(
    d,
    tone,
    { tag: 'div', class: `risk-box ${tone === 'danger' ? 'danger-box' : 'warning-box'}`, ...(tone === 'danger' ? { attrs: { role: 'alert' } } : {}) },
    leadEl,
    leadRows,
    lis.length > 0 ? d.h('ul', { class: 'risk-more' }, ...lis) : null,
  );
}

/** The words on the details' toggle. */
export const DETAILS_LABELS = { show: 'Show details', hide: 'Hide details' } as const;

/**
 * The technical details: a native `<details>` the user opens and closes (keyboard and screen readers get its
 * expanded state from the browser). Always folded at first, for every request, raw signing included (the Tech Lead's
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
  /** The build's accounts of Journear's reviewed NEAR contracts (HanaEnv.nearReviewed): their exact calls read in plain words. */
  readonly reviewedNear?: ReviewedNearAccounts;
  /** The page's own notices (the test-app note or the mainnet demo's banner, the out-of-policy line): after the request's. */
  readonly notes?: readonly (HTMLElement | null)[];
  /** First in the details (the Support ID). */
  readonly detailsExtra?: readonly (HTMLElement | null)[];
  /** The page's clock (ms): a sponsored action's "Valid until" names its date when it isn't today. */
  readonly nowMs?: number;
  /**
   * A test app's note is the plain one (no real-money demo): a message or raw signing then says it in its own network
   * note, and the page leaves its note out (D886, `testAppNoteKind`).
   */
  readonly testAppNoteHere?: boolean;
  /**
   * D896: the app's partner label documents, as the page parsed them from what the vault sent (render-labels.ts
   * `windowLabelDocuments`). Absent or empty: the window exactly as without labels.
   */
  readonly partnerLabels?: readonly LabelDocument[];
  /** D900: what only the chain can tell a label match: a NEAR account's code hash, as the vault read it. */
  readonly labelFacts?: WindowLabelFacts;
}

function kindParts(d: Dom, decoded: DecodedApproval, appName: string, near: ApprovalRenderContext, summary: ApprovalSummary, nowMs?: number): Parts {
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
            row(d, 'Valid until ledger', mono(d, String(decoded.preimage.signatureExpirationLedger))),
          ]),
          invocation(d, decoded.preimage.invocation),
        ],
      };
    case 'stellar_message':
    case 'personal_sign':
      return {
        alerts: NO_ALERTS,
        network: null,
        // D886: the message right after the headline, then the blue note about networks.
        visible: [...message(d, decoded.message), noNetworkNote(d, decoded.message.text === null ? 'unreadable' : 'message', near)],
        details: [d.h('h3', {}, decoded.kind === 'personal_sign' ? 'Sign a message' : 'Sign a Stellar message'), facts(d, [row(d, 'Size', `${decoded.message.length} bytes`)]), d.h('p', {}, 'The message’s bytes:'), mono(d, decoded.message.hex)],
      };
    case 'evm_tx':
      return { alerts: NO_ALERTS, network: null, visible: [], details: [d.h('h3', {}, 'EVM transaction'), ...evmTx(d, decoded.chainId, decoded.tx)] };
    case 'evm_sponsored':
      // Every risk line is the summary's: the same per-call warnings as an EVM transaction's, and the setup note.
      return { alerts: NO_ALERTS, network: null, visible: [], details: sponsoredDetails(d, decoded, nowMs) };
    case 'eip712':
      return {
        alerts: { banners: [], dangers: [], warnings: decoded.chainId === null ? [risk(5, 'warn no-chain', [TYPED_DATA_NO_CHAIN], ['Isn’t tied to one network'])] : [] },
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
        visible: [noNetworkNote(d, 'raw', near)],
        details: [d.h('h3', {}, 'Raw signature'), mono(d, decoded.hex)],
      };
    case 'near_tx':
      return nearTx(d, decoded, near);
    case 'near_delegate':
      return nearDelegate(d, decoded, near, summary, appName);
    case 'near_message':
      return nearMessage(d, decoded, near, summary);
  }
}

/** The request's own facts and the page's notes: what follows the amber box, before the partner's box (D896). */
const journearAfterWarnings = (k: Parts, ctx: ApprovalRenderContext): (HTMLElement | null)[] => [...k.visible, ...(ctx.notes ?? [])];

/**
 * The app's labels for this request (D896). Whatever goes wrong in reading them (a document or a matcher that throws)
 * means no label: the plain window, never "can't be shown" and never a missing Approve. Logged without any text.
 */
function windowLabel(decoded: DecodedApproval, ctx: ApprovalRenderContext): LabelOutcome {
  try {
    return labelOutcome(decoded, ctx.partnerLabels ?? [], {
      user: ctx.address ?? '',
      networkChecked: (decoded.kind === 'near_tx' || decoded.kind === 'near_delegate') && nearNetworkChecked(decoded.kind, decoded.network, ctx),
      reviewedNear: Object.values(ctx.reviewedNear ?? {}).filter((a): a is string => typeof a === 'string'),
      ...(ctx.labelFacts ? { facts: ctx.labelFacts } : {}),
    });
  } catch {
    try {
      console.warn('partner label skipped: it could not be read');
    } catch {
      // No console: nothing to say.
    }
    return { kind: 'none' };
  }
}

/**
 * The partner's box, built inside its own guard (after PR 123's second review): anything that throws while building it
 * leaves the window plain (no box), never a window that can't be shown, and logs no label text.
 */
export function guardedLabelBox(build: () => HTMLElement): HTMLElement | null {
  try {
    return build();
  } catch {
    try {
      console.warn('partner label skipped: it could not be shown');
    } catch {
      // No console: nothing to say.
    }
    return null;
  }
}

/** Typed data whose domain names no chain (D35). */
export const TYPED_DATA_NO_CHAIN = 'This signature names no network, so it may work on any of them, real-money ones included.';

/** The body of the approval screen for a decoded request. */
export function renderApproval(d: Dom, decoded: DecodedApproval, appName: string, ctx: ApprovalRenderContext = { envNetwork: 'testnet', testApp: false }): HTMLElement {
  const summary: ApprovalSummary = summarizeApproval(decoded, { address: ctx.address ?? '', ...(ctx.parentOrigin ? { parentOrigin: ctx.parentOrigin } : {}), ...(ctx.reviewedNear ? { reviewedNear: ctx.reviewedNear } : {}) });
  const k = kindParts(d, decoded, appName, ctx, summary, ctx.nowMs);
  // D896: the app's labels. A match adds the partner's box after every warning box; a request that doesn't meet its
  // description adds one line in Journear's voice to the box of its colour, last (the box's lead never changes);
  // anything else changes nothing.
  const label = windowLabel(decoded, ctx);
  // A control change's bullet repeats nothing: when its step's own line is in view (the headline of a single step, or a
  // grouped line, which names the whole key, signer or address), the bullet is dropped. The banner always stays, and
  // steps left out of the lines keep their bullets (the summary's step_left_out).
  const shown = new Set(summary.shownSteps ?? []);
  const dangers = k.alerts.dangers.filter((it) => it.step === undefined || !shown.has(it.step));
  const red = [
    ...k.alerts.banners,
    ...dangers,
    ...summary.warnings.filter((w) => w.level === 'danger').map(summaryItem),
    ...(label.kind === 'not_listed' ? [risk(5, 'danger takeover partner-not-listed', sponsorText(LABEL_NOT_LISTED.full, appName), sponsorText(LABEL_NOT_LISTED.short, appName))] : []),
  ];
  // A message Journear can't read: its amber line names the app, as "the app" when there is no name to show (D886's
  // note of 2026-11-23, as D884's fee sentence does).
  const unreadableMessage = (decoded.kind === 'personal_sign' || decoded.kind === 'stellar_message' || decoded.kind === 'near_message') && decoded.message.text === null;
  const amber = [
    ...summary.warnings.filter((w) => w.level === 'warning').map((w) => summaryItem(unreadableMessage && w.code === 'cannot_explain' ? { ...w, text: sponsorText(w.text, appName) } : w)),
    ...k.alerts.warnings,
    ...(label.kind === 'mismatch' ? [risk(5, 'warn partner-mismatch', sponsorText(LABEL_MISMATCH.full, appName), sponsorText(LABEL_MISMATCH.short, appName))] : []),
  ];
  // D859: every long value the window names, numbered where two share a short form (or one shares the user's own).
  const book = new IdBook([summary.headline, ...summary.lines, ...[...red, ...amber].flatMap((it) => [it.full, it.short])], ctx.address ?? '');
  // The headline's values are the first to get their rows, which come right after the red box (D809: nothing comes
  // between the headline and the red box; D814: a control change's key row comes right under it).
  const headRefs: IdRef[] = [];
  const headlineEl = d.h('h2', { class: 'summary-headline' }, ...summaryNodes(d, summary.headline, appName, book, headRefs));
  const headRows = book.rows(d, headRefs);
  const redBox = riskBox(d, 'danger', red, appName, book);
  // The headline's rows are placed now, after the red box: only later sentences see them above.
  book.place(headRefs);
  const network = summary.network ? summaryNodes(d, summary.network, appName) : k.network ? [k.network] : null;
  const headline = amountHeadline(decoded);
  // D884: a fee row in the main view means the user pays it. A fee the user doesn't pay ("Free. Sponsored by {App}.")
  // is only in the details, first. D877's look stays there: "Free." in bold after a check mark, in the row; the mark
  // is about the fee only, never a sign the request is safe, so on a window with a red box it is in the plain text
  // colour, not the success green (colour matches meaning, D853).
  const paid = summary.fee && !summary.freeFee ? row(d, 'Network fee', ...summaryNodes(d, summary.fee, appName)) : null;
  const free = summary.fee && summary.freeFee ? row(d, 'Network fee', icon(d, 'check', 'fee-free-mark'), ...summaryNodes(d, sponsorText(summary.fee, appName), appName)) : null;
  free?.[1]?.classList.add(...(red.length > 0 ? ['fee-free', 'beside-danger'] : ['fee-free']));
  const keyFacts = [network && row(d, 'Network', ...network), paid];
  const lines = summary.lines.flatMap((l) => {
    const refs: IdRef[] = [];
    // A line with quoted words (D885): its label as a message's label is shown ("The note", "The message", as D886's
    // "The message"), then the words in their own box, never inside a sentence.
    const quoted = l.filter((part): part is { kind: 'quote'; text: string } => typeof part !== 'string' && part.kind === 'quote');
    if (quoted.length > 0) {
      const label = l.filter((part) => typeof part === 'string' || part.kind !== 'quote');
      return [d.h('p', { class: 'message-label' }, ...summaryNodes(d, label, appName)), ...quoted.map((q) => quoteBox(d, q.text))];
    }
    const p = d.h('p', { class: 'summary-line' }, ...summaryNodes(d, l, appName, book, refs));
    return withRows(d, book, p, refs);
  });
  const amberBox = riskBox(d, 'warning', amber, appName, book);
  const view = d.h(
    'div',
    { class: 'request jp-confirm', attrs: { 'data-explainable': String(summary.explainable), ...(summary.reviewed ? { 'data-reviewed': 'true' } : {}) } },
    headlineEl,
    // The red banners and lines right under the headline: nothing a partner sizes (the summary's lines, the number of
    // operations) can push them down (review M2).
    redBox,
    headRows,
    // The amount (the confirm and sign pattern), where there is one to show.
    headline ? amountView(d, headline) : null,
    ...lines,
    keyFacts.some(Boolean) ? rows(d, keyFacts, 'jp-kv facts summary-facts') : null,
    amberBox,
    // Everything of Journear's, in its own order: the request's facts, then the page's notes (the test-app note, the
    // mainnet demo's banner, the out-of-policy line: alerts of every source the window has).
    ...journearAfterWarnings(k, ctx),
    // D896: the partner's own description of this exact request, attributed: after everything Journear says, every
    // warning of any source included, and only the folded details below it. Its one place, for every request.
    label.kind === 'match' ? guardedLabelBox(() => labelBox(d, label.match, appName)) : null,
    detailsSection(d, [free ? rows(d, [free], 'jp-kv facts fee-facts') : null, ...(ctx.detailsExtra ?? []), ...k.details]),
  );
  // No list without rows: its rules would be drawn around nothing (approval.css "the dividers").
  return withoutEmptyLists(view);
}
