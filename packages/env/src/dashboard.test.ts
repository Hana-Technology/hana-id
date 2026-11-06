import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appChangeDelayProblems, DASHBOARD_BLOCKS, emailFromProblem, hanaOwnOrigins, loadEnv, manifestPath, manifestSchema } from './index.ts';

type Raw = Record<string, unknown>;
// Without identityToken: these tests move apiUrl, and the identity issuer must follow it (tested in identity.test.ts).
// Without the dashboard blocks: sandbox-dev has them (M4), and these tests add their own set (`dashboard()` below) or
// none, so they hold whatever the real manifest's blocks say.
const raw = (): Raw => {
  const m = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Raw;
  delete m.identityToken;
  for (const k of DASHBOARD_BLOCKS) delete m[k];
  return m;
};

/** A complete set of dashboard fields on sandbox-dev's workers.dev subdomain. */
const dashboard = (): Raw => ({
  console: {
    workerName: 'hana-id-console-sandbox-dev',
    d1Name: 'hana-id-console-sandbox-dev',
    origin: 'https://hana-id-console-sandbox-dev.tingtc.workers.dev',
    authWorkerName: 'hana-id-console-auth-sandbox-dev',
    authOrigin: 'https://hana-id-console-auth-sandbox-dev.tingtc.workers.dev',
  },
  files: {
    workerName: 'hana-id-files-sandbox-dev',
    origin: 'https://hana-id-files-sandbox-dev.tingtc.workers.dev',
    logosBucket: 'hana-id-logos-sandbox-dev',
    statementsBucket: 'hana-id-statements-sandbox-dev',
    exportsBucket: 'hana-id-exports-sandbox-dev',
  },
  admin: {
    workerName: 'hana-id-admin-sandbox-dev',
    origin: 'https://hana-id-admin-sandbox-dev.tingtc.workers.dev',
    accessTeamDomain: 'hana.cloudflareaccess.com',
    accessAud: 'UNSET',
    staffEmails: ['staff@example.com'],
  },
  usage: { neonRegion: 'aws-ap-southeast-2', writerHyperdrive: 'hana-id-usage-writer-sandbox-dev', adminHyperdrive: 'hana-id-usage-admin-sandbox-dev' },
  email: { from: 'Hana ID <no-reply@mail.example.com>', securityAlias: 'security@example.com' },
  ownerGrantDelayMs: 60_000,
});

const withDashboard = (patch: (d: Raw) => void = () => undefined): Raw => {
  const d = dashboard();
  patch(d);
  return { ...raw(), ...d };
};
const block = (d: Raw, name: string) => d[name] as Raw;
const messages = (m: Raw): string[] => {
  const r = manifestSchema.safeParse(m);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('appChangeDelayMs', () => {
  it('is required, sandbox-dev sets 60 s', () => {
    expect(loadEnv('sandbox-dev').appChangeDelayMs).toBe(60_000);
    const { appChangeDelayMs: _, ...rest } = raw();
    expect(manifestSchema.safeParse(rest).success).toBe(false);
  });

  it('is 60 s to 7 days', () => {
    for (const ok of [60_000, 86_400_000, 604_800_000]) expect(manifestSchema.safeParse({ ...raw(), appChangeDelayMs: ok }).success).toBe(true);
    for (const bad of [59_999, 604_800_001, 1.5, -1, '60000']) expect(manifestSchema.safeParse({ ...raw(), appChangeDelayMs: bad }).success).toBe(false);
  });

  it('on a production network: at least 24 h, and the contract timelock no shorter', () => {
    const day = 86_400_000;
    expect(appChangeDelayProblems({ network: 'mainnet', changeDelayMs: day, appChangeDelayMs: day })).toEqual([]);
    expect(appChangeDelayProblems({ network: 'mainnet', changeDelayMs: day, appChangeDelayMs: day - 1 }).map((p) => p.path)).toEqual(['appChangeDelayMs']);
    expect(appChangeDelayProblems({ network: 'mainnet', changeDelayMs: day - 1, appChangeDelayMs: day }).map((p) => p.path)).toEqual(['changeDelayMs']);
    expect(appChangeDelayProblems({ network: 'mainnet', changeDelayMs: 2 * day, appChangeDelayMs: day, ownerGrantDelayMs: 60_000 }).map((p) => p.path)).toEqual(['ownerGrantDelayMs']);
    // testnet envs (sandbox-dev: 60 s each) aren't bound by the production minimum.
    expect(appChangeDelayProblems({ network: 'testnet', changeDelayMs: 0, appChangeDelayMs: 60_000, ownerGrantDelayMs: 60_000 })).toEqual([]);
  });
});

describe('dashboard blocks', () => {
  it('an env without them validates (it runs the API only)', () => {
    const r = manifestSchema.safeParse(raw());
    expect(r.success).toBe(true);
    for (const k of DASHBOARD_BLOCKS) expect(r.data![k]).toBeUndefined();
  });

  it('sandbox-dev sets the complete set (M4), its Access application set by access-setup (D409)', () => {
    const env = loadEnv('sandbox-dev');
    for (const k of DASHBOARD_BLOCKS) expect(env[k], k).toBeDefined();
    expect(env.admin!.accessAud).toMatch(/^[0-9a-f]{64}$/u);
    expect(env.admin!.accessTeamDomain).toMatch(/^[a-z0-9-]+\.cloudflareaccess\.com$/u);
    expect(env.admin!.accessTeamDomain).not.toContain('unset');
    expect(env.ownerGrantDelayMs).toBe(60_000);
  });

  it('accept a complete set', () => {
    expect(messages(withDashboard())).toEqual([]);
  });

  it('are present together or not at all', () => {
    for (const k of DASHBOARD_BLOCKS) {
      const m = withDashboard((d) => delete d[k]);
      expect(messages(m).join('\n')).toContain(`missing: ${k}`);
    }
  });

  it('refuse unknown keys in a block', () => {
    expect(messages(withDashboard((d) => (block(d, 'console').extra = 1))).length).toBeGreaterThan(0);
  });

  it('every dashboard origin is a Hana origin of its own', () => {
    // Not https, a path, an IP, a public suffix: hanaOriginProblem's rules.
    for (const bad of ['http://console.example.com', 'https://console.example.com/', 'https://10.0.0.1', 'https://workers.dev']) {
      expect(messages(withDashboard((d) => (block(d, 'console').origin = bad))).join('\n')).toContain('console.origin');
    }
    // Equal to another dashboard origin, the API's or a batch B page origin.
    const r = raw();
    for (const taken of [new URL(r.apiUrl as string).origin, r.vaultOrigin as string, r.authOrigin as string, (dashboard().files as Raw).origin as string]) {
      expect(messages(withDashboard((d) => (block(d, 'admin').origin = taken))).join('\n')).toMatch(/admin\.origin must be its own origin/u);
    }
    expect(messages(withDashboard((d) => (block(d, 'console').authOrigin = block(d, 'console').origin))).join('\n')).toContain('console.authOrigin must be its own origin');
  });

  it('outside dev envs no dashboard origin shares the vault site (D38)', () => {
    const prod = (patch: (d: Raw) => void) => ({
      ...withDashboard(patch),
      name: 'staging',
      apiUrl: 'https://api.hanaapi.example',
      vaultOrigin: 'https://vault.hanavault.example',
      authOrigin: 'https://auth.hana.example',
    });
    const set = (d: Raw) => {
      block(d, 'console').origin = 'https://console.hana.example';
      block(d, 'console').authOrigin = 'https://auth.console.hana.example';
      block(d, 'files').origin = 'https://files.hana.example';
      block(d, 'admin').origin = 'https://admin.hana.example';
    };
    expect(messages(prod(set))).toEqual([]);
    expect(messages(prod((d) => { set(d); block(d, 'files').origin = 'https://files.hanavault.example'; })).join('\n')).toContain('different site from vaultOrigin');
  });

  it('names one resource each', () => {
    expect(messages(withDashboard((d) => (block(d, 'console').authWorkerName = block(d, 'console').workerName))).join('\n')).toContain('Worker name hana-id-console-sandbox-dev is also console.workerName');
    expect(messages(withDashboard((d) => (block(d, 'admin').workerName = raw().cloudflare && (raw().cloudflare as Raw).workerName))).join('\n')).toContain('is also cloudflare.workerName');
    expect(messages(withDashboard((d) => (block(d, 'console').d1Name = (raw().cloudflare as Raw).d1Name))).join('\n')).toContain('D1 name');
    expect(messages(withDashboard((d) => (block(d, 'files').exportsBucket = block(d, 'files').logosBucket))).join('\n')).toContain('R2 bucket name');
    expect(messages(withDashboard((d) => (block(d, 'usage').adminHyperdrive = block(d, 'usage').writerHyperdrive))).join('\n')).toContain('Hyperdrive name');
    // The watchdog's Worker too.
    const wd = (raw().watchdog as Raw).cloudflare as Raw;
    expect(messages(withDashboard((d) => (block(d, 'files').workerName = wd.workerName))).join('\n')).toContain('is also watchdog.cloudflare.workerName');
  });

  it('staff list: lowercased, non-empty, distinct', () => {
    expect(messages(withDashboard((d) => (block(d, 'admin').staffEmails = [])))).not.toEqual([]);
    expect(messages(withDashboard((d) => (block(d, 'admin').staffEmails = ['Staff@example.com'])))).not.toEqual([]);
    expect(messages(withDashboard((d) => (block(d, 'admin').staffEmails = ['a@example.com', 'a@example.com']))).join('\n')).toContain('Duplicate staff email');
  });

  it('Access fields have their shapes', () => {
    expect(messages(withDashboard((d) => (block(d, 'admin').accessAud = 'a'.repeat(64))))).toEqual([]);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), '']) expect(messages(withDashboard((d) => (block(d, 'admin').accessAud = bad)))).not.toEqual([]);
    for (const bad of ['hana.example.com', 'https://hana.cloudflareaccess.com', '.cloudflareaccess.com']) {
      expect(messages(withDashboard((d) => (block(d, 'admin').accessTeamDomain = bad)))).not.toEqual([]);
    }
  });

  it('the ledger is in Sydney (D73)', () => {
    expect(messages(withDashboard((d) => (block(d, 'usage').neonRegion = 'aws-us-east-1')))).not.toEqual([]);
  });

  it('ownerGrantDelayMs has the appChangeDelayMs bounds', () => {
    expect(messages(withDashboard((d) => (d.ownerGrantDelayMs = 59_999)))).not.toEqual([]);
    expect(messages(withDashboard((d) => (d.ownerGrantDelayMs = 86_400_000)))).toEqual([]);
  });
});

describe('email.from', () => {
  it('accepts a display name with an address, or a bare address', () => {
    expect(emailFromProblem('Hana ID <no-reply@mail.example.com>')).toBeNull();
    expect(emailFromProblem('no-reply@mail.example.com')).toBeNull();
  });

  it('refuses header injection, quotes, several addresses and bad addresses', () => {
    for (const bad of ['Hana <a@b.com>\r\nBcc: x@y.com', 'Hana <a@b.com>, c@d.com', '"Hana" <a@b.com>', 'Hana <not-an-address>', 'Hana <A@b.com>', '<>', '']) {
      expect(emailFromProblem(bad), bad).not.toBeNull();
    }
    expect(messages(withDashboard((d) => (block(d, 'email').from = 'x\ny')))).not.toEqual([]);
  });
});

describe('hanaOwnOrigins (REFUSED_ORIGINS)', () => {
  it('lists the API, page and dashboard origins once each, sorted', () => {
    const bare = manifestSchema.parse(raw());
    expect(hanaOwnOrigins(bare)).toEqual([new URL(bare.apiUrl).origin, bare.vaultOrigin, bare.authOrigin].sort());
    const full = manifestSchema.parse(withDashboard());
    const list = hanaOwnOrigins(full);
    expect(list).toHaveLength(7);
    expect(list).toEqual([...list].sort());
    expect(list).toContain(full.console!.authOrigin);
    expect(list).toContain(full.files!.origin);
    // sandbox-dev's own seven.
    const env = loadEnv('sandbox-dev');
    expect(hanaOwnOrigins(env)).toEqual(
      [new URL(env.apiUrl).origin, env.vaultOrigin, env.authOrigin, env.console!.origin, env.console!.authOrigin, env.files!.origin, env.admin!.origin].sort(),
    );
  });
});
