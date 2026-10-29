// The one display-safety rule (sweep AUTH-5, merged with CORE-4; AUTH-2 for app names): which text the Hana popups show
// as text and which they show as hex (or refuse). Property-based rather than a hand-written range list, so it covers
// every invisible or direction-changing code point Unicode classes as such:
// - controls (Cc), except \t \n \r in multi-line text (messages);
// - format characters (Cf): bidi controls and isolates, zero-width characters, U+00AD, U+061C, U+180E, U+206A–U+206F,
//   U+FEFF, U+FFF9–U+FFFB, the tag characters U+E0000–U+E007F, U+1D173–U+1D17A, …;
// - private use (Co), and line and paragraph separators (Zl, Zp);
// - the other default-ignorable code points: U+034F, the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, U+17B4,
//   U+17B5, the Mongolian selectors U+180B–U+180F, and every variation selector (U+FE00–U+FE0F, U+E0100–U+E01EF).
// Unassigned code points (Cn) aren't refused: what is unassigned depends on the engine's Unicode version, and the
// policy validator must answer the same in the CLI, the API and every browser. An emoji with a variation selector
// (U+FE0F) is shown as hex: variation selectors can also smuggle data into text that looks plain.
const INVISIBLE = String.raw`\p{Cf}\p{Co}\p{Zl}\p{Zp}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{e0100}-\u{e01ef}`;
const UNSAFE_MULTILINE = new RegExp(String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f${INVISIBLE}]`, 'u');
const UNSAFE_LINE = new RegExp(String.raw`[\p{Cc}${INVISIBLE}]`, 'u');

/** Multi-line text (signed messages, Soroban and ABI strings, memos): safe to show as is. Tab, LF and CR are allowed. */
export const isDisplaySafeText = (text: string): boolean => !UNSAFE_MULTILINE.test(text);

/** One-line text (app names, policy labels and contract names): no control character at all. */
export const isDisplaySafeLine = (text: string): boolean => !UNSAFE_LINE.test(text);
