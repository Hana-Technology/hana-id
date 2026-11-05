#!/usr/bin/env node
// Secret-scan self-test (security sweep OPER-2): proves .gitleaks.toml catches each of this repo's own secret shapes, and
// stays quiet on the public look-alikes the repo does contain. Every secret here is a FAKE generated at run time from
// the CSPRNG and thrown away; none is ever committed (that would be the leak the rules exist to stop) or printed (the
// scan runs with --redact and only rule ids are shown).
//
//   node scripts/secret-scan-selftest.mjs [path to gitleaks]     (default: `gitleaks` on PATH)
//
// It scans with `gitleaks dir` (the same rule engine and config as the hook's `--staged` mode and CI's history scan).
//
// No dependencies beyond Node's standard library, so the CI `secrets` job runs it with the same pinned gitleaks binary
// and config as the full-history scan. Exit 0 when every case is caught and the negatives pass, 1 otherwise.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SECRET_SCAN_CONFIG: another config to test (scripts/test/secret-scan.test.ts proves the default rules alone fail).
const config = process.env.SECRET_SCAN_CONFIG ?? join(repo, '.gitleaks.toml');
const gitleaks = process.argv[2] ?? 'gitleaks';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A fake NEAR ed25519 secret key as KeyPair.toString() writes it (64 bytes: seed ‖ public key). */
const secretKey = () => `ed25519:${base58(randomBytes(64))}`;
/** A fake ed25519 public key (32 bytes): public, must not be flagged. */
const publicKey = () => `ed25519:${base58(randomBytes(32))}`;
/** A fake VAULT_KEK as scripts/lib/vault-kek.ts writes it. */
const kek = (id) => `${id}:${randomBytes(32).toString('base64')}`;
/** A fake P-256 private JWK as scripts/lib/identity-key.ts writes it (random coordinates: only the shape matters). */
const privateJwk = () => JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomBytes(32).toString('base64url'), y: randomBytes(32).toString('base64url'), d: randomBytes(32).toString('base64url') });
/** A fake RSA-2048 private JWK as scripts/lib/email-issuer.ts writes it (random members: only the shape matters). */
const rsaPrivateJwk = () =>
  JSON.stringify({ kty: 'RSA', n: randomBytes(256).toString('base64url'), e: 'AQAB', d: randomBytes(256).toString('base64url'), p: randomBytes(128).toString('base64url'), q: randomBytes(128).toString('base64url'), dp: randomBytes(128).toString('base64url'), dq: randomBytes(128).toString('base64url'), qi: randomBytes(128).toString('base64url') });
/** A fake public JWKS entry (no `d`): public, must not be flagged. */
const publicJwk = () => JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomBytes(32).toString('base64url'), y: randomBytes(32).toString('base64url'), kid: randomBytes(32).toString('base64url'), use: 'sig', alg: 'ES256' });
const keyFile = (account) => `${JSON.stringify({ account_id: account, public_key: publicKey(), private_key: secretKey() }, null, 2)}\n`;

/** Each case: files to write, and the rule ids gitleaks must report for them (at least these). */
const CASES = [
  { name: 'ed25519 secret key as a TS constant', files: { 'src/config.ts': `export const RELAYER = "${secretKey()}";\n` }, expect: ['near-ed25519-secret-key'] },
  { name: 'relayer pool keys pasted into an innocent file', files: { 'backup/pool.json': `${JSON.stringify([secretKey(), secretKey()], null, 2)}\n` }, expect: ['near-ed25519-secret-key'] },
  { name: 'relayer-keys.json outside .secrets', files: { 'notes/relayer-keys.json': `${JSON.stringify([secretKey()], null, 2)}\n` }, expect: ['hana-secret-file', 'near-ed25519-secret-key'] },
  { name: 'owner-relayer-keys.json', files: { 'owner-relayer-keys.json': `${JSON.stringify([secretKey()])}\n` }, expect: ['hana-secret-file', 'near-ed25519-secret-key'] },
  { name: 'keys-updater.json', files: { 'keys-updater.json': keyFile('hana-id-signer-dev1.testnet') }, expect: ['hana-secret-file', 'near-ed25519-secret-key'] },
  {
    name: '.dev.vars as gen-wrangler --dev-vars writes it',
    files: {
      'apps/api/.dev.vars': `RELAYER_KEYS=${JSON.stringify([secretKey(), secretKey()])}\nOWNER_RELAYER_KEYS=${JSON.stringify([secretKey()])}\nKEYS_UPDATER_KEY=${secretKey()}\nVAULT_KEK=${kek(1)}\n`,
    },
    expect: ['hana-secret-file', 'hana-worker-secret-assignment', 'near-ed25519-secret-key', 'hana-vault-kek'],
  },
  { name: '.dev.vars lines pasted into a doc', files: { 'docs/notes.md': `Set these:\n\nVAULT_KEK=${kek(7)}\nWATCHDOG_STATUS_TOKEN=${randomBytes(32).toString('base64url')}\n` }, expect: ['hana-worker-secret-assignment', 'hana-vault-kek'] },
  { name: 'vault-kek file copied out of .secrets', files: { 'copy/vault-kek': kek(1), 'copy/vault-kek.previous': kek(2) }, expect: ['hana-secret-file', 'hana-vault-kek'] },
  { name: 'KEK value in an innocent file', files: { 'kek-backup.txt': `${kek(3)}\n` }, expect: ['hana-vault-kek'] },
  { name: 'council key file (force-added .secrets)', files: { '.secrets/sandbox-dev/council/hana-id-council-a-dev1.testnet.json': keyFile('hana-id-council-a-dev1.testnet') }, expect: ['hana-secret-file', 'near-ed25519-secret-key'] },
  { name: 'council key file copied elsewhere', files: { 'council-member.json': keyFile('hana-id-council-b-dev1.testnet') }, expect: ['near-ed25519-secret-key'] },
  { name: 'identity signing key file copied out of .secrets', files: { 'backup/identity-signing-key.json': `${privateJwk()}\n`, 'backup/identity-signing-key-standby.json': `${privateJwk()}\n` }, expect: ['hana-secret-file', 'hana-private-jwk'] },
  { name: 'identity sub key file', files: { 'copy/identity-sub-key': `${randomBytes(32).toString('base64')}\n` }, expect: ['hana-secret-file'] },
  { name: 'private JWK pasted into an innocent file', files: { 'src/key.ts': `export const KEY = ${privateJwk()};\n` }, expect: ['hana-private-jwk'] },
  {
    name: 'identity secrets as gen-wrangler --dev-vars writes them, pasted into a doc',
    files: { 'docs/dev.md': `IDENTITY_SIGNING_KEY='${privateJwk()}'\nIDENTITY_SUB_KEY='${randomBytes(32).toString('base64')}'\n` },
    expect: ['hana-worker-secret-assignment', 'hana-private-jwk'],
  },
  { name: 'uid key file copied out of .secrets', files: { 'copy/user-id-key': `${randomBytes(32).toString('base64')}\n` }, expect: ['hana-secret-file'] },
  { name: 'USER_ID_KEY line pasted into a doc', files: { 'docs/usage.md': `USER_ID_KEY=${randomBytes(32).toString('base64')}\n` }, expect: ['hana-worker-secret-assignment'] },
  {
    name: 'ledger role URL file copied out of .secrets',
    files: { 'backup/neon-usage-writer.url': `postgresql://usage_writer:${randomBytes(32).toString('base64url')}@ep-x-${randomBytes(4).toString('hex')}.ap-southeast-2.aws.neon.tech/neondb?sslmode=require\n` },
    expect: ['hana-secret-file', 'hana-postgres-url'],
  },
  // 10 distinct characters (random order): log2(10) ≈ 3.3 bits each, over the rule's 3.0 floor.
  { name: 'Postgres URL with a short (10-character) password', files: { 'notes/short.txt': 'postgres://app:' + shortPassword(10) + '@db.example.net/app\n' }, expect: ['hana-postgres-url'] },
  { name: 'Postgres URL with a password in an innocent file', files: { 'notes/db.txt': `psql "postgresql://neondb_owner:${randomBytes(18).toString('base64url')}@ep-y.ap-southeast-2.aws.neon.tech/neondb"\n` }, expect: ['hana-postgres-url'] },
  { name: 'email issuer signing key file copied out of .secrets', files: { 'backup/email-issuer-signing-key.json': `${rsaPrivateJwk()}\n`, 'backup/email-issuer-signing-key-standby.json': `${rsaPrivateJwk()}\n` }, expect: ['hana-secret-file', 'hana-private-jwk'] },
  { name: 'email issuer HMAC key files', files: { 'copy/email-sub-key': `${randomBytes(32).toString('base64')}\n`, 'copy/email-code-key': `${randomBytes(32).toString('base64')}\n`, 'copy/email-rl-key': `${randomBytes(32).toString('base64')}\n` }, expect: ['hana-secret-file'] },
  {
    name: 'email issuer secrets as gen-wrangler --dev-vars writes them, pasted into a doc',
    files: { 'docs/email-dev.md': `ISSUER_SIGNING_KEY='${rsaPrivateJwk()}'\nEMAIL_SUB_KEY='${randomBytes(32).toString('base64')}'\nEMAIL_RL_KEY='${randomBytes(32).toString('base64')}'\n` },
    expect: ['hana-worker-secret-assignment', 'hana-private-jwk'],
  },
  { name: 'RSA private JWK pasted into an innocent file', files: { 'src/rsa.ts': `export const KEY = ${rsaPrivateJwk()};\n` }, expect: ['hana-private-jwk'] },
  { name: 'EC private JWK as a JS object literal (unquoted d)', files: { 'src/ec.ts': `export const KEY = { kty: 'EC', crv: 'P-256', d: '${randomBytes(32).toString('base64url')}' };\n` }, expect: ['hana-private-jwk'] },
  { name: 'RSA private JWK as a JS object literal (unquoted d, backticks)', files: { 'src/rsa2.ts': `export const KEY = { kty: 'RSA', d: \`${randomBytes(256).toString('base64url')}\` };\n` }, expect: ['hana-private-jwk'] },
  // A SendGrid key's shape (SG.<22>.<43>), random at run time: the issuer's and the admin Worker's key files (D401).
  { name: 'SendGrid key files copied out of .secrets', files: { 'copy/admin-sendgrid-key': `${sendgridKey()}\n`, 'copy/email-issuer-sendgrid-key': `${sendgridKey()}\n` }, expect: ['hana-secret-file', 'sendgrid-api-token'] },
  { name: 'admin EMAIL_API_KEY line pasted into a doc', files: { 'docs/admin.md': `EMAIL_API_KEY=${sendgridKey()}\n` }, expect: ['hana-worker-secret-assignment', 'sendgrid-api-token'] },
  { name: 'watchdog secrets file', files: { '.secrets/sandbox-dev/watchdog-secrets.json': `{"WATCHDOG_STATUS_TOKEN":"${randomBytes(32).toString('base64url')}"}\n` }, expect: ['hana-secret-file'] },
];

/** A random value of a SendGrid API key's shape: `SG.` + 22 + `.` + 43 base64url characters. */
function sendgridKey() {
  return `SG.${randomBytes(17).toString('base64url').slice(0, 22)}.${randomBytes(33).toString('base64url').slice(0, 43)}`;
}

/** `n` distinct letters and digits in a random order (a short password whose entropy is log2(n) bits a character). */
function shortPassword(n) {
  const pool = [...'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).join('');
}

/** Public look-alikes the repo legitimately contains: none may be flagged by any rule. */
const NEGATIVE = {
  'src/keys.ts': `export const RELAYER_PUBLIC_KEY = "${publicKey()}";\nexport const CKD = "bls12381g2:${base58(randomBytes(96))}";\nexport const PK = "pk_test_${base58(randomBytes(24))}";\n`,
  'docs/ops.md': "VAULT_KEK=1:<base64 of 32 bytes>\nRELAYER_KEYS='[\"ed25519:…\"]'\nKEYS_UPDATER_KEY=$(jq -r .private_key .secrets/<env>/keys-updater.json)\n",
  'test/fixture.ts': `const placeholder = "1:${'A'.repeat(43)}=";\n`,
  'scripts/vault-kek.ts': '// vault-kek.ts <env> <init | put | rotate>\n',
  'envs/x.json': `{ "watchdogs": ["${publicKey()}"], "identityToken": { "publicKeys": [${publicJwk()}] } }\n`,
  'docs/jwks.md': `IDENTITY_SIGNING_KEY=<a P-256 private JWK>\nIDENTITY_SUB_KEY=<base64 of 32 bytes>\n`,
  'docs/usage.md': 'postgresql://usage_writer:<password>@<host>/neondb?sslmode=require\nUSER_ID_KEY=<base64 of 32 bytes>\npostgresql://usage_writer:unused@usage-db.test.invalid:5432/usage\n',
};

function scan(dir) {
  const report = join(dir, '..', `${dir.split('/').pop()}.report.json`);
  const res = spawnSync(gitleaks, ['dir', dir, '--config', config, '--no-banner', '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', report, '--log-level', 'error'], { encoding: 'utf8' });
  if (res.error) throw new Error(`could not run ${gitleaks}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`gitleaks exited ${res.status}: ${(res.stderr || '').slice(0, 500)}`);
  return JSON.parse(readFileSync(report, 'utf8')).map((f) => f.RuleID);
}

function writeAll(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, { mode: 0o600 });
  }
}

const root = mkdtempSync(join(tmpdir(), 'hana-gitleaks-selftest-'));
let failed = 0;
try {
  CASES.forEach((c, i) => {
    const dir = join(root, `case${i}`);
    writeAll(dir, c.files);
    const found = new Set(scan(dir));
    const missing = c.expect.filter((id) => !found.has(id));
    if (missing.length) {
      failed++;
      console.log(`FAIL  ${c.name}: not caught by ${missing.join(', ')} (found: ${[...found].join(', ') || 'nothing'})`);
    } else console.log(`ok    ${c.name}: ${[...found].sort().join(', ')}`);
  });
  const neg = join(root, 'negative');
  writeAll(neg, NEGATIVE);
  const flagged = scan(neg);
  if (flagged.length) {
    failed++;
    console.log(`FAIL  public look-alikes flagged: ${flagged.join(', ')}`);
  } else console.log('ok    public look-alikes (public keys, placeholders, pk_test_, BLS keys) pass');
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed) {
  console.log(`${failed} gitleaks self-test case(s) failed: .gitleaks.toml misses a secret shape (or flags a public one).`);
  process.exitCode = 1;
}
