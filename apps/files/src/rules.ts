// What the files Worker serves and how (docs/batch-c-spec.md "Other app settings, name and logo", "Response headers"):
// plain values, no Workers types, so the Node-side config and source tests read the same constants.

/** The only path served: the key the console writes, `logos/<app id>/<sha256 hex>.png` (console-core LOGO_KEY_RE). */
export const LOGO_PATH_RE = /^\/(logos\/app_[A-Za-z0-9]{1,64}\/([0-9a-f]{64})\.png)$/u;

/** The console's output cap (docs/batch-c-spec.md: the re-encoded PNG is ≤ 128 KiB); anything larger isn't one of ours. */
export const LOGO_MAX_BYTES = 128 * 1024;

/** The PNG file signature. */
export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** A logo's headers, exactly as the spec lists them. */
export const LOGO_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'image/png',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
  'content-disposition': 'inline; filename="logo.png"',
  'cache-control': 'public, max-age=31536000, immutable',
  'referrer-policy': 'no-referrer',
});

/**
 * The mail logo's headers (D685): a logo's, under its own file name. No cookie, a year's immutable caching (the path
 * names the image's hash), cross-origin CORP so mail clients' image proxies may fetch it.
 */
export const MAIL_LOGO_HEADERS: Readonly<Record<string, string>> = Object.freeze({ ...LOGO_HEADERS, 'content-disposition': 'inline; filename="hana.png"' });
