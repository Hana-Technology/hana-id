// identity-probe.ts's body: the outside probe of the partner identity token's published keys (D210). The watchdog
// reads Hana's identity JWKS from its own Cloudflare account, so its fetches come from Cloudflare's network (and a
// Worker's subrequests can be told apart); someone who controls Hana's Cloudflare account could serve it a clean JWKS
// and partners another. This probe runs from GitHub Actions (`.github/workflows/identity-probe.yml`, hourly, D382),
// outside Cloudflare, looking like a partner's verifier (jose's User-Agent and Accept, no `CF-Worker` header), and
// applies the watchdog's rules (`@hana-id/jwks/identity`): every key pinned in `watchdog.pinnedIdentityKeys` and
// public members only, no private member, no duplicate member, the right shape, `issuer` and `jwks_uri` exact, a 200
// (a redirect is a finding, never followed) within 64 KB. Any finding fails the run, so GitHub notifies the repo's
// owners. It holds no secret and prints only public values (kids, thumbprints, URLs, statuses). Every value taken
// from Hana's answers is JSON-quoted, escaped to printable ASCII (`%` too) and cut, and no printed line can start with
// `::`, so a hostile JWKS can't inject a workflow command or break a log line (`quote`, `safeLine`).
//
// It narrows cloaking by the fetch's origin; it doesn't close it (an attacker can still single out partners' IPs) and
// it runs every 15 min: partner-side thumbprint pinning is what prevents a forged key being accepted.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import {
  IDENTITY_BODY_LIMIT,
  type IdentityResponse,
  identityDiscoveryUrl,
  identityJwksUrl,
  judgeDiscovery,
  judgeIdentityJwks,
  MAX_LISTED,
  readIdentityResponse,
} from '@hana-id/jwks/identity';
import { CliError, parseCli } from './cli.ts';

/** What `jose`'s `createRemoteJWKSet` sends from Node (jose 6.2.13, as the partner example verifier uses). */
export const PROBE_HEADERS = { 'user-agent': 'jose/v6.2.13', accept: 'application/json, application/jwk-set+json' } as const;
export const PROBE_TIMEOUT_MS = 10_000;

export const IDENTITY_PROBE_USAGE = `Usage: identity-probe.ts [<env>…]
  Fetches each env's identity JWKS and discovery document from here (outside Cloudflare) and checks them against
  envs/<env>.json: watchdog.pinnedIdentityKeys (else identityToken.publicKeys), identityToken.iss. Without <env>, every
  env with an identityToken except local*. Exits 1 on any finding. Prints public values only.`;

export interface ProbeTarget {
  env: string;
  iss: string;
  /** The thumbprints accepted: `watchdog.pinnedIdentityKeys`, or the manifest's own kids for an env without a watchdog. */
  pins: string[];
  pinSource: 'watchdog.pinnedIdentityKeys' | 'identityToken.publicKeys';
}

/** The envs to probe: those with an identity token, never a `local*` env (its API isn't reachable from CI). */
export function probeTargets(manifests: readonly Manifest[]): ProbeTarget[] {
  return manifests
    .filter((m) => m.identityToken && !m.name.startsWith('local'))
    .map((m) => {
      const pinned = m.watchdog?.pinnedIdentityKeys;
      return {
        env: m.name,
        iss: m.identityToken!.iss,
        pins: pinned ? [...pinned] : m.identityToken!.publicKeys.map((k) => k.kid),
        pinSource: pinned ? ('watchdog.pinnedIdentityKeys' as const) : ('identityToken.publicKeys' as const),
      };
    });
}

/** One document from outside Cloudflare: never follows a redirect, requires a 200, caps the body. Throws on a network error. */
export async function probeFetch(url: string, fetchFn: typeof fetch = fetch): Promise<IdentityResponse | { kind: 'status'; status: number }> {
  const res = await fetchFn(url, { headers: { ...PROBE_HEADERS }, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'redirect', status: res.status, location: res.headers.get('location') };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'status', status: res.status };
  }
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > IDENTITY_BODY_LIMIT) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'too_large' };
  }
  const reader = res.body?.getReader();
  if (!reader) return { kind: 'body', text: '' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > IDENTITY_BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      return { kind: 'too_large' };
    }
    chunks.push(value);
  }
  return { kind: 'body', text: Buffer.concat(chunks).toString('utf8') };
}

/** Longest value from Hana's answers shown in a log line, and longest line. */
export const MAX_VALUE_CHARS = 80;
export const MAX_LINE_CHARS = 1000;

/** `\uXXXX` for every UTF-16 unit outside printable ASCII (C0, DEL, C1, U+2028, U+2029, …) and for `%`. */
const escapeUnits = (s: string): string => s.replace(/[^\x20-\x7e]|%/gu, (ch) => ch.split('').map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));

/**
 * A value taken from Hana's answers (a kid, a member name, a path, a URL): JSON-quoted, cut to MAX_VALUE_CHARS, and
 * printable ASCII only, `%` included (GitHub decodes `%0A` in workflow command data), so it can't break a log line.
 */
export function quote(v: string | null): string {
  if (v === null) return 'none';
  const cut = v.length <= MAX_VALUE_CHARS ? v : `${v.slice(0, MAX_VALUE_CHARS - 3)}...`;
  return escapeUnits(JSON.stringify(cut));
}

/**
 * One line for the Actions log: control and non-ASCII characters escaped (no CR, LF or other line break survives),
 * cut to MAX_LINE_CHARS, and never starting with `::` (a workflow command) whatever its leading spaces.
 */
export function safeLine(line: string): string {
  let out = escapeUnits(line);
  if (out.length > MAX_LINE_CHARS) out = `${out.slice(0, MAX_LINE_CHARS - 3)}...`;
  return /^\s*::/u.test(out) ? `> ${out}` : out;
}

const shown = quote;

/** Every finding for one env (empty: clean). Each is one line of public values. */
export async function probeEnv(t: ProbeTarget, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const findings: string[] = [];
  const pins = { pins: t.pins, problems: [] };
  for (const what of ['jwks', 'discovery'] as const) {
    const url = what === 'jwks' ? identityJwksUrl(t.iss) : identityDiscoveryUrl(t.iss);
    let res: Awaited<ReturnType<typeof probeFetch>>;
    try {
      res = await probeFetch(url, fetchFn);
    } catch (err) {
      findings.push(`${what}: fetch failed (${err instanceof Error ? quote(err.name) : 'error'}) at ${url}`);
      continue;
    }
    if (res.kind === 'status') {
      findings.push(`${what}: HTTP ${res.status} at ${url}`);
      continue;
    }
    const r = readIdentityResponse(res);
    for (const f of r.findings) {
      const values = f.values.length ? `: ${f.values.map(quote).join(', ')}` : '';
      findings.push(`${what}: ${f.reason}${f.reason === 'redirect' ? ` (${f.detail.slice(0, f.detail.indexOf(' to '))})` : ''}${values} at ${url}`);
    }
    if (!r.parsed) continue;
    if (what === 'jwks') {
      const v = await judgeIdentityJwks(r.value, pins);
      for (const p of v.shapeProblems) findings.push(`jwks: bad_shape: ${p}`);
      for (const k of v.unpinned.slice(0, MAX_LISTED)) findings.push(`jwks: unpinned key keys[${k.index}] kid ${shown(k.kid)} thumbprint ${k.thumbprint ?? 'none'} (${k.reason}${k.extra.length ? `: ${k.extra.map(quote).join(', ')}` : ''})`);
      for (const k of v.privateKeys.slice(0, MAX_LISTED)) findings.push(`jwks: private members ${k.private.join(', ')} on keys[${k.index}] kid ${shown(k.kid)}`);
      for (const m of v.missing) findings.push(`jwks: pinned key ${m.thumbprint} ${m.reason}`);
    } else {
      const d = judgeDiscovery(r.value, t.iss);
      if (!d.shapeOk) findings.push('discovery: bad_shape: the discovery document is not a JSON object');
      for (const p of d.problems) findings.push(`discovery: ${p.field} is ${shown(p.published)}, expected ${JSON.stringify(p.expected)}`);
    }
  }
  return findings;
}

export interface IdentityProbeDeps {
  log: (line: string) => void;
  fetch?: typeof fetch;
  /** Every manifest name in envs/ (default: the files there). */
  envNames?: () => string[];
  loadManifest?: (name: string) => Manifest;
}

/** Runs the probe; returns the exit code (1 on any finding). */
export async function identityProbe(argv: readonly string[], deps: IdentityProbeDeps): Promise<number> {
  const args = parseCli(argv, { booleans: ['help'], strings: [] });
  if (args.flag('help')) {
    deps.log(IDENTITY_PROBE_USAGE);
    return 0;
  }
  const load = deps.loadManifest ?? loadEnv;
  const all = (deps.envNames ?? (() => readdirSync(join(repoRoot, 'envs')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))))();
  const names = args.positionals.length ? [...args.positionals] : all;
  for (const n of args.positionals) if (!all.includes(n)) throw new CliError(`No envs/${n}.json`);
  const targets = probeTargets(names.map((n) => load(n)));
  if (args.positionals.length && targets.length !== args.positionals.length) throw new CliError('Every env named must have an identityToken and not be local*');
  if (!targets.length) {
    deps.log('No env with an identity token to probe.');
    return 0;
  }
  let failed = 0;
  for (const t of targets) {
    const findings = await probeEnv(t, deps.fetch ?? fetch);
    if (findings.length) {
      failed++;
      deps.log(safeLine(`FAIL ${t.env} (${t.iss}; ${t.pins.length} pinned, from ${t.pinSource}):`));
      for (const f of findings) deps.log(safeLine(`  ${f}`));
    } else {
      deps.log(`ok ${t.env}: every published key pinned (${t.pinSource}), discovery as configured`);
    }
  }
  return failed ? 1 : 0;
}
