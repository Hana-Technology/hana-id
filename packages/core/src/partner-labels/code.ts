// Which code a request runs, as far as a label needs it (D900, piece 5 of D892). Pure: decoding only, no network.
//
// Soroban: a transaction lists every ledger entry it may read or write (its footprint), and the network runs it only
// within that list: the host refuses any storage key not declared, and to call a Wasm contract it reads the contract's
// instance, takes the Wasm hash from it and asks storage for that `ContractCode` entry before it runs the code
// (soroban-env-host `storage.rs`, `host/frame.rs` `instantiate_vm`, read 2026-11-23). So when the footprint declares
// exactly one `ContractCode` entry, any Wasm the transaction runs is that code, or the transaction fails: the binding is
// enforced when it runs, not read before. None or several distinct is no code hash (the label can't be tied to one).
//
// NEAR has no such list: the vault reads the receiver's code hash from both of its providers (vault/partner-labels.ts
// `agreedCodeHash`).
import type { StellarLedgerKey, StellarTransaction } from '../decode/stellar.ts';

const codeKeys = (keys: readonly StellarLedgerKey[]): string[] => keys.flatMap((k) => (k.type === 'contractCode' ? [k.hash] : []));

/**
 * The one Wasm hash (64 lowercase hex) a Soroban transaction's footprint lets it run, or null: no `sorobanData`, no
 * `ContractCode` entry, or more than one distinct.
 */
export function sorobanFootprintCode(tx: StellarTransaction): string | null {
  const s = tx.soroban;
  if (!s) return null;
  const hashes = new Set(codeKeys([...s.readOnly, ...s.readWrite]));
  return hashes.size === 1 ? [...hashes][0]! : null;
}

/**
 * Whether a Soroban transaction can change nothing but `contract`'s own stored data: every read-write entry of its
 * footprint is a `contractData` entry of that contract (so no account, trust line, code or other contract's data, and
 * no balance in XLM, a classic asset or another contract's token). False without `sorobanData`.
 */
export function sorobanWritesOnlyOwn(tx: StellarTransaction, contract: string): boolean {
  const s = tx.soroban;
  if (!s) return false;
  return s.readWrite.every((k) => k.type === 'contractData' && k.contract === contract);
}
