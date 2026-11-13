// The stamps contract (contracts/hana-stamps) on the mocked testnet, for the stamps site's e2e spec: its views
// (`get_passport`, `recent`, `totals`, `catalog`) as the spec defines them, and `collect` with every rule the contract
// enforces, applied when the test's mocked relayer (or an own-fare transaction) delivers a call. `signature`'s proof is
// verified as the contract does, for real: ed25519 over sha256(NEP-413 payload) with the caller's implicit account as
// the public key, so the e2e run proves the site's proof is the one the contract accepts.
import { ed25519 } from '@noble/curves/ed25519';
import { base64Decode, encodeNep413Message, fromHex, nep413Hash } from '@hana-id/core';

export const STAMP_CATALOG = ['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover'] as const;

export interface StoredStamp {
  stamp: string;
  block_timestamp_ms: number;
  sponsored: boolean;
  note?: string;
}

/** Rust's `str::trim` (Unicode White_Space), as the contract trims a note. */
const trimLikeRust = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

export class StampsContract {
  readonly passports = new Map<string, StoredStamp[]>();
  readonly ring: { account_id: string; stamp: string; block_timestamp_ms: number }[] = [];

  constructor(
    readonly account: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `collect` from `sender`; `sponsored`: the call came in a relayed delegate action. Returns the panic, or null. */
  collect(sender: string, sponsored: boolean, args: Record<string, unknown>): string | null {
    const stamp = String(args.stamp);
    const held = this.passports.get(sender) ?? [];
    if (!(STAMP_CATALOG as readonly string[]).includes(stamp)) return 'ERR_UNKNOWN_STAMP';
    if (stamp !== 'arrival' && !held.some((s) => s.stamp === 'arrival')) return 'ERR_NO_ARRIVAL';
    if (held.some((s) => s.stamp === stamp)) return 'ERR_ALREADY';
    if (stamp === 'sponsored' && !sponsored) return 'ERR_NOT_SPONSORED';
    if (stamp === 'own_fare' && sponsored) return 'ERR_NOT_OWN_FARE';
    let note: string | undefined;
    if (stamp === 'postcard') {
      note = typeof args.note === 'string' ? trimLikeRust(args.note) : '';
      if ([...note].length < 1 || [...note].length > 140) return 'ERR_BAD_NOTE';
    }
    if (stamp === 'signature') {
      if (!/^[0-9a-f]{64}$/u.test(sender)) return 'ERR_NOT_IMPLICIT';
      if (!this.#proofOk(sender, args.proof)) return 'ERR_BAD_PROOF';
    }
    if (stamp === 'layover') {
      const arrival = held.find((s) => s.stamp === 'arrival')!;
      if (this.now() < arrival.block_timestamp_ms + 120_000) return 'ERR_TOO_SOON';
    }
    const s: StoredStamp = { stamp, block_timestamp_ms: this.now(), sponsored, ...(note !== undefined ? { note } : {}) };
    this.passports.set(sender, [...held, s]);
    this.ring.push({ account_id: sender, stamp, block_timestamp_ms: s.block_timestamp_ms });
    if (this.ring.length > 100) this.ring.shift();
    return null;
  }

  #proofOk(sender: string, proof: unknown): boolean {
    if (typeof proof !== 'object' || proof === null) return false;
    const p = proof as Record<string, unknown>;
    if (p.message !== `Stamp my passport: ${sender}` || p.recipient !== this.account || typeof p.nonce !== 'string' || typeof p.signature !== 'string') return false;
    try {
      const nonce = base64Decode(p.nonce);
      const signature = base64Decode(p.signature);
      if (nonce.length !== 32 || signature.length !== 64) return false;
      const payload = encodeNep413Message({ message: p.message, nonce, recipient: p.recipient, callbackUrl: null });
      return ed25519.verify(signature, nep413Hash(payload), fromHex(sender));
    } catch {
      return false;
    }
  }

  /** A view's answer, or undefined for a method the contract doesn't have. */
  view(method: string, args: Record<string, unknown>): unknown {
    if (method === 'get_passport') {
      const stamps = this.passports.get(String(args.account_id));
      return stamps ? { account_id: args.account_id, stamps } : null;
    }
    if (method === 'recent') {
      const from = Math.max(0, Number(args.from_index ?? 0));
      const limit = Math.min(Math.max(0, Number(args.limit ?? 50)), 50);
      return [...this.ring].reverse().slice(from, from + limit);
    }
    if (method === 'totals') return { passports: this.passports.size, stamps: [...this.passports.values()].reduce((n, s) => n + s.length, 0) };
    if (method === 'catalog') return [...STAMP_CATALOG];
    return undefined;
  }
}
