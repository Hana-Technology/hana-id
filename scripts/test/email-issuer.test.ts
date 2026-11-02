// email-issuer init / put / show against a temp .secrets root, an in-memory manifest and a fake wrangler: the --yes
// gate, file modes, never overwriting a key or a published block, the offline standby (never uploaded), the pins
// matching @hana-id/jwks' thumbprint, the testnet and outbox rules, and that no secret is ever printed.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMAIL_ISSUER_SECRET_FILES, type Manifest, loadEnv, manifestPath, manifestSchema, rsaJwkThumbprint } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { type EmailIssuerDeps, type IssuerSecret, emailIssuer, newRsa, pinBlock, wranglerSecretArgv } from '../lib/email-issuer.ts';
import { DRY_RUN_LINE } from '../lib/vault-kek.ts';

const NAME = 'sandbox-eit-test';
const baseText = (name = NAME): string => {
  const raw = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
  delete raw.emailIssuer;
  return `${JSON.stringify({ ...raw, name, cloudflare: { workerName: `hana-id-api-${name}`, d1Name: `hana-id-${name}` } }, null, 2)}\n`;
};
const mode = (p: string) => statSync(p).mode & 0o777;

let root: string;
let dir: string;
let out: string[];
let puts: { name: IssuerSecret; value: string }[];
let text: string;
let name: string;

const manifest = (): Manifest => manifestSchema.parse(JSON.parse(text));
const deps = (): EmailIssuerDeps => ({
  putSecret: (m, n, value) => {
    expect(m.name).toBe(name);
    puts.push({ name: n, value });
  },
  newRsa,
  randomBytes: (n) => new Uint8Array(Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)))),
  log: (line) => out.push(line),
  secretsRoot: root,
  loadManifest: () => manifest(),
  readManifestText: () => text,
  writeManifestText: (_n, t) => {
    text = t;
  },
});
const run = (...argv: string[]) => emailIssuer([name, ...argv], deps());
const file = (k: keyof typeof EMAIL_ISSUER_SECRET_FILES) => join(dir, EMAIL_ISSUER_SECRET_FILES[k]);
const FROM = 'Hana <login@mail.example.com>';

/** No secret value (any private JWK member, any 32-byte key, the SendGrid key) in anything printed. */
function expectNoSecretsPrinted(): void {
  const printed = out.join('\n');
  for (const f of readdirSync(dir)) {
    const v = readFileSync(join(dir, f), 'utf8').trim();
    if (v.startsWith('{')) {
      const jwk = JSON.parse(v) as Record<string, string>;
      for (const m of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(printed).not.toContain(jwk[m]);
    } else expect(printed).not.toContain(v);
  }
  for (const p of puts) expect(printed).not.toContain(p.value);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-eit-'));
  name = NAME;
  dir = join(root, '.secrets', name);
  out = [];
  puts = [];
  text = baseText();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('email-issuer init', () => {
  it('without --yes prints the plan and changes nothing', () => {
    run('init', '--from', FROM);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(() => readdirSync(dir)).toThrow();
    expect(text).toBe(baseText());
  });

  it('writes five 0600 files, the manifest block, and uploads nothing; prints the pins, never a secret', async () => {
    run('init', '--from', FROM, '--yes');
    expect(puts).toEqual([]);
    expect(mode(join(root, '.secrets'))).toBe(0o700);
    for (const k of ['signingKey', 'standbyKey', 'subKey', 'codeKey', 'rlKey'] as const) expect(mode(file(k))).toBe(0o600);
    for (const k of ['subKey', 'codeKey', 'rlKey'] as const) expect(Buffer.from(readFileSync(file(k), 'utf8').trim(), 'base64')).toHaveLength(32);
    const t = manifest().emailIssuer!;
    expect(t).toMatchObject({ iss: `${manifest().apiUrl}/v1/email`, sender: 'sendgrid', from: FROM, cloudflare: { workerName: `hana-id-email-issuer-${name}`, d1Name: `hana-id-email-issuer-${name}` } });
    const primary = JSON.parse(readFileSync(file('signingKey'), 'utf8')) as { n: string; e: string };
    const standby = JSON.parse(readFileSync(file('standbyKey'), 'utf8')) as { n: string; e: string };
    expect(t.signer).toEqual({ kind: 'worker-secret', activeKid: rsaJwkThumbprint(primary) });
    expect(t.publicKeys.map((k) => k.kid)).toEqual([rsaJwkThumbprint(primary), rsaJwkThumbprint(standby)]);
    expect(JSON.stringify(t)).not.toContain('"d"');
    // The kid is exactly the thumbprint the watchdog pins (@hana-id/jwks, D190).
    const { rsaThumbprint } = await import('../../packages/jwks/src/index.ts');
    for (const k of t.publicKeys) expect(await rsaThumbprint(k)).toBe(k.kid);
    expect(out.join('\n')).toContain(JSON.stringify(pinBlock(t.publicKeys.map((k) => k.kid))));
    expectNoSecretsPrinted();
  });

  it('never overwrites a key or a published block', () => {
    run('init', '--from', FROM, '--yes');
    const before = readFileSync(file('subKey'), 'utf8');
    expect(() => run('init', '--from', FROM, '--yes')).toThrow('already exists');
    rmSync(file('signingKey'));
    rmSync(file('standbyKey'));
    rmSync(file('subKey'));
    rmSync(file('codeKey'));
    rmSync(file('rlKey'));
    expect(() => run('init', '--from', FROM, '--yes')).toThrow('already has emailIssuer');
    void before;
  });

  it('needs --from; refuses --outbox outside local* and a non-testnet env', () => {
    expect(() => run('init', '--yes')).toThrow(CliError);
    expect(() => run('init', '--from', FROM, '--outbox', '--yes')).toThrow('local* envs only');
    const m = manifest();
    expect(() => emailIssuer([name, 'init', '--from', FROM], { ...deps(), loadManifest: () => ({ ...m, network: 'mainnet' }) as unknown as Manifest })).toThrow('AWS KMS');
    expect(() => run('put', '--from', FROM)).toThrow(CliError);
  });
});

describe('email-issuer put and show', () => {
  it('put uploads the active key and the three HMAC keys (and SendGrid when present), never the standby', () => {
    run('init', '--from', FROM, '--yes');
    run('put');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(puts).toEqual([]);
    run('put', '--yes');
    expect(puts.map((p) => p.name)).toEqual(['ISSUER_SIGNING_KEY', 'EMAIL_SUB_KEY', 'EMAIL_CODE_KEY', 'EMAIL_RL_KEY']);
    const standby = JSON.parse(readFileSync(file('standbyKey'), 'utf8')) as { d: string };
    for (const p of puts) expect(p.value).not.toContain(standby.d);
    expect(JSON.parse(puts[0]!.value)).toEqual(JSON.parse(readFileSync(file('signingKey'), 'utf8')));
    puts = [];
    writeFileSync(file('sendgridKey'), 'not-a-key\n');
    chmodSync(file('sendgridKey'), 0o600);
    expect(() => run('put', '--yes')).toThrow('SendGrid API key');
    writeFileSync(file('sendgridKey'), `${['SG', 'a'.repeat(22), 'b'.repeat(43)].join('.')}\n`);
    run('put', '--yes');
    expect(puts.map((p) => p.name)).toContain('SENDGRID_API_KEY');
    chmodSync(file('sendgridKey'), 0o644);
    expect(() => run('put', '--yes')).toThrow('0600');
    expectNoSecretsPrinted();
  });

  it('put refuses a signing key that is not the manifest’s active key', () => {
    run('init', '--from', FROM, '--yes');
    const standby = readFileSync(file('standbyKey'), 'utf8');
    writeFileSync(file('signingKey'), standby);
    expect(() => run('put', '--yes')).toThrow('active kid');
    expect(puts).toEqual([]);
  });

  it('put --standby switches the active kid to the standby (a suspected leak of the primary) and uploads it', () => {
    run('init', '--from', FROM, '--yes');
    const standby = JSON.parse(readFileSync(file('standbyKey'), 'utf8')) as { n: string; e: string; d: string };
    run('put', '--standby');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(manifest().emailIssuer!.signer).toMatchObject({ activeKid: expect.not.stringMatching(rsaJwkThumbprint(standby)) });
    run('put', '--standby', '--yes');
    expect(manifest().emailIssuer!.signer).toEqual({ kind: 'worker-secret', activeKid: rsaJwkThumbprint(standby) });
    expect(JSON.parse(puts.find((p) => p.name === 'ISSUER_SIGNING_KEY')!.value).d).toBe(standby.d);
    // From now on a plain put uploads the (now active) standby; --standby again is refused.
    puts = [];
    run('put', '--yes');
    expect(JSON.parse(puts.find((p) => p.name === 'ISSUER_SIGNING_KEY')!.value).d).toBe(standby.d);
    expect(() => run('put', '--standby', '--yes')).toThrow('already the active key');
    expect(() => run('show', '--standby')).toThrow(CliError);
    expectNoSecretsPrinted();
  });

  it('show prints public values only', () => {
    run('init', '--from', FROM, '--yes');
    out = [];
    run('show');
    const printed = out.join('\n');
    expect(printed).toContain('(active: signs) primary (on the Worker)');
    expect(printed).toContain('standby (offline)');
    expect(printed).toContain('set_issuer_key("email"');
    expectNoSecretsPrinted();
  });

  it('wrangler gets the value on stdin, never in argv', () => {
    run('init', '--from', FROM, '--yes');
    expect(wranglerSecretArgv(manifest(), 'EMAIL_SUB_KEY')).toEqual(['exec', 'wrangler', 'secret', 'put', 'EMAIL_SUB_KEY', '--name', `hana-id-email-issuer-${name}`]);
  });

  it('the committed manifests carry no emailIssuer yet (nothing is deployed, D196)', () => {
    expect(loadEnv('sandbox-dev').emailIssuer).toBeUndefined();
  });
});
