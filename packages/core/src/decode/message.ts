// Message display for `personal_sign` (EIP-191) and `stellar_signMessage` (SEP-53). The approval page shows the text
// when the bytes are clean UTF-8, and the hex otherwise, so invisible or direction-changing characters can't make a
// message read differently from what is signed.
import { toHex0x } from './hex.ts';

export interface DecodedMessage {
  /** The message as text, or null when it isn't valid UTF-8 or holds control, bidi or other invisible characters. */
  readonly text: string | null;
  /** The exact bytes, `0x` hex (always shown when `text` is null). */
  readonly hex: string;
  readonly length: number;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// C0 controls except \t \n \r, DEL and C1 controls, bidi controls (U+061C, U+200E/F, U+202A–U+202E, U+2066–U+2069),
// zero-width and other format characters (U+200B–U+200D, U+2060–U+2064, U+FEFF), and line/paragraph separators.
const UNSAFE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;

export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  let text: string | null;
  try {
    text = utf8Decoder.decode(bytes);
    if (UNSAFE.test(text)) text = null;
  } catch {
    text = null;
  }
  return Object.freeze({ text, hex: toHex0x(bytes), length: bytes.length });
}
