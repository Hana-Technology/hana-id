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
//
// The one shared module for these checks in the workspace: also served on the subpath `@hana-id/core/display-safe`
// (it imports nothing, so a Worker or the manifest package uses it without the root entry). The app-name rule, the
// email issuer and the manifest's operator names call it instead of keeping copies. Escapes only, so this source holds
// no invisible character.

// The invisible characters, as the body of a character class (for a `u` RegExp): format characters (bidi controls,
// zero-width characters, tags), private use, line and paragraph separators, and the other default-ignorable code points
// (the combining grapheme joiner, the Hangul fillers, the Khmer inherent vowels, the Mongolian selectors, every
// variation selector). Controls are not in it: each rule says which ones it allows.
const INVISIBLE_CHARS = String.raw`\p{Cf}\p{Co}\p{Zl}\p{Zp}\u{34f}\u{115f}\u{1160}\u{17b4}\u{17b5}\u{180b}-\u{180f}\u{3164}\u{fe00}-\u{fe0f}\u{ffa0}\u{e0100}-\u{e01ef}`;

// The controls multi-line text may not hold, as a character-class body: every one but tab, LF and CR.
const CONTROLS_BUT_TAB_LF_CR = String.raw`\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}`;
const UNSAFE_MULTILINE = new RegExp(`[${CONTROLS_BUT_TAB_LF_CR}${INVISIBLE_CHARS}]`, 'u');
const UNSAFE_LINE = new RegExp(String.raw`[\p{Cc}${INVISIBLE_CHARS}]`, 'u');

/** Multi-line text (signed messages, Soroban and ABI strings, memos): safe to show as is. Tab, LF and CR are allowed. */
export const isDisplaySafeText = (text: string): boolean => !UNSAFE_MULTILINE.test(text);

/** One-line text (app names, policy labels and contract names): no control character at all. */
export const isDisplaySafeLine = (text: string): boolean => !UNSAFE_LINE.test(text);
