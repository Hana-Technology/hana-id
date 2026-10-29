import { getDomain, parse } from 'tldts';

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

/**
 * Hostname is loopback, as the URL parser normalises it: `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]` and
 * IPv4-mapped 127.0.0.0/8 (`[::ffff:7fxx:xxxx]`, how the parser writes `[::ffff:127.x.x.x]`), each also with a trailing
 * dot (`localhost.` is the same name to DNS and resolves to the same machine).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/u.test(h) || h === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(h);
}

/**
 * Why `hostname` isn't a real DNS name for a Hana origin, or null. An IP address (including 0.0.0.0, private ranges
 * and IPv4-mapped IPv6), a bare public suffix (`workers.dev`, `co.uk`), a single label (`intranet`) or a name with a
 * trailing dot is never one: the browser would treat it as the local machine, as an IP, or as a site of its own, so
 * neither the loopback rule nor the same-site rule would hold.
 */
function dnsNameProblem(hostname: string): string | null {
  if (hostname.endsWith('.')) return 'must be a DNS name without a trailing dot';
  const parsed = parse(hostname, { allowPrivateDomains: true });
  if (parsed.isIp) return 'must be a DNS name, not an IP address';
  if (parsed.domain === null) return 'must be a name under a registrable domain (not a public suffix or a single label)';
  return null;
}

/**
 * Why `value` can't be a Hana page origin (`vaultOrigin`/`authOrigin`) in env `envName`, or null. It must be a bare
 * origin exactly as `URL.origin` (and so `MessageEvent.origin`) spells it: scheme, host and non-default port, no path,
 * no trailing slash. `https` everywhere; `http` only for a loopback host in a `local*` env, and loopback hosts at all
 * only there. Every other host is a real DNS name (see dnsNameProblem), in every env.
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
  if (!loopback) {
    const problem = dnsNameProblem(url.hostname);
    if (problem) return problem;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'must be https (http only for loopback in local* envs)';
  return null;
}

/** Literal app-origin entry for any `http://localhost:<port>` (the API's `LOCALHOST_WILDCARD`). */
export const LOCALHOST_WILDCARD = 'http://localhost:*';

/** Host names the API serves in CSP and frame-ancestors (apps/api/src/vault/origins.ts `SAFE_ORIGIN_RE`), lowercase. */
const SAFE_HOST_RE = /^(\[::1\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/u;

/**
 * Why `value` can't be one of an app's partner origins in env `envName`, or null (the admin CLI's check, OPER-6): what
 * the API would silently drop or refuse is refused here instead. A bare origin as `URL.origin` spells it; https, with a
 * real DNS name (see dnsNameProblem: no IP, public suffix, single label or wildcard); loopback origins and the
 * `http://localhost:*` wildcard only for a `pk_test_` app in a dev env (`local*`, `sandbox*`), as the API allows them;
 * never one of Hana's own origins (`hanaOrigins`: vaultOrigin, authOrigin, apiUrl's origin), which would let a Hana
 * page act as a partner parent.
 */
export function partnerOriginProblem(value: string, opts: { envName: string; testKey: boolean; hanaOrigins: readonly string[] }): string | null {
  const loopbackOk = opts.testKey && isDevEnv(opts.envName);
  if (value === LOCALHOST_WILDCARD) return loopbackOk ? null : 'the localhost wildcard is only for pk_test_ apps in dev envs (local*, sandbox*)';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.origin === 'null' || url.origin !== value) return `must be a bare origin (${url.origin === 'null' ? 'scheme://host[:port]' : url.origin}), with no path, query or trailing slash`;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must be http(s)';
  if (!SAFE_HOST_RE.test(url.hostname)) return 'must be a plain host name (letters, digits, hyphens and dots; no wildcard)';
  if (opts.hanaOrigins.includes(value)) return "is one of Hana's own origins (vaultOrigin, authOrigin or apiUrl)";
  if (isLoopbackHost(url.hostname)) return loopbackOk ? null : 'may be loopback only for pk_test_ apps in dev envs (local*, sandbox*)';
  const problem = dnsNameProblem(url.hostname);
  if (problem) return problem;
  if (url.protocol !== 'https:') return 'must be https (http only for loopback)';
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
