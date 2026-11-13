// The stamps contract (contracts/hana-stamps) on the mocked testnet, for the stamps site's e2e spec: its views
// (`get_passport`, `recent`, `totals`, `catalog`) and `collect`, as the real contract's src/lib.rs and README.md define
// them: the same checks in the same order with the same panic messages, the stamps in the order collected, `note` only
// on a postcard, `sponsored` on every stamp, `recent` newest first with its limit clamped to 50. `signature`'s proof is
// verified as the contract does, for real: ed25519 over sha256(NEP-413 payload, no callback URL) with the caller's
// implicit account as the public key, so the e2e run proves the site's proof is the one the contract accepts.
// apps/api/test-sandbox/stamps-site.test.ts runs this model and the deployed wasm side by side on the same calls and
// requires the same answers, so the mock can't drift from the contract unnoticed.
import { ed25519 } from '@noble/curves/ed25519';
import { base64Decode, encodeNep413Message, fromHex, nep413Hash } from '@hana-id/core';

export const STAMP_CATALOG = ['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover'] as const;

/** near-sdk's panic for arguments that don't deserialise (a non-string `stamp`, a proof without its four strings). */
export const DESERIALIZE_PANIC = 'Failed to deserialize input from JSON.';

export interface StoredStamp {
  stamp: string;
  block_timestamp_ms: number;
  sponsored: boolean;
  note?: string;
}

/** Rust's `str::trim` (Unicode White_Space), as the contract trims a note. */
const trimLikeRust = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

/** JSON null and an absent field are both Rust's None. */
const absent = (v: unknown): boolean => v === undefined || v === null;

/** Standard padded base64 of exactly `n` bytes (the contract checks the encoded length first), else null. */
function base64Exact(text: string, n: number): ReturnType<typeof base64Decode> | null {
  if (text.length !== Math.ceil(n / 3) * 4) return null;
  try {
    const bytes = base64Decode(text);
    return bytes.length === n ? bytes : null;
  } catch {
    return null;
  }
}

export class StampsContract {
  readonly passports = new Map<string, StoredStamp[]>();
  readonly ring: { account_id: string; stamp: string; block_timestamp_ms: number }[] = [];
  #totalPassports = 0;
  #totalStamps = 0;

  constructor(
    readonly account: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * `collect` from `sender` (the predecessor); `sponsored`: the transaction's signer is not the sender (a relayed
   * delegate action). Returns the panic message, or null when the stamp was stored.
   */
  collect(sender: string, sponsored: boolean, args: Record<string, unknown>): string | null {
    // Deserialisation first, as near-sdk does: `stamp` a string, `note` a string or none, `proof` four strings or none.
    if (typeof args.stamp !== 'string') return DESERIALIZE_PANIC;
    if (!absent(args.note) && typeof args.note !== 'string') return DESERIALIZE_PANIC;
    const proof = args.proof;
    if (!absent(proof)) {
      if (typeof proof !== 'object' || Array.isArray(proof)) return DESERIALIZE_PANIC;
      const p = proof as Record<string, unknown>;
      if (!['message', 'nonce', 'recipient', 'signature'].every((k) => typeof p[k] === 'string')) return DESERIALIZE_PANIC;
    }
    const stamp = args.stamp;
    if (!(STAMP_CATALOG as readonly string[]).includes(stamp)) return 'ERR_UNKNOWN_STAMP';
    // Arguments that belong to another stamp.
    if (!absent(args.note) && stamp !== 'postcard') return 'ERR_BAD_NOTE';
    if (!absent(proof) && stamp !== 'signature') return 'ERR_BAD_PROOF';
    const held = this.passports.get(sender);
    if (stamp === 'arrival' && held) return 'ERR_ALREADY';
    if (stamp !== 'arrival' && !held) return 'ERR_NO_ARRIVAL';
    if (held?.some((s) => s.stamp === stamp)) return 'ERR_ALREADY';
    let note: string | undefined;
    const implicit = /^[0-9a-f]{64}$/u.test(sender);
    switch (stamp) {
      case 'sponsored':
        if (!sponsored) return 'ERR_NOT_SPONSORED';
        break;
      case 'own_fare':
        if (sponsored) return 'ERR_NOT_OWN_FARE';
        break;
      case 'signature':
        // A named account can't collect it at all, with or without a proof.
        if (!implicit) return 'ERR_NOT_IMPLICIT';
        if (absent(proof) || !this.#proofOk(sender, proof as Record<string, string>)) return 'ERR_BAD_PROOF';
        break;
      case 'postcard': {
        note = trimLikeRust(typeof args.note === 'string' ? args.note : '');
        const chars = [...note].length;
        if (chars < 1 || chars > 140) return 'ERR_BAD_NOTE';
        break;
      }
      case 'layover': {
        const arrived = held![0]!.block_timestamp_ms;
        if (this.now() - arrived < 120_000) return 'ERR_TOO_SOON';
        break;
      }
      default:
        break;
    }
    const s: StoredStamp = { stamp, block_timestamp_ms: this.now(), sponsored, ...(note !== undefined ? { note } : {}) };
    this.passports.set(sender, [...(held ?? []), s]);
    if (stamp === 'arrival') this.#totalPassports++;
    this.#totalStamps++;
    this.ring.push({ account_id: sender, stamp, block_timestamp_ms: s.block_timestamp_ms });
    if (this.ring.length > 100) this.ring.shift();
    return null;
  }

  #proofOk(sender: string, p: Record<string, string>): boolean {
    if (p.recipient !== this.account || p.message !== `Stamp my passport: ${sender}`) return false;
    const nonce = base64Exact(p.nonce!, 32);
    const signature = base64Exact(p.signature!, 64);
    if (!nonce || !signature) return false;
    try {
      const payload = encodeNep413Message({ message: p.message, nonce, recipient: p.recipient!, callbackUrl: null });
      return ed25519.verify(signature, nep413Hash(payload), fromHex(sender));
    } catch {
      return false;
    }
  }

  /** A view's answer, or undefined for a method the contract doesn't have. */
  view(method: string, args: Record<string, unknown>): unknown {
    if (method === 'get_passport') {
      const stamps = this.passports.get(String(args.account_id));
      return stamps ? { account_id: args.account_id, stamps: stamps.map((s) => ({ ...s })) } : null;
    }
    if (method === 'recent') {
      const from = Math.max(0, Number(args.from_index ?? 0));
      const limit = Math.min(Math.max(0, Number(args.limit ?? 50)), 50);
      return [...this.ring].reverse().slice(from, from + limit);
    }
    if (method === 'totals') return { passports: this.#totalPassports, stamps: this.#totalStamps };
    if (method === 'catalog') return [...STAMP_CATALOG];
    return undefined;
  }
}
