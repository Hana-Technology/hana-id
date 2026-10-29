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
  stellarAccountControl,
  stellarFlagNames,
} from '@hana-id/core/decode';
import { type Child, type Dom, row, rows } from './dom.ts';

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
  return f.type === 'invokeContract' ? call(d, f.contract, f.function, f.args) : d.h('p', { class: 'warn' }, `${f.type} `, mono(d, f.xdr));
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
  'Danger: this transaction changes who controls a Stellar account. Whoever gets control can take everything in it, and Hana ID can’t undo it. Approve only if you started this change yourself; an app should almost never need it.';

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
            ? 'This sets the weight of the account’s own key (your Hana key) to 0: it can no longer sign for the account, so you lose control of it.'
            : `This sets the weight of the account’s own key (your Hana key) to ${op.masterWeight}, which changes what it can still do on the account.`,
        );
      }
    }
  }
  return out;
}

function classic(d: Dom, op: StellarOperation): Child[] {
  switch (op.type) {
    case 'pathPaymentStrictReceive':
      return [rows(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Pays at most', assetAmount(d, op.sendMax, op.sendAsset)), row(d, 'Receives exactly', assetAmount(d, op.destAmount, op.destAsset)), row(d, 'Through', path(d, op.path))])];
    case 'pathPaymentStrictSend':
      return [rows(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Pays exactly', assetAmount(d, op.sendAmount, op.sendAsset)), row(d, 'Receives at least', assetAmount(d, op.destMin, op.destAsset)), row(d, 'Through', path(d, op.path))])];
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
      return [rows(d, [row(d, 'Sells', assetAmount(d, op.amount, op.selling)), row(d, 'For', mono(d, op.buying === 'native' ? 'XLM' : op.buying)), row(d, 'Price', `${price(op.price)} per unit sold`), row(d, 'Offer', op.type === 'createPassiveSellOffer' ? 'new passive offer' : offer(op.offerId, op.amount))])];
    case 'manageBuyOffer':
      return [rows(d, [row(d, 'Buys', assetAmount(d, op.buyAmount, op.buying)), row(d, 'Paying with', mono(d, op.selling === 'native' ? 'XLM' : op.selling)), row(d, 'Price', `${price(op.price)} per unit bought`), row(d, 'Offer', offer(op.offerId, op.buyAmount))])];
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
      return r.some(Boolean) ? [rows(d, r)] : [d.h('p', { class: 'muted' }, 'Changes nothing')];
    }
    case 'allowTrust':
      return [rows(d, [row(d, 'Trustor', mono(d, op.trustor)), row(d, 'Asset code', mono(d, op.assetCode)), row(d, 'Authorization', op.authorize === 0 ? 'revoked' : flags(op.authorize, STELLAR_TRUSTLINE_FLAGS))])];
    case 'accountMerge':
      return [rows(d, [row(d, 'Sends all XLM to', mono(d, op.destination))])];
    case 'inflation':
      return [d.h('p', {}, 'Runs inflation (it no longer has any effect on Stellar)')];
    case 'endSponsoringFutureReserves':
      return [d.h('p', {}, 'Ends the reserve sponsorship started earlier in this transaction')];
    case 'manageData':
      return [rows(d, [row(d, 'Name', shortText(d, op.name)), row(d, 'Value', op.value === null ? 'deletes the entry' : mono(d, op.value))])];
    case 'bumpSequence':
      return [rows(d, [row(d, 'Bumps the sequence number to', mono(d, op.bumpTo))])];
    case 'createClaimableBalance':
      return [
        rows(d, [row(d, 'Amount', assetAmount(d, op.amount, op.asset))]),
        d.h('p', {}, 'Who can claim it:'),
        d.h('ul', {}, ...op.claimants.map((c) => d.h('li', {}, mono(d, c.destination), c.unconditional ? ' (at any time)' : ' (with conditions: ', c.unconditional ? null : mono(d, c.predicate), c.unconditional ? null : ')'))),
      ];
    case 'claimClaimableBalance':
    case 'clawbackClaimableBalance':
      return [rows(d, [row(d, 'Balance', mono(d, op.balanceId))])];
    case 'beginSponsoringFutureReserves':
      return [rows(d, [row(d, 'Pays the reserves of', mono(d, op.sponsored))])];
    case 'revokeSponsorship':
      return op.target.type === 'ledgerEntry'
        ? [d.h('p', {}, 'Ends the sponsorship of:'), d.h('ul', {}, ledgerKey(d, op.target.key))]
        : [rows(d, [row(d, 'Ends the sponsorship of signer', mono(d, op.target.signer)), row(d, 'On account', mono(d, op.target.account))])];
    case 'clawback':
      return [rows(d, [row(d, 'Takes back from', mono(d, op.from)), row(d, 'Amount', assetAmount(d, op.amount, op.asset))])];
    case 'setTrustLineFlags':
      return [rows(d, [row(d, 'Trustor', mono(d, op.trustor)), row(d, 'Asset', mono(d, op.asset)), row(d, 'Sets flags', flags(op.setFlags, STELLAR_TRUSTLINE_FLAGS)), row(d, 'Clears flags', flags(op.clearFlags, STELLAR_TRUSTLINE_FLAGS))])];
    case 'liquidityPoolDeposit':
      return [rows(d, [row(d, 'Pool', mono(d, op.poolId)), row(d, 'At most', `${formatUnits(op.maxAmountA, 7)} of asset A and ${formatUnits(op.maxAmountB, 7)} of asset B`), row(d, 'Price between', `${price(op.minPrice)} and ${price(op.maxPrice)}`)])];
    case 'liquidityPoolWithdraw':
      return [rows(d, [row(d, 'Pool', mono(d, op.poolId)), row(d, 'Pool shares', formatUnits(op.amount, 7)), row(d, 'At least', `${formatUnits(op.minAmountA, 7)} of asset A and ${formatUnits(op.minAmountB, 7)} of asset B`)])];
    default:
      // Never reached: every operation type the XDR defines is decoded (the decoder refuses unknown ones).
      return [d.h('p', { class: 'warn' }, 'Hana does not decode this operation. Its raw XDR:'), mono(d, op.xdr)];
  }
}

function operation(d: Dom, op: StellarOperation, index: number): HTMLElement {
  const body: Child[] = accountControlWarnings(op).map((w) => d.h('p', { class: 'danger takeover' }, w));
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
      body.push(rows(d, [row(d, 'Asset', mono(d, op.asset)), row(d, 'Limit', stroops(op.limit))]));
      break;
    case 'payment':
      body.push(rows(d, [row(d, 'To', mono(d, op.destination)), row(d, 'Asset', mono(d, op.asset)), row(d, 'Amount', `${formatUnits(op.amount, 7)} (${op.amount} stroops)`)]));
      break;
    case 'createAccount':
      body.push(rows(d, [row(d, 'New account', mono(d, op.destination)), row(d, 'Starting balance', stroops(op.startingBalance))]));
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
    rows(d, [
      row(d, 'Network', passphrase),
      row(d, 'Source', mono(d, tx.source)),
      row(d, 'Sequence', mono(d, tx.sequence)),
      row(d, 'Maximum fee', stroops(tx.fee)),
      row(d, 'Valid', tx.timeBounds ? `from ${unixTime(tx.timeBounds.minTime)} until ${tx.timeBounds.maxTime === '0' ? 'no limit' : unixTime(tx.timeBounds.maxTime)}` : 'no time limit'),
      tx.ledgerBounds && row(d, 'Ledgers', `${tx.ledgerBounds.minLedger} to ${tx.ledgerBounds.maxLedger === 0 ? 'no limit' : tx.ledgerBounds.maxLedger}`),
      row(d, 'Memo', memoText),
      tx.soroban && row(d, 'Resource fee', stroops(tx.soroban.resourceFee)),
    ]),
    tx.otherPreconditions ? d.h('p', { class: 'warn' }, 'This transaction has extra preconditions (sequence or signer rules).') : d.h('span'),
    d.h('h2', {}, tx.operations.length === 1 ? '1 operation' : `${tx.operations.length} operations`),
    d.h('ol', { class: 'ops' }, ...tx.operations.map((op, i) => operation(d, op, i))),
    tx.soroban && tx.soroban.readWrite.length > 0
      ? d.h('details', {}, d.h('summary', {}, 'Ledger entries it may change'), d.h('ul', {}, ...tx.soroban.readWrite.map((k) => ledgerKey(d, k))))
      : d.h('span'),
  ];
}

function stellarEnvelope(d: Dom, passphrase: string, env: DecodedStellarEnvelope): HTMLElement[] {
  const banner = env.tx.operations.some((op) => stellarAccountControl(op).length > 0) ? [d.h('p', { class: 'danger takeover banner', attrs: { role: 'alert' } }, ACCOUNT_CONTROL_BANNER)] : [];
  return [...banner, ...envelopeBody(d, passphrase, env)];
}

function envelopeBody(d: Dom, passphrase: string, env: DecodedStellarEnvelope): HTMLElement[] {
  if (env.envelope === 'fee_bump') {
    return [
      d.h('p', { class: 'warn' }, 'This is a fee-bump: it pays the fee for the transaction inside it.'),
      rows(d, [row(d, 'Fee paid by', mono(d, env.feeSource)), row(d, 'Fee-bump fee', stroops(env.fee))]),
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
  if (tx.to === null) data.push(d.h('p', { class: 'warn' }, 'This creates a contract.'), d.h('details', {}, d.h('summary', {}, 'Code'), mono(d, tx.data)));
  else if (tx.call) {
    data.push(
      d.h('p', {}, 'Function ', d.h('strong', {}, tx.call.signature), ' ', mono(d, tx.call.selector)),
      tx.call.args.length > 0 ? d.h('ol', { class: 'args' }, ...tx.call.args.map((a) => d.h('li', {}, abiValue(d, a)))) : null,
    );
  } else if (tx.data !== '0x') {
    data.push(d.h('p', { class: 'warn' }, tx.selector ? `Unknown function ${tx.selector}. Its raw data:` : 'Raw data:'), mono(d, tx.data));
  }
  return [
    rows(d, [
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
    ? [d.h('p', { class: 'warn' }, 'This message is not plain text, so it is shown as hex.'), mono(d, m.hex)]
    : [d.h('pre', { class: 'message' }, m.text)];
}

const CHAIN_NAMES = { stellar: 'Stellar', evm: 'EVM chains' } as const;

/**
 * Shown on message and raw requests: their approval binds no network (an empty context in the approval digest; user
 * decision 2026-10-28, docs/decisions.md). Typed data shows its domain's chain instead.
 */
export const NO_NETWORK_NOTE = 'This signature isn’t tied to one network.';

/** The body of the approval screen for a decoded request. */
export function renderApproval(d: Dom, decoded: DecodedApproval, appName: string): HTMLElement {
  const parts: HTMLElement[] = [];
  switch (decoded.kind) {
    case 'stellar_tx':
      parts.push(d.h('h2', {}, 'Stellar transaction'), ...stellarEnvelope(d, decoded.networkPassphrase, decoded.envelope));
      break;
    case 'stellar_auth_entry':
      parts.push(
        d.h('h2', {}, 'Stellar authorization'),
        rows(d, [
          row(d, 'Network', decoded.networkPassphrase),
          row(d, 'Network ID', mono(d, decoded.preimage.networkId)),
          row(d, 'Nonce', mono(d, decoded.preimage.nonce)),
          row(d, 'Valid until ledger', String(decoded.preimage.signatureExpirationLedger)),
        ]),
        invocation(d, decoded.preimage.invocation),
      );
      break;
    case 'stellar_message':
      parts.push(d.h('h2', {}, 'Sign a Stellar message'), d.h('p', { class: 'note' }, NO_NETWORK_NOTE), ...message(d, decoded.message));
      break;
    case 'personal_sign':
      parts.push(d.h('h2', {}, 'Sign a message'), d.h('p', { class: 'note' }, NO_NETWORK_NOTE), ...message(d, decoded.message));
      break;
    case 'evm_tx':
      parts.push(d.h('h2', {}, 'EVM transaction'), ...evmTx(d, decoded.chainId, decoded.tx));
      break;
    case 'eip712':
      parts.push(
        d.h('h2', {}, 'Sign typed data'),
        decoded.chainId === null ? d.h('p', { class: 'warn' }, 'This signature names no chain: it may be valid on any chain.') : d.h('p', {}, `Chain ID ${decoded.chainId}`),
        d.h('h3', {}, 'Domain'),
        d.h('ul', { class: 'tree' }, ...decoded.view.domain.map((n) => typedNode(d, n))),
        d.h('h3', {}, decoded.view.primaryType),
        d.h('ul', { class: 'tree' }, typedNode(d, decoded.view.message)),
      );
      break;
    case 'raw':
      parts.push(
        d.h('h2', {}, 'Raw signature'),
        d.h('p', { class: 'danger' }, rawSigningWarning(CHAIN_NAMES[decoded.chain], appName)),
        d.h('p', { class: 'note' }, NO_NETWORK_NOTE),
        mono(d, decoded.hex),
      );
      break;
  }
  return d.h('div', { class: 'request' }, ...parts);
}
