// The demo page: a partner app on @hana-id/web, written the way docs/integration.md tells partners to integrate.
// createHana once per page, login() synchronously in the click handler, signing through hana.ethereum (EIP-1193),
// hana.stellar and hana.near (the NEAR card, near-card.ts), export and logout through the client. The page holds nothing secret. It sees addresses, status, expiry,
// persistence, the signatures the user approves and, for pk_test_ apps, the login's per-stage timings.
//
// The client is injected (startDemo), so the tests drive the page against a fake one.
import type { HanaAddresses, HanaClient, HanaConfig, HanaStatus } from '@hana-id/web';
import type { DemoConfig } from './config.ts';
import { type ErrorRecord, type LoginTiming, diagnosticsJson } from './diagnostics.ts';
import { type DemoAction, errorInfo, isSignedOut, plainMessage } from './errors.ts';
import { type NearCard, startNearCard } from './near-card.ts';
import type { FetchLike } from './near.ts';
import { TEST_MESSAGE, testEvmTransaction, utf8Hex } from './requests.ts';

/** The part of the partner client the page uses. */
export type DemoClient = Pick<
  HanaClient,
  | 'ready'
  | 'status'
  | 'addresses'
  | 'expiresAtMs'
  | 'supportId'
  | 'persistence'
  | 'warning'
  | 'lastLogin'
  | 'vaultOrigin'
  | 'login'
  | 'cancelLogin'
  | 'logout'
  | 'exportKey'
  | 'revokeOtherDevices'
  | 'getIdentityToken'
  | 'requestEmailSharing'
  | 'on'
  | 'stellar'
  | 'ethereum'
  | 'near'
  | 'prepareApproval'
>;

export interface DemoDeps {
  config: DemoConfig;
  /** createHana. */
  createClient(config: HanaConfig): DemoClient;
  sdkVersion: string;
  /** Monotonic ms (performance.now). */
  now?: () => number;
  /** Wall-clock ms (Date.now). */
  clock?: () => number;
  copy?: (text: string) => Promise<void>;
  /** The page's own fetch, for the NEAR card's reads from the env's NEAR RPC. */
  fetch?: FetchLike;
  random?: (n: number) => Uint8Array;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The Login timings table's columns: the vault's login stages, in order (@hana-id/core timings.ts), with the sign-in
 * step as one column (`signIn`). Others the vault adds are listed after them.
 */
export const STAGES = ['app', 'popup', 'signIn', 'verify', 'chain', 'decrypt'] as const;
/** An email login's own stages (timings.ts): the user's and the issuer's part, summed in the sign-in column. */
export const EMAIL_SIGN_IN_STAGES = ['emailEntry', 'emailStart', 'emailCode', 'emailVerify'] as const;
const EMAIL_LABELS: Record<(typeof EMAIL_SIGN_IN_STAGES)[number], string> = { emailEntry: 'address', emailStart: 'code request', emailCode: 'code wait', emailVerify: 'verify' };

/** Which method a login's stages came from: an email login has the email step's stages, a Google one `google`. */
export function loginMethodOf(stages: Readonly<Record<string, number>>): 'google' | 'email' {
  return EMAIL_SIGN_IN_STAGES.some((k) => k in stages) || 'emailRelay' in stages ? 'email' : 'google';
}

/** The sign-in column: Google's pages (`google`), or the email step's address, code request, code wait and verify. */
export function signInMs(stages: Readonly<Record<string, number>>): number | undefined {
  if (loginMethodOf(stages) === 'google') return stages.google;
  return EMAIL_SIGN_IN_STAGES.reduce((sum, k) => sum + (stages[k] ?? 0), 0);
}

const PROGRESS: Record<string, string> = {
  popup_connected: 'The Hana sign-in window is open.',
  google: 'Choose your Google account in the sign-in window…',
  token: 'Google sign-in done. Checking it…',
  chain: 'Creating your wallet key on NEAR testnet (a few seconds)…',
  key_pending: 'Google just rotated its signing key; Hana ID is activating it. Retrying in up to 30 seconds…',
  done: 'Done.',
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function h(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

const show = (id: string, visible: boolean): void => {
  el(id).hidden = !visible;
};

const disable = (id: string, disabled: boolean): void => {
  el<HTMLButtonElement>(id).disabled = disabled;
};

/** A JWT's header and claims, decoded for display only (the page never trusts them: the partner backend verifies). */
export function decodeToken(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } | null {
  const part = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (ch) => ch.charCodeAt(0)))) as Record<string, unknown>;
  const [h, c] = token.split('.');
  try {
    return h && c ? { header: part(h), claims: part(c) } : null;
  } catch {
    return null;
  }
}

/** The verify-it-yourself snippet for a token's issuer and audience (docs/integration.md "Identity token"). */
export function verifySnippet(iss: string, aud: string): string {
  return [
    "import { createRemoteJWKSet, jwtVerify } from 'jose';",
    '',
    `const keys = createRemoteJWKSet(new URL('${iss}/jwks.json'));`,
    'const { payload } = await jwtVerify(token, keys, {',
    `  issuer: '${iss}',`,
    `  audience: '${aud}',`,
    "  algorithms: ['ES256'],",
    "  typ: 'hana-identity+jwt',",
    '});',
    '// payload.sub: the user in this app; payload.sid: this session; payload.wallets: their addresses.',
  ].join('\n');
}

/** "in 11 h 58 min" / "in 4 min" / "now". */
export function untilText(ms: number): string {
  if (ms <= 30_000) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${Math.max(min, 1)} min`;
  return `in ${Math.floor(min / 60)} h ${min % 60} min`;
}

const PERSISTENCE: Record<string, string> = {
  session: 'stays signed in across reloads and new tabs',
  none: 'every page load signs in again',
};

/** The one-line status under the explainer. */
export function statusText(c: Pick<DemoClient, 'status' | 'expiresAtMs' | 'persistence' | 'warning'> | null, nowMs: number): string {
  if (!c) return 'The Hana client could not start.';
  const s: HanaStatus = c.status;
  switch (s) {
    case 'unlocking':
      return 'Connecting to the Hana vault…';
    case 'logging_in':
      return 'Signing in…';
    case 'logged_out':
      return 'Logged out.';
    case 'error':
      return 'The Hana vault reported an error. Reload the page.';
    case 'logged_in': {
      const parts = ['Logged in'];
      if (c.expiresAtMs !== null) {
        const t = new Date(c.expiresAtMs);
        parts.push(`session ends by ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${untilText(c.expiresAtMs - nowMs)}), or sooner if idle`);
      }
      if (c.persistence) {
        const why = c.warning === 'storage_unavailable' ? ' (your browser blocks storage here)' : '';
        parts.push(`persistence: ${c.persistence}, ${PERSISTENCE[c.persistence] ?? ''}${why}`);
      }
      return `${parts.join(' · ')}.`;
    }
  }
}

export function startDemo(deps: DemoDeps): { client: DemoClient | null } {
  const { config } = deps;
  const now = deps.now ?? (() => performance.now());
  const clock = deps.clock ?? (() => Date.now());
  const copy = deps.copy ?? ((text: string) => navigator.clipboard.writeText(text));

  let client: DemoClient | null = null;
  let nearCard: NearCard | null = null;
  let progress = '';
  let pending = false;
  let unlockMs: number | null = null;
  const logins: LoginTiming[] = [];
  const errors: ErrorRecord[] = [];

  // ---- messages ----

  /** `box`: where the message goes (the page's error line, or the NEAR card's own). */
  function showError(action: DemoAction, e: unknown, box = 'error'): void {
    const info = errorInfo(e);
    errors.push({ at: new Date(clock()).toISOString(), action, code: info.code, reason: info.reason, message: info.message, requestId: info.requestId });
    // Signed out by Hana (D695): a notice, not an error. The `disconnect` and the request it refused say the same thing,
    // so whichever comes second leaves the one notice in place.
    if (isSignedOut(e)) {
      clearError();
      notice(plainMessage(e, action));
      return;
    }
    const node = el(box);
    node.textContent = plainMessage(e, action);
    node.hidden = false;
  }

  function clearError(): void {
    for (const id of ['error', 'near-error']) {
      el(id).hidden = true;
      el(id).textContent = '';
    }
  }

  function notice(text: string | null): void {
    const n = el('notice');
    n.textContent = text ?? '';
    n.hidden = text === null;
  }

  // ---- rendering ----

  function renderAddresses(a: HanaAddresses | null): void {
    show('wallet', a !== null);
    show('signing', a !== null);
    show('export', a !== null);
    show('export-near', a?.near !== undefined);
    el('stellar-address').textContent = a?.stellar ?? '';
    el('evm-address').textContent = a?.evm ?? '';
    const stellarLink = el<HTMLAnchorElement>('stellar-link');
    const evmLink = el<HTMLAnchorElement>('evm-link');
    stellarLink.hidden = !a || config.stellar.explorer === null;
    evmLink.hidden = !a || config.evm.explorer === null;
    if (a && config.stellar.explorer) stellarLink.href = `${config.stellar.explorer}/account/${encodeURIComponent(a.stellar)}`;
    if (a && config.evm.explorer) evmLink.href = `${config.evm.explorer}/address/${encodeURIComponent(a.evm)}`;
  }

  function render(): void {
    const c = client;
    const status = c?.status ?? 'error';
    const loggedIn = c !== null && c.addresses !== null && status === 'logged_in';
    el('status').textContent = statusText(c, clock());
    show('login', !loggedIn);
    disable('login', c === null || status === 'unlocking' || status === 'logging_in' || status === 'error');
    show('login-email', !loggedIn);
    disable('login-email', c === null || status === 'unlocking' || status === 'logging_in' || status === 'error');
    show('cancel-login', status === 'logging_in');
    show('logout', loggedIn);
    show('revoke', loggedIn);
    show('revoke-hint', loggedIn);
    const p = el('progress');
    p.textContent = status === 'logging_in' ? progress : '';
    p.hidden = !p.textContent;
    renderAddresses(loggedIn ? c.addresses : null);
    show('identity', loggedIn);
    if (!loggedIn) renderIdentity(null);
    for (const id of ['logout', 'revoke', 'sign-personal', 'sign-stellar', 'sign-evm-tx', 'export-stellar', 'export-evm', 'export-near', 'identity-token', 'email-share']) disable(id, pending || !loggedIn);
    nearCard?.render(loggedIn, pending);
  }

  /** The decoded token (display only) and the verify snippet, or nothing. */
  function renderIdentity(token: string | null): void {
    const decoded = token === null ? null : decodeToken(token);
    show('identity-result', decoded !== null);
    if (!decoded) {
      el('identity-claims').textContent = '';
      el('identity-snippet').textContent = '';
      el('identity-expiry').textContent = '';
      return;
    }
    el('identity-claims').textContent = JSON.stringify(decoded, null, 2);
    const exp = typeof decoded.claims.exp === 'number' ? decoded.claims.exp * 1000 : null;
    el('identity-expiry').textContent = exp === null ? '' : `Expires ${untilText(exp - clock())}. Send it to your backend as Authorization: Bearer <token>.`;
    el('identity-snippet').textContent = verifySnippet(String(decoded.claims.iss ?? ''), String(decoded.claims.aud ?? ''));
  }

  function renderTimings(): void {
    const body = el('timings');
    if (logins.length === 0) return;
    const shown: readonly string[] = [...STAGES, 'google', ...EMAIL_SIGN_IN_STAGES];
    const extra = [...new Set(logins.flatMap((l) => Object.keys(l.stages ?? {})))].filter((k) => !shown.includes(k));
    const cell = (ms: number | undefined) => h('td', {}, ms === undefined ? '—' : String(Math.round(ms)));
    body.replaceChildren(
      ...logins.map((l) =>
        h(
          'tr',
          {},
          h('td', {}, new Date(l.at).toLocaleTimeString()),
          h('td', {}, l.method),
          ...STAGES.map((s) => cell(!l.stages ? undefined : s === 'signIn' ? signInMs(l.stages) : l.stages[s])),
          h('td', {}, String(Math.round(l.totalMs))),
        ),
      ),
    );
    const email = logins.filter((l) => l.stages && loginMethodOf(l.stages) === 'email');
    if (email.length) {
      const parts = email.map((l) => EMAIL_SIGN_IN_STAGES.map((k) => `${EMAIL_LABELS[k]} ${Math.round(l.stages?.[k] ?? 0)}`).join(', '));
      body.append(h('tr', {}, h('td', { colspan: '9', class: 'muted' }, `Email sign-in: ${parts.join(' | ')}`)));
    }
    if (extra.length) body.append(h('tr', {}, h('td', { colspan: '9', class: 'muted' }, `Other stages: ${logins.map((l) => extra.map((k) => `${k} ${l.stages?.[k] ?? '—'}`).join(', ')).join(' | ')}`)));
    if (logins.some((l) => l.stages === null)) body.append(h('tr', {}, h('td', { colspan: '9', class: 'muted' }, 'No per-stage times: the vault returns them for test apps (pk_test_) only.')));
  }

  function renderUnlock(): void {
    el('unlock').textContent = unlockMs === null ? '' : `This page load restored your session in ${Math.round(unlockMs)} ms (vault frame, page and one API call).`;
  }

  // ---- client ----

  el('env-badge').textContent = `${config.environment} · testnet`;
  el('footer-env').textContent = `Environment ${config.environment} · app ${config.publishableKey.slice(0, 12)}… · @hana-id/web ${deps.sdkVersion} · EVM: ${config.evm.name} (${config.evm.id}) · NEAR: testnet${config.near.guestbook ? `, guestbook ${config.near.guestbook}` : ''}`;
  el('evm-label').textContent = `EVM (${config.evm.name})`;
  el('sign-evm-tx').textContent = `Sign a test transaction (${config.evm.name})`;
  const evmLink = el('evm-link');
  if (config.evm.explorer) evmLink.textContent = `View on ${new URL(config.evm.explorer).hostname} ↗`;

  const t0 = now();
  try {
    client = deps.createClient({
      publishableKey: config.publishableKey,
      environment: config.environment,
      evm: { chains: [{ id: config.evm.id, rpcUrl: config.evm.rpcUrl }], defaultChainId: config.evm.id },
      stellar: { networkPassphrase: config.stellar.networkPassphrase },
    });
  } catch (e) {
    showError('load', e);
    render();
    return { client: null };
  }
  const c = client;
  if (c.vaultOrigin !== config.vaultOrigin) {
    // The page's CSP frame-src is the configured vault: another one would be blocked (vault_unavailable).
    showError('load', Object.assign(new Error(`This build's vault origin ${config.vaultOrigin} is not the SDK's ${c.vaultOrigin}`), { code: 'config_mismatch' }));
  }

  c.on('statusChanged', (s) => {
    if (s !== 'logging_in') progress = '';
    render();
  });
  c.on('accountsChanged', () => render());
  c.on('loginProgress', ({ stage }) => {
    progress = PROGRESS[stage] ?? '';
    render();
  });
  let launcherNotice: string | null = null;
  c.on('launcher', ({ visible, label, clickable }) => {
    // A notice ("Signed by Hana under …") needs no click: only a button is pointed at.
    if (visible && clickable) {
      launcherNotice = `Click “${label}” on the Hana button at the bottom right of the page to continue.`;
      notice(launcherNotice);
    } else {
      // Only the launcher's own hint goes away with it (an outcome shown meanwhile stays).
      if (launcherNotice !== null && el('notice').textContent === launcherNotice) notice(null);
      launcherNotice = null;
    }
  });
  c.on('sessionExpired', () => {
    notice('Your session ended. Log in again.');
    render();
  });
  c.on('disconnect', ({ code, reason }) => {
    // `reason: 'signed_out'`: Hana signed this device out (Hana Home, another tab or another device); without it, the
    // demo keeps its lost-vault text.
    showError('load', reason === undefined ? { code } : { code, data: { reason } });
    render();
  });

  c.ready.then(
    () => {
      if (c.status === 'logged_in') {
        unlockMs = now() - t0;
        renderUnlock();
      }
      render();
    },
    (e: unknown) => {
      showError('load', e);
      render();
    },
  );

  // ---- actions ----

  /**
   * Synchronous up to client.login(), so the click's user activation still opens the popup. Each button names its
   * method, so the popup skips its chooser: "Log in with email" works once the demo app's `login_methods` include
   * email (docs/operations.md "Email login demo on sandbox-dev"); until then it fails with login_method_unavailable.
   */
  function login(method: 'google' | 'email'): void {
    const before = c.lastLogin;
    const start = now();
    const p = c.login({ method });
    clearError();
    notice(null);
    render();
    p.then(
      () => {
        const result = c.lastLogin;
        if (result && result !== before) {
          logins.push({ at: new Date(clock()).toISOString(), method, totalMs: now() - start, stages: result.timings ? { ...result.timings } : null });
          renderTimings();
        }
        notice(null);
        render();
      },
      (e: unknown) => {
        notice(null);
        showError('login', e);
        render();
      },
    );
  }

  /**
   * Runs one request at a time; its failure goes to the error box `box`. The task is called synchronously, so a signing
   * call it makes before its first await is still inside the click (the popup rule, docs/integration.md section 8).
   */
  function run(action: DemoAction, task: () => Promise<void>, box = 'error'): void {
    if (pending) return;
    pending = true;
    clearError();
    notice(null);
    render();
    task()
      .catch((e: unknown) => showError(action, e, box))
      .finally(() => {
        pending = false;
        render();
      });
  }

  function result(label: string, value: string | null, failure: string | null): void {
    const item = h('li', {}, h('div', {}, h('span', { class: failure ? 'fail' : 'ok' }, failure ? '✗ ' : '✓ '), label));
    if (value) item.append(h('code', {}, value));
    if (failure) item.append(h('div', { class: 'muted small' }, failure));
    el('results').prepend(item);
  }

  function sign(label: string, send: (a: HanaAddresses) => Promise<string>): void {
    const a = c.addresses;
    if (!a) return;
    run('sign', async () => {
      try {
        result(`${label}: signed`, await send(a), null);
      } catch (e) {
        result(`${label}: not signed`, null, plainMessage(e, 'sign'));
        throw e;
      }
    });
  }

  el('login').addEventListener('click', () => login('google'));
  el('login-email').addEventListener('click', () => login('email'));
  el('cancel-login').addEventListener('click', () => c.cancelLogin());
  el('logout').addEventListener('click', () =>
    run('logout', async () => {
      await c.logout();
      el('results').replaceChildren();
      notice('Logged out on this device, in every tab of this site.');
    }),
  );
  el('revoke').addEventListener('click', () =>
    run('revoke', async () => {
      const { revoked } = await c.revokeOtherDevices();
      notice(revoked === 0 ? 'No other device was signed in.' : `Signed out ${revoked} other device${revoked === 1 ? '' : 's'}.`);
    }),
  );
  el('identity-token').addEventListener('click', () =>
    run('identity', async () => {
      renderIdentity(await c.getIdentityToken());
    }),
  );
  // D411: Hana's email sharing sheet (the app's `identity_email` must be on_request or at_login); synchronous in the
  // click, as login: `run` calls the task at once, and requestEmailSharing opens its popup before any await.
  el('email-share').addEventListener('click', () =>
    run('identity', async () => {
      const state = await c.requestEmailSharing();
      notice(state === 'granted' ? 'Email shared: the next identity token carries it.' : state === 'declined' ? 'Email not shared.' : 'The sheet was closed; nothing changed.');
      renderIdentity(await c.getIdentityToken());
    }),
  );
  el('sign-personal').addEventListener('click', () =>
    sign('EVM personal_sign', async (a) => String(await c.ethereum.request({ method: 'personal_sign', params: [utf8Hex(TEST_MESSAGE), a.evm] }))),
  );
  el('sign-stellar').addEventListener('click', () => sign('Stellar message', async (a) => (await c.stellar.signMessage(TEST_MESSAGE, { address: a.stellar })).signedMessage));
  el('sign-evm-tx').addEventListener('click', () =>
    sign(`${config.evm.name} transaction (0 to yourself, not broadcast)`, async (a) =>
      String(await c.ethereum.request({ method: 'eth_signTransaction', params: [testEvmTransaction(a.evm, config.evm.id)] })),
    ),
  );
  for (const chain of ['stellar', 'evm', 'near'] as const) {
    el(`export-${chain}`).addEventListener('click', () =>
      run('export', async () => {
        await c.exportKey(chain);
        notice('The Hana export window is open: the key is shown only there.');
      }),
    );
  }
  for (const chain of ['stellar', 'evm'] as const) {
    el(`copy-${chain}`).addEventListener('click', () => {
      const a = c.addresses;
      if (!a) return;
      copy(a[chain]).then(
        () => notice(`${chain === 'stellar' ? 'Stellar' : 'EVM'} address copied.`),
        (e: unknown) => showError('copy', e),
      );
    });
  }
  el('copy-diagnostics').addEventListener('click', () => {
    const text = diagnosticsJson(
      {
        environment: config.environment,
        publishableKey: config.publishableKey,
        pageOrigin: location.origin,
        vaultOrigin: config.vaultOrigin,
        sdkVersion: deps.sdkVersion,
        evmChainId: config.evm.id,
        status: c.status,
        persistence: c.persistence,
        warning: c.warning,
        expiresAtMs: c.expiresAtMs,
        addresses: c.addresses,
        supportId: c.supportId,
        unlockMs,
        logins,
        errors,
        userAgent: navigator.userAgent,
      },
      clock(),
    );
    el('diagnostics').textContent = text;
    el<HTMLDetailsElement>('diagnostics-panel').open = true;
    copy(text).then(
      () => notice('Diagnostics copied. Paste them into your bug report.'),
      (e: unknown) => showError('copy', e),
    );
  });

  nearCard = startNearCard({
    config,
    client: c,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    clock,
    copy,
    random: deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
    recipient: location.host,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    run,
    notice,
    showError,
    plainMessage,
  });

  // The status line's "in N min" stays current.
  setInterval(render, 30_000);
  render();
  return { client: c };
}
