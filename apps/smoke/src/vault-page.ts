// The smoke page on the vault (docs/batch-b-spec.md, Order of work step 7): it mounts the partner client from
// @hana-id/web and drives it the way a partner page would. The vault iframe and the Hana pages do everything secret
// (session key, Google token, CKD, derivation v1, the server-held share); this page sees only what a partner sees:
// status, addresses, expiry, persistence, events and, for pk_test_ apps, the login's and the unlock's per-stage
// timings (stage names and durations only: @hana-id/core timings.ts, README "Timings").
//
// What it checks, with its results log (vault-runs.ts):
// - login through the vault and POST /v1/login, with timings and the ship-gate medians (ship-gate.ts);
// - persistence and unlock: every mount that comes back logged in (a page load, a reload, a new tab, the "Remount"
//   button) is logged as an unlock with its createHana → ready time (and, pk_test_, its stages) and must restore the
//   last run's addresses;
// - the auto-approve demo policy (demo-requests.ts): consent, covered and uncovered requests, the never-covered ones;
// - logout, revoke other devices and export.
// The client is injected (startVaultPage), so the tests drive the page against a fake one.
import {
  ApiError,
  type AppConfig,
  LOGIN_TIMING_DETAILS,
  LOGIN_TIMING_STAGES,
  UNLOCK_TIMING_DETAILS,
  UNLOCK_TIMING_STAGES,
  withOther,
} from '@hana-id/core';
import { policyId } from '@hana-id/core/policy';
import type { HanaAddresses, HanaClient, HanaConfig } from '@hana-id/web';
import { HanaApi } from './api.ts';
import type { PageEnv } from './config.ts';
import {
  DEMO_EVM_CHAIN_ID,
  DEMO_EVM_RPC_URL,
  DEMO_EVM_STRANGER,
  DEMO_POLICY,
  DEMO_STELLAR_PASSPHRASE,
  DEMO_STELLAR_STRANGER,
  demoEvmApprove,
  demoStellarTransfer,
} from './demo-requests.ts';
import { $, type Child, code, fillDl, h, logEvent, ms, setDisabled } from './dom.ts';
import { type RunRecord, parseStoredRuns, pkPrefix } from './runs.ts';
import { shipGate } from './ship-gate.ts';
import { ACCOUNT_STORAGE, PK_STORAGE, RUNS_STORAGE, VAULT_RUNS_STORAGE, isPublishableKey } from './storage-keys.ts';
import { type VaultRunRecord, accountLabelProblem, allResultsJson, compareVaultRun, parseStoredVaultRuns } from './vault-runs.ts';

/** The part of the partner client the page uses. */
export type SmokeClient = Pick<
  HanaClient,
  | 'ready'
  | 'status'
  | 'addresses'
  | 'expiresAtMs'
  | 'persistence'
  | 'warning'
  | 'lastLogin'
  | 'readyTimings'
  | 'login'
  | 'cancelLogin'
  | 'logout'
  | 'exportKey'
  | 'revokeOtherDevices'
  | 'signRaw'
  | 'requestAutoApprove'
  | 'autoApproveStatus'
  | 'revokeAutoApprove'
  | 'prepareApproval'
  | 'destroy'
  | 'on'
  | 'stellar'
  | 'ethereum'
>;

export interface VaultPageDeps {
  env: PageEnv;
  /** The env names this @hana-id/web build knows (HANA_ENVIRONMENTS). */
  environments: readonly string[];
  /** createHana. */
  createClient(config: HanaConfig): SmokeClient;
  fetch?: typeof fetch;
  reload?: () => void;
  now?: () => number;
}

/** Each kind's stages in order (they and `other` add up to the run's total) and its details (not added). */
const TIMING_LISTS: Record<VaultRunRecord['kind'], { stages: readonly string[]; details: readonly string[] }> = {
  login: { stages: [...LOGIN_TIMING_STAGES, 'other', 'overrun'], details: LOGIN_TIMING_DETAILS },
  unlock: { stages: [...UNLOCK_TIMING_STAGES, 'other', 'overrun'], details: UNLOCK_TIMING_DETAILS },
};

/** "name ms · name ms" for the `names` present in `stages`, in that order. */
function timingText(stages: Record<string, number>, names: readonly string[]): string {
  return names
    .filter((n) => typeof stages[n] === 'number')
    .map((n) => `${n} ${ms(stages[n])}`)
    .join(' · ');
}

/**
 * A run's stages and details as table cells. Names neither list knows (runs logged before results version 3, whose
 * `google` and `chain` still held what is now split out) go with the stages.
 */
function timingCells(kind: VaultRunRecord['kind'], stages: Record<string, number> | null): [string, string] {
  if (!stages) return ['— (pk_test_ apps only)', ''];
  const { stages: order, details } = TIMING_LISTS[kind];
  const known = new Set([...order, ...details]);
  return [timingText(stages, [...order, ...Object.keys(stages).filter((k) => !known.has(k))]), timingText(stages, details)];
}
/** The buttons that send a request which may need a Hana popup: one such request at a time. */
const REQUEST_BUTTONS = ['export-stellar', 'export-evm', 'aa-request', 'aa-status', 'aa-revoke', 'sign-stellar-self', 'sign-stellar-other', 'sign-evm-self', 'sign-evm-other', 'sign-personal', 'sign-raw'] as const;
const TEST_MESSAGE_HEX = `0x${[...new TextEncoder().encode('Hana ID smoke test: personal_sign')].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const RAW_TEST_BYTES = new TextEncoder().encode('Hana ID smoke test: raw bytes, not a transaction');

function describeError(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.requestId ? ` [request ${err.requestId}]` : ''}`;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const e = err as { code: unknown; message?: unknown; data?: unknown };
    let data = '';
    if (e.data !== undefined) {
      try {
        data = ` ${JSON.stringify(e.data).slice(0, 200)}`;
      } catch {
        // Unserialisable data: the code and message say enough.
      }
    }
    return `${String(e.code)}: ${typeof e.message === 'string' ? e.message : ''}${data}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const errorCode = (err: unknown): unknown => (typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: convenience only.
  }
}

/** The demo policy's id, or the validator's complaint (shown on the page; the tests keep the policy valid). */
function demoPolicyId(): string {
  try {
    return policyId(DEMO_POLICY);
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid';
  }
}

export function startVaultPage(deps: VaultPageDeps): void {
  const { env } = deps;
  const now = deps.now ?? (() => performance.now());
  const fetchFn = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const demoId = demoPolicyId();
  const vaultProblem =
    env.vaultOrigin === null || env.authOrigin === null
      ? `envs/${env.name}.json sets no vaultOrigin/authOrigin, so there is no vault for this env (the direct page still works)`
      : !deps.environments.includes(env.name)
        ? `@hana-id/web was built without env ${env.name} (known: ${deps.environments.join(', ') || 'none'}); run pnpm --filter @hana-id/smoke gen:envs`
        : null;

  let client: SmokeClient | null = null;
  let publishableKey: string | null = null;
  let app: AppConfig | null = null;
  /** The page's latest GET /v1/app; an unlock run waits for it so it carries the scope and client. */
  let appLoading: Promise<unknown> = Promise.resolve();
  let busy = false;
  let progress = '';
  let launcher = '';
  /**
   * A sign, auto-approve or export request is pending. They run one at a time (their buttons are disabled meanwhile),
   * so the counters below change only for the pending request and its outcome label is its own.
   */
  let requestPending = false;
  /** Bumped on every `autoApproved` event: a sign request that saw it bump was signed under the policy. */
  let autoApprovedCount = 0;
  /** Bumped on every launcher shown: a request that saw it bump needed a click into a Hana popup. */
  let launcherShownCount = 0;
  let signs = 0;
  let vaultRuns: VaultRunRecord[] = parseStoredVaultRuns(read(VAULT_RUNS_STORAGE));
  const directRuns = (): RunRecord[] => parseStoredRuns(read(RUNS_STORAGE));

  // ---- Rendering ----

  function renderEnv(): void {
    fillDl($('env'), [
      ['Environment', `${env.name} (${env.network})`],
      ['Signer', code(env.signer)],
      ['Vault', env.vaultOrigin ? code(env.vaultOrigin) : '—'],
      ['Auth pages', env.authOrigin ? code(env.authOrigin) : '—'],
      ['API', h('span', {}, code(env.apiUrl), env.apiUrlOverridden ? ' (VITE_HANA_API_URL override: this page only)' : '')],
      ['Relayer', h('a', { href: `https://testnet.nearblocks.io/address/${encodeURIComponent(env.relayer)}`, target: '_blank', rel: 'noreferrer' }, env.relayer)],
      ['Page origin', code(location.origin)],
    ]);
    const problem = $('env-problem');
    problem.hidden = vaultProblem === null;
    problem.textContent = vaultProblem ?? '';
    const warning = $('env-warning');
    warning.hidden = !env.apiUrlOverridden;
    warning.textContent = env.apiUrlOverridden
      ? `VITE_HANA_API_URL applies to this page's GET /v1/app only: the vault and login pages use the apiUrl they were built with (${env.name}'s manifest).`
      : '';
  }

  function renderApp(): void {
    if (!app) {
      $('app').replaceChildren();
      return;
    }
    const signerOk = app.signer === env.signer;
    fillDl($('app'), [
      ['Name', app.name ?? '—'],
      ['scope_id', code(app.scopeId)],
      ['Signer (API)', h('span', signerOk ? {} : { class: 'fail' }, code(app.signer), signerOk ? '' : ` ≠ ${env.signer}: the vault will refuse (config_mismatch)`)],
      ['Google client', h('span', {}, `${app.google.mode}: `, code(app.google.clientId))],
    ]);
  }

  function renderPolicy(): void {
    let inForce: Child = 'none (every request gets the approval popup)';
    const p = app?.autoApprovePolicy;
    if (p) {
      try {
        const id = policyId(p);
        inForce = h('span', {}, code(id), id === demoId ? h('span', { class: 'ok' }, ' = the demo policy') : h('span', { class: 'info' }, ' (not the demo policy)'));
      } catch (e) {
        inForce = h('span', { class: 'fail' }, e instanceof Error ? e.message : 'invalid policy');
      }
    }
    fillDl($('policy'), [
      ['Demo policyId', code(demoId)],
      ['App policy in force', app ? inForce : '— (load the app)'],
    ]);
  }

  function renderWallet(): void {
    const c = client;
    const a = c?.addresses ?? null;
    fillDl($('wallet'), [
      ['Status', c ? c.status : vaultProblem ? 'no vault' : 'not mounted (load the app)'],
      ['Stellar', a ? code(a.stellar) : '—'],
      ['EVM', a ? code(a.evm) : '—'],
      ['Expires', c?.expiresAtMs ? `${new Date(c.expiresAtMs).toISOString()} (${c.expiresAtMs})` : '—'],
      ['Persistence', c?.persistence ? `${c.persistence}${c.warning ? ` (${c.warning})` : ''}` : '—'],
      ['Login progress', progress || '—'],
      ['Launcher', launcher || 'hidden'],
    ]);
  }

  function renderButtons(): void {
    const c = client;
    const loggedIn = c !== null && c.addresses !== null;
    const status = c?.status;
    setDisabled('load-app', busy || vaultProblem !== null);
    setDisabled('login', busy || c === null || status === 'logged_in' || status === 'logging_in' || status === 'unlocking' || status === 'error');
    setDisabled('cancel-login', c === null || status !== 'logging_in');
    setDisabled('logout', busy || !loggedIn);
    setDisabled('remount', busy || publishableKey === null || vaultProblem !== null);
    setDisabled('revoke-others', busy || !loggedIn);
    for (const id of REQUEST_BUTTONS) setDisabled(id, !loggedIn || requestPending);
  }

  function renderRuns(): void {
    const direct = directRuns();
    $('timings').replaceChildren(
      ...vaultRuns.map((r) => {
        const [stages, details] = timingCells(r.kind, r.timings.stages);
        return h(
          'tr',
          {},
          h('td', {}, String(r.run)),
          h('td', {}, r.kind),
          h('td', { class: 'num' }, ms(r.timings.totalMs)),
          h('td', { class: 'mono' }, stages),
          h('td', { class: 'mono' }, details),
        );
      }),
    );
    $('runs').replaceChildren(
      ...vaultRuns.map((r, i) => {
        const checks = compareVaultRun(r, vaultRuns.slice(0, i), direct);
        return h(
          'tr',
          {},
          h('td', {}, String(r.run)),
          h('td', {}, r.kind),
          h('td', { class: 'mono' }, r.pkPrefix),
          h('td', {}, r.account || '—'),
          h('td', { class: 'mono' }, r.scopeId ?? '—'),
          h('td', {}, r.clientMode ?? '—'),
          h('td', {}, `${r.persistence}${r.warning ? ` (${r.warning})` : ''}`),
          h('td', { class: 'mono' }, r.stellar),
          h('td', { class: 'mono' }, r.evm),
          h('td', {}, ...checks.map((c) => h('div', { class: c.verdict }, `${c.other}: ${c.verdict.toUpperCase()} — ${c.note}`))),
        );
      }),
    );
    const gate = shipGate(env.name, env.signer, env.manifestApiUrl, vaultRuns, direct);
    fillDl($('ship-gate'), [
      ['Combined (vault chain stage)', `median ${ms(gate.combined.medianMs)} ms over ${Math.min(gate.combined.runs, 10)} of ${gate.combined.runs} login(s)`],
      ['Split (direct page create_session + derive_key)', `median ${ms(gate.split.medianMs)} ms over ${Math.min(gate.split.runs, 10)} of ${gate.split.runs} session(s)`],
      ['Verdict', h('span', { class: gate.verdict === 'pass' ? 'ok' : gate.verdict === 'fail' ? 'fail' : 'info' }, `${gate.verdict}: ${gate.note}`)],
    ]);
  }

  function render(): void {
    renderWallet();
    renderButtons();
  }

  // ---- Runs ----

  function record(kind: VaultRunRecord['kind'], c: SmokeClient, addresses: HanaAddresses, totalMs: number, account: string, stages: Record<string, number> | null): void {
    // Another tab of this page may have recorded since this one loaded (the README's new-tab and logout-across-tabs
    // steps): append to the stored log as it is now, so neither tab's runs are lost and run numbers stay unique.
    vaultRuns = parseStoredVaultRuns(read(VAULT_RUNS_STORAGE));
    const r: VaultRunRecord = {
      run: (vaultRuns.at(-1)?.run ?? 0) + 1,
      at: new Date().toISOString(),
      env: env.name,
      signer: env.signer,
      // The vault calls the apiUrl it was built with (the manifest's), whatever this page's VITE_HANA_API_URL says.
      apiUrl: env.manifestApiUrl,
      pkPrefix: pkPrefix(publishableKey ?? ''),
      scopeId: app?.scopeId ?? null,
      clientMode: app?.google.mode ?? null,
      clientId: app?.google.clientId ?? null,
      account,
      kind,
      keyIndex: 0,
      derivation: 1,
      persistence: c.persistence ?? 'none',
      warning: c.warning,
      stellar: addresses.stellar,
      evm: addresses.evm,
      expiresAtMs: c.expiresAtMs,
      timings: { stages: stages ? { ...stages } : null, totalMs },
    };
    vaultRuns.push(r);
    write(VAULT_RUNS_STORAGE, JSON.stringify(vaultRuns));
    renderRuns();
    const checks = compareVaultRun(r, vaultRuns.slice(0, -1), directRuns());
    for (const ch of checks) if (ch.verdict === 'fail') logEvent(`Run #${r.run} check FAILED against ${ch.other}: ${ch.note}`, 'error');
  }

  const accountLabel = (): string => ($('account') as HTMLInputElement).value.trim();

  // ---- Client ----

  function mount(pk: string): void {
    client?.destroy();
    client = null;
    progress = '';
    launcher = '';
    publishableKey = pk;
    const startedAt = now();
    let c: SmokeClient;
    try {
      c = deps.createClient({
        publishableKey: pk,
        environment: env.name,
        evm: { chains: [{ id: DEMO_EVM_CHAIN_ID, rpcUrl: DEMO_EVM_RPC_URL }], defaultChainId: DEMO_EVM_CHAIN_ID },
        stellar: { networkPassphrase: DEMO_STELLAR_PASSPHRASE },
      });
    } catch (e) {
      logEvent(`createHana failed: ${describeError(e)}`, 'error');
      render();
      return;
    }
    client = c;
    // Events of a client this page has since replaced (remount, another app) are ignored.
    const live = (): boolean => client === c;
    c.on('statusChanged', (s) => {
      if (!live()) return;
      if (s !== 'logging_in') progress = '';
      render();
    });
    c.on('accountsChanged', (a) => {
      if (!live()) return;
      logEvent(a ? `accountsChanged: ${a.stellar} / ${a.evm}` : 'accountsChanged: logged out');
      render();
    });
    c.on('loginProgress', ({ stage }) => {
      if (!live()) return;
      progress = stage;
      render();
    });
    c.on('launcher', ({ visible, label }) => {
      if (!live()) return;
      launcher = visible ? `shown: "${label}" (click it)` : '';
      if (visible) {
        launcherShownCount += 1;
        logEvent(`Hana launcher: "${label}"`);
      }
      render();
    });
    c.on('autoApproved', (d) => {
      if (!live()) return;
      autoApprovedCount += 1;
      logEvent(`autoApproved: ${d.kind} on ${d.chain}, ${d.function} at ${d.contract}`);
    });
    c.on('sessionExpired', () => {
      if (!live()) return;
      logEvent('sessionExpired: the session ended; log in again');
      render();
    });
    c.on('disconnect', ({ code: dc }) => {
      if (!live()) return;
      logEvent(`disconnect ${dc}`);
      render();
    });
    render();
    c.ready.then(
      () => {
        if (!live()) return;
        const readyMs = now() - startedAt;
        const a = c.addresses;
        // pk_test_ apps: the handshake's and the unlock's stages, with `other` (this page's own share of the total).
        const ready = c.readyTimings;
        const stages = ready ? withOther(ready, UNLOCK_TIMING_STAGES, readyMs) : null;
        if (c.status === 'logged_in' && a) {
          const unlockNote = stages?.unlockRtt === undefined ? '' : ` (POST /v1/vault/unlock ${ms(stages.unlockRtt)} ms, API ${ms(stages.unlockServer)} ms)`;
          logEvent(`Vault ready in ${ms(readyMs)} ms${unlockNote}: unlocked ${a.stellar} (persistence ${c.persistence})`);
          void appLoading.then(() => {
            if (live()) record('unlock', c, a, readyMs, accountLabel(), stages);
          });
        } else {
          logEvent(`Vault ready in ${ms(readyMs)} ms: logged out (no record, an expired or revoked share, or persistence 'none')${c.warning ? `, ${c.warning}` : ''}`);
        }
        render();
      },
      (e: unknown) => {
        if (!live()) return;
        logEvent(`Vault failed to load: ${describeError(e)}`, 'error');
        render();
      },
    );
  }

  function loadAppConfig(pk: string): Promise<AppConfig | null> {
    const p = fetchAppConfig(pk);
    appLoading = p;
    return p;
  }

  async function fetchAppConfig(pk: string): Promise<AppConfig | null> {
    const api = new HanaApi(env.apiUrl, pk, fetchFn);
    try {
      const config = await api.app();
      if (publishableKey !== pk) return null;
      app = config;
      logEvent(`GET /v1/app: ${config.name ?? 'app'}, scope ${config.scopeId}, ${config.google.mode} client [request ${config.requestId}]`);
      if (config.signer !== env.signer) logEvent(`The API's signer ${config.signer} is not this env's ${env.signer}: the vault will refuse to log in`, 'error');
      return config;
    } catch (e) {
      logEvent(`GET /v1/app failed: ${describeError(e)}`, 'error');
      return null;
    } finally {
      renderApp();
      renderPolicy();
    }
  }

  function loadApp(): void {
    const pk = ($('pk') as HTMLInputElement).value.trim();
    if (!isPublishableKey(pk)) {
      logEvent('Enter a publishable key (pk_test_…)', 'error');
      return;
    }
    const labelProblem = accountLabelProblem(accountLabel());
    if (labelProblem) {
      logEvent(labelProblem, 'error');
      return;
    }
    write(PK_STORAGE, pk);
    write(ACCOUNT_STORAGE, accountLabel());
    app = null;
    renderApp();
    renderPolicy();
    mount(pk);
    void loadAppConfig(pk);
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

  /** Synchronous up to client.login(), so the click's user activation still opens the popup. */
  function login(): void {
    const c = client;
    if (!c || busy) return;
    const account = accountLabel();
    const labelProblem = accountLabelProblem(account);
    if (labelProblem) {
      logEvent(labelProblem, 'error');
      return;
    }
    const before = c.lastLogin;
    const t0 = now();
    const pending = c.login();
    write(ACCOUNT_STORAGE, account);
    // The client mode and scope as the API sees them now (own vs shared client is a log check).
    const appP = publishableKey ? loadAppConfig(publishableKey) : Promise.resolve(null);
    void withBusy(async () => {
      try {
        const addresses = await pending;
        const totalMs = now() - t0;
        await appP;
        if (client !== c) return;
        const result = c.lastLogin;
        if (!result || result === before) {
          logEvent('Already logged in: no new login');
          return;
        }
        // The vault's, the popup's and the client's stages, with `other`: they add up to this page's total.
        const stages = result.timings ? withOther(result.timings, LOGIN_TIMING_STAGES, totalMs) : null;
        logEvent(`Logged in through the vault in ${ms(totalMs)} ms (chain ${ms(stages?.chain)} ms, other ${ms(stages?.other)} ms): ${addresses.stellar} / ${addresses.evm}`);
        if (!stages) logEvent('No per-stage timings: the vault returns them for pk_test_ apps only');
        record('login', c, addresses, totalMs, account, stages);
      } catch (e) {
        const code = errorCode(e);
        if (code === 'token_has_pii') logEvent(`Login refused: the Google token carries a claim outside the allow-list (${describeError(e)})`, 'error');
        else if (code === 'session_consumed') logEvent(`Login refused: ${describeError(e)}. The vault shows "Continue signing in"; click it.`, 'error');
        else throw e;
      }
    });
  }

  async function logout(): Promise<void> {
    const c = client;
    if (!c) return;
    await c.logout();
    logEvent('Logged out: share revoked, record deleted; other tabs of this app should log out too');
  }

  async function revokeOthers(): Promise<void> {
    const c = client;
    if (!c) return;
    const { revoked } = await c.revokeOtherDevices();
    logEvent(`Revoked ${revoked} share(s) on other devices`);
  }

  async function exportKey(chain: 'stellar' | 'evm'): Promise<void> {
    const c = client;
    if (!c) return;
    logEvent(`Export ${chain}: click the Hana launcher; the key is shown only in the Hana export window`);
    await c.exportKey(chain);
    logEvent(`Export ${chain}: done`);
  }

  async function autoApprove(kind: 'request' | 'status' | 'revoke'): Promise<void> {
    const c = client;
    if (!c) return;
    if (kind === 'request') {
      const r = await c.requestAutoApprove();
      logEvent(r.granted ? `Auto-approve accepted: policy ${r.policyId ?? '?'} until ${r.expiresAtMs ? new Date(r.expiresAtMs).toISOString() : '?'}${r.policyId === demoId ? ' (the demo policy)' : ''}` : 'Auto-approve declined');
    } else if (kind === 'status') {
      const s = await c.autoApproveStatus();
      logEvent(s ? `Auto-approve: "${s.label}" (${s.policyId}), until ${new Date(s.expiresAtMs).toISOString()}, used ${s.used.count} today` : 'Auto-approve: no consent in force');
    } else {
      await c.revokeAutoApprove();
      logEvent('Auto-approve stopped: every request needs the popup again');
    }
  }

  /** Runs `action` unless another sign, auto-approve or export request is pending (see `requestPending`). */
  function exclusive(action: () => Promise<void>): void {
    if (requestPending) return;
    requestPending = true;
    render();
    void action()
      .catch((e: unknown) => logEvent(describeError(e), 'error'))
      .finally(() => {
        requestPending = false;
        render();
      });
  }

  /**
   * Runs one sign request and logs its outcome: auto-approved with no popup, signed under the policy after the consent
   * screen (the first covered request with no consent in force), signed after approval, rejected or refused. Requests
   * run one at a time, so the `autoApproved` and launcher events seen meanwhile are this request's.
   */
  function sign(label: string, send: (c: SmokeClient, a: HanaAddresses) => Promise<unknown>): void {
    const c = client;
    const a = c?.addresses;
    if (!c || !a || requestPending) return;
    // The consent check below is awaited before the request is sent: open the approval popup now, in the click, so
    // the request can use it (D95; Safari would block window.open after the await). The vault closes it at once if the
    // request is auto-approved.
    c.prepareApproval();
    exclusive(async () => {
      signs += 1;
      const outcome = h('td', {}, 'waiting (approve or reject in the Hana popup)…');
      const took = h('td', { class: 'num' }, '…');
      $('signs').prepend(h('tr', {}, h('td', {}, String(signs)), h('td', {}, label), outcome, took));
      // Whether consent was in force before: a covered request without it opens the consent screen first, which may
      // reuse a recently active Hana popup (no launcher). undefined: the vault couldn't say.
      const consentBefore = await c.autoApproveStatus().then(
        (s) => s !== null,
        () => undefined,
      );
      const autoBefore = autoApprovedCount;
      const launcherBefore = launcherShownCount;
      const t0 = now();
      try {
        await send(c, a);
        took.textContent = ms(now() - t0);
        const auto = autoApprovedCount > autoBefore;
        const popup = launcherShownCount > launcherBefore || consentBefore === false;
        outcome.className = 'ok';
        outcome.textContent = !auto ? 'signed after approval' : popup ? 'signed under the policy, after the consent screen' : 'signed, auto-approved (no popup)';
      } catch (e) {
        took.textContent = ms(now() - t0);
        const code = errorCode(e);
        outcome.className = code === 4001 ? 'info' : 'fail';
        outcome.textContent = code === 4001 ? 'rejected (4001)' : `refused: ${describeError(e)}`;
      }
    });
  }

  // ---- Wiring ----

  renderEnv();
  ($('pk') as HTMLInputElement).value = read(PK_STORAGE) ?? '';
  ($('account') as HTMLInputElement).value = read(ACCOUNT_STORAGE) ?? '';
  $('demo-policy').textContent = JSON.stringify(DEMO_POLICY, null, 2);
  $('load-app').addEventListener('click', loadApp);
  $('login').addEventListener('click', login);
  $('cancel-login').addEventListener('click', () => client?.cancelLogin());
  $('logout').addEventListener('click', () => void withBusy(logout));
  $('remount').addEventListener('click', () => {
    if (publishableKey) mount(publishableKey);
  });
  $('reload').addEventListener('click', () => (deps.reload ?? (() => location.reload()))());
  $('revoke-others').addEventListener('click', () => void withBusy(revokeOthers));
  $('export-stellar').addEventListener('click', () => exclusive(() => exportKey('stellar')));
  $('export-evm').addEventListener('click', () => exclusive(() => exportKey('evm')));
  $('aa-request').addEventListener('click', () => exclusive(() => autoApprove('request')));
  $('aa-status').addEventListener('click', () => exclusive(() => autoApprove('status')));
  $('aa-revoke').addEventListener('click', () => exclusive(() => autoApprove('revoke')));
  $('sign-stellar-self').addEventListener('click', () =>
    sign('Stellar: SAC transfer of 1 stroop to yourself', (c, a) => c.stellar.signTransaction(demoStellarTransfer(a.stellar, a.stellar), { networkPassphrase: DEMO_STELLAR_PASSPHRASE })),
  );
  $('sign-stellar-other').addEventListener('click', () =>
    sign('Stellar: SAC transfer of 1 stroop to a stranger', (c, a) => c.stellar.signTransaction(demoStellarTransfer(a.stellar, DEMO_STELLAR_STRANGER), { networkPassphrase: DEMO_STELLAR_PASSPHRASE })),
  );
  $('sign-evm-self').addEventListener('click', () => sign('EVM: Sepolia USDC approve(you, 1)', (c, a) => c.ethereum.request({ method: 'eth_signTransaction', params: [demoEvmApprove(a.evm)] })));
  $('sign-evm-other').addEventListener('click', () =>
    sign('EVM: Sepolia USDC approve(burn address, 1)', (c) => c.ethereum.request({ method: 'eth_signTransaction', params: [demoEvmApprove(DEMO_EVM_STRANGER)] })),
  );
  $('sign-personal').addEventListener('click', () => sign('EVM: personal_sign', (c, a) => c.ethereum.request({ method: 'personal_sign', params: [TEST_MESSAGE_HEX, a.evm] })));
  $('sign-raw').addEventListener('click', () => sign('Raw: Stellar bytes', (c) => c.signRaw({ chain: 'stellar', bytes: RAW_TEST_BYTES })));
  $('copy-json').addEventListener('click', () =>
    void navigator.clipboard
      .writeText(allResultsJson(vaultRuns, directRuns()))
      .then(() => logEvent(`Copied ${vaultRuns.length} vault run(s) and the direct log as JSON`))
      .catch((e: unknown) => logEvent(describeError(e), 'error')),
  );
  $('clear-log').addEventListener('click', () => {
    vaultRuns = [];
    write(VAULT_RUNS_STORAGE, JSON.stringify(vaultRuns));
    renderRuns();
  });
  // Another tab of this page (or the direct page) recorded a run: show the logs as stored.
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== VAULT_RUNS_STORAGE && e.key !== RUNS_STORAGE) return;
    vaultRuns = parseStoredVaultRuns(read(VAULT_RUNS_STORAGE));
    renderRuns();
  });
  renderApp();
  renderPolicy();
  renderRuns();
  render();
  if (vaultProblem) {
    logEvent(vaultProblem, 'error');
    return;
  }
  // A stored key mounts the vault at once, so a page load is an unlock measurement.
  const stored = read(PK_STORAGE);
  if (stored && isPublishableKey(stored)) {
    mount(stored);
    void loadAppConfig(stored);
  }
}
