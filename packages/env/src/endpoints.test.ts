// Manifest endpoint rules (https RPC and API URLs, the recorded CKD key source; OPER-1) and the partner-origin rule the
// admin CLI applies (OPER-6).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { endpointUrlProblem, LOCALHOST_WILDCARD, MIN_CKD_SOURCES, manifestPath, manifestSchema, partnerOriginProblem } from './index.ts';

// Without identityToken: these tests move apiUrl, and the identity issuer must follow it (tested in identity.test.ts).
const raw = (): Record<string, unknown> => {
  const { identityToken: _i, ...m } = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
  return m;
};
const issues = (m: Record<string, unknown>) => manifestSchema.safeParse(m).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

describe('rpc, rpcFallback and apiUrl: https outside local* envs', () => {
  it('refuses http for every endpoint in a non-local env, loopback included', () => {
    for (const field of ['rpc', 'rpcFallback', 'apiUrl']) {
      expect(issues({ ...raw(), [field]: 'http://rpc.example.com' }), field).toEqual([`${field}: ${field} must be an https URL (http only for a loopback host in local* envs)`]);
      expect(issues({ ...raw(), [field]: 'http://127.0.0.1:3030' }), field).toHaveLength(1);
      expect(issues({ ...raw(), name: 'staging', [field]: 'http://localhost:3030' }), field).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${field}: `, 'u'))]));
    }
  });

  it('allows http only for a loopback host in a local* env', () => {
    const local = { ...raw(), name: 'local-dev', vaultOrigin: 'http://localhost:8787', authOrigin: 'http://localhost:8788' };
    expect(issues({ ...local, rpc: 'http://127.0.0.1:3030', apiUrl: 'http://localhost:8790' })).toEqual([]);
    expect(issues({ ...local, rpc: 'http://rpc.example.com' })).toHaveLength(1);
  });

  it('refuses other schemes', () => {
    expect(endpointUrlProblem('wss://rpc.example.com', 'local-dev')).toMatch(/https/u);
    expect(endpointUrlProblem('ftp://rpc.example.com', 'sandbox-dev')).toMatch(/https/u);
    expect(endpointUrlProblem('https://rpc.example.com', 'staging')).toBeNull();
  });
});

describe('ckdNetworkKeySource', () => {
  const source = { blockHeight: 123456, blockHash: '9DFC5WU3ihL8xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZ', rpcs: ['test.rpc.fastnear.com', 'rpc.testnet.near.org', 'near-testnet.drpc.org'] };

  it('records the block and at least three hosts on distinct registrable domains', () => {
    expect(MIN_CKD_SOURCES).toBe(3);
    expect(issues({ ...raw(), ckdNetworkKeySource: source })).toEqual([]);
    expect(issues({ ...raw(), ckdNetworkKeySource: { ...source, rpcs: source.rpcs.slice(0, 2) } })).toEqual(expect.arrayContaining([expect.stringMatching(/^ckdNetworkKeySource\.rpcs: /u)]));
    // Two hosts of one provider count once.
    expect(issues({ ...raw(), ckdNetworkKeySource: { ...source, rpcs: ['a.fastnear.com', 'b.fastnear.com', 'rpc.testnet.near.org'] } })).toEqual([
      'ckdNetworkKeySource.rpcs: ckdNetworkKeySource.rpcs must span at least 3 providers (registrable domains), got 2',
    ]);
    expect(issues({ ...raw(), ckdNetworkKeySource: { ...source, rpcs: [...source.rpcs, source.rpcs[0]] } })).toEqual(['ckdNetworkKeySource.rpcs: ckdNetworkKeySource.rpcs must be distinct']);
  });

  it('holds hosts only (no URL that could carry an API key), a base58 hash and no other field', () => {
    expect(issues({ ...raw(), ckdNetworkKeySource: { ...source, rpcs: ['https://rpc.testnet.near.org', ...source.rpcs.slice(1)] } })).toHaveLength(1);
    expect(issues({ ...raw(), ckdNetworkKeySource: { ...source, rpcs: ['near-testnet.drpc.org/?key=abc', ...source.rpcs.slice(0, 2)] } })).toHaveLength(1);
    expect(issues({ ...raw(), ckdNetworkKeySource: { ...source, blockHash: '0xabc' } })).toHaveLength(1);
    expect(issues({ ...raw(), ckdNetworkKeySource: { ...source, extra: 1 } })).toHaveLength(1);
  });

  it('is optional (an env pinned before D100 has none)', () => {
    const { ckdNetworkKeySource: _s, ...rest } = raw();
    expect(issues(rest)).toEqual([]);
  });
});

describe('partnerOriginProblem (admin CLI app origins)', () => {
  const hana = ['https://vault.hana.example', 'https://auth.hana-login.example', 'https://api.hana.example'];
  const p = (origin: string, envName = 'staging', testKey = true) => partnerOriginProblem(origin, { envName, testKey, hanaOrigins: hana });

  it('accepts a bare https origin on a real DNS name', () => {
    expect(p('https://wallet.example.com')).toBeNull();
    expect(p('https://wallet.example.com:8443', 'sandbox-dev', false)).toBeNull();
  });

  it('refuses what the API would silently drop: wildcards, odd characters, IPs, public suffixes, single labels', () => {
    for (const o of ['https://*.example.com', 'https://a;b.example.com', 'https://10.0.0.1', 'https://[2001:db8::1]', 'https://co.uk', 'https://workers.dev', 'https://intranet']) {
      expect(p(o, 'sandbox-dev'), o).not.toBeNull();
    }
    expect(p('http://wallet.example.com')).toMatch(/https/u);
    expect(p('https://wallet.example.com/')).toMatch(/bare origin/u);
  });

  it("refuses Hana's own origins", () => {
    for (const o of hana) expect(p(o, 'sandbox-dev')).toMatch(/Hana's own origins/u);
  });

  it('loopback origins and the localhost wildcard only for pk_test_ apps in dev envs', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', LOCALHOST_WILDCARD]) {
      expect(p(o, 'sandbox-dev', true), o).toBeNull();
      expect(p(o, 'local-dev', true), o).toBeNull();
      expect(p(o, 'sandbox-dev', false), `${o} pk_live_`).not.toBeNull();
      expect(p(o, 'staging', true), `${o} staging`).not.toBeNull();
    }
  });
});
