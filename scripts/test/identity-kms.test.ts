// identity-key's AWS KMS commands (lib/identity-kms.ts; D215, D219) against a temp .secrets root, an in-memory manifest
// and a fake wrangler: get-public-key files turned into published keys, a new env's manifest block and sub key, a
// rotation and a standby switch from start to end (the manifest valid at every step), the AWS access key upload in one
// bulk request from a 0600 file of the right IAM user, and that no credential or sub key is ever printed.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY_SECRET_FILES, type Manifest, loadEnv, manifestPath, manifestSchema, p256Thumbprint } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { type IdentityKeyDeps, identityKey, newP256, wranglerSecretBulkArgv } from '../lib/identity-key.ts';
import { parseKmsPublicKey, readAwsAccessKeyFile } from '../lib/identity-kms.ts';
import { DRY_RUN_LINE } from '../lib/vault-kek.ts';

const base: Manifest = { ...loadEnv('sandbox-dev'), name: 'sandbox-kms-test', cloudflare: { workerName: 'hana-id-api-kms-test', d1Name: 'hana-id-kms-test' } };
const baseText = (): string => {
  const raw = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
  delete raw.identityToken;
  return `${JSON.stringify({ ...raw, name: base.name, cloudflare: base.cloudflare }, null, 2)}\n`;
};
const ACCOUNT = '111122223333';
const IAM_USER = 'hana-identity-signer';
// Throwaway credential-shaped values, made at run time (never a literal a secret scanner would rightly flag).
const FAKE_ACCESS_KEY_ID = ['AK', 'IA', 'TESTONLYFAKEKEY2'].join('');
const FAKE_SECRET = randomBytes(30).toString('base64');

let root: string;
let dir: string;
let out: string[];
let puts: { name: string; value: string }[];
let bulk: Record<string, string>[];
let text: string;
let n = 0;

const manifest = (): Manifest => manifestSchema.parse(JSON.parse(text));
const deps = (): IdentityKeyDeps => ({
  putSecret: (_m, name, value) => void puts.push({ name, value }),
  putSecretsBulk: (m, values) => {
    expect(m.cloudflare.workerName).toBe(base.cloudflare.workerName);
    bulk.push(values);
  },
  deleteSecret: () => {
    throw new Error('the KMS commands never delete a Worker secret');
  },
  newP256,
  randomBytes: (k) => Uint8Array.from({ length: k }, (_, i) => (i * 11 + 5) % 256),
  log: (line) => out.push(line),
  secretsRoot: root,
  loadManifest: () => manifest(),
  readManifestText: () => text,
  writeManifestText: (_name, t) => {
    text = t;
  },
});
const run = (...argv: string[]) => identityKey([base.name, ...argv], deps());

/** A KMS key as `aws kms get-public-key --output json` describes it, written to a file; returns the path and kid. */
function kmsKey(region: string, over: Record<string, unknown> = {}, curve = 'P-256'): { file: string; kid: string; arn: string } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
  const arn = `arn:aws:kms:${region}:${ACCOUNT}:key/${String(++n).padStart(8, '0')}-1111-4222-8333-444455556666`;
  const answer = {
    KeyId: arn,
    PublicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    CustomerMasterKeySpec: 'ECC_NIST_P256',
    KeySpec: 'ECC_NIST_P256',
    KeyUsage: 'SIGN_VERIFY',
    SigningAlgorithms: ['ECDSA_SHA_256'],
    ...over,
  };
  const file = join(root, `pub-${n}.json`);
  writeFileSync(file, JSON.stringify(answer));
  return { file, kid: curve === 'P-256' ? p256Thumbprint(jwk) : '', arn };
}

function awsKeyFile(over: Record<string, unknown> = {}, mode = 0o600): { accessKeyId: string; secretAccessKey: string } {
  const accessKey = { UserName: IAM_USER, AccessKeyId: FAKE_ACCESS_KEY_ID, Status: 'Active', SecretAccessKey: FAKE_SECRET, CreateDate: '2026-11-02T00:00:00+00:00', ...over };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, IDENTITY_SECRET_FILES.awsAccessKey);
  writeFileSync(file, JSON.stringify({ AccessKey: accessKey }), { mode });
  chmodSync(file, mode);
  return { accessKeyId: String(accessKey.AccessKeyId), secretAccessKey: String(accessKey.SecretAccessKey) };
}

const signer = () => {
  const s = manifest().identityToken!.signer;
  if (s.kind !== 'aws-kms') throw new Error('not aws-kms');
  return s;
};
const roles = () => Object.fromEntries(Object.entries(signer().keys).map(([r, k]) => [r, k!.kid]));
const published = () => manifest().identityToken!.publicKeys.map((k) => k.kid);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-id-kms-'));
  dir = join(root, '.secrets', base.name);
  out = [];
  puts = [];
  bulk = [];
  text = baseText();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseKmsPublicKey', () => {
  it('turns a get-public-key answer into its ARN and JWKS entry', () => {
    const k = kmsKey('ap-east-1');
    const parsed = parseKmsPublicKey(readFileSync(k.file, 'utf8'), k.file);
    expect(parsed.arn).toBe(k.arn);
    expect(parsed.jwk).toMatchObject({ kty: 'EC', crv: 'P-256', kid: k.kid, use: 'sig', alg: 'ES256' });
    expect(Object.keys(parsed.jwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  });

  it('refuses another key spec, usage or algorithm, an alias or multi-region ARN, another curve, bad base64, not JSON', () => {
    const cases: [Record<string, unknown>, RegExp, string?][] = [
      [{ KeySpec: 'ECC_NIST_P384' }, /KeySpec/u],
      [{ KeyUsage: 'ENCRYPT_DECRYPT' }, /KeyUsage/u],
      [{ SigningAlgorithms: ['ECDSA_SHA_384'] }, /ECDSA_SHA_256/u],
      [{ KeyId: `arn:aws:kms:ap-east-1:${ACCOUNT}:alias/identity` }, /single-region key ARN/u],
      [{ KeyId: `arn:aws:kms:ap-east-1:${ACCOUNT}:key/mrk-1234abcd12ab34cd56ef1234567890ab` }, /single-region key ARN/u],
      [{ PublicKey: 'not base64!' }, /base64/u],
      [{ PublicKey: Buffer.from('nonsense').toString('base64') }, /not a P-256 public key/u],
      [{}, /not a P-256 public key/u, 'secp256k1'],
      [{}, /not a P-256 public key/u, 'P-384'],
    ];
    for (const [over, re, curve] of cases) {
      const k = kmsKey('ap-east-1', over, curve);
      expect(() => parseKmsPublicKey(readFileSync(k.file, 'utf8'), k.file)).toThrow(re);
    }
    expect(() => parseKmsPublicKey('{', 'x.json')).toThrow(/not JSON/u);
    expect(() => parseKmsPublicKey('null', 'x.json')).toThrow(/get-public-key/u);
  });
});

describe('identity-key kms-init', () => {
  it('without --yes: a plan, nothing written or set', () => {
    const [a, s] = [kmsKey('ap-east-1'), kmsKey('ap-southeast-1')];
    run('kms-init', '--active', a.file, '--standby', s.file, '--iam-user', IAM_USER);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(manifest().identityToken).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(puts).toEqual([]);
  });

  it('--yes: the aws-kms block (both keys published, active and standby), a 0600 sub key, IDENTITY_SUB_KEY set', () => {
    const [a, s] = [kmsKey('ap-east-1'), kmsKey('ap-southeast-1')];
    run('kms-init', '--active', a.file, '--standby', s.file, '--iam-user', IAM_USER, '--yes');
    const t = manifest().identityToken!;
    expect(t.iss).toBe(`${base.apiUrl}/v1/identity`);
    expect(t.signer).toEqual({ kind: 'aws-kms', credentials: { kind: 'worker-secret', iamUser: IAM_USER }, keys: { active: { kid: a.kid, arn: a.arn }, standby: { kid: s.kid, arn: s.arn } } });
    expect(published()).toEqual([a.kid, s.kid]);
    const subFile = join(dir, IDENTITY_SECRET_FILES.subKey);
    expect(statSync(subFile).mode & 0o777).toBe(0o600);
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SUB_KEY']);
    expect(Buffer.from(puts[0]!.value, 'base64')).toHaveLength(32);
    expect(out.join('\n')).not.toContain(puts[0]!.value);
    // No private signing key file exists for a KMS env.
    expect(existsSync(join(dir, IDENTITY_SECRET_FILES.signingKey))).toBe(false);
  });

  it('--local sets nothing on the Worker', () => {
    const [a, s] = [kmsKey('ap-east-1'), kmsKey('ap-southeast-1')];
    run('kms-init', '--active', a.file, '--standby', s.file, '--iam-user', IAM_USER, '--local', '--yes');
    expect(puts).toEqual([]);
    expect(manifest().identityToken?.signer.kind).toBe('aws-kms');
  });

  it('refuses a standby in the active key’s region before writing anything, an existing block or sub key, a missing flag', () => {
    const [a, same] = [kmsKey('ap-east-1'), kmsKey('ap-east-1')];
    expect(() => run('kms-init', '--active', a.file, '--standby', same.file, '--iam-user', IAM_USER, '--yes')).toThrow(/another region/u);
    expect(existsSync(join(dir, IDENTITY_SECRET_FILES.subKey))).toBe(false);
    expect(manifest().identityToken).toBeUndefined();
    expect(() => run('kms-init', '--active', a.file, '--standby', kmsKey('ap-southeast-1').file, '--yes')).toThrow(/--iam-user/u);
    expect(() => run('kms-init', '--active', a.file, '--iam-user', IAM_USER, '--yes')).toThrow(/--standby/u);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, IDENTITY_SECRET_FILES.subKey), 'x', { mode: 0o600 });
    expect(() => run('kms-init', '--active', a.file, '--standby', kmsKey('ap-southeast-1').file, '--iam-user', IAM_USER, '--yes')).toThrow(/sub key/u);
    rmSync(dir, { recursive: true });
    run('init', '--local', '--yes'); // a Worker-secret env
    expect(() => run('kms-init', '--active', a.file, '--standby', kmsKey('ap-southeast-1').file, '--iam-user', IAM_USER, '--yes')).toThrow(/kms-init is for a new env/u);
  });
});

describe('identity-key kms rotation and switch', () => {
  const init = () => {
    const [a, s] = [kmsKey('ap-east-1'), kmsKey('ap-southeast-1')];
    run('kms-init', '--active', a.file, '--standby', s.file, '--iam-user', IAM_USER, '--local', '--yes');
    out = [];
    return { a, s };
  };

  it('scheduled rotation: kms-add next → kms-switch --to next → kms-retire previous, valid at every step', () => {
    const { a, s } = init();
    const next = kmsKey('ap-east-1');
    run('kms-add', '--role', 'next', '--key', next.file);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(roles()).toEqual({ active: a.kid, standby: s.kid });
    run('kms-add', '--role', 'next', '--key', next.file, '--yes');
    expect(roles()).toEqual({ active: a.kid, standby: s.kid, next: next.kid });
    expect(published()).toEqual([a.kid, s.kid, next.kid]);
    run('kms-switch', '--to', 'next', '--yes');
    expect(roles()).toEqual({ active: next.kid, standby: s.kid, previous: a.kid });
    expect(out.join('\n')).toContain(`kms:Sign on ${next.arn}`);
    expect(() => run('kms-switch', '--to', 'standby', '--yes')).toThrow(/retire it first/u);
    run('kms-retire', '--key', 'previous', '--yes');
    expect(roles()).toEqual({ active: next.kid, standby: s.kid });
    expect(published()).toEqual([s.kid, next.kid]);
    expect(out.at(-1)).toContain(`disable the key and schedule its deletion`);
  });

  it('the watchdog pins follow the published keys (D211): kms-init and kms-add pin, kms-retire unpins, each with its deploy order', () => {
    const pins = () => manifest().watchdog?.pinnedIdentityKeys ?? [];
    const sandboxPins = loadEnv('sandbox-dev').watchdog!.pinnedIdentityKeys!;
    const ours = () => pins().filter((k) => !sandboxPins.includes(k));
    const [a, s] = [kmsKey('ap-east-1'), kmsKey('ap-southeast-1')];
    run('kms-init', '--active', a.file, '--standby', s.file, '--iam-user', IAM_USER, '--local', '--yes');
    expect(ours()).toEqual([a.kid, s.kid]);
    expect(out.join('\n')).toContain('deploy the watchdog FIRST');
    const next = kmsKey('ap-east-1');
    run('kms-add', '--role', 'next', '--key', next.file, '--yes');
    expect(ours()).toEqual([a.kid, s.kid, next.kid]);
    expect(out.at(-1)).toContain('deploy the watchdog FIRST');
    run('kms-switch', '--to', 'next', '--yes');
    expect(ours()).toEqual([a.kid, s.kid, next.kid]);
    run('kms-retire', '--key', 'previous', '--yes');
    expect(ours()).toEqual([s.kid, next.kid]);
    expect(out.at(-1)).toContain('deploy the API FIRST, then gen and deploy the watchdog');
    for (const k of published()) expect(pins()).toContain(k);
  });

  it('compromise: kms-switch --to standby leaves no standby until a new one is added in another region', () => {
    const { a, s } = init();
    run('kms-switch', '--to', 'standby', '--yes');
    expect(roles()).toEqual({ active: s.kid, previous: a.kid });
    run('kms-retire', '--key', 'previous', '--yes');
    expect(roles()).toEqual({ active: s.kid });
    run('show');
    expect(out.join('\n')).toContain('No standby key');
    // The new standby can't be in the (new) active key's region.
    expect(() => run('kms-add', '--role', 'standby', '--key', kmsKey('ap-southeast-1').file, '--yes')).toThrow(/two regions/u);
    const fresh = kmsKey('ap-east-1');
    run('kms-add', '--role', 'standby', '--key', fresh.file, '--yes');
    expect(roles()).toEqual({ active: s.kid, standby: fresh.kid });
    // A standby added while a next key waits keeps away from the next key's region too.
    run('kms-retire', '--key', 'standby', '--yes');
    run('kms-add', '--role', 'next', '--key', kmsKey('ap-northeast-1').file, '--yes');
    expect(() => run('kms-add', '--role', 'standby', '--key', kmsKey('ap-northeast-1').file, '--yes')).toThrow(/next key's region/u);
    run('kms-add', '--role', 'standby', '--key', kmsKey('ap-east-1').file, '--yes');
    expect(Object.keys(roles()).sort()).toEqual(['active', 'next', 'standby']);
  });

  it('refuses a role that is taken, a key already published, a next in the standby’s region, a fifth key', () => {
    const { s } = init();
    expect(() => run('kms-add', '--role', 'standby', '--key', kmsKey('ap-northeast-1').file, '--yes')).toThrow(/already/u);
    expect(() => run('kms-add', '--role', 'next', '--key', kmsKey('ap-southeast-1').file, '--yes')).toThrow(/two regions/u);
    const dup = JSON.parse(readFileSync(kmsKey('ap-east-1').file, 'utf8')) as Record<string, unknown>;
    const standbyAnswer = JSON.parse(readFileSync(s.file, 'utf8')) as Record<string, unknown>;
    expect(p256Thumbprint(parseKmsPublicKey(JSON.stringify(standbyAnswer), 's').jwk)).toBe(s.kid);
    const dupFile = join(root, 'dup.json');
    writeFileSync(dupFile, JSON.stringify({ ...dup, PublicKey: standbyAnswer.PublicKey }));
    expect(() => run('kms-add', '--role', 'next', '--key', dupFile, '--yes')).toThrow(/already published/u);
    run('kms-add', '--role', 'next', '--key', kmsKey('ap-east-1').file, '--yes');
    run('kms-switch', '--to', 'next', '--yes');
    expect(manifest().identityToken!.publicKeys).toHaveLength(3);
    run('kms-add', '--role', 'next', '--key', kmsKey('ap-east-1').file, '--yes');
    expect(manifest().identityToken!.publicKeys).toHaveLength(4);
    expect(() => run('kms-switch', '--to', 'next', '--yes')).toThrow(/retire it first/u);
    expect(() => run('kms-retire', '--key', 'next', '--yes')).toThrow(CliError);
  });

  it('kms-switch and kms-retire need a key in that role', () => {
    init();
    expect(() => run('kms-switch', '--to', 'next', '--yes')).toThrow(/no next key/u);
    expect(() => run('kms-retire', '--key', 'previous', '--yes')).toThrow(/no previous key/u);
    expect(() => run('kms-switch', '--to', 'active', '--yes')).toThrow(CliError);
  });
});

describe('identity-key kms-put-aws-key', () => {
  const init = () => {
    run('kms-init', '--active', kmsKey('ap-east-1').file, '--standby', kmsKey('ap-southeast-1').file, '--iam-user', IAM_USER, '--local', '--yes');
    out = [];
  };

  it('sets both values in one bulk request; prints neither', () => {
    init();
    const key = awsKeyFile();
    run('kms-put-aws-key');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(bulk).toEqual([]);
    run('kms-put-aws-key', '--yes');
    expect(bulk).toEqual([{ IDENTITY_AWS_ACCESS_KEY_ID: key.accessKeyId, IDENTITY_AWS_SECRET_ACCESS_KEY: key.secretAccessKey }]);
    const printed = out.join('\n');
    expect(printed).not.toContain(key.accessKeyId);
    expect(printed).not.toContain(key.secretAccessKey);
    expect(printed).toContain('created 2026-11-02');
    expect(wranglerSecretBulkArgv(manifest())).toEqual(['exec', 'wrangler', 'secret', 'bulk', '--name', base.cloudflare.workerName]);
  });

  it('refuses a readable file, another IAM user, an inactive or temporary key, a malformed secret, a missing file', () => {
    init();
    expect(() => run('kms-put-aws-key', '--yes')).toThrow(/doesn't exist/u);
    awsKeyFile({}, 0o644);
    expect(() => run('kms-put-aws-key', '--yes')).toThrow();
    for (const [over, re] of [
      [{ UserName: 'admin' }, /another IAM user/u],
      [{ Status: 'Inactive' }, /not Active/u],
      [{ AccessKeyId: FAKE_ACCESS_KEY_ID.replace(/^AKIA/u, 'ASIA') }, /AKIA/u],
      [{ SecretAccessKey: 'short' }, /malformed/u],
    ] as const) {
      awsKeyFile(over);
      expect(() => run('kms-put-aws-key', '--yes')).toThrow(re);
      expect(out.join('\n')).not.toContain(FAKE_SECRET);
    }
    expect(bulk).toEqual([]);
    expect(() => readAwsAccessKeyFile(join(dir, 'missing.json'), IAM_USER)).toThrow();
  });
});

describe('identity-key: the two signer kinds stay apart', () => {
  it('Worker-secret commands refuse a KMS env, KMS commands refuse a Worker-secret env, flags stay with their commands', () => {
    run('kms-init', '--active', kmsKey('ap-east-1').file, '--standby', kmsKey('ap-southeast-1').file, '--iam-user', IAM_USER, '--local', '--yes');
    for (const cmd of [['put'], ['next'], ['switch', '--to', 'next'], ['retire', '--key', 'previous']]) expect(() => run(...cmd, '--yes')).toThrow(/kms-\* commands/u);
    expect(() => run('init', '--yes')).toThrow(/already/u);
    text = baseText();
    rmSync(dir, { recursive: true });
    run('init', '--local', '--yes');
    for (const cmd of [['kms-switch', '--to', 'next'], ['kms-retire', '--key', 'previous'], ['kms-put-aws-key']]) expect(() => run(...cmd, '--yes')).toThrow(/aws-kms signer only/u);
    expect(() => run('kms-add', '--role', 'next', '--key', 'x', '--to', 'next')).toThrow(CliError);
    expect(() => run('kms-put-aws-key', '--local')).toThrow(CliError);
    expect(() => run('next', '--role', 'next')).toThrow(CliError);
    expect(() => run('kms-unknown')).toThrow(CliError);
  });

  it('show lists the KMS roles and ARNs (public values only)', () => {
    const [a, s] = [kmsKey('ap-east-1'), kmsKey('ap-southeast-1')];
    run('kms-init', '--active', a.file, '--standby', s.file, '--iam-user', IAM_USER, '--local', '--yes');
    out = [];
    run('show');
    expect(out).toEqual([
      `iss ${base.apiUrl}/v1/identity`,
      `signer aws-kms, IAM user ${IAM_USER} (credentials: Worker secrets IDENTITY_AWS_ACCESS_KEY_ID, IDENTITY_AWS_SECRET_ACCESS_KEY)`,
      `kid ${a.kid} active (signs) ${a.arn}`,
      `kid ${s.kid} standby ${s.arn}`,
    ]);
  });
});
