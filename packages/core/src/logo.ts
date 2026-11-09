// App logos (docs/batch-c-spec.md "Other app settings, name and logo", batch C11): a re-encoded 256 × 256 PNG on Hana's
// files origin at `<files origin>/logos/<app id>/<sha256 hex>.png`, which `GET /v1/app` answers as `logoUrl` and the
// auth pages show beside the app's name. Hana's popups never show a partner-hosted image (D74): a page shows a logo
// only when its URL has exactly this shape on the files origin its build pins, and its CSP `img-src` names that origin
// alone besides 'self' and data:.

/** The path of a logo on the files origin, the only path Hana's files Worker serves. */
export const LOGO_PATH_RE = /^\/logos\/app_[A-Za-z0-9]{1,64}\/[0-9a-f]{64}\.png$/u;

/** The longest logo URL a message may carry (an origin of up to 512 characters plus the path). */
export const LOGO_URL_MAX = 700;

/**
 * Whether `v` is a logo URL in canonical form: http(s), no credentials, query or fragment, and the logo path. The
 * protocol checks the shape only; where it is shown, `logoUrlOn` also pins the origin.
 */
export function isLogoUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > LOGO_URL_MAX) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return false;
  return LOGO_PATH_RE.test(u.pathname) && `${u.origin}${u.pathname}` === v;
}

/**
 * `v` when it is a logo URL on `filesOrigin` (and, with `appId`, that app's), else null: no files origin in this build,
 * no logo, or a value that isn't one. A logo is decoration, so a bad value is dropped (the name is shown alone), never
 * an error.
 */
export function logoUrlOn(filesOrigin: string | undefined, v: unknown, appId?: string): string | null {
  if (!filesOrigin || !isLogoUrl(v)) return null;
  const u = new URL(v);
  if (u.origin !== filesOrigin) return null;
  if (appId !== undefined && !u.pathname.startsWith(`/logos/${appId}/`)) return null;
  return v;
}
