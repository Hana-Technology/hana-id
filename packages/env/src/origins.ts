import { getDomain } from 'tldts';

/**
 * Dev envs (`local*`, `sandbox*`) get the dev-only privileges of batch B: loopback partner origins, partner-origin calls
 * to `/v1/sessions`, `/v1/derive` and `/v1/sessions/revoke` for `pk_test_` keys, and same-site Hana origins. The rule is
 * tied to the env name so no flag can turn it on in a production env. `@hana-id/web` mirrors it as the `devEnv` build
 * constant (envs.generated.ts).
 */
export function isDevEnv(name: string): boolean {
  return /^(local|sandbox)/u.test(name);
}

/** `local*` envs only: the only envs whose Hana origins (`vaultOrigin`, `authOrigin`) may be loopback. */
export function isLocalEnv(name: string): boolean {
  return /^local/u.test(name);
}

/** Hostname is loopback: `localhost`, `*.localhost`, 127.0.0.0/8 or `[::1]` (as the URL parser normalises them). */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/u.test(hostname) || hostname === '[::1]';
}

/**
 * Why `value` can't be a Hana page origin (`vaultOrigin`/`authOrigin`) in env `envName`, or null. It must be a bare
 * origin exactly as `URL.origin` (and so `MessageEvent.origin`) spells it: scheme, host and non-default port, no path,
 * no trailing slash. `https` everywhere; `http` only for a loopback host in a `local*` env, and loopback hosts at all
 * only there.
 */
export function hanaOriginProblem(value: string, envName: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.origin === 'null' || url.origin !== value) return `must be a bare origin (${url.origin === 'null' ? 'scheme://host[:port]' : url.origin}), with no path, query or trailing slash`;
  const loopback = isLoopbackHost(url.hostname);
  if (loopback && !isLocalEnv(envName)) return 'may be loopback only in local* envs';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'must be https (http only for loopback in local* envs)';
  return null;
}

/**
 * The site (scheme + registrable domain) of an origin, as browsers compute it for SameSite and storage partitioning:
 * the Public Suffix List including its private section, so two `<account>.workers.dev` hostnames of one account are
 * same-site while two accounts are not. An IP address or a bare public suffix is its own site.
 */
export function siteOf(origin: string): string {
  const url = new URL(origin);
  const domain = getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
  return `${url.protocol}//${domain}`;
}
