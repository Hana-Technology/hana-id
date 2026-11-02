// Hana ID smoke, direct page: the in-page flow from before the vault (Google Identity Services → POST /v1/sessions →
// POST /v1/derive → CKD decryption here). It stays as the split-flow baseline for the ship gate and for what the vault
// can't do (key_index ≠ 0, a client choice, derive again, revoke, replays), and works only while the env's
// REJECT_PII_ON_SESSIONS is "0": GIS tokens carry `email`, which the claim allow-list refuses once the user turns it on
// (400 token_has_pii). Public data only on screen, in the log and in storage. Never display, log, persist or send
// (except the token to POST /v1/sessions) the Google ID token, the CKD secret or derived private keys.
import { checkSessionParams, ckdKeyProblem, jsonBytes, toHex } from '@hana-id/core';
import { ApiError, type AppConfig, type CreateSessionBody, type GoogleMode, HanaApi } from './api.ts';
import type { PageEnv } from './config.ts';
import { $, code, fillDl, h, logEvent, ms, txLink } from './dom.ts';
import { deriveOnce } from './flow.ts';
import { readClaims, renderGoogleButton } from './google.ts';
import { NearRpc, formatNear, formatTgas, googleOwnClients, googleSharedClients, type ScopeView } from './near.ts';
import { type RunRecord, type StepTimings, compareRun, parseStoredRuns, pkPrefix, resultsJson } from './runs.ts';
import { type PendingSession, newPendingSession, signCreateProof, signRevoke } from './session.ts';
import { PK_STORAGE, RUNS_STORAGE, isPublishableKey } from './storage-keys.ts';

const env: PageEnv = __HANA_SMOKE_ENV__;
const rpc = new NearRpc(env.rpc);

function describeError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'token_has_pii') {
    return `${err.message}: this env refuses GIS tokens on /v1/sessions (REJECT_PII_ON_SESSIONS = "1"), so the direct flow is retired here; use the vault page${err.requestId ? ` [request ${err.requestId}]` : ''}`;
  }
  if (err instanceof ApiError) return `${err.message}${err.nearTx ? ` (tx ${err.nearTx})` : ''}${err.requestId ? ` [request ${err.requestId}]` : ''}`;
  return err instanceof Error ? err.message : String(err);
}

// ---- State ----

interface ClientChoice {
  mode: GoogleMode;
  clientId: string;
}

interface LoadedApp {
  publishableKey: string;
  api: HanaApi;
  config: AppConfig;
  scope: ScopeView | null;
  choices: ClientChoice[];
}

interface ActiveSession {
  app: LoadedApp;
  client: ClientChoice;
  pending: PendingSession;
  /** Set once POST /v1/sessions succeeded. */
  path: string | null;
  used: number;
  maxUses: number;
  revoked: boolean;
  googleMs: number | null;
  createSessionMs: number | null;
  createSessionTx: string | null;
  createSessionGas: number | null;
  /** Last create_session body, memory only (it holds the Google token), for the replay test. Never shown. */
  lastCreateBody: CreateSessionBody | null;
  lastDeriveBody: Parameters<HanaApi['derive']>[0] | null;
}

let app: LoadedApp | null = null;
let session: ActiveSession | null = null;
let busy = false;
let runs: RunRecord[] = loadRuns();
const envProblem = ckdKeyProblem(env);

function loadRuns(): RunRecord[] {
  try {
    return parseStoredRuns(localStorage.getItem(RUNS_STORAGE));
  } catch {
    return [];
  }
}

function saveRuns(): void {
  try {
    localStorage.setItem(RUNS_STORAGE, JSON.stringify(runs));
  } catch {
    // Storage unavailable: the log lives in memory only.
  }
}

// ---- Rendering ----

function renderEnv(): void {
  fillDl($('env'), [
    ['Environment', `${env.name} (${env.network})`],
    ['Signer', code(env.signer)],
    ['API', h('span', {}, code(env.apiUrl), env.apiUrlOverridden ? ' (VITE_HANA_API_URL override)' : '')],
    ['RPC', code(env.rpc)],
    ['MPC', h('span', {}, code(env.mpc), ` domain ${env.ckdDomainId}`)],
    ['Pinned CKD key', code(env.ckdNetworkKey)],
    ['Page origin', code(location.origin)],
  ]);
  const problem = $('env-problem');
  problem.hidden = envProblem === null;
  problem.textContent = envProblem ? `Can't derive: ${envProblem}` : '';
}

function renderButtons(): void {
  const live = session !== null && session.path !== null && !session.revoked;
  ($('start') as HTMLButtonElement).disabled = busy || app === null || envProblem !== null || session !== null;
  ($('load-app') as HTMLButtonElement).disabled = busy;
  ($('derive-again') as HTMLButtonElement).disabled = busy || session === null || session.path === null;
  ($('revoke') as HTMLButtonElement).disabled = busy || !live;
  ($('replay-session') as HTMLButtonElement).disabled = busy || session?.lastCreateBody == null;
  ($('replay-derive') as HTMLButtonElement).disabled = busy || session?.lastDeriveBody == null;
  ($('restart') as HTMLButtonElement).disabled = busy || session === null;
}

function selectedClient(): ClientChoice | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="client"]:checked');
  if (!checked || !app) return null;
  return app.choices[Number(checked.value)] ?? null;
}

function renderApp(a: LoadedApp): void {
  const scope = a.scope;
  fillDl($('app'), [
    ['scope_id', code(a.config.scopeId)],
    ['Signer (API)', code(a.config.signer)],
    ['/v1/app google', h('span', {}, `${a.config.google.mode}: `, code(a.config.google.clientId))],
    ['Scope clients', scope ? (googleOwnClients(scope).join(', ') || 'none') : 'get_scope unavailable'],
    ['allow_shared', scope ? String(scope.allow_shared) : '—'],
  ]);
  const box = $('clients');
  if (a.choices.length === 0) {
    box.replaceChildren(h('p', { class: 'fail' }, 'No Google client available for this app.'));
    return;
  }
  const defaultIndex = Math.max(
    0,
    a.choices.findIndex((c) => c.clientId === a.config.google.clientId && c.mode === a.config.google.mode),
  );
  box.replaceChildren(
    h('div', {}, 'Google client for this session:'),
    ...a.choices.map((c, i) => {
      const input = h('input', { type: 'radio', name: 'client', value: String(i) }) as HTMLInputElement;
      input.checked = i === defaultIndex;
      return h('label', {}, input, `${c.mode === 'own' ? 'own client' : 'shared client'}: `, code(c.clientId));
    }),
  );
}

function renderSession(s: ActiveSession | null): void {
  if (!s) {
    $('pending').replaceChildren();
    $('session').replaceChildren();
    $('google-button').replaceChildren();
    return;
  }
  fillDl($('pending'), [
    ['Session public key', code(toHex(s.pending.publicKey))],
    ['Expires', `${new Date(s.pending.expiresAtMs).toISOString()} (${s.pending.expiresAtMs})`],
    ['key_index / max_uses', `${s.pending.keyIndex} / ${s.pending.maxUses}`],
    ['Client', h('span', {}, `${s.client.mode}: `, code(s.client.clientId))],
    ['Google nonce', code(s.pending.nonce)],
  ]);
  if (s.path === null) {
    $('session').replaceChildren();
    return;
  }
  fillDl($('session'), [
    ['Path', code(s.path)],
    ['Scope', code(s.app.config.scopeId)],
    ['create_session tx', txLink(s.createSessionTx)],
    ['create_session gas', s.createSessionGas === null ? '…' : formatTgas(s.createSessionGas)],
    ['Google / create_session', `${ms(s.googleMs)} ms / ${ms(s.createSessionMs)} ms`],
    ['Used / max', `${s.used} / ${s.maxUses}${s.revoked ? ' (revoked)' : ''}`],
  ]);
}

function renderResult(r: RunRecord | null): void {
  if (!r) {
    $('result').replaceChildren();
    return;
  }
  fillDl($('result'), [
    ['Stellar', code(r.stellar)],
    ['EVM', code(r.evm)],
    ['app_id', code(r.appIdHex)],
    ['derive_key tx', txLink(r.deriveTx)],
    ['derive_key gas', r.deriveGas === null ? '…' : formatTgas(r.deriveGas)],
    ['Counter', String(r.counter)],
  ]);
}

function renderRuns(): void {
  $('timings').replaceChildren(
    ...runs.map((r) =>
      h(
        'tr',
        {},
        h('td', {}, String(r.run)),
        h('td', { class: 'num' }, ms(r.timings.googleMs)),
        h('td', { class: 'num' }, ms(r.timings.createSessionMs)),
        h('td', { class: 'num' }, ms(r.timings.deriveMs)),
        h('td', { class: 'num' }, ms(r.timings.decryptVerifyMs)),
        h('td', { class: 'num' }, ms(r.timings.totalMs)),
        h('td', { class: 'num' }, r.createSessionGas === null ? '—' : formatTgas(r.createSessionGas)),
        h('td', { class: 'num' }, r.deriveGas === null ? '—' : formatTgas(r.deriveGas)),
      ),
    ),
  );
  $('runs').replaceChildren(
    ...runs.map((r, i) => {
      const checks = compareRun(r, runs.slice(0, i));
      return h(
        'tr',
        {},
        h('td', {}, String(r.run)),
        h('td', { class: 'mono' }, r.pkPrefix),
        h('td', {}, `${r.clientMode}`),
        h('td', {}, String(r.keyIndex)),
        h('td', { class: 'mono' }, r.path),
        h('td', { class: 'mono' }, r.stellar),
        h('td', { class: 'mono' }, r.evm),
        h('td', { class: 'mono' }, `${r.appIdHex.slice(0, 16)}…`),
        h('td', {}, ...checks.map((c) => h('div', { class: c.verdict }, `#${c.other}: ${c.verdict === 'ok' ? 'OK' : 'FAIL'} — ${c.note}`))),
      );
    }),
  );
}

function render(): void {
  renderButtons();
  renderSession(session);
}

// ---- Actions ----

async function withBusy(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    await action();
  } catch (err) {
    logEvent(describeError(err), 'error');
  } finally {
    busy = false;
    render();
  }
}

async function loadApp(): Promise<void> {
  const publishableKey = ($('pk') as HTMLInputElement).value.trim();
  if (!isPublishableKey(publishableKey)) throw new Error('Enter a publishable key (pk_test_…)');
  try {
    localStorage.setItem(PK_STORAGE, publishableKey);
  } catch {
    // Convenience only.
  }
  app = null;
  $('app').replaceChildren();
  $('clients').replaceChildren();
  const api = new HanaApi(env.apiUrl, publishableKey);
  const config = await api.app();
  if (config.signer !== env.signer) {
    throw new Error(`The API's signer ${config.signer} is not this page's ${env.signer} (envs/${env.name}.json): nonces and app_ids would not match`);
  }
  logEvent(`GET /v1/app: scope ${config.scopeId}, ${config.google.mode} client [request ${config.requestId}]`);

  // Which clients the scope can log in with: its own Google clients, and Hana's shared ones when allow_shared.
  const [scopeRes, configRes] = await Promise.allSettled([rpc.getScope(env.signer, config.scopeId), rpc.getConfig(env.signer)]);
  const scope = scopeRes.status === 'fulfilled' ? scopeRes.value : null;
  if (scopeRes.status === 'rejected') logEvent(`get_scope failed: ${describeError(scopeRes.reason)}`, 'error');
  if (configRes.status === 'rejected') logEvent(`get_config failed: ${describeError(configRes.reason)}`, 'error');
  const choices: ClientChoice[] = [];
  if (scope) for (const id of googleOwnClients(scope)) choices.push({ mode: 'own', clientId: id });
  if (scope?.allow_shared && configRes.status === 'fulfilled') {
    for (const id of googleSharedClients(configRes.value)) choices.push({ mode: 'shared', clientId: id });
  }
  if (!choices.some((c) => c.clientId === config.google.clientId)) choices.unshift({ ...config.google });
  app = { publishableKey, api, config, scope, choices };
  renderApp(app);
}

async function startSession(): Promise<void> {
  if (!app) throw new Error('Load the app first');
  if (envProblem) throw new Error(envProblem);
  const client = selectedClient();
  if (!client) throw new Error('Choose a Google client');
  const keyIndex = Number(($('key-index') as HTMLInputElement).value);
  const maxUses = Number(($('max-uses') as HTMLInputElement).value);
  checkSessionParams({ keyIndex, maxUses });
  const runStart = performance.now();
  const pending = await newPendingSession({ signer: env.signer, scopeId: app.config.scopeId, keyIndex, maxUses });
  const s: ActiveSession = {
    app,
    client,
    pending,
    path: null,
    used: 0,
    maxUses,
    revoked: false,
    googleMs: null,
    createSessionMs: null,
    createSessionTx: null,
    createSessionGas: null,
    lastCreateBody: null,
    lastDeriveBody: null,
  };
  session = s;
  render();
  const googleStart = performance.now();
  await renderGoogleButton($('google-button'), client.clientId, pending.nonce, (jwt) => {
    if (session !== s || s.path !== null) return;
    s.googleMs = performance.now() - googleStart;
    void withBusy(() => openSessionAndDerive(s, jwt, runStart));
  });
  logEvent(`Session key ready (key_index ${keyIndex}, max_uses ${maxUses}): sign in with Google`);
}

async function openSessionAndDerive(s: ActiveSession, jwt: string, runStart: number): Promise<void> {
  const claims = readClaims(jwt);
  if (claims.nonce !== s.pending.nonce) throw new Error('Google returned a token for a different nonce');
  if (claims.aud !== s.client.clientId) throw new Error(`Google returned a token for ${claims.aud}, not ${s.client.clientId}`);
  $('google-button').replaceChildren();
  const body: CreateSessionBody = {
    jwt,
    sessionPublicKey: jsonBytes(s.pending.publicKey),
    expiresAtMs: s.pending.expiresAtMs,
    salt: jsonBytes(s.pending.salt),
    keyIndex: s.pending.keyIndex,
    maxUses: s.pending.maxUses,
    // The session key's proof of possession (D137): required by contract v3, ignored by v2.
    signature: jsonBytes(await signCreateProof(s.pending)),
  };
  s.lastCreateBody = body;
  const t0 = performance.now();
  const created = await s.app.api.createSession(body);
  s.createSessionMs = performance.now() - t0;
  s.path = created.result.path;
  s.used = created.result.used;
  s.createSessionTx = created.nearTx;
  if (created.result.scope_id !== s.app.config.scopeId) logEvent(`Session scope ${created.result.scope_id} ≠ app scope ${s.app.config.scopeId}`, 'error');
  logEvent(`create_session: ${s.path} in ${ms(s.createSessionMs)} ms, tx ${created.nearTx ?? '—'}`);
  render();
  if (created.nearTx) {
    void fetchGas(created.nearTx, (gas) => {
      s.createSessionGas = gas;
      for (const r of runs) if (r.createSessionTx === created.nearTx) r.createSessionGas = gas;
      saveRuns();
      renderRuns();
      render();
    });
  }
  await derive(s, runStart, true);
}

async function derive(s: ActiveSession, runStart: number, first: boolean): Promise<void> {
  if (!s.path) throw new Error('No session');
  if (envProblem) throw new Error(envProblem);
  const counter = s.used + 1;
  if (s.revoked) logEvent('Session is revoked: expect 404 unknown_session');
  else if (counter > s.maxUses) logEvent(`Counter ${counter} > max_uses ${s.maxUses}: expect 409 session_exhausted`);
  let outcome;
  try {
    outcome = await deriveOnce({
      api: s.app.api,
      signer: env.signer,
      ckdNetworkKey: env.ckdNetworkKey,
      privateKey: s.pending.privateKey,
      sessionPublicKey: s.pending.publicKey,
      path: s.path,
      counter,
    });
  } catch (err) {
    await syncCounter(s);
    throw err;
  }
  s.used = counter;
  s.lastDeriveBody = outcome.body;
  const timings: StepTimings = {
    googleMs: first ? s.googleMs : null,
    createSessionMs: first ? s.createSessionMs : null,
    deriveMs: outcome.deriveMs,
    decryptVerifyMs: outcome.decryptVerifyMs,
    totalMs: performance.now() - runStart,
  };
  const record: RunRecord = {
    run: (runs.at(-1)?.run ?? 0) + 1,
    at: new Date().toISOString(),
    env: env.name,
    signer: env.signer,
    apiUrl: env.apiUrl,
    pkPrefix: pkPrefix(s.app.publishableKey),
    scopeId: s.app.config.scopeId,
    clientMode: s.client.mode,
    clientId: s.client.clientId,
    keyIndex: s.pending.keyIndex,
    path: s.path,
    counter,
    sessionKeyPrefix: toHex(s.pending.publicKey.slice(0, 6)),
    appIdHex: outcome.appIdHex,
    derivation: 1,
    stellar: outcome.stellar,
    evm: outcome.evm,
    createSessionTx: first ? s.createSessionTx : null,
    deriveTx: outcome.nearTx,
    createSessionGas: first ? s.createSessionGas : null,
    deriveGas: null,
    timings,
  };
  runs.push(record);
  saveRuns();
  renderResult(record);
  renderRuns();
  logEvent(`derive_key #${counter}: verified against the pinned CKD key in ${ms(outcome.deriveMs)} + ${ms(outcome.decryptVerifyMs)} ms, tx ${outcome.nearTx ?? '—'}`);
  if (outcome.nearTx) {
    void fetchGas(outcome.nearTx, (gas) => {
      record.deriveGas = gas;
      saveRuns();
      renderRuns();
      renderResult(runs.at(-1) ?? null);
    });
  }
}

/** After a failed derive the contract may or may not have counted it: take its `used`. */
async function syncCounter(s: ActiveSession): Promise<void> {
  try {
    const chain = await rpc.getSession(env.signer, jsonBytes(s.pending.publicKey));
    if (chain) {
      if (chain.used !== s.used) logEvent(`Counter re-synced from chain: used ${s.used} → ${chain.used}`);
      s.used = chain.used;
    } else {
      logEvent('get_session: no session on chain (revoked or expired)');
    }
  } catch (err) {
    logEvent(`Couldn't re-sync the counter: ${describeError(err)}`, 'error');
  }
}

async function fetchGas(txHash: string, apply: (gas: number) => void): Promise<void> {
  try {
    const gas = await rpc.txGas(txHash, env.relayer);
    logEvent(`gas ${txHash.slice(0, 10)}…: ${formatTgas(gas.gasBurnt)} (${gas.receipts} receipts), ${formatNear(gas.tokensBurnt)} burnt`);
    apply(gas.gasBurnt);
  } catch (err) {
    logEvent(`Couldn't read gas for ${txHash}: ${describeError(err)}`, 'error');
  }
}

async function revoke(s: ActiveSession): Promise<void> {
  const counter = s.used + 1;
  const signature = await signRevoke(s.pending.privateKey, counter);
  try {
    const res = await s.app.api.revoke({ sessionPublicKey: jsonBytes(s.pending.publicKey), counter, signature: jsonBytes(signature) });
    s.used = counter;
    s.revoked = true;
    logEvent(`revoke_session: done, tx ${res.nearTx ?? '—'}. "Derive again" should now fail with 404 unknown_session.`);
  } catch (err) {
    await syncCounter(s);
    throw err;
  }
}

/** Sends an earlier request again; it must be rejected. */
async function replay(kind: 'create_session' | 'derive', s: ActiveSession): Promise<void> {
  try {
    if (kind === 'create_session') {
      if (!s.lastCreateBody) throw new Error('Nothing to replay');
      const res = await s.app.api.createSession(s.lastCreateBody);
      logEvent(`REPLAY ACCEPTED: create_session replay opened a session (${res.result.path}, tx ${res.nearTx ?? '—'}): replay protection FAILED`, 'error');
    } else {
      if (!s.lastDeriveBody) throw new Error('Nothing to replay');
      const res = await s.app.api.derive(s.lastDeriveBody);
      logEvent(`REPLAY ACCEPTED: derive replay returned a key (tx ${res.nearTx ?? '—'}): replay protection FAILED`, 'error');
    }
  } catch (err) {
    if (err instanceof ApiError) logEvent(`Replay of ${kind} rejected as expected: ${describeError(err)}`);
    else throw err;
  }
}

function restart(): void {
  // Drop the session (and with it the non-extractable key and the in-memory token) and start over.
  session = null;
  renderResult(null);
  $('google-button').replaceChildren();
  logEvent('Session dropped: change key_index, client or publishable key, then Start session');
}

async function copyJson(): Promise<void> {
  await navigator.clipboard.writeText(resultsJson(runs));
  logEvent(`Copied ${runs.length} run(s) as JSON`);
}

// ---- Wiring ----

function init(): void {
  renderEnv();
  try {
    ($('pk') as HTMLInputElement).value = localStorage.getItem(PK_STORAGE) ?? '';
  } catch {
    // Convenience only.
  }
  $('load-app').addEventListener('click', () => void withBusy(loadApp));
  $('start').addEventListener('click', () => void withBusy(startSession));
  $('derive-again').addEventListener('click', () => {
    const s = session;
    if (s) void withBusy(() => derive(s, performance.now(), false));
  });
  $('revoke').addEventListener('click', () => {
    const s = session;
    if (s) void withBusy(() => revoke(s));
  });
  $('replay-session').addEventListener('click', () => {
    const s = session;
    if (s) void withBusy(() => replay('create_session', s));
  });
  $('replay-derive').addEventListener('click', () => {
    const s = session;
    if (s) void withBusy(() => replay('derive', s));
  });
  $('restart').addEventListener('click', () => {
    restart();
    render();
  });
  $('copy-json').addEventListener('click', () => void copyJson().catch((err: unknown) => logEvent(describeError(err), 'error')));
  $('clear-log').addEventListener('click', () => {
    runs = [];
    saveRuns();
    renderRuns();
  });
  renderRuns();
  render();
  if (envProblem) logEvent(envProblem, 'error');
}

init();
