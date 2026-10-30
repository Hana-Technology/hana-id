// identity-key.ts's body: the partner identity token's secrets (docs/identity-token-spec.md "D1 schema, manifest and
// secrets", docs/operations.md "Identity token keys"), testnet and local* only (mainnet signs with AWS KMS, D127):
//
//   IDENTITY_SIGNING_KEY, IDENTITY_SIGNING_KEY_STANDBY   P-256 private JWKs: the active key and a standby that every
//                                                        partner's JWKS cache already holds (the compromise switch)
//   IDENTITY_SUB_KEY                                     32 random bytes (base64): the `sub`/`sid` HMAC key, never rotated
//
// Each is generated here, kept in .secrets/<env>/ (0600, never overwritten; Cloudflare never gives a secret back) and
// set as a Worker secret through wrangler's stdin. `init` also writes the public half to envs/<env>.json
// (`identityToken`: iss, signer.activeKid, publicKeys), which the JWKS is generated from. Nothing prints a private key.
//
//   init [--local]  generate the three, write the files and the manifest block, set the Worker secrets (--local: not)
//   put             set the three Worker secrets again from the files (refused if they don't match the manifest)
//   show            print the published kids and which one signs (public values only)
//
// Every command that changes something prints its plan and changes nothing without --yes. Dependencies are injectable,
// so the tests run every flow against a temp directory and a fake wrangler.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY_SECRET_FILES, type Manifest, identityIssuerFor, loadEnv, manifestPath, manifestSchema, p256Thumbprint, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { assertPrivate, parseSecretJson, secretsDir } from './secrets.ts';
import { DRY_RUN_LINE, writeNewSecretFile } from './vault-kek.ts';

export const IDENTITY_KEY_USAGE = `Usage: identity-key.ts <env> <init [--local] | put | show> [--yes]
  init     generate IDENTITY_SIGNING_KEY, IDENTITY_SIGNING_KEY_STANDBY (P-256) and IDENTITY_SUB_KEY (32 bytes), write
           .secrets/<env>/identity-* (0600) and the public keys to envs/<env>.json (identityToken), then set the three
           Worker secrets. --local: files and manifest only (local* envs, or to upload later with \`put\`)
  put      set the three Worker secrets again from .secrets/<env>/identity-* (checked against the manifest)
  show     print the published kids and which one signs (public values only)
  --yes    do it (without it, only print the plan)

No private key is ever printed. Testnet envs only. The sub key is never rotated: a new one changes every user's \`sub\`
at every partner.`;

export type IdentitySecret = 'IDENTITY_SIGNING_KEY' | 'IDENTITY_SIGNING_KEY_STANDBY' | 'IDENTITY_SUB_KEY';

export interface P256PrivateJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
}

export interface IdentityKeyDeps {
  putSecret: (m: Manifest, name: IdentitySecret, value: string) => void;
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

export function wranglerSecretArgv(m: Manifest, name: IdentitySecret): string[] {
  return ['exec', 'wrangler', 'secret', 'put', name, '--name', m.cloudflare.workerName];
}

export function newP256(): P256PrivateJwk {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as P256PrivateJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

export function defaultIdentityKeyDeps(): IdentityKeyDeps {
  return {
    putSecret: (m, name, value) => {
      const res = spawnSync('pnpm', wranglerSecretArgv(m, name), { cwd: apiDir, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`wrangler secret put ${name} failed (exit ${res.status})`);
    },
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

function readKeyFile(file: string): P256PrivateJwk {
  assertPrivate(file);
  const v = parseSecretJson<unknown>(readFileSync(file, 'utf8'), file);
  if (!isP256PrivateJwk(v)) throw new Error(`${file} is not a P-256 private JWK`);
  return { kty: 'EC', crv: 'P-256', x: v.x, y: v.y, d: v.d };
}

function readSubKeyFile(file: string): string {
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
  const check = JSON.parse(out) as Record<string, unknown>;
  if (JSON.stringify(check[key]) !== JSON.stringify(value)) throw new Error(`Failed to set "${key}" in the manifest`);
  manifestSchema.parse(check);
  return out;
}

/** Runs `identity-key <argv>`. */
export function identityKey(argv: readonly string[], deps: IdentityKeyDeps): void {
  const args = parseCli(argv, { booleans: ['yes', 'help', 'local'] });
  if (args.flag('help')) return void deps.log(IDENTITY_KEY_USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <init | put | show>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  if (command !== 'init' && command !== 'put' && command !== 'show') throw new CliError(`Unknown command ${command}`);
  if (args.flag('local') && command !== 'init') throw new CliError('--local goes with init only');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env: mainnet identity keys live in AWS KMS (D127)`);
  const dir = secretsDir(m.name, deps.secretsRoot ?? repoRoot);
  const files = {
    signingKey: join(dir, IDENTITY_SECRET_FILES.signingKey),
    standbyKey: join(dir, IDENTITY_SECRET_FILES.standbyKey),
    subKey: join(dir, IDENTITY_SECRET_FILES.subKey),
  };
  const shown = (k: keyof typeof IDENTITY_SECRET_FILES) => `.secrets/${m.name}/${IDENTITY_SECRET_FILES[k]}`;
  const worker = m.cloudflare.workerName;
  const apply = args.flag('yes');
  const put = (name: IdentitySecret, value: string, what: string) => {
    deps.putSecret(m, name, value);
    deps.log(`Set ${name} (${what}) on Worker ${worker}.`);
  };

  if (command === 'show') {
    const t = m.identityToken;
    if (!t) return void deps.log(`envs/${m.name}.json has no identityToken: run \`identity-key ${m.name} init\`.`);
    deps.log(`iss ${t.iss}`);
    const active = t.signer.kind === 'worker-secret' ? t.signer.activeKid : t.signer.keys.active;
    for (const k of t.publicKeys) deps.log(`kid ${k.kid}${k.kid === active ? ' (active: signs)' : ''}`);
    return;
  }

  if (command === 'init') {
    for (const k of Object.keys(files) as (keyof typeof files)[]) {
      if (existsSync(files[k])) throw new Error(`${shown(k)} already exists: refusing to overwrite a key. Use \`put\` to set the Worker secrets again.`);
    }
    if (m.identityToken) throw new Error(`envs/${m.name}.json already has identityToken: refusing to replace published keys (see docs/operations.md "Identity token keys")`);
    const local = args.flag('local');
    deps.log(
      `Plan (env ${m.name}): generate two P-256 keys (active, standby) and a 32-byte sub key, write ${shown('signingKey')}, ` +
        `${shown('standbyKey')} and ${shown('subKey')} (0600), add identityToken (iss ${identityIssuerFor(m.apiUrl)}, both public keys, ` +
        `the first active) to envs/${m.name}.json${local ? '' : `, set IDENTITY_SIGNING_KEY, IDENTITY_SIGNING_KEY_STANDBY and IDENTITY_SUB_KEY on Worker ${worker}`}.`,
    );
    if (!apply) return void deps.log(DRY_RUN_LINE);
    const active = deps.newP256();
    const standby = deps.newP256();
    if (!isP256PrivateJwk(active) || !isP256PrivateJwk(standby)) throw new Error('newP256 returned a malformed key');
    const subKey = newSubKey(deps.randomBytes);
    // On disk before anything else: the files are the only copies Cloudflare won't give back.
    writeNewSecretFile(files.signingKey, `${JSON.stringify(active)}\n`);
    writeNewSecretFile(files.standbyKey, `${JSON.stringify(standby)}\n`);
    writeNewSecretFile(files.subKey, `${subKey}\n`);
    deps.log(`Wrote ${shown('signingKey')}, ${shown('standbyKey')} and ${shown('subKey')} (0600, values not shown).`);
    const block = { iss: identityIssuerFor(m.apiUrl), signer: { kind: 'worker-secret', activeKid: publicEntry(active).kid }, publicKeys: [publicEntry(active), publicEntry(standby)] };
    const read = deps.readManifestText ?? ((name: string) => readFileSync(manifestPath(name), 'utf8'));
    const write = deps.writeManifestText ?? ((name: string, text: string) => writeFileSync(manifestPath(name), text));
    write(m.name, insertManifestBlock(read(m.name), 'identityToken', block, 'apiUrl'));
    deps.log(`Wrote identityToken to envs/${m.name}.json (active kid ${block.signer.activeKid}, standby ${block.publicKeys[1]!.kid}). Commit it.`);
    if (local) return void deps.log(`Not set on the Worker (--local). \`identity-key ${m.name} put --yes\` sets them, or \`gen ${m.name} --dev-vars\` for wrangler dev.`);
    put('IDENTITY_SIGNING_KEY', JSON.stringify(active), `kid ${block.publicKeys[0]!.kid}`);
    put('IDENTITY_SIGNING_KEY_STANDBY', JSON.stringify(standby), `kid ${block.publicKeys[1]!.kid}`);
    put('IDENTITY_SUB_KEY', subKey, '32 bytes');
    return;
  }

  // put
  const t = m.identityToken;
  if (!t) throw new Error(`envs/${m.name}.json has no identityToken: run \`identity-key ${m.name} init\` first`);
  if (t.signer.kind !== 'worker-secret') throw new Error(`identityToken.signer is ${t.signer.kind}: there are no Worker-secret keys to set`);
  const active = readKeyFile(files.signingKey);
  const standby = readKeyFile(files.standbyKey);
  const subKey = readSubKeyFile(files.subKey);
  const published = new Set(t.publicKeys.map((k) => k.kid));
  const kids = [p256Thumbprint(active), p256Thumbprint(standby)];
  if (!kids.every((k) => published.has(k))) throw new Error(`The keys in .secrets/${m.name} don't match envs/${m.name}.json identityToken.publicKeys`);
  if (!kids.includes(t.signer.activeKid)) throw new Error(`Neither key in .secrets/${m.name} has the active kid ${t.signer.activeKid}`);
  deps.log(`Plan (env ${m.name}): set IDENTITY_SIGNING_KEY (kid ${kids[0]}), IDENTITY_SIGNING_KEY_STANDBY (kid ${kids[1]}) and IDENTITY_SUB_KEY from .secrets/${m.name}/identity-* on Worker ${worker}.`);
  if (!apply) return void deps.log(DRY_RUN_LINE);
  put('IDENTITY_SIGNING_KEY', JSON.stringify(active), `kid ${kids[0]}`);
  put('IDENTITY_SIGNING_KEY_STANDBY', JSON.stringify(standby), `kid ${kids[1]}`);
  put('IDENTITY_SUB_KEY', subKey, '32 bytes');
}
