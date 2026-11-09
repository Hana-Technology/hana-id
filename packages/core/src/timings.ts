// Per-stage timings for pk_test_ apps (apps/smoke, docs/operations.md "Logs and latency"). Durations in ms, never
// timestamps: each one is measured within one page's clock (performance.now) or by the API, then passed on as a
// duration, so no two clocks are ever compared. They carry no secrets: names and numbers only.
//
// A login's or an unlock's timings are one flat record. The STAGES of each list follow one another and add up to the
// partner page's total once the page adds `other` (its total minus their sum: the page's own event handling, and any
// gap the stages don't cover). The DETAILS are not added: they break a stage down (the API's own phases of a request
// inside the request's round trip) or overlap others (`scopeCheck` runs while the user is at Google).
//
// pk_live_ apps never get any of it: the vault, the login popup, the partner client and the API each add timings only
// for a pk_test_ key.

/** Login stages in order (the partner client's, the vault's, the login popup's), summing with `other` to the total. */
export const LOGIN_TIMING_STAGES = [
  // Partner client: window.open of the login popup, and waiting for the vault's handshake before hana_login is sent.
  'open',
  'wait',
  // Vault: GET /v1/app (normally already answered: the vault asks right after `ready`), the session key and nonce, the
  // popup's hello.
  'app',
  'keygen',
  'popup',
  // Login popup (/login): its checks of the vault's message (the pinned signer, the nonce) and storing the relay key,
  // until it shows the method chooser or navigates on. No API call (D77).
  'authCheck',
  // Login popup (/login), only when it shows the method chooser (an app with email): the user choosing, chooser shown
  // → click. A Google-only app's login never has it.
  'choose',
  // Email login only, the email step (/login/email), each a sum on that page's clock: `emailLoad` its navigation (the
  // chooser's click → the address screen), `emailEntry` the user typing the address, `emailStart` the issuer's `start`
  // (and any `resend`) round trips, `emailCode` the wait for the code (the mail's delivery and the user typing it),
  // `emailVerify` the `verify` round trips and encrypting the token, up to the relay POST. `emailRelay` is the
  // residual of the vault's hello → token once those and the relay's own part are taken out: the relay's network
  // legs (the page's POST upstream, the vault's read downstream) and any gap between the measured parts. An email
  // login has no `google` stage.
  'emailLoad',
  'emailEntry',
  'emailStart',
  'emailCode',
  'emailVerify',
  'emailRelay',
  // The residual of the vault's hello → token time once the popup's and the relay's own parts are taken out: the
  // user at Google and Google's pages, plus the relay's network legs, which no single clock sees (the callback's
  // CORS preflight and POST upstream, the vault's read response downstream: about 1.5 API round trips).
  'google',
  // Callback page (/login/callback), from its own navigation timing: Google's redirect hops before the callback is
  // fetched, the auth page Worker's response (DNS, TLS, the Worker, the HTML), parsing and loading the callback
  // script, then taking the relay key and encrypting Google's answer, up to the relay POST.
  'callbackRedirect',
  'callbackFetch',
  'callbackBoot',
  'callbackPrep',
  // API: the time the token sat in the relay slot before the vault's read answered (about 0 while the vault
  // long-polls; more when its poll was between requests).
  'relayHeld',
  // Vault: the token check (with Google's JWKS fetch when it isn't cached), the wait for the registry scope check,
  // POST /v1/login with any recovery, CKD decryption and derivation, and switching to the new session. The share and
  // record (POST /v1/vault/shares, IndexedDB) are made after the reply (D79), so no stage covers them: their server
  // time is in the API's request log.
  'verify',
  'scopeWait',
  'chain',
  'decrypt',
  'finish',
  // Partner client: the port round trip around the vault's own time (postMessage both ways, event-loop queueing).
  'port',
] as const;

/** Login details: parts of a stage, or overlapped with the stages. Not added to the total. */
export const LOGIN_TIMING_DETAILS = [
  /**
   * Inside `app`: the GET /v1/app request the login waited for, on the vault's clock (it may have started before the
   * login, so it can be longer than `app`), and the API's own total and phases: `Gate` (the app row and the IP
   * limiter), `Settings` (the settings and login-methods rows), `Chain` (the registry views, `get_scope` and, for a
   * shared client, `get_config`, read side by side with the settings).
   */
  'appRtt',
  'appServer',
  'appServerGate',
  'appServerSettings',
  'appServerChain',
  /** The registry view of the app's scope (overlapped: started at `app`, waited for at `scopeWait`). */
  'scopeCheck',
  /** Inside `chain`: the BLS app key and the counter-1 signature. */
  'chainPrep',
  /** Inside `chain`: POST /v1/login on the vault's clock (the successful attempt), and the API's own total and phases. */
  'loginRtt',
  'loginServer',
  'loginServerGate',
  'loginServerChecks',
  'loginServerRelay',
  'loginServerBroadcast',
  'loginServerWait',
  /** The vault's own time, hana_login received → reply sent (the partner client takes it from its round trip). */
  'vault',
] as const;

/** Unlock stages in order (a page load restoring the wallet), summing with `other` to createHana → ready. */
export const UNLOCK_TIMING_STAGES = [
  // Partner client: createHana until the iframe is in the document (waits for <body> when run in <head>).
  'mount',
  // Partner client, only when the first frame didn't answer in time and the SDK put in a new one (one retry): the
  // first frame's insertion → the second's. The stages after it are the second frame's.
  'retry',
  // The vault iframe's navigation start, as far as the partner sees it: frame load minus the vault's own parts below.
  'frameStart',
  // Vault document, from its navigation timing: request to the vault page Worker (DNS, TLS, D1 reads, the HTML),
  // parsing and loading vault.js, reading the inlined config and constructing the vault, then the rest of the load.
  'vaultFetch',
  'vaultScript',
  'vaultConfig',
  'vaultLoad',
  // Vault, after the hello: open IndexedDB, read the record (and its lock), sign and POST /v1/vault/unlock, write the
  // new counter, unwrap K_s and decrypt PRK, derive and check the addresses (and the consent), then reply `ready`.
  'store',
  'record',
  'unlock',
  'counter',
  'unwrap',
  'addresses',
  // Partner client: the hello → ready round trip around the vault's own time.
  'port',
] as const;

export const UNLOCK_TIMING_DETAILS = [
  /**
   * Inside `unlock`: POST /v1/vault/unlock on the vault's clock, and the API's own total and phases: `Gate` (the app,
   * cached per isolate, and the IP, app and share limiters), `Share` (the KEK, the share and settings rows),
   * `Advance` (the counter update).
   */
  'unlockRtt',
  'unlockServer',
  'unlockServerGate',
  'unlockServerShare',
  'unlockServerAdvance',
  /** The vault's own time, hello received → ready sent. */
  'vault',
] as const;

/** At most this many entries in one timings record (the port's limit). */
export const TIMINGS_MAX_KEYS = 48;
const KEY = /^[a-zA-Z]{1,32}$/u;

/** A timings record: at most TIMINGS_MAX_KEYS entries of a letters-only name and a finite ms ≥ 0. */
export function isTimings(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length <= TIMINGS_MAX_KEYS && entries.every(([k, ms]) => KEY.test(k) && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0);
}

/** The sum of the `stages` present in `timings`. */
export function stageSum(timings: Readonly<Record<string, number>>, stages: readonly string[]): number {
  let sum = 0;
  for (const s of stages) {
    const ms = timings[s];
    if (typeof ms === 'number' && Number.isFinite(ms)) sum += ms;
  }
  return sum;
}

/**
 * `timings` plus `other`: `totalMs` minus the stages' sum. When the stages overshoot the total (rounding, or a stage
 * measured on a slower clock), `other` is 0 and the overshoot is reported as `overrun`, so the stages and `other` still
 * describe the run honestly.
 */
export function withOther(timings: Readonly<Record<string, number>>, stages: readonly string[], totalMs: number): Record<string, number> {
  const rest = totalMs - stageSum(timings, stages);
  const out: Record<string, number> = { ...timings, other: Math.max(0, rest) };
  if (rest < 0) out.overrun = -rest;
  return out;
}

/** The API's `timings` on a pk_test_ app's response: its own total and per-phase ms. */
export interface ServerTimings {
  totalMs: number;
  phases: Record<string, number>;
}

export const isServerTimings = (v: unknown): v is ServerTimings =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).length === 2 &&
  typeof (v as ServerTimings).totalMs === 'number' &&
  Number.isFinite((v as ServerTimings).totalMs) &&
  (v as ServerTimings).totalMs >= 0 &&
  isTimings((v as ServerTimings).phases);
