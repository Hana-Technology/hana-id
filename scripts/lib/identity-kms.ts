// identity-key.ts's AWS KMS commands (docs/identity-token-spec.md "Where the key lives", build step 7; docs/operations.md
// "Identity token keys on AWS KMS"; D215, D219). The private keys never leave KMS, so these commands only move public
// data into the manifest (each key's ARN and the public key `aws kms get-public-key` printed) and set the Worker's
// AWS credentials and sub key. Creating keys, IAM users, access keys and policies is the operator's job in the AWS
// account (D121): these commands never call AWS.
//
//   kms-init --active <file> --standby <file> --iam-user <name> [--local]
//                         a new env: identityToken with the aws-kms signer (active and standby, in two regions), a
//                         fresh IDENTITY_SUB_KEY (.secrets/<env>/identity-sub-key, 0600), uploaded unless --local
//   kms-add --role next|standby --key <file>
//                         publish a key in that role (a rotation's next key, or a new standby after a switch)
//   kms-switch --to next|standby
//                         make that key the active one; the old active key becomes `previous` (still published)
//   kms-retire --key previous|standby
//                         unpublish that key (then disable it and schedule its deletion in KMS)
//   kms-put-aws-key       set IDENTITY_AWS_ACCESS_KEY_ID and IDENTITY_AWS_SECRET_ACCESS_KEY in one `wrangler secret
//                         bulk` from .secrets/<env>/identity-aws-access-key.json (0600: `aws iam create-access-key`'s
//                         output for the manifest's IAM user)
//
// `<file>` is the JSON `aws kms get-public-key --key-id <arn> --output json` prints (public data): its KeyId must be a
// single-region key ARN, its KeySpec ECC_NIST_P256, its KeyUsage SIGN_VERIFY, ECDSA_SHA_256 among its algorithms.
// Every command prints its plan and changes nothing without --yes, and never prints a credential or the sub key.
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AwsKmsSignerConfig, IDENTITY_SECRET_FILES, KMS_KEY_ARN_RE, type Manifest, identityIssuerFor, kmsArnParts, manifestPath, p256Thumbprint, repoRoot } from '@hana-id/env';
import { CliError, type parseCli } from './cli.ts';
import { type IdentityKeyDeps, insertManifestBlock, newSubKey, replaceManifestBlock } from './identity-key.ts';
import { assertPrivate, parseSecretJson, secretsDir } from './secrets.ts';
import { DRY_RUN_LINE, writeNewSecretFile } from './vault-kek.ts';

export const KMS_COMMANDS = ['kms-init', 'kms-add', 'kms-switch', 'kms-retire', 'kms-put-aws-key'] as const;
export type KmsCommand = (typeof KMS_COMMANDS)[number];
/** The string flags the KMS commands take (identity-key.ts parses them), plus the boolean --local. */
export const KMS_STRING_FLAGS = ['active', 'standby', 'iam-user', 'role', 'key', 'to'] as const;
const KMS_FLAGS = [...KMS_STRING_FLAGS, 'local'] as const;

type Args = ReturnType<typeof parseCli>;
type KmsKey = AwsKmsSignerConfig['keys']['active'];
export type AwsSecret = 'IDENTITY_AWS_ACCESS_KEY_ID' | 'IDENTITY_AWS_SECRET_ACCESS_KEY';

/** The JWKS entry of a public P-256 key. */
const entry = (k: { x: string; y: string }) => ({ kty: 'EC' as const, crv: 'P-256' as const, x: k.x, y: k.y, kid: p256Thumbprint({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y }), use: 'sig' as const, alg: 'ES256' as const });

/**
 * Reads `aws kms get-public-key --output json`'s answer: an ECC_NIST_P256 SIGN_VERIFY key that allows ECDSA_SHA_256,
 * with a single-region key ARN. Returns its ARN and JWKS entry.
 */
export function parseKmsPublicKey(text: string, file: string): { arn: string; jwk: ReturnType<typeof entry> } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} is not JSON (expected \`aws kms get-public-key --key-id <arn> --output json\`)`);
  }
  if (typeof v !== 'object' || v === null) throw new Error(`${file} is not a get-public-key answer`);
  if (typeof v.KeyId !== 'string' || !KMS_KEY_ARN_RE.test(v.KeyId)) throw new Error(`${file}: KeyId must be a single-region key ARN (arn:aws:kms:<region>:<account>:key/<uuid>)`);
  if (v.KeySpec !== 'ECC_NIST_P256') throw new Error(`${file}: KeySpec must be ECC_NIST_P256`);
  if (v.KeyUsage !== 'SIGN_VERIFY') throw new Error(`${file}: KeyUsage must be SIGN_VERIFY`);
  if (!Array.isArray(v.SigningAlgorithms) || !v.SigningAlgorithms.includes('ECDSA_SHA_256')) throw new Error(`${file}: the key must allow ECDSA_SHA_256`);
  if (typeof v.PublicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(v.PublicKey)) throw new Error(`${file}: PublicKey must be base64 (DER SubjectPublicKeyInfo)`);
  let jwk: { kty?: string; crv?: string; x?: string; y?: string };
  try {
    const key = createPublicKey({ key: Buffer.from(v.PublicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not P-256');
    jwk = key.export({ format: 'jwk' });
  } catch {
    throw new Error(`${file}: PublicKey is not a P-256 public key`);
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error(`${file}: PublicKey is not a P-256 public key`);
  return { arn: v.KeyId, jwk: entry({ x: jwk.x, y: jwk.y }) };
}

const ACCESS_KEY_ID_RE = /^AKIA[A-Z2-7]{16}$/u;
const SECRET_ACCESS_KEY_RE = /^[A-Za-z0-9/+]{40}$/u;

/** Reads `aws iam create-access-key`'s answer (0600 enforced). The values are returned, never printed. */
export function readAwsAccessKeyFile(file: string, iamUser: string): { accessKeyId: string; secretAccessKey: string; createDate: string } {
  assertPrivate(file);
  const v = parseSecretJson<{ AccessKey?: Record<string, unknown> }>(readFileSync(file, 'utf8'), file);
  const k = v?.AccessKey;
  if (!k || typeof k !== 'object') throw new Error(`${file} must be \`aws iam create-access-key --user-name ${iamUser}\`'s JSON ({"AccessKey": {…}})`);
  if (k.UserName !== iamUser) throw new Error(`${file} is an access key of another IAM user: the manifest's signer user is ${iamUser}`);
  if (k.Status !== 'Active') throw new Error(`${file}: the access key is not Active`);
  if (typeof k.AccessKeyId !== 'string' || !ACCESS_KEY_ID_RE.test(k.AccessKeyId)) throw new Error(`${file}: AccessKeyId is not a long-term IAM user key (AKIA…)`);
  if (typeof k.SecretAccessKey !== 'string' || !SECRET_ACCESS_KEY_RE.test(k.SecretAccessKey)) throw new Error(`${file}: SecretAccessKey is malformed`);
  return { accessKeyId: k.AccessKeyId, secretAccessKey: k.SecretAccessKey, createDate: typeof k.CreateDate === 'string' ? k.CreateDate : 'unknown' };
}

const describeKey = (role: string, k: KmsKey) => `${role} kid ${k.kid} (${k.arn})`;

/** Runs one KMS command for env `m` (argv already parsed by identity-key.ts). */
export function identityKms(m: Manifest, command: KmsCommand, args: Args, deps: IdentityKeyDeps): void {
  // kms-add's --key is a public-key file; kms-retire's --key is a role (as `retire --key`).
  const allowed: Record<KmsCommand, string[]> = {
    'kms-init': ['active', 'standby', 'iam-user', 'local'],
    'kms-add': ['role', 'key'],
    'kms-switch': ['to'],
    'kms-retire': ['key'],
    'kms-put-aws-key': [],
  };
  for (const flag of KMS_FLAGS) {
    const given = flag === 'local' ? args.flag('local') : args.str(flag) !== undefined;
    if (given && !allowed[command].includes(flag)) throw new CliError(`--${flag} doesn't go with ${command}`);
  }
  const apply = args.flag('yes');
  const worker = m.cloudflare.workerName;
  const dir = secretsDir(m.name, deps.secretsRoot ?? repoRoot);
  const readText = deps.readManifestText ?? ((name: string) => readFileSync(manifestPath(name), 'utf8'));
  const writeText = deps.writeManifestText ?? ((name: string, text: string) => writeFileSync(manifestPath(name), text));
  const redeploy = `Commit envs/${m.name}.json, then gen and deploy the API (docs/operations.md "Identity token keys on AWS KMS").`;
  const readKeyFile = (flag: string): { arn: string; jwk: ReturnType<typeof entry> } => {
    const path = args.str(flag);
    if (!path) throw new CliError(`${command} needs --${flag} <file> (aws kms get-public-key --key-id <arn> --output json)`);
    return parseKmsPublicKey(readFileSync(path, 'utf8'), path);
  };

  if (command === 'kms-init') {
    const iamUser = args.str('iam-user');
    if (!iamUser) throw new CliError('kms-init needs --iam-user <name> (the IAM user whose only permission is kms:Sign, D215)');
    if (m.identityToken) {
      throw new Error(
        `envs/${m.name}.json already has identityToken (${m.identityToken.signer.kind}): kms-init is for a new env. Moving a Worker-secret env to KMS keeps its IDENTITY_SUB_KEY and needs a rotation window; it isn't scripted (docs/operations.md "Identity token keys on AWS KMS").`,
      );
    }
    const subFile = join(dir, IDENTITY_SECRET_FILES.subKey);
    if (existsSync(subFile)) throw new Error(`.secrets/${m.name}/${IDENTITY_SECRET_FILES.subKey} already exists: refusing to overwrite the sub key`);
    const active = readKeyFile('active');
    const standby = readKeyFile('standby');
    const block = {
      iss: identityIssuerFor(m.apiUrl),
      signer: { kind: 'aws-kms', credentials: { kind: 'worker-secret', iamUser }, keys: { active: { kid: active.jwk.kid, arn: active.arn }, standby: { kid: standby.jwk.kid, arn: standby.arn } } },
      publicKeys: [active.jwk, standby.jwk],
    };
    const local = args.flag('local');
    deps.log(
      `Plan (env ${m.name}): add identityToken (iss ${block.iss}, aws-kms signer, IAM user ${iamUser}) with ${describeKey('active', block.signer.keys.active)} and ` +
        `${describeKey('standby', block.signer.keys.standby)} to envs/${m.name}.json; write a 32-byte sub key to .secrets/${m.name}/${IDENTITY_SECRET_FILES.subKey} (0600)` +
        `${local ? '' : ` and set IDENTITY_SUB_KEY on Worker ${worker}`}. The AWS credentials come next: \`kms-put-aws-key\`.`,
    );
    if (!apply) return void deps.log(DRY_RUN_LINE);
    // The manifest is checked (insertManifestBlock validates it: regions, one account) before the sub key is made.
    const text = insertManifestBlock(readText(m.name), 'identityToken', block, 'apiUrl');
    const subKey = newSubKey(deps.randomBytes);
    writeNewSecretFile(subFile, `${subKey}\n`);
    deps.log(`Wrote .secrets/${m.name}/${IDENTITY_SECRET_FILES.subKey} (0600, value not shown). Back it up offline with the council backup (D81): it is never rotated.`);
    writeText(m.name, text);
    deps.log(`Wrote identityToken to envs/${m.name}.json. ${redeploy}`);
    if (local) return void deps.log(`IDENTITY_SUB_KEY not set on the Worker (--local).`);
    deps.putSecret(m, 'IDENTITY_SUB_KEY', subKey);
    deps.log(`Set IDENTITY_SUB_KEY (32 bytes) on Worker ${worker}.`);
    return;
  }

  const t = m.identityToken;
  if (!t) throw new Error(`envs/${m.name}.json has no identityToken: run \`identity-key ${m.name} kms-init\` first`);
  if (t.signer.kind !== 'aws-kms') throw new Error(`identityToken.signer is ${t.signer.kind}: the kms-* commands manage an aws-kms signer only`);
  const signer = t.signer;
  const keys = signer.keys;
  const writeManifest = (next: typeof t) => writeText(m.name, replaceManifestBlock(readText(m.name), 'identityToken', next));

  if (command === 'kms-put-aws-key') {
    const file = join(dir, IDENTITY_SECRET_FILES.awsAccessKey);
    if (!existsSync(file)) throw new Error(`.secrets/${m.name}/${IDENTITY_SECRET_FILES.awsAccessKey} doesn't exist (umask 077; aws iam create-access-key --user-name ${signer.credentials.iamUser} > that file)`);
    const key = readAwsAccessKeyFile(file, signer.credentials.iamUser);
    deps.log(`Plan (env ${m.name}): set IDENTITY_AWS_ACCESS_KEY_ID and IDENTITY_AWS_SECRET_ACCESS_KEY on Worker ${worker} in one request, from .secrets/${m.name}/${IDENTITY_SECRET_FILES.awsAccessKey} (IAM user ${signer.credentials.iamUser}, created ${key.createDate}; values not shown).`);
    if (!apply) return void deps.log(DRY_RUN_LINE);
    if (!deps.putSecretsBulk) throw new Error('No bulk secret writer');
    deps.putSecretsBulk(m, { IDENTITY_AWS_ACCESS_KEY_ID: key.accessKeyId, IDENTITY_AWS_SECRET_ACCESS_KEY: key.secretAccessKey });
    deps.log(`Set IDENTITY_AWS_ACCESS_KEY_ID and IDENTITY_AWS_SECRET_ACCESS_KEY on Worker ${worker}. Mint one token to check, then deactivate the previous access key in IAM (docs/operations.md).`);
    return;
  }

  if (command === 'kms-add') {
    const role = args.str('role');
    if (role !== 'next' && role !== 'standby') throw new CliError('kms-add needs --role next or --role standby');
    if (keys[role]) throw new Error(`identityToken.signer.keys.${role} is already ${keys[role].kid}: switch to it or retire it first`);
    if (t.publicKeys.length >= 4) throw new Error('identityToken.publicKeys already has 4 keys: retire one first');
    const key = readKeyFile('key');
    if (t.publicKeys.some((k) => k.kid === key.jwk.kid)) throw new Error(`kid ${key.jwk.kid} is already published`);
    const region = kmsArnParts(key.arn)!.region;
    // The standby stays in another region than the active key (D219), also once `next` becomes active.
    const against = role === 'next' ? keys.standby : keys.active;
    if (against && kmsArnParts(against.arn)?.region === region) {
      throw new Error(`The ${role} key is in ${region}, the ${role === 'next' ? 'standby' : 'active'} key's region: the standby and the active key must be in two regions (D219)`);
    }
    deps.log(`Plan (env ${m.name}): publish ${describeKey(role, { kid: key.jwk.kid, arn: key.arn })} in envs/${m.name}.json (region ${region}; nothing signs with it yet).`);
    if (!apply) return void deps.log(DRY_RUN_LINE);
    writeManifest({ ...t, signer: { ...signer, keys: { ...keys, [role]: { kid: key.jwk.kid, arn: key.arn } } }, publicKeys: [...t.publicKeys, key.jwk] });
    deps.log(
      `Published kid ${key.jwk.kid} as ${role}. ${redeploy}` +
        (role === 'next' ? ' Partners that pin thumbprints need 14 days\' notice before `kms-switch --to next`, unless this is an incident.' : ''),
    );
    return;
  }

  if (command === 'kms-switch') {
    const to = args.str('to');
    if (to !== 'next' && to !== 'standby') throw new CliError('kms-switch needs --to next or --to standby');
    const target = keys[to];
    if (!target) throw new Error(`identityToken.signer.keys has no ${to} key`);
    if (keys.previous) throw new Error(`identityToken.signer.keys.previous is ${keys.previous.kid}: retire it first (\`kms-retire --key previous\`)`);
    const { [to]: _moved, ...rest } = keys;
    const next: AwsKmsSignerConfig['keys'] = { ...rest, active: target, previous: keys.active };
    deps.log(
      `Plan (env ${m.name}): make ${describeKey(to, target)} the active key; ${describeKey('active', keys.active)} becomes previous (still published). ` +
        `Before the deploy, the IAM user ${signer.credentials.iamUser} must be allowed kms:Sign on ${target.arn} (D219).`,
    );
    if (!apply) return void deps.log(DRY_RUN_LINE);
    writeManifest({ ...t, signer: { ...signer, keys: next } });
    deps.log(
      `Kid ${target.kid} is now active in envs/${m.name}.json. ${redeploy} Then, after ≥ 2 h (at once if it was compromised): \`identity-key ${m.name} kms-retire --key previous --yes\`` +
        ` and remove ${keys.active.arn} from the IAM policy.${to === 'standby' ? ' Then create a new standby key in another region and `kms-add --role standby`.' : ''}`,
    );
    return;
  }

  // kms-retire
  const which = args.str('key');
  if (which !== 'previous' && which !== 'standby') throw new CliError('kms-retire needs --key previous or --key standby');
  const key = keys[which];
  if (!key) throw new Error(`identityToken.signer.keys has no ${which} key`);
  const { [which]: _gone, ...rest } = keys;
  deps.log(`Plan (env ${m.name}): unpublish ${describeKey(which, key)} (identityToken.signer.keys and publicKeys in envs/${m.name}.json).`);
  if (!apply) return void deps.log(DRY_RUN_LINE);
  writeManifest({ ...t, signer: { ...signer, keys: rest as AwsKmsSignerConfig['keys'] }, publicKeys: t.publicKeys.filter((k) => k.kid !== key.kid) });
  deps.log(
    `Kid ${key.kid} is unpublished. ${redeploy} Partners using the JWKS URL reject its tokens within 10 minutes of the deploy. ` +
      `In AWS: remove ${key.arn} from the IAM policy, disable the key and schedule its deletion (30 days).`,
  );
}
