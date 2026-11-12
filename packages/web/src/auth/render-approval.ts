// What the approval popup shows for a request (docs/batch-b-spec.md "Approval flow" step 4), rendered from the popup's
// own decode of the request bytes (@hana-id/core/decode), never from a summary the vault sent. Every value is text;
// strings the decoders flag as unsafe to show (control, bidi or invisible characters) are shown as hex.
import { rawSigningWarning } from '@hana-id/core';
import {
  type AbiValue,
  type DecodedApproval,
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

export function accountControlWarnings(op: StellarOperation): string[] {
  const out: string[] = [];
  for (const c of stellarAccountControl(op)) {
    if (c === 'merge' && op.type === 'accountMerge') {
      out.push(`This closes the account and sends all of its XLM to ${op.destination}. It can’t be undone.`);
    } else if (op.type === 'setOptions') {
      if (c === 'signer' && op.signer) {
        out.push(
          op.signer.weight === 0
            ? `This removes signer ${op.signer.key} from the account.`
            : `This adds ${op.signer.key} as a signer with weight ${op.signer.weight}. Whoever holds that key can sign for the account and, with enough weight, move all its funds and lock you out.`,
        );
      } else if (c === 'thresholds') {
        out.push('This changes the account’s signing thresholds, which decide which keys can move funds and change the account. Wrong values let other signers take over or lock you out for good.');
      } else if (c === 'master_weight') {
        out.push(
          op.masterWeight === 0
            ? `This sets the weight of the account’s own key (your ${BRAND.product} key) to 0: it can no longer sign for the account, so you lose control of it.`
            : `This sets the weight of the account’s own key (your ${BRAND.product} key) to ${op.masterWeight}, which changes what it can still do on the account.`,
        );
      }
    }
  }
  return out;
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
  const body: Child[] = accountControlWarnings(op).map((w) => dangerLine(d, 'danger takeover', undefined, w));
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
      row(d, 'Network', passphrase),
      row(d, 'Source', mono(d, tx.source)),
      row(d, 'Sequence', mono(d, tx.sequence)),
      row(d, 'Maximum fee', stroops(tx.fee)),
      row(d, 'Valid', tx.timeBounds ? `from ${unixTime(tx.timeBounds.minTime)} until ${tx.timeBounds.maxTime === '0' ? 'no limit' : unixTime(tx.timeBounds.maxTime)}` : 'no time limit'),
      tx.ledgerBounds && row(d, 'Ledgers', `${tx.ledgerBounds.minLedger} to ${tx.ledgerBounds.maxLedger === 0 ? 'no limit' : tx.ledgerBounds.maxLedger}`),
      row(d, 'Memo', memoText),
      tx.soroban && row(d, 'Resource fee', stroops(tx.soroban.resourceFee)),
    ]),
    tx.otherPreconditions ? warnLine(d, 'warn', 'This transaction has extra preconditions (sequence or signer rules).') : d.h('span'),
    d.h('h2', {}, tx.operations.length === 1 ? '1 operation' : `${tx.operations.length} operations`),
    d.h('ol', { class: 'ops' }, ...tx.operations.map((op, i) => operation(d, op, i))),
    tx.soroban && tx.soroban.readWrite.length > 0
      ? d.h('details', {}, d.h('summary', {}, 'Ledger entries it may change'), d.h('ul', {}, ...tx.soroban.readWrite.map((k) => ledgerKey(d, k))))
      : d.h('span'),
  ];
}

function stellarEnvelope(d: Dom, passphrase: string, env: DecodedStellarEnvelope): HTMLElement[] {
  const banner = env.tx.operations.some((op) => stellarAccountControl(op).length > 0) ? [dangerLine(d, 'danger takeover banner', { role: 'alert' }, ACCOUNT_CONTROL_BANNER)] : [];
  return [...banner, ...envelopeBody(d, passphrase, env)];
}

function envelopeBody(d: Dom, passphrase: string, env: DecodedStellarEnvelope): HTMLElement[] {
  if (env.envelope === 'fee_bump') {
    return [
      warnLine(d, 'warn', 'This is a fee-bump: it pays the fee for the transaction inside it.'),
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

function evmTx(d: Dom, chainId: number, tx: DecodedEvmTx): HTMLElement[] {
  const fees =
    tx.type === 'eip1559'
      ? [row(d, 'Max fee per gas', gwei(tx.maxFeePerGas)), row(d, 'Priority fee per gas', gwei(tx.maxPriorityFeePerGas))]
      : [row(d, 'Gas price', gwei(tx.gasPrice))];
  const data: Child[] = [];
  if (tx.to === null) data.push(warnLine(d, 'warn', 'This creates a contract.'), d.h('details', {}, d.h('summary', {}, 'Code'), mono(d, tx.data)));
  else if (tx.call) {
    data.push(
      d.h('p', {}, 'Function ', d.h('strong', {}, tx.call.signature), ' ', mono(d, tx.call.selector)),
      tx.call.args.length > 0 ? d.h('ol', { class: 'args' }, ...tx.call.args.map((a) => d.h('li', {}, abiValue(d, a)))) : null,
    );
  } else if (tx.data !== '0x') {
    data.push(warnLine(d, 'warn', tx.selector ? `Unknown function ${tx.selector}. Its raw data:` : 'Raw data:'), mono(d, tx.data));
  }
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
      return [`This publishes a global contract and burns ${formatNear(nearGlobalContractBurn(a.code.length))} from ${receiver === me ? 'your account' : receiver} (0.0001 NEAR per byte of code). Burnt NEAR is gone for good.`];
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
  const RO = win.ResizeObserver;
  if (typeof RO === 'function') {
    const ro = new RO((entries) => {
      for (const e of entries) markOne(e.target as HTMLElement);
    });
    for (const box of Array.from(root.querySelectorAll<HTMLElement>('pre.message'))) ro.observe(box);
    return () => ro.disconnect();
  }
  const onResize = () => markOverflowing(root);
  win.addEventListener('resize', onResize);
  return () => win.removeEventListener('resize', onResize);
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
        const warnings = nested ? [] : [...nearControlWarnings(a, receiver, me), ...nearCostWarnings(a, receiver, me)];
        return d.h(
          'li',
          { class: warnings.length > 0 ? 'op takeover-op' : 'op' },
          d.h('h3', {}, `${i + 1}. ${NEAR_ACTION_NAMES[a.type]}`),
          ...warnings.map((w) => dangerLine(d, 'danger takeover', undefined, w)),
          ...nearActionBody(d, a, receiver, me, nested),
        );
      }),
    ),
  );
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
      t.deletesAccount ? d.h('strong', { class: 'danger' }, 'All of it (the account is deleted)') : own ? d.h('strong', { class: 'danger' }, NEAR_OWN_CONTRACT_TOTAL) : d.h('strong', {}, formatNear(leaving)),
      ' (plus the network fee for gas)',
    ),
    own && leaving > 0n && row(d, 'NEAR attached or sent', formatNear(leaving)),
    t.burned > 0n && row(d, 'NEAR burnt', d.h('strong', { class: 'danger' }, formatNear(t.burned)), ' (publishing a global contract)'),
    t.staked > 0n && row(d, 'NEAR staked (locked)', formatNear(t.staked)),
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
        ? d.h('strong', {}, formatNear(t.burned))
        : d.h('strong', {}, NEAR_DELEGATE_NONE);
  return facts(d, [
    row(d, 'NEAR leaving your account', leaving),
    t.total > 0n && row(d, 'NEAR this sends, paid by the relayer', formatNear(t.total)),
    t.burned > 0n && row(d, 'NEAR burnt', d.h('strong', { class: 'danger' }, formatNear(t.burned)), ' (publishing a global contract)'),
    t.staked > 0n && row(d, 'NEAR staked (locked)', formatNear(t.staked)),
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

function nearBanner(d: Dom, actions: readonly NearAction[], receiver: string, me: string): HTMLElement[] {
  return nearChangesControl(actions, receiver, me) ? [dangerLine(d, 'danger takeover banner', { role: 'alert' }, NEAR_ACCOUNT_CONTROL_BANNER)] : [];
}

function nearTx(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_tx' }>, ctx: NearRenderContext): HTMLElement[] {
  const tx = decoded.tx;
  return [
    ...nearBanner(d, tx.actions, tx.receiverId, tx.signerId),
    facts(d, [
      row(d, 'Network', nearNetworkLine('near_tx', decoded.network, ctx)),
      row(d, 'From', mono(d, tx.signerId)),
      row(d, 'To', mono(d, tx.receiverId)),
      row(d, 'Nonce', mono(d, String(tx.nonce))),
      row(d, 'Block hash', mono(d, nearHash58(tx.blockHash))),
      row(d, 'Transaction hash', mono(d, decoded.hash)),
    ]),
    nearTotal(d, tx.actions, tx.receiverId, tx.signerId),
    nearActionList(d, tx.actions, tx.receiverId, tx.signerId, false),
  ];
}

function nearDelegate(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_delegate' }>, ctx: NearRenderContext): HTMLElement[] {
  const da = decoded.delegate;
  return [
    ...nearBanner(d, da.actions, da.receiverId, da.senderId),
    noteLine(d, 'note', NEAR_DELEGATE_NOTES.relayer),
    noteLine(d, 'note', NEAR_DELEGATE_NOTES.network),
    facts(d, [
      row(d, 'Network', nearNetworkLine('near_delegate', decoded.network, ctx)),
      row(d, 'From', mono(d, da.senderId)),
      row(d, 'To', mono(d, da.receiverId)),
      row(d, 'Valid until block', String(da.maxBlockHeight)),
      row(d, 'Nonce', mono(d, String(da.nonce))),
    ]),
    nearDelegateTotal(d, da.actions, da.receiverId, da.senderId),
    nearActionList(d, da.actions, da.receiverId, da.senderId, false),
  ];
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

function nearMessage(d: Dom, decoded: Extract<DecodedApproval, { kind: 'near_message' }>, ctx: NearRenderContext): HTMLElement[] {
  const p = decoded.payload;
  const host = originHost(ctx.parentOrigin);
  const sameSite = host !== null && (p.recipient === host || p.recipient === ctx.parentOrigin);
  const lookalike = /[^\x20-\x7e]/u.test(p.recipient);
  return [
    warnLine(d, 'warn', nearMessageWarning(p.recipient)),
    // Any recipient that isn't exactly this page's host or origin, whatever its shape (a page picks the recipient, so no
    // shape may soften this): one factual line in the warning style.
    host !== null && !sameSite ? warnLine(d, 'warn recipient-mismatch', nearRecipientMismatch(p.recipient, host)) : null,
    lookalike ? dangerLine(d, 'danger', undefined, nearRecipientLookalike(asciiEscaped(p.recipient))) : null,
    facts(d, [row(d, 'For', d.h('strong', {}, p.recipient)), p.callbackUrl !== null && row(d, 'Then returns to', mono(d, p.callbackUrl)), row(d, 'Nonce', mono(d, toHex(p.nonce)))]),
    noteLine(d, 'note', NO_NETWORK_NOTE),
    ...message(d, decoded.message),
  ].filter((x): x is HTMLElement => x !== null);
}

const CHAIN_NAMES = { stellar: 'Stellar', evm: 'EVM chains' } as const;

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
      return tx.to !== null && tx.data === '0x' && info ? { value: formatUnits(tx.value, 18), unit: info.nativeSymbol } : null;
    }
    case 'stellar_tx': {
      const ops = decoded.envelope.tx.operations;
      const op = ops.length === 1 ? ops[0] : undefined;
      if (!op || op.source) return null;
      if (op.type === 'createAccount') return { value: formatUnits(op.startingBalance, 7), unit: 'XLM' };
      // Native XLM only. A credit asset's code is chosen by its issuer, so any account can issue "USDC" or even
      // "XLM": a bare code in the headline would vouch for an asset the popup can't verify. The rows show it in full,
      // code and issuer, as before.
      return op.type === 'payment' && op.asset === 'native' ? { value: formatUnits(op.amount, 7), unit: 'XLM' } : null;
    }
    case 'near_tx': {
      const actions = decoded.tx.actions;
      if (actions.length === 0 || !actions.every((a) => a.type === 'transfer')) return null;
      return { value: formatNear(nearDeposits(actions).total).replace(/ NEAR$/u, ''), unit: 'NEAR' };
    }
    default:
      return null;
  }
}

/** The headline's markup: "Sends", then the number in the system's large figure with its unit beside it. */
function amountView(d: Dom, a: AmountHeadline): HTMLElement {
  return d.h('div', { class: 'headline' }, d.h('p', { class: 'headline-label' }, 'Sends'), d.h('p', { class: 'amt amount' }, d.h('span', { class: 'amt-value' }, a.value), d.h('small', {}, a.unit)));
}

/** The body of the approval screen for a decoded request. */
export function renderApproval(d: Dom, decoded: DecodedApproval, appName: string, near: NearRenderContext = { envNetwork: 'testnet', testApp: false }): HTMLElement {
  const parts: HTMLElement[] = [];
  switch (decoded.kind) {
    case 'stellar_tx':
      parts.push(d.h('h2', {}, 'Stellar transaction'), ...stellarEnvelope(d, decoded.networkPassphrase, decoded.envelope));
      break;
    case 'stellar_auth_entry':
      parts.push(
        d.h('h2', {}, 'Stellar authorization'),
        facts(d, [
          row(d, 'Network', decoded.networkPassphrase),
          row(d, 'Network ID', mono(d, decoded.preimage.networkId)),
          row(d, 'Nonce', mono(d, decoded.preimage.nonce)),
          row(d, 'Valid until ledger', String(decoded.preimage.signatureExpirationLedger)),
        ]),
        invocation(d, decoded.preimage.invocation),
      );
      break;
    case 'stellar_message':
      parts.push(d.h('h2', {}, 'Sign a Stellar message'), noteLine(d, 'note', NO_NETWORK_NOTE), ...message(d, decoded.message));
      break;
    case 'personal_sign':
      parts.push(d.h('h2', {}, 'Sign a message'), noteLine(d, 'note', NO_NETWORK_NOTE), ...message(d, decoded.message));
      break;
    case 'evm_tx':
      parts.push(d.h('h2', {}, 'EVM transaction'), ...evmTx(d, decoded.chainId, decoded.tx));
      break;
    case 'eip712':
      parts.push(
        d.h('h2', {}, 'Sign typed data'),
        decoded.chainId === null ? warnLine(d, 'warn', 'This signature names no chain: it may be valid on any chain.') : d.h('p', {}, `Chain ID ${decoded.chainId}`),
        d.h('h3', {}, 'Domain'),
        d.h('ul', { class: 'tree' }, ...decoded.view.domain.map((n) => typedNode(d, n))),
        d.h('h3', {}, decoded.view.primaryType),
        d.h('ul', { class: 'tree' }, typedNode(d, decoded.view.message)),
      );
      break;
    case 'raw':
      parts.push(
        d.h('h2', {}, 'Raw signature'),
        dangerLine(d, 'danger', undefined, rawSigningWarning(CHAIN_NAMES[decoded.chain], appName)),
        noteLine(d, 'note', NO_NETWORK_NOTE),
        mono(d, decoded.hex),
      );
      break;
    case 'near_tx':
      parts.push(d.h('h2', {}, 'NEAR transaction'), ...nearTx(d, decoded, near));
      break;
    case 'near_delegate':
      parts.push(d.h('h2', {}, 'NEAR transaction, fee paid by a relayer'), ...nearDelegate(d, decoded, near));
      break;
    case 'near_message':
      parts.push(d.h('h2', {}, 'Sign in with your NEAR account'), ...nearMessage(d, decoded, near));
      break;
  }
  // The amount first (the confirm and sign pattern), right under the request's kind, where there is one to show.
  const headline = amountHeadline(decoded);
  if (headline) parts.splice(1, 0, amountView(d, headline));
  return d.h('div', { class: 'request jp-confirm' }, ...parts);
}
