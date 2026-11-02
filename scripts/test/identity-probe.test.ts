// The outside probe of the identity JWKS (D210): which envs it probes, that it looks like a partner's verifier (jose's
// headers, no CF-Worker, no redirect followed), the watchdog's rules on what it reads, and the exit code. Stubbed fetch:
// no network.
import { generateKeyPairSync } from 'node:crypto';
import { type Manifest, loadEnv, manifestSchema, p256Thumbprint } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { MAX_LINE_CHARS, PROBE_HEADERS, identityProbe, probeEnv, probeFetch, probeTargets, quote, safeLine } from '../lib/identity-probe.ts';

function key() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  return { kty: 'EC' as const, crv: 'P-256' as const, x: j.x, y: j.y, kid: p256Thumbprint(j), use: 'sig' as const, alg: 'ES256' as const };
}

const ISS = 'https://api.example.test/v1/identity';
const [A, B] = [key(), key()];
const target = { env: 'staging', iss: ISS, pins: [A.kid, B.kid], pinSource: 'watchdog.pinnedIdentityKeys' as const };
const discovery = { issuer: ISS, jwks_uri: `${ISS}/jwks.json`, id_token_signing_alg_values_supported: ['ES256'] };

/** A Hana API serving `jwks` and `discovery` (each a body, a Response, or a function of the request). */
function server(over: { jwks?: unknown; discovery?: unknown } = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const answer = (v: unknown) => (v instanceof Response ? v : typeof v === 'string' ? new Response(v) : Response.json(v));
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    if (url === `${ISS}/jwks.json`) return answer(over.jwks ?? { keys: [A, B] });
    if (url === `${ISS}/.well-known/openid-configuration`) return answer(over.discovery ?? discovery);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

describe('probeTargets', () => {
  it('probes every env with an identity token except local*, against the watchdog pins (else the manifest kids)', () => {
    const sandbox = loadEnv('sandbox-dev');
    const { watchdog: _w, ...unwatched } = sandbox;
    const local = { ...sandbox, name: 'local-x' } as Manifest;
    const none = { ...sandbox, name: 'staging', identityToken: undefined } as Manifest;
    const t = probeTargets([sandbox, local, none, { ...(unwatched as Manifest), name: 'sandbox-2' }]);
    expect(t.map((x) => [x.env, x.pinSource])).toEqual([
      ['sandbox-dev', 'watchdog.pinnedIdentityKeys'],
      ['sandbox-2', 'identityToken.publicKeys'],
    ]);
    expect(t[0]!.pins).toEqual(sandbox.watchdog!.pinnedIdentityKeys);
    expect(t[0]!.iss).toBe(sandbox.identityToken!.iss);
    expect(manifestSchema.safeParse(sandbox).success).toBe(true);
  });
});

describe('probeFetch: looks like a partner verifier', () => {
  it("sends jose's User-Agent and Accept, no CF-Worker header, and never follows a redirect", async () => {
    const { fetchFn, seen } = server();
    await probeFetch(`${ISS}/jwks.json`, fetchFn);
    const init = seen[0]!.init;
    const headers = new Headers(init.headers);
    expect(headers.get('user-agent')).toBe('jose/v6.2.13');
    expect(headers.get('accept')).toBe(PROBE_HEADERS.accept);
    expect(headers.has('cf-worker')).toBe(false);
    expect(init.redirect).toBe('manual');
  });

  it('a redirect, another status, and a body over 64 KB (by header or by counting) are answers, not bodies', async () => {
    const r = server({ jwks: new Response(null, { status: 302, headers: { location: 'https://evil.example/jwks.json' } }) });
    expect(await probeFetch(`${ISS}/jwks.json`, r.fetchFn)).toEqual({ kind: 'redirect', status: 302, location: 'https://evil.example/jwks.json' });
    expect(await probeFetch(`${ISS}/nope`, r.fetchFn)).toEqual({ kind: 'status', status: 404 });
    const big = ' '.repeat(70 * 1024);
    expect(await probeFetch(`${ISS}/jwks.json`, server({ jwks: new Response(big) }).fetchFn)).toEqual({ kind: 'too_large' });
    expect(await probeFetch(`${ISS}/jwks.json`, server({ jwks: new Response(big, { headers: { 'content-length': String(big.length) } }) }).fetchFn)).toEqual({ kind: 'too_large' });
  });
});

describe('probeEnv: the watchdog rules', () => {
  it('a clean env has no finding', async () => {
    expect(await probeEnv(target, server().fetchFn)).toEqual([]);
  });

  it('an unpinned key, a key with extra or private members, and a pinned key missing are findings', async () => {
    const evil = key();
    const f = await probeEnv(target, server({ jwks: { keys: [A, { ...B, d: 'secret-scalar-not-printed' }, evil, { ...A, x5u: 'https://evil.example' }] } }).fetchFn);
    expect(f.some((l) => l.includes(`thumbprint ${evil.kid} (not_pinned)`))).toBe(true);
    expect(f.some((l) => l.includes('keys[1]') && l.includes('extra_members: "d"'))).toBe(true);
    expect(f.some((l) => l.startsWith('jwks: private members d on keys[1]'))).toBe(true);
    expect(f.some((l) => l.includes('keys[3]') && l.includes('extra_members: "x5u"'))).toBe(true);
    expect(f).toContain(`jwks: pinned key ${B.kid} not_clean`);
    expect(f.join('\n')).not.toContain('secret-scalar-not-printed');
  });

  it('duplicate members, the wrong shape, not JSON, a redirect, a status and a network failure are findings', async () => {
    const dup = `{"keys":[${JSON.stringify(A)},{"kty":"EC","crv":"P-256","x":"${B.x}","y":"${B.y}","kid":"${B.kid}","kid":"other","use":"sig","alg":"ES256"}]}`;
    expect((await probeEnv(target, server({ jwks: dup }).fetchFn)).some((l) => l.startsWith('jwks: duplicate_members: "keys[1].kid"'))).toBe(true);
    expect(await probeEnv(target, server({ jwks: { keys: [A, 'x', B] } }).fetchFn)).toEqual(['jwks: bad_shape: keys[1] is not an object']);
    expect((await probeEnv(target, server({ jwks: '{"keys": [' }).fetchFn))[0]).toMatch(/^jwks: not_json/u);
    expect((await probeEnv(target, server({ jwks: new Response(null, { status: 307, headers: { location: '/elsewhere' } }) }).fetchFn))[0]).toMatch(/^jwks: redirect \(HTTP 307\): "\/elsewhere"/u);
    expect((await probeEnv(target, server({ discovery: new Response('down', { status: 503 }) }).fetchFn))).toEqual([`discovery: HTTP 503 at ${ISS}/.well-known/openid-configuration`]);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await probeEnv(target, down)).toEqual([`jwks: fetch failed ("TypeError") at ${ISS}/jwks.json`, `discovery: fetch failed ("TypeError") at ${ISS}/.well-known/openid-configuration`]);
  });

  it('a wrong issuer or jwks_uri is a finding (exact match)', async () => {
    const f = await probeEnv(target, server({ discovery: { issuer: `${ISS}/`, jwks_uri: 'https://evil.example/jwks.json' } }).fetchFn);
    expect(f).toEqual([`discovery: issuer is "${ISS}/", expected "${ISS}"`, `discovery: jwks_uri is "https://evil.example/jwks.json", expected "${ISS}/jwks.json"`]);
  });
});

describe('identityProbe: the exit code', () => {
  const manifest = (name: string): Manifest => {
    const m = loadEnv('sandbox-dev');
    return { ...m, name, identityToken: { ...m.identityToken!, iss: ISS, publicKeys: [{ ...A }, { ...B }], signer: { kind: 'worker-secret', activeKid: A.kid } }, watchdog: { ...m.watchdog!, pinnedIdentityKeys: [A.kid, B.kid] } };
  };
  const deps = (fetchFn: typeof fetch, out: string[]) => ({ log: (l: string) => void out.push(l), fetch: fetchFn, envNames: () => ['staging', 'local'], loadManifest: manifest });

  it('0 when clean, 1 on any finding, with the findings printed', async () => {
    const out: string[] = [];
    expect(await identityProbe([], deps(server().fetchFn, out))).toBe(0);
    expect(out).toEqual(['ok staging: every published key pinned (watchdog.pinnedIdentityKeys), discovery as configured']);
    out.length = 0;
    expect(await identityProbe(['staging'], deps(server({ jwks: { keys: [A, B, key()] } }).fetchFn, out))).toBe(1);
    expect(out[0]).toMatch(/^FAIL staging/u);
    expect(out[1]).toMatch(/unpinned key keys\[2\]/u);
  });

  it('refuses an env it does not know or cannot probe', async () => {
    await expect(identityProbe(['nope'], deps(server().fetchFn, []))).rejects.toThrow(CliError);
    await expect(identityProbe(['local'], deps(server().fetchFn, []))).rejects.toThrow(/local/u);
  });
});

describe('log safety: a hostile JWKS cannot inject workflow commands', () => {
  /** A line GitHub Actions would read as a workflow command, or that breaks into several lines. */
  const unsafe = (line: string) => /[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029%]/u.test(line) || /^\s*::/u.test(line) || line.length > MAX_LINE_CHARS;

  it('quotes values as JSON, escapes control and non-ASCII characters and %, and caps them', () => {
    expect(quote('\n::set-output name=x::y')).toBe('"\\n::set-output name=x::y"');
    expect(quote('a%0Ab')).toBe('"a\\u00250Ab"');
    expect(quote('\u2028\u0085é😀')).toBe('"\\u2028\\u0085\\u00e9\\ud83d\\ude00"');
    expect(quote('x'.repeat(500)).length).toBeLessThan(100);
    expect(quote(null)).toBe('none');
    expect(safeLine('::error::pwned')).toBe('> ::error::pwned');
    expect(safeLine('   ::warning::x')).toMatch(/^> /u);
    expect(safeLine(`a\r\nb${'z'.repeat(5000)}`)).toMatch(/^a\\u000d\\u000ab/u);
    expect(safeLine('z'.repeat(5000)).length).toBe(MAX_LINE_CHARS);
  });

  it('a member named "\\n::set-output name=x::y", a %0A sequence and a hostile duplicate path all print as one safe line each', async () => {
    const hostile = '\n::set-output name=x::y';
    const kid = '%0A::error::injected%0D\r\n::add-mask::x';
    const jwks = `{"keys":[${JSON.stringify(A)},${JSON.stringify(B)},{"kty":"EC","crv":"P-256","x":"${A.x}","y":"${A.y}","kid":${JSON.stringify(kid)},"use":"sig","alg":"ES256",${JSON.stringify(hostile)}:1,"%0A::x":2,"%0A::x":3}]}`;
    const discoveryBody = { issuer: '\n::stop-commands::tok', jwks_uri: `${ISS}/jwks.json` };
    const out: string[] = [];
    const m = (): Manifest => {
      const s = loadEnv('sandbox-dev');
      return { ...s, name: 'staging', identityToken: { ...s.identityToken!, iss: ISS, publicKeys: [{ ...A }, { ...B }], signer: { kind: 'worker-secret', activeKid: A.kid } }, watchdog: { ...s.watchdog!, pinnedIdentityKeys: [A.kid, B.kid] } };
    };
    const code = await identityProbe([], { log: (l) => void out.push(l), fetch: server({ jwks, discovery: discoveryBody }).fetchFn, envNames: () => ['staging'], loadManifest: m });
    expect(code).toBe(1);
    expect(out.length).toBeGreaterThan(3);
    for (const line of out) expect(unsafe(line), line).toBe(false);
    const all = out.join('\n');
    // The hostile names are there, quoted and escaped, never raw.
    expect(all).toContain(quote(hostile));
    expect(all).toContain(quote(kid));
    expect(all).toContain(quote('%0A::x'));
    expect(all).not.toContain('%0A');
    expect(out.every((l) => !l.trimStart().startsWith('::'))).toBe(true);
  });

  it('a hostile redirect location is quoted too', async () => {
    const f = await probeEnv(target, server({ jwks: new Response(null, { status: 302, headers: { location: 'https://e.example/%0A::error::x' } }) }).fetchFn);
    expect(f[0]).toBe(`jwks: redirect (HTTP 302): ${quote('https://e.example/%0A::error::x')} at ${ISS}/jwks.json`);
    for (const l of f) expect(unsafe(safeLine(`  ${l}`))).toBe(false);
  });
});
