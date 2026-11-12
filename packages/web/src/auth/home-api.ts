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
  isNearImplicitAccountId,
  isOrigin,
  isScopeId,
  isStellarAddress,
  newSessionKey,
  parseApiResponse,
  randomBytes,
} from '@hana-id/core';
import type { LoginBody, LoginResponse } from '@hana-id/core';
import { normalizeProfileName } from '@hana-id/core/identity';
import type { Fetch } from './api.ts';

/** `GET /v1/home/config`: what the page needs before a sign-in. */
export interface HomeConfig {
  serverTimeMs: number;
  signer: string;
  /** The Google client the Home sign-in uses, or null when none is in force. */
  sharedGoogleClientId: string | null;
  /**
   * Hana Home's exit Google client (D484): its own sign-in uses it when no shared client is in force, and opening the
   * wallet of an app whose own sign-in route is gone (D490). Google answers it at `/home/callback` only (D491).
   */
  exitGoogleClientId: string | null;
  /** Email sign-in is open: the env has an email issuer and its Home audience is on the exit list (H10). */
  emailSignIn: boolean;
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
  /** `near` (D755): the NEAR implicit account, on record once the user signed in through an SDK of 0.4.0 or later. */
  chain: 'stellar' | 'evm' | 'near';
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
    else if (a.chain === 'near' && isNearImplicitAccountId(a.address) && !out.some((x) => x.chain === 'near')) out.push({ chain: 'near', address: a.address });
  }
  // Stellar, EVM, then NEAR, whatever order the answer had.
  const order = { stellar: 0, evm: 1, near: 2 } as const;
  return out.sort((x, y) => order[x.chain] - order[y.chain]);
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
  // An API from before email sign-in sends no `emailSignIn`: read as off.
  return { serverTimeMs: body.serverTimeMs as number, signer: body.signer, sharedGoogleClientId: shared, exitGoogleClientId: exit, emailSignIn: body.emailSignIn === true };
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
  /**
   * When this sign-in really ends: its own end, or the attached token's expiry if that comes first (an email token lives
   * 10 minutes, so an email sign-in ends before its 15; a Google token outlives it). The page's warning and end use this.
   */
  readonly endsAtMs: number;
  /** The attached token while usable, else null: an email sign-in's goes to the issuer with a per-app code request. */
  readonly token: string | null;
  /** Attaches the token Google answered for `nonce` (once). */
  attach(token: string): void;
  /** `x-hana-home` for one request, with a counter this key hasn't used. Throws once ended, or before a token. */
  header(method: string, url: URL, body: Uint8Array): Promise<string>;
  end(): void;
}

/** A token's `exp` in ms, read without a check (a compact JWT or the issuer's JWS JSON); +Infinity when it has none. */
export function tokenExpiry(token: string): number {
  try {
    const payload = token.startsWith('{') ? (JSON.parse(token) as { payload?: unknown }).payload : token.split('.')[1];
    if (typeof payload !== 'string') return Number.POSITIVE_INFINITY;
    const json = atob(payload.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (payload.length % 4)) % 4));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return Number.isSafeInteger(exp) ? (exp as number) * 1000 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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
  let tokenExpMs = Number.POSITIVE_INFINITY;
  let counter = 0;
  return {
    publicKey: key.publicKey,
    salt,
    expiresAtMs,
    nonce,
    get usable() {
      return privateKey !== null && token !== null;
    },
    get endsAtMs() {
      return Math.min(expiresAtMs, tokenExpMs);
    },
    get token() {
      return privateKey !== null ? token : null;
    },
    attach(t) {
      if (token !== null || privateKey === null) throw new Error('The Home identity already has a token');
      token = t;
      tokenExpMs = tokenExpiry(t);
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

/** Every Home API call the page makes; the devices list and its stops are `HomeDevicesApi`'s, the name `HomeProfileApi`'s. */
export interface HomeApi extends HomeDevicesApi, HomeProfileApi {
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

// ---- devices (`GET /v1/home/devices` and the three stops) ----

/** A device's active auto-approve consent. `label` is the app's own words for its rule: text only, never a heading. */
export interface HomeConsent {
  consentId: string;
  label: string;
  grantedAtMs: number;
  expiresAtMs: number;
}

/** One signed-in device: one browser profile on one site for one app session. */
export interface HomeDevice {
  shareId: string;
  appId: string;
  partnerOrigin: string;
  /** The vault's coarse "Chrome on macOS", or null (a vault that sent none). */
  label: string | null;
  signedInAtMs: number;
  /** The last unlock or approved signature there, or null when it can't be told. */
  lastUsedAtMs: number | null;
  /** When it signs out by itself if it isn't used again. */
  idleUntilMs: number;
  /** When it signs out at the latest. */
  expiresAtMs: number;
  consent: HomeConsent | null;
}

/** An auto-approve consent of an app that keeps no sign-in on the device (persistence 'none'). */
export interface HomeTabConsent extends HomeConsent {
  appId: string;
  partnerOrigin: string;
}

export interface HomeEmailShare {
  appId: string;
  addresses: string[];
}

/** One listing's devices, consents and email sharing. */
export interface HomeDeviceScope {
  scopeId: string;
  /** The apps named below, with their display-safe names. */
  apps: { appId: string; name: string; status: HomeAppStatus }[];
  devices: HomeDevice[];
  consents: HomeTabConsent[];
  /** Null when Hana can't tell right now. */
  email: HomeEmailShare[] | null;
  /** More devices or consents exist than the answer carries. */
  more: boolean;
  /**
   * Whether this sign-in's place in the account is confirmed, so stops are offered. False while a linked account couldn't
   * be checked on NEAR: the devices are shown, with no stop and no addresses.
   */
  canStop: boolean;
}

export interface HomeDevicesPage {
  scopes: HomeDeviceScope[];
  nextCursor: string | null;
}

/** The user's own listings a page at a time, or one listing. */
export type HomeDevicesQuery = { kind: 'first' } | { kind: 'cursor'; cursor: string } | { kind: 'scope'; scopeId: string };

export type HomeStop = { kind: 'consent'; consentId: string } | { kind: 'share'; shareId: string } | { kind: 'email'; appId: string };

/** What a stop answered: whether it changed anything (false: it had already ended), or how many addresses stopped. */
export type HomeStopResult = { revoked: boolean } | { revoked: number };

export const HOME_DEVICES_MAX = 25;
export const HOME_EMAILS_MAX = 25;
/** The policy's label at most (core's POLICY_LABEL_MAX). */
export const HOME_POLICY_LABEL_MAX = 80;
/** What stands in for a policy label the page won't show. */
export const HOME_UNNAMED_RULE = 'No description';
const HOME_ID_RE = /^[A-Za-z0-9_-]{22}$/u;
/** The API's shape of a device label (D512). */
const DEVICE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .()/_-]{0,39}$/u;
const isMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** A policy's label as the page shows it: the display-safety rule, at most 80 characters, else Hana's stand-in. */
export function homePolicyLabel(v: unknown): string {
  if (typeof v !== 'string') return HOME_UNNAMED_RULE;
  const t = v.trim();
  return t.length === 0 || [...t].length > HOME_POLICY_LABEL_MAX || !isDisplaySafeLine(t) ? HOME_UNNAMED_RULE : t;
}

const isAddress = (v: unknown): v is string => typeof v === 'string' && v.length >= 3 && v.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+$/u.test(v) && isDisplaySafeLine(v);

function parseConsent(v: unknown): HomeConsent | null {
  if (!isObj(v) || typeof v.consentId !== 'string' || !HOME_ID_RE.test(v.consentId) || !isMs(v.grantedAtMs) || !isMs(v.expiresAtMs)) return null;
  return { consentId: v.consentId, label: homePolicyLabel(v.label), grantedAtMs: v.grantedAtMs, expiresAtMs: v.expiresAtMs };
}

function parseDevice(v: unknown): HomeDevice | null {
  if (!isObj(v) || typeof v.shareId !== 'string' || !HOME_ID_RE.test(v.shareId) || typeof v.appId !== 'string' || !HOME_APP_ID.test(v.appId) || !isOrigin(v.partnerOrigin)) return null;
  if (!isMs(v.signedInAtMs) || !isMs(v.idleUntilMs) || !isMs(v.expiresAtMs) || (v.lastUsedAtMs !== null && !isMs(v.lastUsedAtMs))) return null;
  const consent = v.consent === null ? null : parseConsent(v.consent);
  if (v.consent !== null && consent === null) return null;
  return {
    shareId: v.shareId,
    appId: v.appId,
    partnerOrigin: v.partnerOrigin,
    label: typeof v.label === 'string' && DEVICE_LABEL_RE.test(v.label) ? v.label : null,
    signedInAtMs: v.signedInAtMs,
    lastUsedAtMs: v.lastUsedAtMs as number | null,
    idleUntilMs: v.idleUntilMs,
    expiresAtMs: v.expiresAtMs,
    consent,
  };
}

function parseDeviceScope(v: unknown): HomeDeviceScope | null {
  if (!isObj(v) || !isScopeId(v.scopeId) || !Array.isArray(v.apps) || !Array.isArray(v.devices) || !Array.isArray(v.consents)) return null;
  const apps = v.apps
    .filter((a): a is Record<string, unknown> => isObj(a) && typeof a.appId === 'string' && HOME_APP_ID.test(a.appId) && (a.status === 'active' || a.status === 'suspended' || a.status === 'deleted'))
    .slice(0, HOME_MAX_APPS * 5)
    .map((a) => ({ appId: a.appId as string, name: homeAppName(a.name), status: a.status as HomeAppStatus }));
  const devices = v.devices
    .map(parseDevice)
    .filter((x): x is HomeDevice => x !== null)
    .slice(0, HOME_DEVICES_MAX);
  const consents = v.consents
    .map((c) => {
      const base = parseConsent(c);
      return base && isObj(c) && typeof c.appId === 'string' && HOME_APP_ID.test(c.appId) && isOrigin(c.partnerOrigin) ? { ...base, appId: c.appId, partnerOrigin: c.partnerOrigin } : null;
    })
    .filter((x): x is HomeTabConsent => x !== null)
    .slice(0, HOME_DEVICES_MAX);
  let email: HomeEmailShare[] | null = null;
  if (Array.isArray(v.email)) {
    email = v.email
      .filter((e): e is Record<string, unknown> => isObj(e) && typeof e.appId === 'string' && HOME_APP_ID.test(e.appId) && Array.isArray(e.addresses))
      .map((e) => ({ appId: e.appId as string, addresses: (e.addresses as unknown[]).filter(isAddress).slice(0, HOME_EMAILS_MAX) }))
      .filter((e) => e.addresses.length > 0)
      .slice(0, HOME_EMAILS_MAX);
  } else if (v.email !== null) return null;
  // Stops only where the API says so: a missing or odd value offers none.
  return { scopeId: v.scopeId, apps, devices, consents, email, more: v.more === true, canStop: v.canStop === true };
}

/** Reads a `GET /v1/home/devices` answer strictly; a malformed entry is dropped, a malformed answer is `bad_response`. */
export function parseHomeDevices(body: unknown): HomeDevicesPage {
  if (!isObj(body) || !Array.isArray(body.scopes)) throw bad('/v1/home/devices');
  const nextCursor = body.nextCursor === null || body.nextCursor === undefined ? null : isScopeId(body.nextCursor) ? body.nextCursor : undefined;
  if (nextCursor === undefined) throw bad('/v1/home/devices');
  const seen = new Set<string>();
  const scopes: HomeDeviceScope[] = [];
  for (const raw of body.scopes.slice(0, HOME_MAX_SCOPES)) {
    const s = parseDeviceScope(raw);
    if (!s || seen.has(s.scopeId)) continue;
    seen.add(s.scopeId);
    scopes.push(s);
  }
  return { scopes, nextCursor };
}

export function homeDevicesSearch(query: HomeDevicesQuery): string {
  if (query.kind === 'cursor') return `?${new URLSearchParams({ cursor: query.cursor }).toString()}`;
  if (query.kind === 'scope') return `?${new URLSearchParams({ scopeId: query.scopeId }).toString()}`;
  return '';
}

const STOP_PATH: Readonly<Record<HomeStop['kind'], string>> = { consent: '/v1/home/consents/revoke', share: '/v1/home/shares/revoke', email: '/v1/home/email-sharing/revoke' };

/** A stop's body: exactly its one field. */
export function homeStopBody(stop: HomeStop): Record<string, string> {
  if (stop.kind === 'consent') return { consentId: stop.consentId };
  if (stop.kind === 'share') return { shareId: stop.shareId };
  return { appId: stop.appId };
}

/** `GET /v1/home/devices` and the stops, signed by `identity`. One request each, never repeated here. */
export interface HomeDevicesApi {
  devices(identity: HomeIdentity, query: HomeDevicesQuery): Promise<HomeDevicesPage>;
  stop(identity: HomeIdentity, stop: HomeStop): Promise<HomeStopResult>;
}

export function homeDevicesApi(apiUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): HomeDevicesApi {
  const base = new URL(apiUrl).origin;
  const init = (extra: RequestInit): RequestInit => ({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...extra });
  return {
    async devices(identity, query) {
      const url = new URL(`${base}/v1/home/devices${homeDevicesSearch(query)}`);
      const header = await identity.header('GET', url, NO_BODY);
      return parseHomeDevices(await parseApiResponse(await fetchFn(url.toString(), init({ headers: { accept: 'application/json', [HOME_IDENTITY_HEADER]: header } }))));
    },
    async stop(identity, stop) {
      const url = new URL(`${base}${STOP_PATH[stop.kind]}`);
      const bytes = new TextEncoder().encode(JSON.stringify(homeStopBody(stop)));
      const header = await identity.header('POST', url, bytes);
      const out = await parseApiResponse(await fetchFn(url.toString(), init({ method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', [HOME_IDENTITY_HEADER]: header }, body: bytes })));
      if (typeof out.revoked === 'boolean' || (Number.isSafeInteger(out.revoked) && (out.revoked as number) >= 0)) return { revoked: out.revoked as boolean | number } as HomeStopResult;
      throw bad(STOP_PATH[stop.kind]);
    },
  };
}

const NO_BODY = new Uint8Array(0);

// ---- the user's name (`GET`/`POST /v1/home/profile`, `POST /v1/home/name-sharing`, D714) ----

/** A name as the API stores it: each part a `normalizeProfileName` value, at least one of them set. */
export interface HomeProfileName {
  givenName: string | null;
  familyName: string | null;
}

/** One app the signed-in identity shares its name with. `name` is the partner's: shown as text only. */
export interface HomeNameShare {
  appId: string;
  name: string;
  scopeId: string;
  sharedAtMs: number;
}

/** `GET /v1/home/profile[?appId=]`: the name, the apps it is shared with, and with `appId` whether that app gets it. */
export interface HomeProfile {
  name: HomeProfileName | null;
  shares: HomeNameShare[];
  /** More apps share it than the answer lists. */
  more: boolean;
  /** Null without `appId`, or for an app Home can't share a name with (deleted, or never signed in to). */
  app: { appId: string; shared: boolean } | null;
}

/** What saving answered: the name as stored, or (both parts empty) removed, with how many shares ended. */
export type HomeProfileSaved = { name: HomeProfileName } | { name: null; stopped: number };

/** What a share or a stop answered (`stopped`: how many shares ended, 0 when there was none). */
export type HomeNameSharing = { shared: true } | { shared: false; stopped: number };

/** The apps a name is shared with, in one answer at most (the API's HOME_NAME_SHARES_MAX). */
export const HOME_NAME_SHARES_MAX = 100;

/** A name of the API's shape: null, or each part exactly as `normalizeProfileName` leaves it, not both empty. */
function parseProfileName(v: unknown): HomeProfileName | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const ok = (x: unknown): x is string | null => x === null || (typeof x === 'string' && normalizeProfileName(x) === x);
  if (!ok(v.givenName) || !ok(v.familyName) || (v.givenName === null && v.familyName === null)) return undefined;
  return { givenName: v.givenName, familyName: v.familyName };
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Reads a `GET /v1/home/profile` answer strictly; a malformed share is dropped, a malformed answer is `bad_response`. */
export function parseHomeProfile(body: unknown, appId: string | null = null): HomeProfile {
  const what = '/v1/home/profile';
  if (!isObj(body) || !Array.isArray(body.shares)) throw bad(what);
  const name = parseProfileName(body.name);
  if (name === undefined) throw bad(what);
  let app: HomeProfile['app'] = null;
  if (body.app !== null && body.app !== undefined) {
    // Only the app that was asked about, and only a yes or a no.
    if (!isObj(body.app) || appId === null || body.app.appId !== appId || typeof body.app.shared !== 'boolean') throw bad(what);
    app = { appId, shared: name !== null && body.app.shared };
  }
  const seen = new Set<string>();
  const shares: HomeNameShare[] = [];
  // A share without a name shares nothing: the list is empty then, whatever came.
  for (const s of name === null ? [] : body.shares.slice(0, HOME_NAME_SHARES_MAX)) {
    if (!isObj(s) || typeof s.appId !== 'string' || !HOME_APP_ID.test(s.appId) || seen.has(s.appId) || !isScopeId(s.scopeId) || !isMs(s.sharedAtMs)) continue;
    seen.add(s.appId);
    shares.push({ appId: s.appId, name: homeAppName(s.name), scopeId: s.scopeId, sharedAtMs: s.sharedAtMs });
  }
  return { name, shares, more: name !== null && body.more === true, app };
}

/** `POST /v1/home/profile`'s body: exactly the two parts, each already normalized (null: not set). */
export function homeProfileBody(name: HomeProfileName): string {
  for (const part of [name.givenName, name.familyName]) if (part !== null && normalizeProfileName(part) !== part) throw new Error('A name part must be normalized first');
  return JSON.stringify({ givenName: name.givenName, familyName: name.familyName });
}

/** The user's name and who gets it, signed by `identity`. One request each, never repeated here. */
export interface HomeProfileApi {
  profile(identity: HomeIdentity, appId?: string | null): Promise<HomeProfile>;
  /** Saves `name` (both parts null: removes it, and every share of it ends). */
  saveName(identity: HomeIdentity, name: HomeProfileName): Promise<HomeProfileSaved>;
  shareName(identity: HomeIdentity, appId: string, share: boolean): Promise<HomeNameSharing>;
}

export function homeProfileApi(apiUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): HomeProfileApi {
  const base = new URL(apiUrl).origin;
  const init = (extra: RequestInit): RequestInit => ({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...extra });
  const post = async (identity: HomeIdentity, path: string, body: string): Promise<Record<string, unknown>> => {
    const url = new URL(`${base}${path}`);
    // The key signs these exact bytes, so the same bytes are sent.
    const bytes = new TextEncoder().encode(body);
    const header = await identity.header('POST', url, bytes);
    return parseApiResponse(await fetchFn(url.toString(), init({ method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', [HOME_IDENTITY_HEADER]: header }, body: bytes })));
  };
  return {
    async profile(identity, appId = null) {
      if (appId !== null && !HOME_APP_ID.test(appId)) throw new Error('Not an app id');
      const url = new URL(`${base}/v1/home/profile${appId === null ? '' : `?${new URLSearchParams({ appId }).toString()}`}`);
      const header = await identity.header('GET', url, NO_BODY);
      return parseHomeProfile(await parseApiResponse(await fetchFn(url.toString(), init({ headers: { accept: 'application/json', [HOME_IDENTITY_HEADER]: header } }))), appId);
    },
    async saveName(identity, name) {
      const out = await post(identity, '/v1/home/profile', homeProfileBody(name));
      const saved = parseProfileName(out.name);
      if (saved === null && isCount(out.stopped)) return { name: null, stopped: out.stopped };
      // What was stored is what was sent: anything else isn't believed.
      if (saved && saved.givenName === name.givenName && saved.familyName === name.familyName) return { name: saved };
      throw bad('/v1/home/profile');
    },
    async shareName(identity, appId, share) {
      if (!HOME_APP_ID.test(appId)) throw new Error('Not an app id');
      const out = await post(identity, '/v1/home/name-sharing', JSON.stringify({ appId, share }));
      if (share && out.shared === true) return { shared: true };
      if (!share && out.shared === false && isCount(out.stopped)) return { shared: false, stopped: out.stopped };
      throw bad('/v1/home/name-sharing');
    },
  };
}

export function homeApi(apiUrl: string, fetchFn: Fetch = (...args) => fetch(...args)): HomeApi {
  const base = new URL(apiUrl).origin;
  const init = (extra: RequestInit): RequestInit => ({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', ...extra });
  return {
    ...homeDevicesApi(apiUrl, fetchFn),
    ...homeProfileApi(apiUrl, fetchFn),
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
