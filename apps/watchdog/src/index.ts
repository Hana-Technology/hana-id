// Hana ID watchdog: a Cloudflare Worker on its own account (D86) that checks hana-signer's issuer keys against
// Google's JWKS every 5 min, acts only as D82 allows, alerts as D85 says, and serves a read-only status for the
// admin portal (D83). docs/governance-spec.md "Watchdog service"; apps/watchdog/README.md.
import { GOOGLE_JWKS_URL, type Jwk, usableJwks } from '@hana-id/jwks';
import { type Notifier, notifierFromEnv } from './channels.ts';
import { type Env, digestHourUtc, isDevEnvName } from './env.ts';
import { BODY_LIMITS, readJsonCapped } from './http.ts';
import { log } from './log.ts';
import { NearChain, NearWriter, Rpc } from './near.ts';
import { identityDiscoveryUrl, identityJwksUrl, parseIdentityPins } from './identity.ts';
import { parsePins } from './pins.ts';
import { relayerThresholds } from './relayer.ts';
import { type RunDeps, runWatchdog } from './run.ts';
import { handleRequest } from './status.ts';
import { Store } from './store.ts';

export type { Env } from './env.ts';

/** Google's JWKS, fetched directly with no cache (spec step 1). Throws on HTTP or JSON errors and on no usable key. */
export async function fetchGoogleJwks(): Promise<Jwk[]> {
  const res = await fetch(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const keys = usableJwks(await readJsonCapped<unknown>(res, BODY_LIMITS.jwks));
  if (keys.length === 0) throw new Error('JWKS has no usable key');
  return keys;
}

/**
 * Hana's published email JWKS (usable RS256 keys; may be empty), fetched with no cache. Informational only: the
 * watchdog compares it with the pins and never trusts it (docs/email-login-spec.md "Issuer configuration").
 */
export async function fetchEmailJwks(url: string): Promise<Jwk[]> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`email JWKS HTTP ${res.status}`);
  return usableJwks(await readJsonCapped<unknown>(res, BODY_LIMITS.jwks));
}

/**
 * One of Hana's identity documents (the JWKS or the discovery document) as parsed JSON, fetched with no cache and its
 * body capped (64 KB). Informational for the watchdog's own judgement only: it is compared with the pins and the
 * configured issuer, never trusted (D210).
 */
export async function fetchIdentityDocument(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`identity document HTTP ${res.status}`);
  return readJsonCapped<unknown>(res, BODY_LIMITS.jwks);
}

/** The real dependencies of a run, from the Worker's bindings. */
export function runDeps(env: Env, notifier: Notifier = notifierFromEnv(env)): RunDeps {
  const rpc = new Rpc([env.NEAR_RPC, ...(env.NEAR_RPC_FALLBACK ? [env.NEAR_RPC_FALLBACK] : [])]);
  let writer: NearWriter | null = null;
  if (env.WATCHDOG_KEY) {
    try {
      writer = new NearWriter(rpc, env.WATCHDOG_ACCOUNT, env.SIGNER_ACCOUNT, env.WATCHDOG_KEY);
    } catch {
      log({ event: 'config', outcome: 'error', code: 'bad_watchdog_key' }, 'error');
    }
  }
  const emailJwksUrl = env.EMAIL_JWKS_URL?.trim();
  const emailPins = parsePins(env.EMAIL_PINS);
  const identityIss = env.IDENTITY_ISS?.trim() || null;
  return {
    store: new Store(env.DB),
    chain: new NearChain(rpc, env.SIGNER_ACCOUNT),
    writer,
    fetchJwks: fetchGoogleJwks,
    fetchEmailJwks: emailJwksUrl ? () => fetchEmailJwks(emailJwksUrl) : null,
    fetchIdentity: identityIss ? { jwks: () => fetchIdentityDocument(identityJwksUrl(identityIss)), discovery: () => fetchIdentityDocument(identityDiscoveryUrl(identityIss)) } : null,
    notifier,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    config: {
      envName: env.ENV_NAME,
      network: env.NEAR_NETWORK,
      signer: env.SIGNER_ACCOUNT,
      watchdogAccount: env.WATCHDOG_ACCOUNT,
      digestHourUtc: digestHourUtc(env),
      relayer: env.RELAYER_ACCOUNT?.trim() || null,
      relayerThresholds: relayerThresholds(env.RELAYER_FUNDS),
      emailPins,
      devEnv: isDevEnvName(env.ENV_NAME),
      identity: { iss: identityIss, pins: parseIdentityPins(env.IDENTITY_PINS) },
    },
  };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runWatchdog(runDeps(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, { env, store: new Store(env.DB), notifier: notifierFromEnv(env), now: Date.now });
    } catch {
      log({ event: 'status_request', outcome: 'error', code: 'internal' }, 'error');
      return new Response(JSON.stringify({ error: 'Internal error', code: 'internal' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  },
} satisfies ExportedHandler<Env>;
