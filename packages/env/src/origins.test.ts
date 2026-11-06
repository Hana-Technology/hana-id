import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_BLOCKS, envAlertLabel, hanaOriginProblem, isDevEnv, isLocalEnv, isLoopbackHost, loadEnv, manifestPath, manifestSchema, siteOf } from './index.ts';

// Without identityToken: these tests move apiUrl, and the identity issuer must follow it (tested in identity.test.ts).
// Without the dashboard blocks: these tests rename the env and move vaultOrigin/authOrigin, and the dashboard's own
// origin rules (D38 against the vault's site, tested in dashboard.test.ts) would add issues of their own.
const raw = (): Record<string, unknown> => {
  const m = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
  delete m.identityToken;
  for (const k of DASHBOARD_BLOCKS) delete m[k];
  return m;
};

/** sandbox-dev with the given name and origins (undefined drops the field). */
function manifest(name: string, vaultOrigin: string | undefined, authOrigin: string | undefined): Record<string, unknown> {
  const { vaultOrigin: _v, authOrigin: _a, ...rest } = raw();
  return { ...rest, name, ...(vaultOrigin === undefined ? {} : { vaultOrigin }), ...(authOrigin === undefined ? {} : { authOrigin }) };
}

const messages = (m: Record<string, unknown>) => manifestSchema.safeParse(m).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

const VAULT = 'https://vault.hana.example';
const AUTH = 'https://auth.hana-login.example';

describe('isDevEnv / isLocalEnv', () => {
  it('ties dev privileges to the env name prefix', () => {
    for (const name of ['local', 'local-dev', 'localhost', 'sandbox', 'sandbox-dev', 'sandbox2']) expect(isDevEnv(name)).toBe(true);
    for (const name of ['prod', 'staging', 'mainnet', 'dev-sandbox', 'my-local', '']) expect(isDevEnv(name)).toBe(false);
  });

  it('allows loopback Hana origins only for local*', () => {
    expect(isLocalEnv('local-dev')).toBe(true);
    expect(isLocalEnv('sandbox-dev')).toBe(false);
    expect(isLocalEnv('prod-local')).toBe(false);
  });
});

describe('envAlertLabel (D419)', () => {
  it('labels every testnet env by its name, sandbox, staging and local first', () => {
    expect(envAlertLabel({ name: 'sandbox-dev', network: 'testnet' })).toBe('[SANDBOX]');
    expect(envAlertLabel({ name: 'sandbox2', network: 'testnet' })).toBe('[SANDBOX]');
    expect(envAlertLabel({ name: 'staging', network: 'testnet' })).toBe('[STAGING]');
    expect(envAlertLabel({ name: 'staging-eu', network: 'testnet' })).toBe('[STAGING]');
    expect(envAlertLabel({ name: 'local-dev', network: 'testnet' })).toBe('[LOCAL]');
    expect(envAlertLabel({ name: 'prod', network: 'testnet' })).toBe('[TESTNET]');
    expect(envAlertLabel({ name: 'my-sandbox', network: 'testnet' })).toBe('[TESTNET]');
  });

  it('never labels an env on another network, whatever its name', () => {
    for (const name of ['prod', 'mainnet', 'sandbox-dev', 'staging', 'local']) expect(envAlertLabel({ name, network: 'mainnet' }), name).toBe('');
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback hostnames as the URL parser spells them', () => {
    for (const o of ['http://localhost:5173', 'http://a.localhost', 'http://127.0.0.1', 'http://127.1.2.3:8', 'http://[::1]:80']) {
      expect(isLoopbackHost(new URL(o).hostname)).toBe(true);
    }
    for (const o of ['https://localhost.example', 'https://128.0.0.1', 'https://example.com', 'http://[::2]', 'https://[::ffff:a00:1]', 'https://0.0.0.0']) {
      expect(isLoopbackHost(new URL(o).hostname)).toBe(false);
    }
  });

  it('also catches a trailing-dot localhost and IPv4-mapped 127.0.0.0/8', () => {
    for (const o of ['https://localhost.', 'https://a.localhost.', 'https://[::ffff:7f00:1]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:127.9.8.7]', 'https://0x7f.1']) {
      expect(isLoopbackHost(new URL(o).hostname), o).toBe(true);
    }
  });
});

describe('hanaOriginProblem', () => {
  it('accepts a bare https origin, with or without a port', () => {
    expect(hanaOriginProblem('https://vault.hana.example', 'prod')).toBeNull();
    expect(hanaOriginProblem('https://vault.hana.example:8443', 'prod')).toBeNull();
  });

  it('requires the exact URL.origin spelling (what MessageEvent.origin compares against)', () => {
    for (const bad of ['https://vault.hana.example/', 'https://vault.hana.example/vault', 'https://vault.hana.example?x=1', 'https://VAULT.hana.example', 'https://vault.hana.example:443', 'https://u@vault.hana.example']) {
      expect(hanaOriginProblem(bad, 'prod'), bad).toMatch(/bare origin/u);
    }
    expect(hanaOriginProblem('vault.hana.example', 'prod')).toBe('is not a URL');
    expect(hanaOriginProblem('data:text/html,x', 'prod')).toMatch(/bare origin/u);
  });

  it('requires https outside loopback', () => {
    expect(hanaOriginProblem('http://vault.hana.example', 'prod')).toMatch(/must be https/u);
    expect(hanaOriginProblem('http://vault.hana.example', 'local-dev')).toMatch(/must be https/u);
    expect(hanaOriginProblem('wss://vault.hana.example', 'prod')).toMatch(/bare origin|must be https/u);
  });

  it('allows loopback only in local* envs, never in sandbox or production envs', () => {
    for (const o of ['http://localhost:8787', 'http://127.0.0.1:8788', 'https://localhost:8787']) {
      expect(hanaOriginProblem(o, 'local-dev'), o).toBeNull();
      expect(hanaOriginProblem(o, 'sandbox-dev'), o).toMatch(/loopback only in local/u);
      expect(hanaOriginProblem(o, 'prod'), o).toMatch(/loopback only in local/u);
    }
  });
});

describe('hanaOriginProblem: a real DNS name outside loopback', () => {
  it('refuses a trailing-dot or IPv4-mapped loopback outside local* envs, as loopback', () => {
    for (const env of ['prod', 'sandbox-dev']) {
      for (const o of ['https://localhost.', 'https://a.localhost.', 'https://[::ffff:7f00:1]', 'https://[::ffff:7f09:807]']) {
        expect(hanaOriginProblem(o, env), `${env} ${o}`).toMatch(/loopback only in local/u);
      }
    }
  });

  it('refuses IP addresses, bare public suffixes, single labels and trailing dots in every env', () => {
    const cases: [string, RegExp][] = [
      ['https://0.0.0.0', /not an IP address/u],
      ['https://10.0.0.1', /not an IP address/u],
      ['https://192.168.1.10:8443', /not an IP address/u],
      ['https://8.8.8.8', /not an IP address/u],
      ['https://[2001:db8::1]', /not an IP address/u],
      ['https://[::ffff:a00:1]', /not an IP address/u],
      ['https://workers.dev', /registrable domain/u],
      ['https://co.uk', /registrable domain/u],
      ['https://intranet', /registrable domain/u],
      ['https://vault.hana.example.', /trailing dot/u],
    ];
    for (const env of ['prod', 'sandbox-dev', 'local-dev']) {
      for (const [o, why] of cases) expect(hanaOriginProblem(o, env), `${env} ${o}`).toMatch(why);
    }
  });

  it('still accepts real names, workers.dev account hostnames included', () => {
    for (const env of ['prod', 'sandbox-dev']) {
      for (const o of ['https://vault.hana.example', 'https://hana.example', 'https://hana-id-vault-sandbox-dev.tingtc.workers.dev', 'https://tingtc.workers.dev']) {
        expect(hanaOriginProblem(o, env), `${env} ${o}`).toBeNull();
      }
    }
    expect(hanaOriginProblem('http://localhost.:8787', 'local-dev')).toBeNull();
  });

  it('the manifest schema reports them on the field', () => {
    expect(messages(manifest('prod', 'https://10.0.0.1', AUTH))).toEqual([expect.stringMatching(/^vaultOrigin: vaultOrigin must be a DNS name, not an IP address/u)]);
    expect(messages(manifest('sandbox-dev', VAULT, 'https://workers.dev'))).toEqual([expect.stringMatching(/^authOrigin: authOrigin must be a name under a registrable domain/u)]);
  });
});

describe('Hana origins against apiUrl', () => {
  const withApi = (name: string, apiUrl: string, vault: string, auth: string) => ({ ...manifest(name, vault, auth), apiUrl });

  it('refuses a Hana origin equal to apiUrl’s origin, in every env', () => {
    for (const name of ['prod', 'sandbox-dev']) {
      expect(messages(withApi(name, `${VAULT}/`, VAULT, AUTH))).toEqual([`vaultOrigin: vaultOrigin must not be apiUrl's origin (${VAULT})`]);
      expect(messages(withApi(name, `${AUTH}/v1`, VAULT, AUTH))).toEqual([`authOrigin: authOrigin must not be apiUrl's origin (${AUTH})`]);
    }
    expect(messages(withApi('local-dev', 'http://localhost:8787', 'http://localhost:8787', 'http://localhost:8788'))).toEqual([
      "vaultOrigin: vaultOrigin must not be apiUrl's origin (http://localhost:8787)",
    ]);
  });

  it('refuses a Hana origin on apiUrl’s site outside dev envs, and allows it in them', () => {
    expect(messages(withApi('prod', 'https://api.hana.example', VAULT, AUTH))).toEqual([
      expect.stringMatching(/^vaultOrigin: vaultOrigin must be a different site from apiUrl outside local\*\/sandbox\* envs \(both are https:\/\/hana\.example\)/u),
    ]);
    expect(messages(withApi('prod', 'https://api.hana-api.example', VAULT, AUTH))).toEqual([]);
    // sandbox-dev: api, vault and auth are distinct hostnames on one workers.dev account (allowed in dev envs).
    expect(messages(JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>)).toEqual([]);
  });
});

describe('siteOf', () => {
  it('uses the Public Suffix List, private section included', () => {
    expect(siteOf('https://vault.hana.example')).toBe('https://hana.example');
    expect(siteOf('https://a.b.example.co.uk')).toBe('https://example.co.uk');
    // workers.dev is a public suffix: one account's hostnames share a site, two accounts' don't.
    expect(siteOf('https://hana-id-vault-sandbox-dev.tingtc.workers.dev')).toBe('https://tingtc.workers.dev');
    expect(siteOf('https://x.other.workers.dev')).toBe('https://other.workers.dev');
  });

  it('keeps the scheme and treats an IP as its own site', () => {
    expect(siteOf('http://127.0.0.1:8787')).toBe('http://127.0.0.1');
    expect(siteOf('http://hana.example')).not.toBe(siteOf('https://hana.example'));
  });
});

describe('manifestSchema: vaultOrigin / authOrigin', () => {
  it('sandbox-dev sets both, on its workers.dev hostnames', () => {
    const env = loadEnv('sandbox-dev');
    expect(env.vaultOrigin).toMatch(/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/u);
    expect(env.authOrigin).toMatch(/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/u);
    expect(env.vaultOrigin).not.toBe(env.authOrigin);
  });

  it('is optional: both or neither', () => {
    expect(messages(manifest('prod', undefined, undefined))).toEqual([]);
    expect(messages(manifest('prod', VAULT, AUTH))).toEqual([]);
    expect(messages(manifest('prod', VAULT, undefined))).toEqual(['authOrigin: vaultOrigin and authOrigin are set together or not at all']);
    expect(messages(manifest('prod', undefined, AUTH))).toEqual(['vaultOrigin: vaultOrigin and authOrigin are set together or not at all']);
  });

  it('refuses non-https and non-origin values, naming the field', () => {
    expect(messages(manifest('prod', 'http://vault.hana.example', AUTH))).toEqual([expect.stringMatching(/^vaultOrigin: vaultOrigin must be https/u)]);
    expect(messages(manifest('prod', VAULT, `${AUTH}/login`))).toEqual([expect.stringMatching(/^authOrigin: authOrigin must be a bare origin/u)]);
    expect(messages(manifest('prod', 1 as unknown as string, AUTH))).not.toEqual([]);
  });

  it('allows loopback only for local* env names', () => {
    const local = manifest('local-dev', 'http://localhost:8787', 'http://127.0.0.1:8788');
    expect(messages(local)).toEqual([]);
    expect(messages({ ...local, name: 'sandbox-dev' })).toEqual([expect.stringMatching(/^vaultOrigin: .*loopback only in local/u), expect.stringMatching(/^authOrigin: .*loopback only in local/u)]);
    expect(messages({ ...local, name: 'prod' })).toHaveLength(2);
  });

  it('refuses one origin for both, in every env', () => {
    for (const name of ['prod', 'sandbox-dev']) {
      expect(messages(manifest(name, VAULT, VAULT))).toEqual(['authOrigin: vaultOrigin and authOrigin must be different origins']);
    }
    expect(messages(manifest('local-dev', 'http://localhost:8787', 'http://localhost:8787'))).toEqual(['authOrigin: vaultOrigin and authOrigin must be different origins']);
  });

  it('refuses a same-site pair outside local*/sandbox* envs', () => {
    const sameSite = manifest('prod', 'https://vault.hana.example', 'https://auth.hana.example');
    expect(messages(sameSite)).toEqual([expect.stringMatching(/^authOrigin: .*different sites outside local\*\/sandbox\* envs \(both are https:\/\/hana\.example\)/u)]);
    // The fixture's apiUrl is on tingtc.workers.dev too, so both are also same-site with the API.
    const workersDev = manifest('staging', 'https://v.tingtc.workers.dev', 'https://a.tingtc.workers.dev');
    expect(messages(workersDev)).toEqual([
      expect.stringMatching(/^authOrigin: vaultOrigin and authOrigin must be different sites/u),
      expect.stringMatching(/^vaultOrigin: vaultOrigin must be a different site from apiUrl/u),
      expect.stringMatching(/^authOrigin: authOrigin must be a different site from apiUrl/u),
    ]);
    // Different workers.dev accounts are different sites.
    expect(messages(manifest('staging', 'https://v.one.workers.dev', 'https://a.two.workers.dev'))).toEqual([]);
  });

  it('accepts a same-site pair in dev envs (sandbox-dev runs on one workers.dev account)', () => {
    expect(messages(manifest('sandbox-dev', 'https://v.tingtc.workers.dev', 'https://a.tingtc.workers.dev'))).toEqual([]);
    expect(messages(manifest('local-dev', 'http://localhost:8787', 'http://localhost:8788'))).toEqual([]);
  });
});
