// Hana Home's identity and its API calls (the Home page, auth/home-page.ts).
//
// A Home identity is a key made for one sign-in (`hk`, a non-extractable Ed25519 key), a salt and an end 15 minutes
// away, with a token whose nonce commits to all three (core home.ts `homeNonce`). Every Home API call carries
// `x-hana-home`: the token, the public key, the end, the salt, a counter never used before with this key, and the key's
// signature over the request (`homeMessage`: method, path and query, body). The API answers who the user is from that
// alone: no cookie, no stored account.
//
// SECURITY: the identity lives in this module's memory only. Nothing here writes it, the token or a counter to storage,
// a URL or a log, and an error never carries the header. A new sign-in is a new key: a key is never reused across
// sign-ins (its signed message doesn't carry the end).
import {
  ApiError,
  HOME_IDENTITY_HEADER,
  HOME_IDENTITY_LIFETIME_MS,
  HOME_SALT_BYTES,
  SUPPORT_ID_RE,
  encodeHomeIdentity,
  homeMessage,
  homeNonce,
  homeRequestPath,
  isDisplaySafeLine,
  isEvmAddress,
  isLoginResponse,
  isNearAccountId,
  isOrigin,
  isScopeId,
  isStellarAddress,
  newSessionKey,
  parseApiResponse,
  randomBytes,
} from '@hana-id/core';
import type { LoginBody, LoginResponse } from '@hana-id/core';
import type { Fetch } from './api.ts';

/** `GET /v1/home/config`: what the page needs before a sign-in. */
export interface HomeConfig {
  serverTimeMs: number;
  signer: string;
  /** The Google client the Home sign-in uses, or null when none is in force. */
  sharedGoogleClientId: string | null;
  /** The client Home falls back to for an app whose own sign-in is gone (the per-app sign-in's, not used here). */
  exitGoogleClientId: string | null;
}

export const HOME_COVERAGES = ['shared', 'hana_client', 'exit', 'partner_client', 'email', 'none', 'unknown'] as const;
/** Whether, and by which route, Hana can still open a wallet of this app for the signed-in user. `unknown`: not checked yet. */
export type HomeCoverage = (typeof HOME_COVERAGES)[number];

export type HomeAppStatus = 'active' | 'suspended' | 'deleted';

/** One app of a listing. Every string here is partner-supplied: shown as text, never as markup or a link. */
export interface HomeApp {
  appId: string;
  /** As `homeAppName` leaves it: display-safe and at most `HOME_NAME_SHOWN` characters, or Hana's stand-in. */
  name: string;
  status: HomeAppStatus;
  environment: 'test' | 'live';
  origins: string[];
  /** A logo URL as the API sent it; shown only when it is on this build's files origin (auth/logo.ts). */
  logoUrl: string | null;
}

export interface HomeAddress {
  chain: 'stellar' | 'evm';
  address: string;
}

/** One listing: the apps that share a wallet. */
export interface HomeScope {
  scopeId: string;
  /** The signed-in user has a wallet on record here. */
  mine: boolean;
  coverage: HomeCoverage;
  googleClientId: string | null;
  /** `HANA-XXXX-XXXX`, only when the API has one for this user here. */
  supportId: string | null;
  /** The user's addresses on record here; empty when there are none. */
  addresses: HomeAddress[];
  apps: HomeApp[];
}

export interface HomeAppsPage {
  scopes: HomeScope[];
  nextCursor: string | null;
}

/** Which page of the listing to read: at most one of these, as the API takes them. */
export type HomeAppsQuery = { kind: 'first' } | { kind: 'cursor'; cursor: string } | { kind: 'search'; term: string } | { kind: 'scope'; scopeId: string } | { kind: 'app'; appId: string };

/** The bounds the API promises (apps a listing, origins an app), enforced again here so a bad answer can't flood the page. */
export const HOME_MAX_SCOPES = 64;
export const HOME_MAX_APPS = 10;
export const HOME_MAX_ORIGINS = 5;
export const HOME_NAME_MAX = 200;
/** How much of an app's name the page shows, in characters; a longer one ends in "…". */
export const HOME_NAME_SHOWN = 60;
/** What stands in for a name the page won't show (empty, too long, or with a control, bidi or invisible character). */
export const HOME_UNNAMED_APP = 'Unnamed app';

/**
 * An app's name as the page shows it. The name is the partner's own words on Hana's origin, so it is held to the one
 * display-safety rule (no control, direction-changing or invisible character) and cut short; a name that fails is
 * replaced by Hana's own words, never shown. The app stays listed either way: a user's wallet is never hidden by it.
 */
export function homeAppName(v: unknown): string {
  if (typeof v !== 'string') return HOME_UNNAMED_APP;
  const name = v.trim();
  if (name.length === 0 || name.length > HOME_NAME_MAX || !isDisplaySafeLine(name)) return HOME_UNNAMED_APP;
  const chars = [...name];
  return chars.length <= HOME_NAME_SHOWN ? name : `${chars.slice(0, HOME_NAME_SHOWN).join('').trimEnd()}…`;
}
/** A search term, in characters, after trimming (the API's bounds). */
export const HOME_SEARCH_MIN = 2;
export const HOME_SEARCH_MAX = 64;
export const HOME_APP_ID = /^app_[A-Za-z0-9_-]{1,64}$/u;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (what: string): ApiError => new ApiError(502, 'bad_response', `Unexpected ${what} response`, null, null);
const clientId = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && v.length >= 1 && v.length <= 256 ? v : undefined);

function parseApp(v: unknown): HomeApp | null {
  if (!isObj(v)) return null;
  if (typeof v.appId !== 'string' || !HOME_APP_ID.test(v.appId)) return null;
  if (v.status !== 'active' && v.status !== 'suspended' && v.status !== 'deleted') return null;
  if (v.environment !== 'test' && v.environment !== 'live') return null;
  if (!Array.isArray(v.origins)) return null;
  // An origin that isn't one is dropped, never shown: it is only ever text, but it should at least be an origin.
  const origins = v.origins.filter((o): o is string => isOrigin(o)).slice(0, HOME_MAX_ORIGINS);
  return { appId: v.appId, name: homeAppName(v.name), status: v.status, environment: v.environment, origins, logoUrl: typeof v.logoUrl === 'string' && v.logoUrl.length <= 512 ? v.logoUrl : null };
}

function parseAddresses(v: unknown): HomeAddress[] {
  if (!Array.isArray(v)) return [];
  const out: HomeAddress[] = [];
  for (const a of v) {
    if (!isObj(a) || typeof a.address !== 'string') continue;
    // One address a chain, of that chain's form; anything else is left out rather than shown as an address.
    if (a.chain === 'stellar' && isStellarAddress(a.address) && !out.some((x) => x.chain === 'stellar')) out.push({ chain: 'stellar', address: a.address });
    else if (a.chain === 'evm' && isEvmAddress(a.address) && !out.some((x) => x.chain === 'evm')) out.push({ chain: 'evm', address: a.address });
  }
  return out;
}

function parseScope(v: unknown): HomeScope | null {
  if (!isObj(v) || !isScopeId(v.scopeId) || typeof v.mine !== 'boolean') return null;
  if (!(HOME_COVERAGES as readonly unknown[]).includes(v.coverage)) return null;
  const google = clientId(v.googleClientId);
  if (google === undefined || !Array.isArray(v.apps)) return null;
  const apps = v.apps
    .map(parseApp)
    .filter((a): a is HomeApp => a !== null)
    .slice(0, HOME_MAX_APPS);
  return {
    scopeId: v.scopeId,
    mine: v.mine,
    coverage: v.coverage as HomeCoverage,
    googleClientId: google,
    // Only the user's own listings carry a Support ID or addresses, and only of the expected form.
    supportId: v.mine && typeof v.supportId === 'string' && SUPPORT_ID_RE.test(v.supportId) ? v.supportId : null,
    addresses: v.mine ? parseAddresses(v.addresses) : [],
    apps,
  };
}

/** Reads a `GET /v1/home/apps` answer strictly; a malformed listing is dropped, a malformed answer is `bad_response`. */
export function parseHomeApps(body: unknown): HomeAppsPage {
  if (!isObj(body) || !Array.isArray(body.scopes)) throw bad('/v1/home/apps');
  const nextCursor = body.nextCursor === null || body.nextCursor === undefined ? null : isScopeId(body.nextCursor) ? body.nextCursor : undefined;
  if (nextCursor === undefined) throw bad('/v1/home/apps');
  const seen = new Set<string>();
  const scopes: HomeScope[] = [];
  for (const raw of body.scopes.slice(0, HOME_MAX_SCOPES)) {
    const s = parseScope(raw);
    if (!s || seen.has(s.scopeId)) continue;
    seen.add(s.scopeId);
    scopes.push(s);
  }
  return { scopes, nextCursor };
}

export function parseHomeConfig(body: unknown): HomeConfig {
  if (!isObj(body) || !Number.isSafeInteger(body.serverTimeMs) || (body.serverTimeMs as number) <= 0 || !isNearAccountId(body.signer)) throw bad('/v1/home/config');
  const shared = clientId(body.sharedGoogleClientId);
  const exit = clientId(body.exitGoogleClientId ?? null);
  if (shared === undefined || exit === undefined) throw bad('/v1/home/config');
  return { serverTimeMs: body.serverTimeMs as number, signer: body.signer, sharedGoogleClientId: shared, exitGoogleClientId: exit };
}

/** The query string of a listing request (empty for the first page). */
export function homeAppsSearch(query: HomeAppsQuery): string {
  switch (query.kind) {
    case 'first':
      return '';
    case 'cursor':
      return `?${new URLSearchParams({ cursor: query.cursor }).toString()}`;
    case 'search':
      return `?${new URLSearchParams({ q: query.term }).toString()}`;
    case 'scope':
      return `?${new URLSearchParams({ scopeId: query.scopeId }).toString()}`;
    case 'app':
      return `?${new URLSearchParams({ appId: query.appId }).toString()}`;
  }
}

/**
 * One sign-in's Home identity, in memory. Usable once Google's token is attached; `end()` drops the token and the key
 * and zeroes the salt, so nothing can be signed with it again.
 */
export interface HomeIdentity {
  readonly publicKey: Uint8Array;
  readonly salt: Uint8Array;
  readonly expiresAtMs: number;
  /** The nonce Google's token must carry. */
  readonly nonce: string;
  /** Whether a token is attached and the identity hasn't been ended. */
  readonly usable: boolean;
  /** Attaches the token Google answered for `nonce` (once). */
  attach(token: string): void;
  /** `x-hana-home` for one request, with a counter this key hasn't used. Throws once ended, or before a token. */
  header(method: string, url: URL, body: Uint8Array): Promise<string>;
  end(): void;
}

/**
 * Makes a new Home identity ending `HOME_IDENTITY_LIFETIME_MS` from `nowMs` (the server-corrected clock). Throws what
 * `newSessionKey` throws when the browser can't make the key.
 */
export async function newHomeIdentity(signer: string, nowMs: number): Promise<HomeIdentity> {
  const key = await newSessionKey();
  const salt = randomBytes(HOME_SALT_BYTES);
  const expiresAtMs = nowMs + HOME_IDENTITY_LIFETIME_MS;
  const nonce = homeNonce({ signer, homePublicKey: key.publicKey, expiresAtMs, salt });
  let privateKey: CryptoKey | null = key.keyPair.privateKey;
  let token: string | null = null;
  let counter = 0;
  return {
    publicKey: key.publicKey,
    salt,
    expiresAtMs,
    nonce,
    get usable() {
      return privateKey !== null && token !== null;
    },
    attach(t) {
      if (token !== null || privateKey === null) throw new Error('The Home identity already has a token');
      token = t;
    },
    async header(method, url, body) {
      const k = privateKey;
      const jwt = token;
      if (k === null || jwt === null) throw new Error('No Home identity');
      // Counted before the await, so two calls at once never share a counter.
      counter += 1;
      const mine = counter;
      const message = homeMessage({ signer, counter: mine, method, path: homeRequestPath(url), body });
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k, message as BufferSource));
      // Ended while signing (a sign-out, the 15 minutes): no header, so a zeroed salt is never sent.
      if (privateKey === null) throw new Error('No Home identity');
      return encodeHomeIdentity({ jwt, key: key.publicKey, expiresAtMs, salt, counter: mine, sig });
    },
    end() {
      privateKey = null;
      token = null;
      salt.fill(0);
    },
  };
}

export interface HomeApi {
  /** `GET /v1/home/config`. No identity yet. */
  config(): Promise<HomeConfig>;
  /** `GET /v1/home/apps`, signed by `identity`. One request, never repeated here. */
  apps(identity: HomeIdentity, query: HomeAppsQuery): Promise<HomeAppsPage>;
  /**
   * `POST /v1/home/login`, signed by `identity`: one `create_session_and_derive` for the session in `body`, in
   * `scopeId`. The body carries the per-app sign-in's token; it goes only to the API and is never logged.
   */
  login(identity: HomeIdentity, body: HomeLoginBody): Promise<LoginResponse>;
}

/** `/v1/login`'s body without what a Home derive can't carry (a link, an export label), plus the scope. */
export type HomeLoginBody = Omit<LoginBody, 'linkJwt' | 'linkImmediate' | 'exportChain'> & { scopeId: string };

const NO_BODY = new Uint8Array(0);

export function homeApi(apiUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): HomeApi {
  const base = new URL(apiUrl).origin;
  const init = (extra: RequestInit): RequestInit => ({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...extra });
  return {
    async config() {
      return parseHomeConfig(await parseApiResponse(await fetchFn(`${base}/v1/home/config`, init({ headers: { accept: 'application/json' } }))));
    },
    async apps(identity, query) {
      const url = new URL(`${base}/v1/home/apps${homeAppsSearch(query)}`);
      const header = await identity.header('GET', url, NO_BODY);
      return parseHomeApps(await parseApiResponse(await fetchFn(url.toString(), init({ headers: { accept: 'application/json', [HOME_IDENTITY_HEADER]: header } }))));
    },
    async login(identity, body) {
      const url = new URL(`${base}/v1/home/login`);
      // The key signs these exact bytes, so the same bytes are sent.
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const header = await identity.header('POST', url, bytes);
      const res = await fetchFn(url.toString(), init({ method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', [HOME_IDENTITY_HEADER]: header }, body: bytes }));
      // How long a limit asks the user to wait (the API exposes the header): the page's sentence says it.
      const retry = res.headers.get('retry-after');
      let out: Record<string, unknown>;
      try {
        out = await parseApiResponse(res);
      } catch (err) {
        if (err instanceof ApiError && retry !== null && /^[1-9]\d{0,6}$/u.test(retry)) throw new ApiError(err.status, err.code, 'refused', err.nearTx, err.requestId, { ...err.details, retryAfterS: Number(retry) });
        throw err;
      }
      if (!isLoginResponse(out)) throw bad('/v1/home/login');
      return out;
    },
  };
}
