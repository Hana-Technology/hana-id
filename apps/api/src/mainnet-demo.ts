// The mainnet demo exception to D39 and the user events staff see (D426, D428; docs/mainnet-demo-and-key-export-spec.md):
// - whether an app has the demo on, as GET /v1/app serves it: only in a dev env on testnet, only for a test scope, only
//   when Hana staff set `apps.mainnet_demo` (migration 0013); anything unreadable is off;
// - POST /v1/mainnet-demo/events: the vault's report of one demo signature (no key, signature or signed bytes), stored
//   as a `mainnet_signature` row in `user_events`;
// - the `key_exported` row the export window's /v1/login writes once it succeeded (login.ts).
//
// SECURITY: nothing here reads or stores a key, a token, a signature, a path or a sub. A vault report is the vault's
// word (the API can't check that a signature was made); it is rate-limited per app and labelled as reported.
import { MAINNET_DEMO_EVENTS_ENDPOINT, MAINNET_DEMO_EVM_CHAINS, MAINNET_DEMO_TX_CAP_USD_MICROS } from '@hana-id/core/demo-config';
import { directoryUser } from './directory/store.ts';
import type { Env } from './env.ts';
import { done, lap, limiter, newCtx, reject } from './handlers.ts';
import { readJson } from './http.ts';
import { log } from './log.ts';
import { mainnetDemoOn } from './mainnet-demo-setting.ts';
import { vaultApp, vaultLimits } from './vault/endpoints.ts';

export { MAINNET_DEMO_EVENTS_ENDPOINT };
export { mainnetDemoEnv, mainnetDemoOn } from './mainnet-demo-setting.ts';

/** Demo signatures one app may report per hour (a script on the page can't flood the table). */
export const MAINNET_DEMO_EVENTS_PER_HOUR = 120;
const HOUR = 3_600_000;
const MAX_BODY = 1024;

export interface MainnetDemoEvent {
  chain: 'evm' | 'stellar';
  network: string;
  kind: 'evm_tx' | 'stellar_tx';
  address: string;
  usdMicros: number;
}

/** The report's body, exactly: a demo network, a signing address of that chain, a value within the cap. */
export function toMainnetDemoEvent(body: unknown): MainnetDemoEvent | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'address,chain,kind,network,usdMicros') return null;
  const { chain, network, kind, address, usdMicros } = b;
  if (typeof usdMicros !== 'string' || !/^\d{1,9}$/u.test(usdMicros) || BigInt(usdMicros) > MAINNET_DEMO_TX_CAP_USD_MICROS) return null;
  if (chain === 'evm') {
    if (kind !== 'evm_tx' || typeof network !== 'string' || !/^\d{1,10}$/u.test(network) || !MAINNET_DEMO_EVM_CHAINS.includes(Number(network))) return null;
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(address)) return null;
  } else if (chain === 'stellar') {
    if (kind !== 'stellar_tx' || network !== 'pubnet') return null;
    if (typeof address !== 'string' || !/^G[A-Z2-7]{55}$/u.test(address)) return null;
  } else return null;
  return { chain, network, kind, address, usdMicros: Number(usdMicros) };
}

/** POST /v1/mainnet-demo/events: the vault page only, for an app with the demo on. */
export async function handleMainnetDemoEvent(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, MAINNET_DEMO_EVENTS_ENDPOINT, request);
  const gate = await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const limited = await vaultLimits(request, env, ctx, app);
  if (limited) return limited;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const event = toMainnetDemoEvent(parsed.body);
  if (!event) return reject(ctx, 400, 'bad_request', 'Not a mainnet demo event');
  if (!(await mainnetDemoOn(env, app))) return reject(ctx, 409, 'mainnet_demo_off', 'The mainnet demo is not on for this app');
  try {
    const hit = await limiter(env, `mainnet-demo:${app.id}`).hit([{ name: 'mainnet_demo:hour', windowMs: HOUR, max: MAINNET_DEMO_EVENTS_PER_HOUR }]);
    if (!hit.ok) return reject(ctx, 429, 'rate_limited', 'Too many mainnet demo events for this app', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  try {
    await env.DB.prepare(
      `INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at)
       VALUES ('mainnet_signature', ?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(app.id, app.scope_id, event.chain, event.network, event.address, event.usdMicros, requestId, Date.now())
      .run();
  } catch {
    return reject(ctx, 503, 'event_unavailable', 'Could not record the event');
  }
  lap(ctx, 'insert');
  return done(ctx, 200, { recorded: true });
}

/**
 * The export window's login succeeded (login.ts): records `key_exported` for the account's user. Never throws, never
 * slows the answer (run in the background); a failure (the directory keys missing, migration 0013 not applied) is
 * logged without any identifier but the app's.
 */
export async function recordKeyExport(
  env: Env,
  a: { appId: string; scopeId: string; root: { provider: string; sub: string }; chain: 'stellar' | 'evm' | null; requestId: string },
): Promise<void> {
  const user = await directoryUser(env, a.scopeId, a.root).catch(() => 'no_user_id_key' as const);
  if (typeof user === 'string') {
    log({ event: 'key_export_unrecorded', requestId: a.requestId, appId: a.appId, code: user }, 'warn');
    return;
  }
  try {
    await env.DB.prepare(
      `INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at)
       VALUES ('key_exported', ?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, ?6)`,
    )
      .bind(a.appId, a.scopeId, user.internalId, a.chain, a.requestId, Date.now())
      .run();
  } catch {
    log({ event: 'key_export_unrecorded', requestId: a.requestId, appId: a.appId, code: 'write_failed' }, 'warn');
  }
}
