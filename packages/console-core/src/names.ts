// App names as the API stores them (docs/batch-c-spec.md "Other app settings, name and logo": ≤ 64 characters, the
// batch B label rules). The name is shown beside the verified origin in the consent and approval popups, so it must be
// one display-safe line: the property-based rule of @hana-id/core `isDisplaySafeLine` (display-safe.ts), copied here
// because the Worker can't typecheck @hana-id/core's root entry; test/names.test.ts checks the two agree on every code
// point.
const INVISIBLE = String.raw`\p{Cf}\p{Co}\p{Zl}\p{Zp}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{e0100}-\u{e01ef}`;
const UNSAFE_LINE = new RegExp(String.raw`[\p{Cc}${INVISIBLE}]`, 'u');

/** One-line text with no control, format (bidi, zero-width), private-use, separator or other invisible character. */
export const isDisplaySafeName = (text: string): boolean => !UNSAFE_LINE.test(text);

/** The longest app name, in code points, after NFC and trimming. */
export const APP_NAME_MAX = 64;

/** The stored form of an app name (NFC, trimmed), or why it is refused. */
export function normaliseAppName(input: string): { ok: true; name: string } | { ok: false; problem: string } {
  const name = input.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > APP_NAME_MAX) return { ok: false, problem: `The name must be 1..${APP_NAME_MAX} characters` };
  if (!isDisplaySafeName(name)) return { ok: false, problem: 'The name has a control, format (bidi, zero-width), separator or other invisible character' };
  return { ok: true, name };
}
