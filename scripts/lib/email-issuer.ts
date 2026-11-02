// email-issuer.ts's body: the email issuer's keys (docs/email-login-spec.md "Signing key (staged)", "`sub`";
// docs/operations.md "Email issuer"), testnet and local* only (mainnet signs with AWS KMS, D121; build plan batch 10).
//
// Files in .secrets/<env>/ (0600, never overwritten: Cloudflare never gives a secret back; never printed):
//   email-issuer-signing-key.json          RSA-2048 private JWK of signer `hana`'s primary key: the Worker secret
//                                          ISSUER_SIGNING_KEY
//   email-issuer-signing-key-standby.json  the standby: published in the JWKS and posted on chain, kept OFF the Worker
//                                          (D196), so a leak of the Worker's secrets doesn't reach it
//   email-sub-key                          K_sub (base64 of 32 bytes): every email user's `sub`. Losing it locks every
//                                          email user out; replacing it moves every email address. Never rotated; keep
//                                          an offline copy with the council backup (D81)
//   email-code-key, email-rl-key           K_code (code hashes) and K_rl (limiter and suppression keys)
//   email-issuer-sendgrid-key              pasted by hand: a SendGrid API key restricted to Mail Send (D194)
//
//   init --from "<Name> <addr>" [--outbox]   generate both keys and the three HMAC keys, write the files and the
//                                            manifest's emailIssuer block. Uploads nothing
//   put                                      upload ISSUER_SIGNING_KEY, EMAIL_SUB_KEY, EMAIL_CODE_KEY, EMAIL_RL_KEY (and
//                                            SENDGRID_API_KEY when its file exists) to the issuer Worker, values on
//                                            wrangler's stdin. Never the standby
//   show                                     the published kids, their roles, the watchdog pin block and the public keys
//                                            the owner posts with set_issuer_key (public values only)
//
// Every command that changes something prints its plan and changes nothing without --yes. Dependencies are injectable,
// so the tests run every flow against a temp directory, an in-memory manifest and a fake wrangler.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMAIL_ISSUER_SECRET_FILES, type EmailPublicKey, type Manifest, emailIssuerFor, isLocalEnv, loadEnv, manifestPath, repoRoot, rsaJwkThumbprint } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { insertManifestBlock, replaceManifestBlock } from './identity-key.ts';
import { assertPrivate, parseSecretJson, secretsDir } from './secrets.ts';
import { DRY_RUN_LINE, writeNewSecretFile } from './vault-kek.ts';

export const EMAIL_ISSUER_USAGE = `Usage: email-issuer.ts <env> <command> [--yes]
  init --from "<Name> <address>" [--budget <mails a day>] [--outbox]
                 generate the signing key (primary), an offline standby (RSA-2048) and K_sub, K_code, K_rl (32 bytes
                 each), write .secrets/<env>/email-* (0600) and emailIssuer in envs/<env>.json. Uploads nothing.
                 --budget: emailIssuer.dailySendBudget, required outside local* envs (no default)
                 --outbox: the test stub sender (local* envs only)
  put [--standby] set ISSUER_SIGNING_KEY (the manifest's active key; --standby: switch the active kid to the standby
                 key first, for a suspected leak of the primary), EMAIL_SUB_KEY, EMAIL_CODE_KEY, EMAIL_RL_KEY (and SENDGRID_API_KEY when
                 .secrets/<env>/email-issuer-sendgrid-key exists) on the issuer Worker from the files
  show           the published kids and roles, the watchdog pin block, the keys to post on chain (public values)
  --yes          do it (without it, only print the plan)

No secret is ever printed. Testnet envs only. K_sub is never rotated: a new one moves every email user's address.`;

export type IssuerSecret = 'ISSUER_SIGNING_KEY' | 'EMAIL_SUB_KEY' | 'EMAIL_CODE_KEY' | 'EMAIL_RL_KEY' | 'SENDGRID_API_KEY';

export interface RsaPrivateJwk {
  kty: 'RSA';
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
}

export interface EmailIssuerDeps {
  putSecret: (m: Manifest, name: IssuerSecret, value: string) => void;
  newRsa: () => RsaPrivateJwk;
  randomBytes: (n: number) => Uint8Array;
  log: (line: string) => void;
  secretsRoot?: string;
  loadManifest?: (name: string) => Manifest;
  readManifestText?: (name: string) => string;
  writeManifestText?: (name: string, text: string) => void;
}

const issuerDir = join(repoRoot, 'apps', 'email-issuer');

export function wranglerSecretArgv(m: Manifest, name: IssuerSecret): string[] {
  if (!m.emailIssuer) throw new Error(`envs/${m.name}.json has no emailIssuer`);
  return ['exec', 'wrangler', 'secret', 'put', name, '--name', m.emailIssuer.cloudflare.workerName];
}

export function newRsa(): RsaPrivateJwk {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const j = privateKey.export({ format: 'jwk' }) as RsaPrivateJwk;
  return { kty: 'RSA', n: j.n, e: j.e, d: j.d, p: j.p, q: j.q, dp: j.dp, dq: j.dq, qi: j.qi };
}

export function defaultEmailIssuerDeps(): EmailIssuerDeps {
  return {
    putSecret: (m, name, value) => {
      const res = spawnSync('pnpm', wranglerSecretArgv(m, name), { cwd: issuerDir, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`wrangler secret put ${name} failed (exit ${res.status})`);
    },
    newRsa,
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
    log: (line) => console.log(line),
  };
}

const B64URL = /^[A-Za-z0-9_-]+$/u;
const KEY32_RE = /^[A-Za-z0-9+/]{43}=$/u;
const SENDGRID_RE = /^SG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}$/u;

export const isRsaPrivateJwk = (v: unknown): v is RsaPrivateJwk => {
  const k = v as Record<string, unknown> | null;
  return !!k && k.kty === 'RSA' && ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'].every((f) => typeof k[f] === 'string' && B64URL.test(k[f] as string));
};

/** The JWKS entry of a key (public members only). */
export const publicEntry = (k: RsaPrivateJwk): EmailPublicKey => ({ kty: 'RSA', n: k.n, e: k.e, kid: rsaJwkThumbprint(k), use: 'sig', alg: 'RS256' });

/** base64 of 32 random bytes (the buffer is zeroed after). */
export function newKey32(randomBytes: (n: number) => Uint8Array): string {
  const raw = randomBytes(32);
  if (raw.length !== 32) throw new Error('randomBytes returned the wrong length');
  const v = Buffer.from(raw).toString('base64');
  raw.fill(0);
  return v;
}

function readKeyFile(file: string): RsaPrivateJwk {
  assertPrivate(file);
  const v = parseSecretJson<unknown>(readFileSync(file, 'utf8'), file);
  if (!isRsaPrivateJwk(v)) throw new Error(`${file} is not an RSA private JWK`);
  return v;
}

function readKey32(file: string): string {
  assertPrivate(file);
  const v = readFileSync(file, 'utf8').trim();
  if (!KEY32_RE.test(v) || Buffer.from(v, 'base64').length !== 32) throw new Error(`${file} is not base64 of 32 bytes`);
  return v;
}

/** The watchdog's pin block for these kids (manifest `watchdog.pinnedIssuerKeys.email`, D190): signer `hana`, 1-of-1. */
export const pinBlock = (kids: string[]): { required: number; signers: { hana: string[] } } => ({ required: 1, signers: { hana: kids } });

/** Runs `email-issuer <argv>`. */
export function emailIssuer(argv: readonly string[], deps: EmailIssuerDeps): void {
  const args = parseCli(argv, { booleans: ['yes', 'help', 'outbox', 'standby'], strings: ['from', 'budget'] });
  if (args.flag('help')) return void deps.log(EMAIL_ISSUER_USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <init | put | show>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  if (!['init', 'put', 'show'].includes(command)) throw new CliError(`Unknown command ${command}`);
  if ((args.str('from') !== undefined || args.str('budget') !== undefined || args.flag('outbox')) && command !== 'init') throw new CliError('--from, --budget and --outbox go with init only');
  if (args.flag('standby') && command !== 'put') throw new CliError('--standby goes with put only');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env: mainnet email keys live in AWS KMS (D121)`);
  const dir = secretsDir(m.name, deps.secretsRoot ?? repoRoot);
  type F = keyof typeof EMAIL_ISSUER_SECRET_FILES;
  const file = (k: F) => join(dir, EMAIL_ISSUER_SECRET_FILES[k]);
  const shown = (k: F) => `.secrets/${m.name}/${EMAIL_ISSUER_SECRET_FILES[k]}`;
  const apply = args.flag('yes');
  const readText = deps.readManifestText ?? ((name: string) => readFileSync(manifestPath(name), 'utf8'));
  const writeText = deps.writeManifestText ?? ((name: string, text: string) => writeFileSync(manifestPath(name), text));

  if (command === 'init') {
    const from = args.required('from');
    const outbox = args.flag('outbox');
    if (outbox && !isLocalEnv(m.name)) throw new CliError('--outbox is for local* envs only');
    const budgetArg = args.str('budget');
    const budget = budgetArg === undefined ? undefined : Number(budgetArg);
    if (budget !== undefined && !(Number.isSafeInteger(budget) && budget >= 1 && budget <= 10_000_000)) throw new CliError('--budget is a whole number of mails a day (1..10000000)');
    if (budget === undefined && !isLocalEnv(m.name)) throw new CliError('--budget <mails a day> is required outside local* envs (emailIssuer.dailySendBudget, no default)');
    for (const k of ['signingKey', 'standbyKey', 'subKey', 'codeKey', 'rlKey'] as const) {
      if (existsSync(file(k))) throw new Error(`${shown(k)} already exists: refusing to overwrite a key (K_sub decides every email address). Use \`put\` to upload again.`);
    }
    if (m.emailIssuer) throw new Error(`envs/${m.name}.json already has emailIssuer: refusing to replace published keys`);
    const worker = `hana-id-email-issuer-${m.name}`;
    deps.log(
      `Plan (env ${m.name}): generate two RSA-2048 keys (primary, standby) and K_sub, K_code, K_rl (32 bytes each); write ${shown('signingKey')}, ` +
        `${shown('standbyKey')}, ${shown('subKey')}, ${shown('codeKey')} and ${shown('rlKey')} (0600); add emailIssuer (iss ${emailIssuerFor(m.apiUrl)}, ` +
        `Worker and D1 ${worker}, both public keys, the primary active, sender ${outbox ? 'outbox' : 'sendgrid'}) to envs/${m.name}.json. Nothing is uploaded.`,
    );
    if (!apply) return void deps.log(DRY_RUN_LINE);
    const primary = deps.newRsa();
    const standby = deps.newRsa();
    if (!isRsaPrivateJwk(primary) || !isRsaPrivateJwk(standby)) throw new Error('newRsa returned a malformed key');
    if (primary.n === standby.n) throw new Error('newRsa returned the same key twice');
    const keys = { subKey: newKey32(deps.randomBytes), codeKey: newKey32(deps.randomBytes), rlKey: newKey32(deps.randomBytes) };
    if (new Set(Object.values(keys)).size !== 3) throw new Error('randomBytes returned the same key twice');
    // On disk before anything else: the files are the only copies.
    writeNewSecretFile(file('signingKey'), `${JSON.stringify(primary)}\n`);
    writeNewSecretFile(file('standbyKey'), `${JSON.stringify(standby)}\n`);
    for (const k of ['subKey', 'codeKey', 'rlKey'] as const) writeNewSecretFile(file(k), `${keys[k]}\n`);
    deps.log(`Wrote ${shown('signingKey')}, ${shown('standbyKey')}, ${shown('subKey')}, ${shown('codeKey')} and ${shown('rlKey')} (0600, values not shown).`);
    deps.log(`Back up ${shown('subKey')} offline twice (with the council backup, D81) before the first email login, and move the standby key file offline.`);
    const block = {
      iss: emailIssuerFor(m.apiUrl),
      cloudflare: { workerName: worker, d1Name: worker },
      signer: { kind: 'worker-secret', activeKid: publicEntry(primary).kid },
      publicKeys: [publicEntry(primary), publicEntry(standby)],
      from,
      sender: outbox ? 'outbox' : 'sendgrid',
      ...(budget !== undefined ? { dailySendBudget: budget } : {}),
    };
    writeText(m.name, insertManifestBlock(readText(m.name), 'emailIssuer', block, 'apiUrl'));
    deps.log(`Wrote emailIssuer to envs/${m.name}.json (active kid ${block.signer.activeKid}, standby ${block.publicKeys[1]!.kid}).`);
    deps.log(`Watchdog pins (watchdog.pinnedIssuerKeys.email, deployed before the owner posts a key): ${JSON.stringify(pinBlock(block.publicKeys.map((k) => k.kid)))}`);
    deps.log(`Next: commit envs/${m.name}.json, paste the SendGrid key into ${shown('sendgridKey')} (0600), then \`email-issuer ${m.name} put --yes\` (docs/operations.md "Email issuer").`);
    return;
  }

  const t = m.emailIssuer;
  if (!t) throw new Error(`envs/${m.name}.json has no emailIssuer: run \`email-issuer ${m.name} init\` first`);
  if (t.signer.kind !== 'worker-secret') throw new Error(`emailIssuer.signer is ${t.signer.kind}: there are no Worker-secret keys to manage`);
  const activeKid = t.signer.activeKid;

  if (command === 'show') {
    deps.log(`iss ${t.iss}  worker ${t.cloudflare.workerName}  sender ${t.sender}`);
    const roles = new Map<string, string>();
    for (const r of ['signingKey', 'standbyKey'] as const) if (existsSync(file(r))) roles.set(publicEntry(readKeyFile(file(r))).kid, r === 'signingKey' ? 'primary (on the Worker)' : 'standby (offline)');
    for (const k of t.publicKeys) deps.log(`kid ${k.kid}${k.kid === activeKid ? ' (active: signs)' : ''}${roles.has(k.kid) ? ` ${roles.get(k.kid)}` : ''}`);
    deps.log(`Watchdog pins: ${JSON.stringify(pinBlock(t.publicKeys.map((k) => k.kid)))}`);
    for (const k of t.publicKeys) deps.log(`set_issuer_key("email", {"kid":"${k.kid}","n":"${k.n}","e":"${k.e}"}, signer "hana")`);
    const present = (['signingKey', 'standbyKey', 'subKey', 'codeKey', 'rlKey', 'sendgridKey'] as const).filter((k) => existsSync(file(k)));
    deps.log(`Files present: ${present.map((k) => EMAIL_ISSUER_SECRET_FILES[k]).join(', ') || '(none)'}`);
    return;
  }

  // put [--standby]: the key file whose kid is the active kid (after --standby, the standby's).
  const standbyKey = existsSync(file('standbyKey')) ? readKeyFile(file('standbyKey')) : null;
  let active = activeKid;
  if (args.flag('standby')) {
    if (!standbyKey) throw new Error(`${shown('standbyKey')} doesn't exist (bring it back from its offline copy first)`);
    const kid = publicEntry(standbyKey).kid;
    if (!t.publicKeys.some((k) => k.kid === kid)) throw new Error(`the standby key (kid ${kid}) isn't in emailIssuer.publicKeys`);
    if (kid === activeKid) throw new Error('the standby key is already the active key');
    active = kid;
  }
  const candidates = [readKeyFile(file('signingKey')), ...(standbyKey ? [standbyKey] : [])];
  const primary = candidates.find((k) => publicEntry(k).kid === active);
  if (!primary) throw new Error(`no key file in .secrets/${m.name}/ has the manifest's active kid ${active}`);
  const values: [IssuerSecret, string, string][] = [
    ['ISSUER_SIGNING_KEY', JSON.stringify(primary), `kid ${active}`],
    ['EMAIL_SUB_KEY', readKey32(file('subKey')), '32 bytes'],
    ['EMAIL_CODE_KEY', readKey32(file('codeKey')), '32 bytes'],
    ['EMAIL_RL_KEY', readKey32(file('rlKey')), '32 bytes'],
  ];
  if (new Set(values.slice(1).map(([, v]) => v)).size !== 3) throw new Error('K_sub, K_code and K_rl must differ');
  if (existsSync(file('sendgridKey'))) {
    assertPrivate(file('sendgridKey'));
    const sg = readFileSync(file('sendgridKey'), 'utf8').trim();
    if (!SENDGRID_RE.test(sg)) throw new Error(`${shown('sendgridKey')} is not a SendGrid API key (SG.<id>.<secret>)`);
    values.push(['SENDGRID_API_KEY', sg, 'Mail Send key']);
  }
  deps.log(`Plan (env ${m.name}): set ${values.map(([n]) => n).join(', ')} on Worker ${t.cloudflare.workerName} from the files${active === activeKid ? ' (the standby stays offline)' : ''}.${existsSync(file('sendgridKey')) ? '' : ` No ${shown('sendgridKey')}: SENDGRID_API_KEY is not set.`}`);
  if (active !== activeKid) deps.log(`Plan (env ${m.name}): first set emailIssuer.signer.activeKid to the standby's kid ${active} in envs/${m.name}.json; then gen and deploy the issuer.`);
  if (!apply) return void deps.log(DRY_RUN_LINE);
  if (active !== activeKid) {
    writeText(m.name, replaceManifestBlock(readText(m.name), 'emailIssuer', { ...t, signer: { kind: 'worker-secret', activeKid: active } }));
    deps.log(`Set emailIssuer.signer.activeKid to ${active} in envs/${m.name}.json. Commit it, then gen and deploy the issuer (docs/operations.md "Email issuer", a suspected key leak).`);
  }
  for (const [name, value, what] of values) {
    deps.putSecret(m, name, value);
    deps.log(`Set ${name} (${what}) on Worker ${t.cloudflare.workerName}.`);
  }
}
