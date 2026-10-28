import { ckdKeyProblem } from '@hana-id/core';
import { loadEnv } from '@hana-id/env';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENV, pageEnvFrom } from '../src/config.ts';
import { NearRpc, formatNear, formatTgas, googleOwnClients, googleSharedClients, sumGas } from '../src/near.ts';

describe('page config', () => {
  it('takes only public fields from the default manifest', () => {
    const m = loadEnv(DEFAULT_ENV);
    const env = pageEnvFrom(m);
    expect(Object.keys(env).sort()).toEqual(['apiUrl', 'apiUrlOverridden', 'authOrigin', 'ckdDomainId', 'ckdNetworkKey', 'mpc', 'name', 'network', 'relayer', 'rpc', 'signer', 'vaultOrigin']);
    expect(env).toMatchObject({ name: DEFAULT_ENV, signer: m.signer, apiUrl: m.apiUrl, apiUrlOverridden: false, vaultOrigin: m.vaultOrigin, authOrigin: m.authOrigin });
    expect(env.vaultOrigin).toMatch(/^https:\/\//u);
  });

  it('gives null Hana origins for an env without the vault pages', () => {
    const m = loadEnv(DEFAULT_ENV);
    const { vaultOrigin: _v, authOrigin: _a, ...rest } = m;
    expect(pageEnvFrom(rest)).toMatchObject({ vaultOrigin: null, authOrigin: null });
  });

  it('accepts an https or localhost API override only', () => {
    const m = loadEnv(DEFAULT_ENV);
    expect(pageEnvFrom(m, 'http://localhost:8787')).toMatchObject({ apiUrl: 'http://localhost:8787', apiUrlOverridden: true });
    expect(pageEnvFrom(m, '  ')).toMatchObject({ apiUrl: m.apiUrl, apiUrlOverridden: false });
    expect(() => pageEnvFrom(m, 'http://api.example')).toThrow(/https/);
  });

  it('fails clearly while ckdNetworkKey is the UNSET placeholder', () => {
    // ckdKeyProblem lives in @hana-id/core (tested there); the page runs it on its own env.
    expect(ckdKeyProblem({ ...pageEnvFrom(loadEnv(DEFAULT_ENV)), ckdNetworkKey: 'UNSET-run-scripts/fetch-ckd-key.ts' })).toMatch(/UNSET placeholder.*fetch-ckd-key sandbox-dev/);
    expect(ckdKeyProblem(pageEnvFrom(loadEnv(DEFAULT_ENV)))).toBeNull();
  });
});

describe('NEAR RPC helpers', () => {
  it('views a contract method with base64 JSON args', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ jsonrpc: '2.0', id: 'x', result: { result: [...new TextEncoder().encode('{"shared_clients":[["google","s.apps"]],"pending_shared_clients":[],"mpc":"m","ckd_domain_id":2}')] } }),
    );
    const config = await new NearRpc('https://rpc.example', f).getConfig('signer.testnet');
    expect(config.shared_clients).toEqual([['google', 's.apps']]);
    const sent = JSON.parse(f.mock.calls[0]![1]!.body as string) as { params: { method_name: string; args_base64: string; account_id: string } };
    expect(sent.params).toMatchObject({ method_name: 'get_config', account_id: 'signer.testnet', args_base64: btoa('{}') });
  });

  it('reports RPC errors', async () => {
    const f = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 'x', error: { message: 'Server error', data: 'account x does not exist while viewing' } }));
    await expect(new NearRpc('https://rpc.example', f).getScope('x', 's1')).rejects.toThrow(/does not exist/);
  });

  it('lists effective shared clients (matured pending ones included) and own clients', () => {
    const config = {
      shared_clients: [['google', 'a'], ['other', 'z']] as [string, string][],
      pending_shared_clients: [
        { provider: 'google', aud: 'b', effective_at_ms: 100 },
        { provider: 'google', aud: 'c', effective_at_ms: 300 },
      ],
      mpc: 'm',
      ckd_domain_id: 2,
    };
    expect(googleSharedClients(config, 200)).toEqual(['a', 'b']);
    expect(googleOwnClients({ id: 's1', clients: [['google', 'x'], ['other', 'y']], allow_shared: true })).toEqual(['x']);
  });

  it('sums gas over the transaction and all receipts', () => {
    const gas = sumGas({
      transaction_outcome: { outcome: { gas_burnt: 2_000_000_000_000, tokens_burnt: '200000000000000000000' } },
      receipts_outcome: [{ outcome: { gas_burnt: 10_000_000_000_000, tokens_burnt: '1000000000000000000000' } }, { outcome: { gas_burnt: 500_000_000_000, tokens_burnt: '50000000000000000000' } }],
    });
    expect(gas).toEqual({ gasBurnt: 12_500_000_000_000, tokensBurnt: '1250000000000000000000', receipts: 2 });
    expect(formatTgas(gas.gasBurnt)).toBe('12.50 Tgas');
    expect(formatNear(gas.tokensBurnt)).toBe('0.001250 NEAR');
    expect(() => sumGas({})).toThrow();
  });
});
