// The build id (D384): which commit each deployed piece of an env was built from, so `deploy-check <env>`
// (scripts/lib/deploy-check.ts) can tell after a deploy whether the API, the email issuer, both page Workers and the
// page bundles they serve all run the same code. On 2026-11-05 sandbox-dev's page Workers served a stale vault build
// that the new API refused (400 on every wallet record), and nothing showed it.
//
// The id is the commit's first 12 hex characters, with `-dirty` when the working tree had uncommitted changes (tracked
// or untracked; ignored files aside), e.g. `0485faa1c2d3` or `0485faa1c2d3-dirty`. It is public: it names a commit of
// a private repository and nothing else (no build time, so a rebuild of one commit is byte-identical, and no path,
// user or host). Where it lives:
// - the Workers: the plain-text var HANA_BUILD (BUILD_VAR), set only at deploy time by each app's `deploy` script
//   (`wrangler deploy --var HANA_BUILD:<id>`, ./local-build.ts), never by `gen`, so a raw `wrangler deploy` leaves it
//   unset and the check reports that Worker as unstamped instead of trusting a stale value;
// - the page bundles, at build time (packages/web scripts): the vault's `/vault.js` starts with VAULT_BANNER, each auth
//   page's HTML carries `<meta name="hana-build">`, so the check confirms the assets themselves, not only the Worker
//   script that serves them (the stale part on 2026-11-05).
// Read from: the API's `GET /v1/health` and the issuer's `GET /v1/email/health` (`build`), each page Worker's
// `GET /.well-known/hana-build` (BUILD_PATH), `{vaultOrigin}/vault.js` and `{authOrigin}/login`.
//
// No Node import here: the Workers' tests and the page builds share these constants; ./local-build.ts reads git.

/** A build id: 12 lowercase hex characters of the commit, then `-dirty` for a tree with uncommitted changes. */
export const BUILD_ID_RE = /^[0-9a-f]{12}(?:-dirty)?$/u;
/** Characters of the commit hash in a build id. */
export const BUILD_COMMIT_CHARS = 12;
/** The Worker var holding the build id (absent: deployed without the `deploy` script). */
export const BUILD_VAR = 'HANA_BUILD';
/** Each page Worker's build endpoint: `{"build": "<id>" | null}`. */
export const BUILD_PATH = '/.well-known/hana-build';
/** The email issuer's health endpoint, under its `emailIssuer.url`. */
export const ISSUER_HEALTH_PATH = '/v1/email/health';
/** The `<meta name>` of the build id in each auth page. */
export const BUILD_META_NAME = 'hana-build';

export interface BuildId {
  /** The whole id, as stamped. */
  id: string;
  /** The commit's first BUILD_COMMIT_CHARS hex characters. */
  commit: string;
  /** Built from a tree with uncommitted changes: not exactly any commit. */
  dirty: boolean;
}

/** The id for a commit (its full or abbreviated hash, at least 12 hex characters) and the tree's state. */
export function formatBuildId(commit: string, dirty: boolean): string {
  if (!/^[0-9a-f]{12,64}$/u.test(commit)) throw new Error('A commit hash is 12 to 64 lowercase hex characters');
  return `${commit.slice(0, BUILD_COMMIT_CHARS)}${dirty ? '-dirty' : ''}`;
}

/** A well-formed build id, parsed; anything else (absent, empty, another shape) is null. */
export function parseBuildId(value: unknown): BuildId | null {
  if (typeof value !== 'string' || !BUILD_ID_RE.test(value)) return null;
  return { id: value, commit: value.slice(0, BUILD_COMMIT_CHARS), dirty: value.endsWith('-dirty') };
}

/** Throws unless `id` is a build id: it is written into a JS comment and an HTML attribute, so nothing else may reach them. */
export function assertBuildId(id: string): string {
  if (!BUILD_ID_RE.test(id)) throw new Error('Not a build id (12 hex characters, optionally -dirty)');
  return id;
}

/** The first line of `/vault.js` (esbuild `banner`): kept by minification, read by `parseVaultBanner`. */
export function vaultBanner(id: string): string {
  return `/* hana-build ${assertBuildId(id)} */`;
}

/** The build id from the start of a vault bundle, or null when it has no well-formed banner. */
export function parseVaultBanner(js: string): BuildId | null {
  const m = /^\/\* hana-build ([^\s*]{1,64}) \*\//u.exec(js);
  return m ? parseBuildId(m[1]) : null;
}

/** The auth pages' `<meta>` element. */
export function buildMeta(id: string): string {
  return `<meta name="${BUILD_META_NAME}" content="${assertBuildId(id)}">`;
}

/** The build id from an auth page's HTML (its one `<meta name="hana-build">`), or null when absent, repeated or malformed. */
export function parseBuildMeta(html: string): BuildId | null {
  const all = [...html.matchAll(/<meta name="hana-build" content="([^"]{0,64})">/gu)];
  return all.length === 1 ? parseBuildId(all[0]![1]) : null;
}
