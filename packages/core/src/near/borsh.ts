// A strict borsh reader and writer for the NEAR codec (codec.ts): every read checks the bytes are there, an option or
// enum tag is one the schema defines, strings are valid UTF-8, and the caller checks nothing is left over. Borsh is
// canonical under these rules (one encoding per value), so a decoded value encodes back to the same bytes.
import { type Bytes, concatBytes, toBytes } from '../bytes.ts';
import { fail } from '../decode/errors.ts';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();
// Without the `u` flag a regex sees UTF-16 code units, so this finds a surrogate that is not half of a pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class BorshReader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.at;
  }

  get offset(): number {
    return this.at;
  }

  private take(n: number, what: string): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) fail('malformed', `NEAR borsh: ${what} runs past the end`);
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  u8(what: string): number {
    return this.take(1, what)[0]!;
  }

  u32(what: string): number {
    const b = this.take(4, what);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  u64(what: string): bigint {
    const b = this.take(8, what);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }

  u128(what: string): bigint {
    const b = this.take(16, what);
    const v = new DataView(b.buffer, b.byteOffset, 16);
    return (v.getBigUint64(8, true) << 64n) | v.getBigUint64(0, true);
  }

  /** A fixed-length byte array, copied out. */
  fixed(n: number, what: string): Bytes {
    return toBytes(this.take(n, what));
  }

  /** `Vec<u8>`: u32 length, then the bytes (copied). */
  vecU8(what: string, max = Number.MAX_SAFE_INTEGER): Bytes {
    const n = this.u32(`${what} length`);
    if (n > max) fail('too_large', `NEAR borsh: ${what} is over ${max} bytes`);
    return this.fixed(n, what);
  }

  /** `String`: u32 length, then strict UTF-8. */
  string(what: string, max = Number.MAX_SAFE_INTEGER): string {
    const n = this.u32(`${what} length`);
    if (n > max) fail('too_large', `NEAR borsh: ${what} is over ${max} bytes`);
    const raw = this.take(n, what);
    try {
      return utf8Decoder.decode(raw);
    } catch {
      return fail('malformed', `NEAR borsh: ${what} is not valid UTF-8`);
    }
  }

  /** A `Vec<T>` length, refused over `max` items (or when even one-byte items couldn't fit). */
  vecLength(what: string, max: number): number {
    const n = this.u32(`${what} count`);
    if (n > max) fail('too_large', `NEAR borsh: more than ${max} ${what}`);
    if (n > this.remaining) fail('malformed', `NEAR borsh: ${what} run past the end`);
    return n;
  }

  /** `Option<T>`'s tag: only 0 (None) and 1 (Some). */
  option(what: string): boolean {
    const t = this.u8(`${what} option tag`);
    if (t > 1) fail('malformed', `NEAR borsh: ${what} has option tag ${t}`);
    return t === 1;
  }

  /** Throws unless every byte was read. */
  end(what: string): void {
    if (this.remaining !== 0) fail('malformed', `NEAR borsh: ${this.remaining} trailing bytes after the ${what}`);
  }
}

export class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError('Not a u8');
    this.parts.push(Uint8Array.of(n));
    return this;
  }

  u32(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('Not a u32');
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.parts.push(b);
    return this;
  }

  u64(n: bigint): this {
    if (typeof n !== 'bigint' || n < 0n || n >= 1n << 64n) throw new RangeError('Not a u64');
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    this.parts.push(b);
    return this;
  }

  u128(n: bigint): this {
    if (typeof n !== 'bigint' || n < 0n || n >= 1n << 128n) throw new RangeError('Not a u128');
    const b = new Uint8Array(16);
    const v = new DataView(b.buffer);
    v.setBigUint64(0, n & ((1n << 64n) - 1n), true);
    v.setBigUint64(8, n >> 64n, true);
    this.parts.push(b);
    return this;
  }

  fixed(bytes: Uint8Array, n: number): this {
    if (bytes.length !== n) throw new RangeError(`Expected ${n} bytes`);
    this.parts.push(Uint8Array.from(bytes));
    return this;
  }

  vecU8(bytes: Uint8Array): this {
    return this.u32(bytes.length).fixed(bytes, bytes.length);
  }

  string(s: string): this {
    // TextEncoder turns a lone surrogate into U+FFFD silently: two different strings would encode the same.
    if (typeof s !== 'string' || LONE_SURROGATE.test(s)) throw new RangeError('Not a well-formed string');
    const b = utf8Encoder.encode(s);
    return this.u32(b.length).fixed(b, b.length);
  }

  raw(bytes: Uint8Array): this {
    this.parts.push(Uint8Array.from(bytes));
    return this;
  }

  bytes(): Bytes {
    return concatBytes(...this.parts);
  }
}
