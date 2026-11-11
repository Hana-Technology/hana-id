// What the approval popup shows for NEAR requests (D723), from the bytes it decoded itself (near/codec.ts): amounts in
// NEAR, gas in Tgas, function-call arguments as escaped JSON when they are JSON and hex otherwise, the NEAR leaving
// the account, and which actions change who controls an account. Pure: the DOM rendering is web's
// render-approval.ts.
import { base58 } from '@scure/base';
import { isDisplaySafeLine } from '../display-safe.ts';
import { sha256, toHex } from '../bytes.ts';
import type { NearAction, NearDelegateAction, NearPublicKey, NearTransaction, Nep413Payload } from '../near/codec.ts';
import { nearKeyString } from '../near/codec.ts';
import { parseStrictJson } from './json.ts';
import { DecodeError } from './errors.ts';
import { decodeMessage, type DecodedMessage } from './message.ts';

/** 1 NEAR in yoctoNEAR. */
export const YOCTO_PER_NEAR = 10n ** 24n;
/** 1 Tgas in gas units. */
export const GAS_PER_TGAS = 10n ** 12n;

/** `yocto` as NEAR with every significant digit: "1.5 NEAR", "0.000000000000000000000001 NEAR". */
export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/u, '');
  return `${whole}${frac ? `.${frac}` : ''} NEAR`;
}

/** Gas in Tgas: "30 Tgas", "0.5 Tgas". */
export function formatGas(gas: bigint): string {
  const whole = gas / GAS_PER_TGAS;
  const frac = (gas % GAS_PER_TGAS).toString().padStart(12, '0').replace(/0+$/u, '');
  return `${whole}${frac ? `.${frac}` : ''} Tgas`;
}

/** A function call's arguments as shown: pretty JSON with unsafe characters escaped, or hex. */
export type NearArgsView = { readonly kind: 'json'; readonly text: string; readonly length: number } | { readonly kind: 'hex'; readonly hex: string; readonly length: number } | { readonly kind: 'empty'; readonly length: 0 };

/** Arguments over this many bytes are shown as hex, not parsed (the popup still shows all of them). */
export const NEAR_ARGS_JSON_MAX_BYTES = 64 * 1024;

// ignoreBOM: a leading BOM stays in the text, so arguments that start with one fail strict JSON and show as hex (what is
// sent, byte for byte), instead of being shown without it.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const escapeChar = (ch: string): string => Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

/**
 * Re-indents JSON text that parseStrictJson accepted, token by token, so keys keep their order and numbers their
 * lexemes: whitespace outside strings is replaced by two-space indentation, and inside strings every character that
 * isn't safe to show (display-safe.ts, one line) is written as its \u escape (the same string value).
 */
function indentJson(text: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  const newline = () => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (inString) {
      if (ch === '\\') {
        // An escape is copied whole: \uXXXX or one character.
        const n = text[i] === 'u' ? 5 : 1;
        out += ch + text.slice(i, i + n);
        i += n;
      } else {
        if (ch === '"') inString = false;
        out += ch === '"' || isDisplaySafeLine(ch) ? ch : escapeChar(ch);
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      let j = i;
      while (j < text.length && /[ \t\n\r]/u.test(text[j]!)) j++;
      if (text[j] === close) {
        out += ch + close;
        i = j + 1;
      } else {
        depth++;
        out += ch + newline();
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
      out += newline() + ch;
    } else if (ch === ',') out += `,${newline()}`;
    else if (ch === ':') out += ': ';
    else out += ch;
  }
  return out;
}

/**
 * The view of a function call's arguments: JSON (strict: no duplicate keys, no lone surrogates; keys in their order,
 * numbers as written) re-indented with unsafe characters escaped, so what is shown is the value that is sent;
 * anything else, and JSON over NEAR_ARGS_JSON_MAX_BYTES, as hex.
 */
export function nearArgsView(args: Uint8Array): NearArgsView {
  if (args.length === 0) return { kind: 'empty', length: 0 };
  if (args.length <= NEAR_ARGS_JSON_MAX_BYTES) {
    try {
      const text = utf8Decoder.decode(args);
      parseStrictJson(text);
      return { kind: 'json', text: indentJson(text), length: args.length };
    } catch (e) {
      if (!(e instanceof DecodeError) && !(e instanceof TypeError)) throw e;
    }
  }
  return { kind: 'hex', hex: toHex(args), length: args.length };
}

/** A method name as shown: the name when it is one line of visible text, else null (show `hex`). */
export function nearMethodName(name: string): { text: string | null; hex: string } {
  return { text: name.length > 0 && isDisplaySafeLine(name) ? name : null, hex: toHex(new TextEncoder().encode(name)) };
}

/** Why an action changes who controls an account (the rule Stellar's account-control operations follow): shown under the red warning. */
export type NearControlChange = 'add_full_access_key' | 'add_function_call_key' | 'delete_key' | 'delete_account' | 'deploy_contract' | 'use_global_contract';

/**
 * The control changes of one action of the user's own transaction or delegate action. AddKey (any key), DeleteKey,
 * DeleteAccount, DeployContract and UseGlobalContract change who controls the account they act on (a contract can
 * move its account's funds); DeployGlobalContract only publishes code, and a nested delegate acts on its own sender.
 */
export function nearAccountControl(a: NearAction): NearControlChange[] {
  switch (a.type) {
    case 'addKey':
      return [a.accessKey.permission.type === 'fullAccess' ? 'add_full_access_key' : 'add_function_call_key'];
    case 'deleteKey':
      return ['delete_key'];
    case 'deleteAccount':
      return ['delete_account'];
    case 'deployContract':
      return ['deploy_contract'];
    case 'useGlobalContract':
      return ['use_global_contract'];
    default:
      return [];
  }
}

/** True when any action changes who controls an account (the popup's red banner). */
export const nearChangesControl = (actions: readonly NearAction[]): boolean => actions.some((a) => nearAccountControl(a).length > 0);

/**
 * What DeployGlobalContract burns per byte of code: the protocol's `global_contract_storage_amount_per_byte`,
 * 10^20 yoctoNEAR (0.0001 NEAR), taken from the account the action runs on (always the signer's own: nearcore lets
 * only the account itself deploy) and burnt, not stored. UseGlobalContract burns nothing.
 */
export const NEAR_GLOBAL_CONTRACT_YOCTO_PER_BYTE = 10n ** 20n;

/** The NEAR a DeployGlobalContract of `codeLength` bytes burns. */
export const nearGlobalContractBurn = (codeLength: number): bigint => BigInt(codeLength) * NEAR_GLOBAL_CONTRACT_YOCTO_PER_BYTE;

export interface NearDeposits {
  /** Transfer and FunctionCall deposits, a relayed delegate's included (the signer prepays those). */
  readonly total: bigint;
  /** Stake: locked, not sent. */
  readonly staked: bigint;
  /** DeployGlobalContract: burnt. */
  readonly burned: bigint;
  /** A DeleteAccount: everything goes. */
  readonly deletesAccount: boolean;
}

/**
 * The NEAR these actions take, for the account that signs a transaction with them: Transfer and FunctionCall
 * deposits (nearcore's `total_deposit`, which counts a Delegate action's inner deposits too: the transaction's signer
 * prepays them), Stake apart (locked), DeployGlobalContract's burn apart, DeleteAccount flagged (everything). Gas is
 * paid on top. Hana never signs a transaction that relays a delegate action (near_relayed_delegate), so in practice
 * the delegate case only keeps this sum honest.
 */
export function nearDeposits(actions: readonly NearAction[]): NearDeposits {
  let total = 0n;
  let staked = 0n;
  let burned = 0n;
  let deletesAccount = false;
  for (const a of actions) {
    if (a.type === 'transfer' || a.type === 'functionCall') total += a.deposit;
    else if (a.type === 'stake') staked += a.stake;
    else if (a.type === 'deleteAccount') deletesAccount = true;
    else if (a.type === 'deployGlobalContract') burned += nearGlobalContractBurn(a.code.length);
    else if (a.type === 'delegate') {
      const inner = nearDeposits(a.signedDelegate.delegateAction.actions);
      total += inner.total;
    }
  }
  return { total, staked, burned, deletesAccount };
}

/** base58 sha256 of contract code, as NEAR shows code hashes. */
export const nearCodeHash = (code: Uint8Array): string => base58.encode(sha256(code));

/** base58 of a block or code hash. */
export const nearHash58 = (bytes: Uint8Array): string => base58.encode(bytes);

/** `ed25519:<base58>` of a key. */
export const nearKeyText = (pk: NearPublicKey): string => nearKeyString(pk);

/** The decoded NEAR approvals (decode/request.ts DecodedApproval's NEAR members). */
export interface DecodedNearTx {
  readonly network: 'testnet' | 'mainnet';
  readonly tx: NearTransaction;
  /** base58 sha256 of the transaction: its NEAR hash. */
  readonly hash: string;
}

export interface DecodedNearDelegate {
  readonly network: 'testnet' | 'mainnet';
  readonly delegate: NearDelegateAction;
}

export interface DecodedNearMessage {
  readonly payload: Nep413Payload;
  /** The message as text when it is display-safe, else its hex. */
  readonly message: DecodedMessage;
}

export const nearMessageView = (payload: Nep413Payload): DecodedNearMessage => ({ payload, message: decodeMessage(new TextEncoder().encode(payload.message)) });
