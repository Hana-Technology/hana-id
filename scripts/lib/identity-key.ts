// identity-key.ts's body: the partner identity token's keys (docs/identity-token-spec.md "Signing key, JWKS and
// rotation", docs/operations.md "Identity token keys", D177), testnet and local* only (mainnet signs with AWS KMS, D127).
//
// Files in .secrets/<env>/ (0600, never overwritten: Cloudflare never gives a secret back), P-256 private JWKs by role:
//   identity-signing-key.json           signs now; a Worker secret
//   identity-signing-key-standby.json   published in the JWKS, kept OFF the Worker: a leak of the Worker's secrets
//                                       doesn't reach it, so switching to it is a real recovery (move the file offline)
//   identity-signing-key-next.json      a rotation's incoming key: published, not uploaded until `switch --to next`
//   identity-signing-key-previous.json  the key a switch replaced, still published until `retire`
//   identity-slots.json                 which Worker secret slot (IDENTITY_SIGNING_KEY, IDENTITY_SIGNING_KEY_STANDBY)
//                                       holds which kid (public data); a switch uploads into the slot the active key
//                                       isn't in, so the Worker always has a key with the active kid
//   identity-sub-key                    32 random bytes (base64): the `sub`/`sid` HMAC key, never rotated
//   identity-seal-key                   IDENTITY_SEAL_KEY (D418): `<id>:<base64 of 32 bytes>`, the sealed email's key,
//                                       on the API and the email issuer
//   email-consent-key                   EMAIL_CONSENT_KEY (D419): 32 random bytes (base64), the consents' MAC key (API)
//
//   init [--local]                  generate active, standby and sub key; files; the manifest's `identityToken`; upload
//                                   the active key and the sub key (never the standby). --local: no upload
//   put                             upload the active key (into its slot) and the sub key again from the files
//   next                            generate a rotation key, publish it (manifest `publicKeys`), upload nothing
//   switch --to next|standby        upload that key into the free slot and make it the manifest's `activeKid`; the
//                                   old active key becomes `previous` (still published, so its tokens keep verifying)
//   retire --key previous|standby   remove that key from the manifest's `publicKeys`, delete its Worker secret if it
//                                   is in a slot, and set its file aside (`identity-signing-key-retired-<kid>.json`)
//   show                            the published kids, their roles and slots (public values only)
//   email-keys [--local]            email sharing's keys (D418, D419): write identity-seal-key and email-consent-key
//                                   (each only if missing: an existing file is reused, never replaced), then set
//                                   IDENTITY_SEAL_KEY and EMAIL_CONSENT_KEY on the API Worker and IDENTITY_SEAL_KEY on
//                                   the email issuer Worker (skipped when the manifest has no emailIssuer). --local: no
//                                   upload
//   email-keys put                  set those three secrets again from the files
//
// Every command that changes something prints its plan and changes nothing without --yes; each manifest change needs
// `gen` and a deploy to take effect, which the command says. When the manifest has a `watchdog` block, every key the
// manifest publishes is also pinned in `watchdog.pinnedIdentityKeys` (D211; the schema requires it): `init` and `next`
// pin the new keys (deploy the watchdog first, then the API), `retire` unpins the key it unpublishes (deploy the API
// first, then the watchdog). Dependencies are injectable, so the tests run every flow
// against a temp directory and a fake wrangler. Nothing prints a private key.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY_SECRET_FILES, type Manifest, identityIssuerFor, identitySealKeyId, loadEnv, manifestPath, manifestSchema, p256Thumbprint, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { type AwsSecret, KMS_COMMANDS, KMS_STRING_FLAGS, type KmsCommand, identityKms } from './identity-kms.ts';
import { assertPrivate, parseSecretJson, secretsDir, writeSecretJson } from './secrets.ts';
import { DRY_RUN_LINE, writeNewSecretFile } from './vault-kek.ts';

export const IDENTITY_KEY_USAGE = `Usage: identity-key.ts <env> <command> [--yes]
  init [--local]                 generate the active key, an offline standby (P-256) and IDENTITY_SUB_KEY (32 bytes),
                                 write .secrets/<env>/identity-* (0600) and identityToken in envs/<env>.json, then set
                                 IDENTITY_SIGNING_KEY and IDENTITY_SUB_KEY (never the standby). --local: no upload
  put                            set the active key and the sub key on the Worker again from the files
  next                           generate a rotation key and publish it (manifest only; upload nothing)
  switch --to next|standby       upload that key into the free slot and make it the active key (manifest)
  retire --key previous|standby  unpublish that key, delete its Worker secret if it has one, set its file aside
  show                           the published kids, their roles and slots (public values only)
  email-keys [--local]           email sharing's keys (D418, D419): write .secrets/<env>/identity-seal-key
                                 (IDENTITY_SEAL_KEY, 1:<32 bytes>) and email-consent-key (EMAIL_CONSENT_KEY, 32 bytes),
                                 0600, each only if missing (an existing file is reused), then set both on the API
                                 Worker and IDENTITY_SEAL_KEY on the email issuer Worker (if the env has one).
                                 --local: no upload
  email-keys put                 set those secrets again from the files
  --yes                          do it (without it, only print the plan)

After init, next, switch and retire: commit envs/<env>.json, run gen and deploy the API. With a watchdog block, init
and next (and kms-init, kms-add) also pin the new keys in watchdog.pinnedIdentityKeys (deploy the watchdog first), and
retire (and kms-retire) unpins (deploy the watchdog after the API). No private key is ever
printed. Testnet envs only. The sub key is never rotated: a new one changes every user's \`sub\` at every partner.

AWS KMS signer (staging and mainnet; D215, docs/operations.md "Identity token keys on AWS KMS"):
  kms-init --active <file> --standby <file> --iam-user <name> [--local]
                                 a new env: identityToken with the aws-kms signer (active and standby in two regions)
                                 and a new IDENTITY_SUB_KEY, set on the Worker unless --local
  kms-add --role next|standby --key <file>
                                 publish a KMS key in that role (manifest only)
  kms-switch --to next|standby   make that key active; the old active key becomes "previous" (still published)
  kms-retire --key previous|standby
                                 unpublish that key (then disable it and schedule its deletion in KMS)
  kms-put-aws-key                set IDENTITY_AWS_ACCESS_KEY_ID and IDENTITY_AWS_SECRET_ACCESS_KEY in one wrangler
                                 secret bulk, from .secrets/<env>/${IDENTITY_SECRET_FILES.awsAccessKey}
  <file> is \`aws kms get-public-key --key-id <arn> --output json\`'s output. The kms-* commands never call AWS and
  never print a credential.`;

export type SigningSlot = 'IDENTITY_SIGNING_KEY' | 'IDENTITY_SIGNING_KEY_STANDBY';
/** Email sharing's API secrets (D418, D419); IDENTITY_SEAL_KEY also goes to the email issuer. */
export type EmailKeySecret = 'IDENTITY_SEAL_KEY' | 'EMAIL_CONSENT_KEY';
export type IdentitySecret = SigningSlot | 'IDENTITY_SUB_KEY' | EmailKeySecret;
export const SIGNING_SLOTS: readonly SigningSlot[] = ['IDENTITY_SIGNING_KEY', 'IDENTITY_SIGNING_KEY_STANDBY'];

export interface P256PrivateJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
}

export interface IdentityKeyDeps {
  putSecret: (m: Manifest, name: IdentitySecret, value: string) => void;
  /** Sets a secret on the email issuer Worker (`emailIssuer.cloudflare.workerName`), the value on wrangler's stdin. */
  putIssuerSecret?: (m: Manifest, name: 'IDENTITY_SEAL_KEY', value: string) => void;
  /** Sets several secrets in one request (`wrangler secret bulk`, stdin): the AWS key pair changes atomically. */
  putSecretsBulk?: (m: Manifest, values: Record<AwsSecret, string>) => void;
  deleteSecret: (m: Manifest, name: SigningSlot) => void;
  /** A fresh P-256 private JWK (default node:crypto). */
  newP256: () => P256PrivateJwk;
  randomBytes: (n: number) => Uint8Array;
  log: (line: string) => void;
  secretsRoot?: string;
  loadManifest?: (name: string) => Manifest;
  readManifestText?: (name: string) => string;
  writeManifestText?: (name: string, text: string) => void;
}

const apiDir = join(repoRoot, 'apps', 'api');
const issuerDir = join(repoRoot, 'apps', 'email-issuer');

export function wranglerSecretArgv(m: Manifest, name: IdentitySecret): string[] {
  return ['exec', 'wrangler', 'secret', 'put', name, '--name', m.cloudflare.workerName];
}

/** `wrangler secret bulk` with no file reads the JSON object from stdin: the values never touch the disk again. */
/** `wrangler secret put` on the email issuer Worker (run from apps/email-issuer). */
export function wranglerIssuerSecretArgv(m: Manifest, name: 'IDENTITY_SEAL_KEY'): string[] {
  if (!m.emailIssuer) throw new Error(`envs/${m.name}.json has no emailIssuer`);
  return ['exec', 'wrangler', 'secret', 'put', name, '--name', m.emailIssuer.cloudflare.workerName];
}

export function wranglerSecretBulkArgv(m: Manifest): string[] {
  return ['exec', 'wrangler', 'secret', 'bulk', '--name', m.cloudflare.workerName];
}

export function wranglerSecretDeleteArgv(m: Manifest, name: SigningSlot): string[] {
  return ['exec', 'wrangler', 'secret', 'delete', name, '--name', m.cloudflare.workerName];
}

export function newP256(): P256PrivateJwk {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as P256PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

export function defaultIdentityKeyDeps(): IdentityKeyDeps {
  const wrangler = (argv: string[], input?: string, cwd: string = apiDir) => {
    const res = spawnSync('pnpm', argv, { cwd, input: input ?? 'y\n', stdio: ['pipe', 'inherit', 'inherit'] });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`wrangler ${argv.slice(2, 4).join(' ')} ${argv[4] ?? ''} failed (exit ${res.status})`);
  };
  return {
    putSecret: (m, name, value) => wrangler(wranglerSecretArgv(m, name), value),
    putIssuerSecret: (m, name, value) => wrangler(wranglerIssuerSecretArgv(m, name), value, issuerDir),
    putSecretsBulk: (m, values) => wrangler(wranglerSecretBulkArgv(m), JSON.stringify(values)),
    deleteSecret: (m, name) => wrangler(wranglerSecretDeleteArgv(m, name)),
    newP256,
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
    log: (line) => console.log(line),
  };
}

const COORD_RE = /^[A-Za-z0-9_-]{43}$/u;
const SUB_KEY_RE = /^[A-Za-z0-9+/]{43}=$/u;

export const isP256PrivateJwk = (v: unknown): v is P256PrivateJwk => {
  const k = v as P256PrivateJwk | null;
  return !!k && k.kty === 'EC' && k.crv === 'P-256' && [k.x, k.y, k.d].every((c) => typeof c === 'string' && COORD_RE.test(c));
};

/** The JWKS entry of a key (public members only). */
export const publicEntry = (k: P256PrivateJwk) => ({ kty: 'EC' as const, crv: 'P-256' as const, x: k.x, y: k.y, kid: p256Thumbprint(k), use: 'sig' as const, alg: 'ES256' as const });

/** A new sub key value: base64 of 32 random bytes. */
export function newSubKey(randomBytes: (n: number) => Uint8Array): string {
  const raw = randomBytes(32);
  if (raw.length !== 32) throw new Error('randomBytes returned the wrong length');
  const value = Buffer.from(raw).toString('base64');
  raw.fill(0);
  return value;
}

/** A new IDENTITY_SEAL_KEY value: key id 1 and 32 random bytes (`1:<base64>`). */
export function newSealKey(randomBytes: (n: number) => Uint8Array): string {
  const value = `1:${newSubKey(randomBytes)}`;
  if (identitySealKeyId(value) !== 1) throw new Error('newSealKey made a malformed key');
  return value;
}

/** An IDENTITY_SEAL_KEY file (0600 checked; the error names the file, never its contents). */
export function readSealKeyFile(file: string): string {
  assertPrivate(file);
  const v = readFileSync(file, 'utf8').trim();
  if (identitySealKeyId(v) === null) throw new Error(`${file} is not an IDENTITY_SEAL_KEY value (<id>:<base64 of 32 bytes>)`);
  return v;
}

export function readKeyFile(file: string): P256PrivateJwk {
  assertPrivate(file);
  const v = parseSecretJson<unknown>(readFileSync(file, 'utf8'), file);
  if (!isP256PrivateJwk(v)) throw new Error(`${file} is not a P-256 private JWK`);
  return { kty: 'EC', crv: 'P-256', x: v.x, y: v.y, d: v.d };
}

export function readSubKeyFile(file: string): string {
  assertPrivate(file);
  const v = readFileSync(file, 'utf8').trim();
  if (!SUB_KEY_RE.test(v) || Buffer.from(v, 'base64').length !== 32) throw new Error(`${file} is not base64 of 32 bytes`);
  return v;
}

/**
 * Inserts the top-level field `key` (a nested object, pretty-printed) right after the top-level field `after`, keeping
 * the rest of the file as it is; the result must validate. Refuses when `key` is already there.
 */
export function insertManifestBlock(text: string, key: string, value: unknown, after: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (key in parsed) throw new Error(`The manifest already has "${key}"`);
  const re = new RegExp(`^([ \\t]*)("${after}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*")(,?)$`, 'gmu');
  const matches = [...text.matchAll(re)];
  let out: string;
  if (matches.length === 1 && matches[0]![3] === ',') {
    const indent = matches[0]![1]!;
    const block = JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`);
    out = text.replace(re, (_m, i: string, field: string) => `${i}${field},\n${i}"${key}": ${block},`);
  } else {
    out = `${JSON.stringify({ ...parsed, [key]: value }, null, 2)}\n`;
  }
  return checked(out, key, value);
}

/**
 * Replaces the value of the top-level object field `key` (found by matching braces, strings skipped), keeping the rest
 * of the file; when it can't be placed, the whole file is rewritten. The result must validate.
 */
export function replaceManifestBlock(text: string, key: string, value: unknown): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!(key in parsed)) throw new Error(`The manifest has no "${key}"`);
  const head = new RegExp(`^([ \\t]*)"${key}"\\s*:\\s*\\{`, 'gmu');
  const matches = [...text.matchAll(head)];
  let out: string | null = null;
  if (matches.length === 1) {
    const m = matches[0]!;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length && end < 0; i++) {
      const c = text[i];
      if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      } else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) end = i;
    }
    if (end > 0) out = `${text.slice(0, open)}${JSON.stringify(value, null, 2).split('\n').join(`\n${m[1]}`)}${text.slice(end + 1)}`;
  }
  out ??= `${JSON.stringify({ ...parsed, [key]: value }, null, 2)}\n`;
  return checked(out, key, value);
}

function checked(out: string, key: string, value: unknown): string {
  const check = JSON.parse(out) as Record<string, unknown>;
  if (JSON.stringify(check[key]) !== JSON.stringify(value)) throw new Error(`Failed to set "${key}" in the manifest`);
  manifestSchema.parse(check);
  return out;
}

/** The `"pinnedIdentityKeys": [...]` member on one line, as envs/*.json keep it. */
const PINS_LINE = /^([ \t]*)"pinnedIdentityKeys"[ \t]*:[ \t]*\[[^\]\n]*\](,?)[ \t]*$/mu;

/**
 * `watchdog.pinnedIdentityKeys` with `add` pinned and `remove` unpinned (D211); the result must validate. Only that
 * one line changes (L3): it is rewritten in place (`["a", "b"]`, as the committed manifests have it), added after the
 * watchdog block's last member, or removed when nothing stays pinned; the rest of the file is kept byte for byte. A
 * manifest without a `watchdog` block is returned unchanged (no watchdog, nothing to pin). A layout this can't place
 * (the member spread over several lines, or two of them) falls back to rewriting the watchdog block.
 */
export function withIdentityPins(text: string, add: readonly string[], remove: readonly string[]): string {
  const raw = JSON.parse(text) as { watchdog?: Record<string, unknown> };
  if (!raw.watchdog) return text;
  const current = Array.isArray(raw.watchdog.pinnedIdentityKeys) ? (raw.watchdog.pinnedIdentityKeys as string[]) : [];
  const next = [...current.filter((t) => !remove.includes(t)), ...add.filter((t) => !current.includes(t))];
  if (next.length === current.length && next.every((t, i) => t === current[i])) return checked(text, 'watchdog', raw.watchdog);
  const { pinnedIdentityKeys: _old, ...rest } = raw.watchdog;
  // A present member keeps its place among the watchdog's members (the line is edited in place); a new one is last.
  const value = !next.length ? rest : 'pinnedIdentityKeys' in raw.watchdog ? { ...raw.watchdog, pinnedIdentityKeys: next } : { ...rest, pinnedIdentityKeys: next };
  const member = `"pinnedIdentityKeys": [${next.map((t) => JSON.stringify(t)).join(', ')}]`;
  const lines = [...text.matchAll(new RegExp(PINS_LINE.source, 'gmu'))];
  let out: string | null = null;
  if (lines.length === 1) {
    const m = lines[0]!;
    if (next.length) {
      out = `${text.slice(0, m.index)}${m[1]}${member}${m[2]}${text.slice(m.index + m[0].length)}`;
    } else if (m[2] === ',') {
      // Not the last member: drop the line.
      out = text.slice(0, m.index) + text.slice(m.index + m[0].length + 1);
    } else {
      // The last member: drop the line and the comma that ends the member before it.
      const before = text.slice(0, m.index).replace(/,([ \t]*\n)$/u, '$1');
      out = before + text.slice(m.index + m[0].length + 1);
    }
  } else if (lines.length === 0 && next.length) {
    // Absent: a new last member of the watchdog block, indented like the others.
    const head = /^([ \t]*)"watchdog"[ \t]*:[ \t]*\{[ \t]*\n/mu.exec(text);
    if (head) {
      let depth = 0;
      let end = -1;
      for (let i = head.index + head[0].lastIndexOf('{'); i < text.length && end < 0; i++) {
        const c = text[i];
        if (c === '"') {
          for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
        } else if (c === '{' || c === '[') depth++;
        else if ((c === '}' || c === ']') && --depth === 0) end = i;
      }
      const body = end > 0 ? text.slice(head.index + head[0].length, end) : '';
      const indent = /^([ \t]+)"/mu.exec(body)?.[1];
      if (end > 0 && indent !== undefined) {
        const lastNl = text.lastIndexOf('\n', end - 1);
        const prev = text.slice(head.index + head[0].length, lastNl).replace(/[ \t]+$/u, '');
        out = `${text.slice(0, head.index + head[0].length)}${prev},\n${indent}${member}${text.slice(lastNl)}`;
      }
    }
  }
  return out === null ? replaceManifestBlock(text, 'watchdog', value) : checked(out, 'watchdog', value);
}

type Slots = Record<SigningSlot, string | null>;

/** Runs `identity-key <argv>`. */
export function identityKey(argv: readonly string[], deps: IdentityKeyDeps): void {
  const args = parseCli(argv, { booleans: ['yes', 'help', 'local'], strings: [...KMS_STRING_FLAGS] });
  if (args.flag('help')) return void deps.log(IDENTITY_KEY_USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <init | put | next | switch | retire | show | email-keys | kms-…>');
  // `email-keys put` is the one command with a second word.
  const emailKeysPut = command === 'email-keys' && rest.length === 1 && rest[0] === 'put';
  if (rest.length && !emailKeysPut) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  // The AWS KMS signer's commands (identity-kms.ts): any network, no private key files.
  if ((KMS_COMMANDS as readonly string[]).includes(command)) return identityKms((deps.loadManifest ?? loadEnv)(envName), command as KmsCommand, args, deps);
  if (!['init', 'put', 'next', 'switch', 'retire', 'show', 'email-keys'].includes(command)) throw new CliError(`Unknown command ${command}`);
  for (const flag of ['active', 'standby', 'iam-user', 'role'] as const) {
    if (args.str(flag) !== undefined) throw new CliError(`--${flag} goes with the kms-* commands only`);
  }
  if (args.flag('local') && command !== 'init' && (command !== 'email-keys' || emailKeysPut)) throw new CliError('--local goes with init and email-keys only');
  if (args.str('to') !== undefined && command !== 'switch') throw new CliError('--to goes with switch only');
  if (args.str('key') !== undefined && command !== 'retire') throw new CliError('--key goes with retire only');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (command === 'show' && m.identityToken?.signer.kind === 'aws-kms') {
    const t = m.identityToken;
    const s = m.identityToken.signer;
    deps.log(`iss ${t.iss}`);
    deps.log(`signer aws-kms, IAM user ${s.credentials.iamUser} (credentials: Worker secrets IDENTITY_AWS_ACCESS_KEY_ID, IDENTITY_AWS_SECRET_ACCESS_KEY)`);
    for (const role of ['active', 'standby', 'next', 'previous'] as const) {
      const k = s.keys[role];
      if (k) deps.log(`kid ${k.kid} ${role}${role === 'active' ? ' (signs)' : ''} ${k.arn}`);
    }
    if (!s.keys.standby) deps.log(`No standby key: create one in another region than the active key and \`kms-add --role standby\`.`);
    return;
  }
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env: mainnet identity keys live in AWS KMS (D127)`);
  const dir = secretsDir(m.name, deps.secretsRoot ?? repoRoot);
  type Role = 'signingKey' | 'standbyKey' | 'nextKey' | 'previousKey';
  const file = (k: Role | 'subKey' | 'slots') => join(dir, IDENTITY_SECRET_FILES[k]);
  const shown = (k: Role | 'subKey' | 'slots') => `.secrets/${m.name}/${IDENTITY_SECRET_FILES[k]}`;
  const worker = m.cloudflare.workerName;
  const apply = args.flag('yes');
  const readText = deps.readManifestText ?? ((name: string) => readFileSync(manifestPath(name), 'utf8'));
  const writeText = deps.writeManifestText ?? ((name: string, text: string) => writeFileSync(manifestPath(name), text));
  const put = (name: IdentitySecret, value: string, what: string) => {
    deps.putSecret(m, name, value);
    deps.log(`Set ${name} (${what}) on Worker ${worker}.`);
  };
  const readSlots = (): Slots => {
    if (!existsSync(file('slots'))) return { IDENTITY_SIGNING_KEY: null, IDENTITY_SIGNING_KEY_STANDBY: null };
    assertPrivate(file('slots'));
    const v = parseSecretJson<Partial<Slots>>(readFileSync(file('slots'), 'utf8'), file('slots'));
    return { IDENTITY_SIGNING_KEY: v.IDENTITY_SIGNING_KEY ?? null, IDENTITY_SIGNING_KEY_STANDBY: v.IDENTITY_SIGNING_KEY_STANDBY ?? null };
  };
  const writeSlots = (s: Slots) => writeSecretJson(file('slots'), s);
  const redeploy = `Commit envs/${m.name}.json, then gen and deploy the API (docs/operations.md "Identity token keys").`;
  const watched = m.watchdog !== undefined;
  const pinFirst = watched
    ? `Commit envs/${m.name}.json, then gen and deploy the watchdog FIRST (on its own Cloudflare account), then gen and deploy the API (docs/operations.md "Identity token keys"); until both are deployed the watchdog warns identity_key_missing.`
    : redeploy;
  const unpinAfter = watched
    ? `Commit envs/${m.name}.json, then gen and deploy the API FIRST, then gen and deploy the watchdog (docs/operations.md "Identity token keys"): the other order pages identity_key_unpinned until the API deploy.`
    : redeploy;

  if (command === 'email-keys') return emailKeys(m, dir, emailKeysPut, args.flag('local'), apply, deps);

  if (command === 'show') {
    const t = m.identityToken;
    if (!t) return void deps.log(`envs/${m.name}.json has no identityToken: run \`identity-key ${m.name} init\`.`);
    deps.log(`iss ${t.iss}`);
    const active = t.signer.kind === 'worker-secret' ? t.signer.activeKid : t.signer.keys.active.kid;
    const roles = new Map<string, string>();
    for (const r of ['signingKey', 'standbyKey', 'nextKey', 'previousKey'] as const) {
      if (existsSync(file(r))) roles.set(p256Thumbprint(readKeyFile(file(r))), r.replace('Key', ''));
    }
    const slots = readSlots();
    for (const k of t.publicKeys) {
      const slot = SIGNING_SLOTS.find((s) => slots[s] === k.kid);
      deps.log(`kid ${k.kid}${k.kid === active ? ' (active: signs)' : ''}${roles.has(k.kid) ? ` role ${roles.get(k.kid)}` : ''}${slot ? ` in ${slot}` : ' not on the Worker'}`);
    }
    return;
  }

  if (command === 'init') {
    for (const k of ['signingKey', 'standbyKey', 'nextKey', 'previousKey', 'subKey', 'slots'] as const) {
      if (existsSync(file(k))) throw new Error(`${shown(k)} already exists: refusing to overwrite a key. Use \`put\` to set the Worker secrets again.`);
    }
    if (m.identityToken) throw new Error(`envs/${m.name}.json already has identityToken: refusing to replace published keys (see docs/operations.md "Identity token keys")`);
    const local = args.flag('local');
    deps.log(
      `Plan (env ${m.name}): generate two P-256 keys (active, standby) and a 32-byte sub key, write ${shown('signingKey')}, ` +
        `${shown('standbyKey')} and ${shown('subKey')} (0600), add identityToken (iss ${identityIssuerFor(m.apiUrl)}, both public keys, ` +
        `the first active) to envs/${m.name}.json${watched ? ' and pin both in watchdog.pinnedIdentityKeys' : ''}${local ? '' : `, set IDENTITY_SIGNING_KEY and IDENTITY_SUB_KEY on Worker ${worker} (the standby stays off the Worker)`}.`,
    );
    if (!apply) return void deps.log(DRY_RUN_LINE);
    const active = deps.newP256();
    const standby = deps.newP256();
    if (!isP256PrivateJwk(active) || !isP256PrivateJwk(standby)) throw new Error('newP256 returned a malformed key');
    const subKey = newSubKey(deps.randomBytes);
    const block = { iss: identityIssuerFor(m.apiUrl), signer: { kind: 'worker-secret', activeKid: publicEntry(active).kid }, publicKeys: [publicEntry(active), publicEntry(standby)] };
    // The new manifest text first, validated (L4): a manifest that won't take the keys fails before any key file exists.
    // Pins before the block (D211): each intermediate manifest validates, and a published key is always pinned.
    const manifestText = insertManifestBlock(withIdentityPins(readText(m.name), block.publicKeys.map((k) => k.kid), []), 'identityToken', block, 'apiUrl');
    // On disk before the manifest and the Worker: the files are the only copies Cloudflare won't give back.
    writeNewSecretFile(file('signingKey'), `${JSON.stringify(active)}\n`);
    writeNewSecretFile(file('standbyKey'), `${JSON.stringify(standby)}\n`);
    writeNewSecretFile(file('subKey'), `${subKey}\n`);
    deps.log(`Wrote ${shown('signingKey')}, ${shown('standbyKey')} and ${shown('subKey')} (0600, values not shown). Move the standby file offline.`);
    writeText(m.name, manifestText);
    deps.log(
      `Wrote identityToken to envs/${m.name}.json (active kid ${block.signer.activeKid}, standby ${block.publicKeys[1]!.kid})${watched ? ' and pinned both in watchdog.pinnedIdentityKeys' : ''}. ${pinFirst}`,
    );
    if (local) {
      writeSlots({ IDENTITY_SIGNING_KEY: null, IDENTITY_SIGNING_KEY_STANDBY: null });
      return void deps.log(`Not set on the Worker (--local). \`identity-key ${m.name} put --yes\` sets them, or \`gen ${m.name} --dev-vars\` for wrangler dev.`);
    }
    put('IDENTITY_SIGNING_KEY', JSON.stringify(active), `kid ${block.signer.activeKid}`);
    writeSlots({ IDENTITY_SIGNING_KEY: block.signer.activeKid, IDENTITY_SIGNING_KEY_STANDBY: null });
    put('IDENTITY_SUB_KEY', subKey, '32 bytes');
    return;
  }

  const t = m.identityToken;
  if (!t) throw new Error(`envs/${m.name}.json has no identityToken: run \`identity-key ${m.name} init\` first`);
  if (t.signer.kind !== 'worker-secret') throw new Error(`identityToken.signer is ${t.signer.kind}: there are no Worker-secret keys to manage (use the kms-* commands)`);
  const activeKid = t.signer.activeKid;
  const published = new Set(t.publicKeys.map((k) => k.kid));
  const active = readKeyFile(file('signingKey'));
  if (p256Thumbprint(active) !== activeKid) throw new Error(`${shown('signingKey')} doesn't have the manifest's active kid ${activeKid}`);
  const slots = readSlots();
  const activeSlot: SigningSlot = SIGNING_SLOTS.find((s) => slots[s] === activeKid) ?? 'IDENTITY_SIGNING_KEY';
  const writeManifest = (next: typeof t) => writeText(m.name, replaceManifestBlock(readText(m.name), 'identityToken', next));

  if (command === 'put') {
    const subKey = readSubKeyFile(file('subKey'));
    deps.log(`Plan (env ${m.name}): set ${activeSlot} (active kid ${activeKid}) and IDENTITY_SUB_KEY from the files on Worker ${worker}.`);
    if (!apply) return void deps.log(DRY_RUN_LINE);
    put(activeSlot, JSON.stringify(active), `kid ${activeKid}`);
    writeSlots({ ...slots, [activeSlot]: activeKid });
    put('IDENTITY_SUB_KEY', subKey, '32 bytes');
    return;
  }

  if (command === 'next') {
    if (existsSync(file('nextKey'))) throw new Error(`${shown('nextKey')} exists: switch to it or retire it first`);
    if (t.publicKeys.length >= 4) throw new Error(`identityToken.publicKeys already has 4 keys: retire one first`);
    deps.log(
      `Plan (env ${m.name}): generate a P-256 key, write ${shown('nextKey')} (0600) and publish it in envs/${m.name}.json${watched ? ', pinned in watchdog.pinnedIdentityKeys' : ''} (nothing is uploaded).`,
    );
    if (!apply) return void deps.log(DRY_RUN_LINE);
    const key = deps.newP256();
    if (!isP256PrivateJwk(key)) throw new Error('newP256 returned a malformed key');
    const entry = publicEntry(key);
    // Validated before the key file is written (L4); pinned before published (D211).
    const manifestText = replaceManifestBlock(withIdentityPins(readText(m.name), [entry.kid], []), 'identityToken', { ...t, publicKeys: [...t.publicKeys, entry] });
    writeNewSecretFile(file('nextKey'), `${JSON.stringify(key)}\n`);
    writeText(m.name, manifestText);
    deps.log(`Published kid ${entry.kid}${watched ? ' and pinned it' : ''}. ${pinFirst} Partners that pin thumbprints need 14 days' notice (24 h on testnet) before \`switch --to next\`, unless this is an incident.`);
    return;
  }

  if (command === 'switch') {
    const to = args.str('to');
    if (to !== 'next' && to !== 'standby') throw new CliError('switch needs --to next or --to standby');
    const role: Role = to === 'next' ? 'nextKey' : 'standbyKey';
    if (!existsSync(file(role))) throw new Error(`${shown(role)} doesn't exist`);
    if (existsSync(file('previousKey'))) throw new Error(`${shown('previousKey')} exists: retire it first (\`retire --key previous\`)`);
    const key = readKeyFile(file(role));
    const kid = p256Thumbprint(key);
    if (!published.has(kid)) throw new Error(`kid ${kid} (${shown(role)}) isn't in identityToken.publicKeys: publish it and deploy first`);
    const freeSlot: SigningSlot = activeSlot === 'IDENTITY_SIGNING_KEY' ? 'IDENTITY_SIGNING_KEY_STANDBY' : 'IDENTITY_SIGNING_KEY';
    deps.log(
      `Plan (env ${m.name}): set ${freeSlot} to the ${to} key (kid ${kid}) on Worker ${worker}, make it the active kid in envs/${m.name}.json, ` +
        `and move ${shown('signingKey')} (kid ${activeKid}) to ${shown('previousKey')}; it stays published until \`retire --key previous\`.`,
    );
    if (!apply) return void deps.log(DRY_RUN_LINE);
    // The Worker first holds both keys (the deployed one signs with the old kid), then the deploy switches the signer.
    put(freeSlot, JSON.stringify(key), `kid ${kid}`);
    writeSlots({ ...slots, [freeSlot]: kid });
    writeManifest({ ...t, signer: { kind: 'worker-secret', activeKid: kid } });
    renameSync(file('signingKey'), file('previousKey'));
    renameSync(file(role), file('signingKey'));
    deps.log(
      `Kid ${kid} is now active (${shown('signingKey')}); kid ${activeKid} is ${shown('previousKey')}. ${redeploy} Then, after ≥ 2 h (at once if it ` +
        `was compromised): \`identity-key ${m.name} retire --key previous --yes\`.${to === 'standby' ? ' Make a new standby with `next`.' : ''}`,
    );
    return;
  }

  // retire
  const which = args.str('key');
  if (which !== 'previous' && which !== 'standby') throw new CliError('retire needs --key previous or --key standby');
  const role: Role = which === 'previous' ? 'previousKey' : 'standbyKey';
  if (!existsSync(file(role))) throw new Error(`${shown(role)} doesn't exist`);
  const key = readKeyFile(file(role));
  const kid = p256Thumbprint(key);
  if (kid === activeKid) throw new Error(`kid ${kid} is the active key: switch away from it first`);
  const slot = SIGNING_SLOTS.find((s) => slots[s] === kid) ?? null;
  const retiredFile = join(dir, `identity-signing-key-retired-${kid.slice(0, 16)}.json`);
  deps.log(
    `Plan (env ${m.name}): remove kid ${kid} (${which}) from identityToken.publicKeys${watched ? ' and watchdog.pinnedIdentityKeys' : ''}${slot ? `, delete ${slot} on Worker ${worker}` : ''}, and move ` +
      `${shown(role)} to .secrets/${m.name}/identity-signing-key-retired-${kid.slice(0, 16)}.json (kept for the post-mortem; never commit it).`,
  );
  if (!apply) return void deps.log(DRY_RUN_LINE);
  if (existsSync(retiredFile)) throw new Error(`${retiredFile} exists: refusing to overwrite it`);
  // Unpublish first, then unpin (D211): each intermediate manifest validates. A retired key is never left pinned, so a
  // key that leaked can't be republished without a critical alert.
  writeText(m.name, withIdentityPins(replaceManifestBlock(readText(m.name), 'identityToken', { ...t, publicKeys: t.publicKeys.filter((k) => k.kid !== kid) }), [], [kid]));
  if (slot) {
    deps.deleteSecret(m, slot);
    deps.log(`Deleted ${slot} on Worker ${worker}.`);
    writeSlots({ ...slots, [slot]: null });
  }
  renameSync(file(role), retiredFile);
  deps.log(`Kid ${kid} is unpublished${watched ? ' and unpinned' : ''}. ${unpinAfter} Partners using the JWKS URL reject its tokens within 10 minutes of the deploy.`);
}

/**
 * `email-keys [put]` (D418, D419, docs/operations.md "Email sharing keys"): IDENTITY_SEAL_KEY (the sealed email, on the
 * API and the email issuer) and EMAIL_CONSENT_KEY (the consents' MAC, on the API). Without `put`, each file is written
 * only when it is missing (an existing one is checked and reused, never replaced: the seal key's value is needed for a
 * rotation, and a new consent key forgets every consent); `put` only uploads them. The API is set first, so a blob the
 * issuer seals with the new key always finds it there. No value is printed.
 */
function emailKeys(m: Manifest, dir: string, putOnly: boolean, local: boolean, apply: boolean, deps: IdentityKeyDeps): void {
  const sealFile = join(dir, IDENTITY_SECRET_FILES.sealKey);
  const consentFile = join(dir, IDENTITY_SECRET_FILES.emailConsentKey);
  const shownSeal = `.secrets/${m.name}/${IDENTITY_SECRET_FILES.sealKey}`;
  const shownConsent = `.secrets/${m.name}/${IDENTITY_SECRET_FILES.emailConsentKey}`;
  const worker = m.cloudflare.workerName;
  const issuer = m.emailIssuer?.cloudflare.workerName;
  // Existing files are checked first (0600, their form): a malformed one stops the command and is never replaced.
  const existingSeal = existsSync(sealFile) ? readSealKeyFile(sealFile) : null;
  const existingConsent = existsSync(consentFile) ? readSubKeyFile(consentFile) : null;
  if (putOnly) {
    const missing = [existingSeal ? null : shownSeal, existingConsent ? null : shownConsent].filter((x): x is string => x !== null);
    if (missing.length) throw new Error(`${missing.join(' and ')} ${missing.length > 1 ? "don't" : "doesn't"} exist: run \`identity-key ${m.name} email-keys --yes\` first`);
  }
  const files = putOnly
    ? `from ${shownSeal} and ${shownConsent}`
    : `${existingSeal ? `reuse ${shownSeal}` : `write ${shownSeal} (IDENTITY_SEAL_KEY, key id 1, 32 random bytes)`}, ${existingConsent ? `reuse ${shownConsent}` : `write ${shownConsent} (EMAIL_CONSENT_KEY, 32 random bytes)`}${existingSeal && existingConsent ? '' : ' (0600)'}`;
  const upload = local
    ? 'upload nothing (--local)'
    : `set IDENTITY_SEAL_KEY and EMAIL_CONSENT_KEY on the API Worker ${worker}, then ${issuer ? `IDENTITY_SEAL_KEY on the email issuer Worker ${issuer}` : `no issuer (envs/${m.name}.json has no emailIssuer)`}`;
  deps.log(`Plan (env ${m.name}): ${files}; ${upload}.`);
  if (!apply) return void deps.log(DRY_RUN_LINE);

  const seal = existingSeal ?? newSealKey(deps.randomBytes);
  const consent = existingConsent ?? newSubKey(deps.randomBytes);
  // Two keys for two purposes: the same 32 bytes in both would be a broken random source or a copied file.
  if (seal.slice(seal.indexOf(':') + 1) === consent) throw new Error(`${shownSeal} and ${shownConsent} hold the same 32 bytes: they must differ`);
  const written = [existingSeal ? null : shownSeal, existingConsent ? null : shownConsent].filter((x): x is string => x !== null);
  // On disk before any Worker: the files are the only copies Cloudflare won't give back.
  if (!existingSeal) writeNewSecretFile(sealFile, `${seal}\n`);
  if (!existingConsent) writeNewSecretFile(consentFile, `${consent}\n`);
  if (written.length) deps.log(`Wrote ${written.join(' and ')} (0600, values not shown). Keep them: a seal key rotation needs the current value, and a new consent key forgets every consent.`);
  if (local) return void deps.log(`Not set on any Worker (--local). \`identity-key ${m.name} email-keys put --yes\` sets them; \`gen ${m.name} --dev-vars\` (the API's and the issuer's) writes them for wrangler dev.`);
  const keyId = identitySealKeyId(seal);
  deps.putSecret(m, 'IDENTITY_SEAL_KEY', seal);
  deps.log(`Set IDENTITY_SEAL_KEY (key id ${keyId}) on Worker ${worker}.`);
  deps.putSecret(m, 'EMAIL_CONSENT_KEY', consent);
  deps.log(`Set EMAIL_CONSENT_KEY (32 bytes) on Worker ${worker}.`);
  if (!issuer) return void deps.log(`envs/${m.name}.json has no emailIssuer: no issuer Worker to set. Once it exists, run \`identity-key ${m.name} email-keys put --yes\`.`);
  if (!deps.putIssuerSecret) throw new Error('No way to set a secret on the email issuer Worker (putIssuerSecret)');
  deps.putIssuerSecret(m, 'IDENTITY_SEAL_KEY', seal);
  deps.log(`Set IDENTITY_SEAL_KEY (key id ${keyId}) on the email issuer Worker ${issuer}.`);
}
