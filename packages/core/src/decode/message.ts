// Message display for `personal_sign` (EIP-191) and `stellar_signMessage` (SEP-53). The approval page shows the text
// when the bytes are clean UTF-8, and the hex otherwise, so invisible or direction-changing characters can't make a
// message read differently from what is signed.
import { isDisplaySafeText } from '../display-safe.ts';
import { toHex0x } from './hex.ts';

/**
 * True when `text` can be shown as is (display-safe.ts: no control other than \t \n \r, no format, bidi, invisible or
 * other default-ignorable character). The approval page shows the hex of any text that fails this (messages, Stellar
 * strings, memos, home domains and data names, ABI and EIP-712 strings).
 */
export { isDisplaySafeText };

export interface DecodedMessage {
  /** The message as text, or null when it isn't valid UTF-8 or holds control, bidi or other invisible characters. */
  readonly text: string | null;
  /** The exact bytes, `0x` hex (always shown when `text` is null). */
  readonly hex: string;
  readonly length: number;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  let text: string | null;
  try {
    text = utf8Decoder.decode(bytes);
    if (!isDisplaySafeText(text)) text = null;
  } catch {
    text = null;
  }
  return Object.freeze({ text, hex: toHex0x(bytes), length: bytes.length });
}
