// env-secrets.ts's body: every Worker secret an env's Workers need, where each comes from in .secrets/<env>/, and, with
// --yes, uploading them all again through wrangler's stdin. For moving an env to another Cloudflare account (D404,
// docs/operations.md "Moving an env to another Cloudflare account"): Cloudflare never gives a secret back, so the
// files are the only source, and a fresh Worker on the new account needs every one of them.
//
//   env-secrets <env> [--worker api|issuer|watchdog|console|admin|files] [--yes]
//
// Without --yes it only lists: each secret, its source file, and whether the file is there, private (0600) and
// well-formed. A missing file is listed, never invented: a key that only exists on the old Worker is gone, and its
// generator (deploy-contract, vault-kek, identity-key, email-issuer, usage-setup, watchdog secrets) is the way to
// make a new one, with what that changes (the runbook says which can be replaced and which never). Email sharing's
// IDENTITY_SEAL_KEY (API and issuer) and EMAIL_CONSENT_KEY (API) are optional: listed, and set when their files exist. With --yes it
// refuses while a required secret of the selected Workers is missing or malformed, then sets each one with
// `wrangler secret put <NAME> --name <worker>` from the Worker's app directory (its generated config names the
// account), the value on stdin. Nothing here prints a value.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMAIL_ISSUER_SECRET_FILES, IDENTITY_SECRET_FILES, type Manifest, accountIdFields, loadEnv, p256Thumbprint, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { SENDGRID_RE, isRsaPrivateJwk, publicEntry as rsaPublicEntry, readKey32 } from './email-issuer.ts';
import { readKeyFile as readP256KeyFile, readSealKeyFile, readSubKeyFile } from './identity-key.ts';
import { SECRET_FILES, assertPrivate, parseSecretJson, secretsDir } from './secrets.ts';
import { KEK_FILES, readKekFile } from './vault-kek.ts';
import { USER_ID_KEY_FILE } from './usage-setup.ts';

export const ENV_SECRETS_USAGE = `Usage: env-secrets.ts <env> [--worker api|issuer|watchdog|console|admin|files] [--yes]
  Lists every Worker secret the env's Workers need, its source file in .secrets/<env>/, and whether that file is
  present, 0600 and well-formed. A missing file is listed, never invented.
  --worker  only this Worker (default: every Worker the manifest has)
  --yes     upload them (wrangler secret put, the value on stdin) to each Worker on the account its generated config
            names; refused while a required secret of those Workers is missing or malformed

Run gen for each Worker first (its wrangler.jsonc carries the account). No value is ever printed. Testnet envs only.`;

export const DRY_RUN_LINE = 'Dry run: nothing uploaded. Re-run with --yes to upload.';

export const WORKER_IDS = ['api', 'issuer', 'watchdog', 'console', 'admin', 'files'] as const;
export type WorkerId = (typeof WORKER_IDS)[number];

export interface WorkerTarget {
  id: WorkerId;
  /** The deployed Worker's name (`--name`). */
  workerName: string;
  /** Its app directory, relative to the repo root (wrangler's cwd: its generated wrangler.jsonc names the account). */
  dir: string;
  /** The Cloudflare account the manifest names for it, if any. */
  accountId: string | undefined;
  /** Where that account id comes from in the manifest. */
  accountField: string;
}

export type SecretStatus = 'ok' | 'missing' | 'invalid';

export interface SecretItem {
  worker: WorkerId;
  name: string;
  /** The source, as shown: `.secrets/<env>/<file>` and the field, if any. */
  source: string;
  required: boolean;
  status: SecretStatus;
  /** Why it is missing or invalid, or a note (never a value). */
  note?: string;
  /** The value to upload (status ok only). Never printed. */
  value?: string;
}

/** One `wrangler` run: argv after `pnpm`, its cwd, and stdin. */
export type Spawn = (argv: string[], opts: { cwd: string; input: string }) => { status: number | null; error?: Error };

export interface EnvSecretsDeps {
  /** Runs `pnpm <argv>` in `cwd` with `input` on stdin; wrangler's output goes to the terminal (it never echoes a value). */
  spawn: Spawn;
  log: (line: string) => void;
  /** Directory holding .secrets/ and the app directories (default: the repo root). */
  root?: string;
  loadManifest?: (name: string) => Manifest;
  /** Where CLOUDFLARE_ACCOUNT_ID is read (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
}

export function defaultEnvSecretsDeps(): EnvSecretsDeps {
  return {
    spawn: (argv, opts) => {
      const res = spawnSync('pnpm', argv, { cwd: opts.cwd, input: opts.input, stdio: ['pipe', 'inherit', 'inherit'] });
      return { status: res.status, ...(res.error ? { error: res.error } : {}) };
    },
    log: (line) => console.log(line),
  };
}

/** `pnpm exec wrangler secret put <name> --name <worker>`, run from the Worker's app directory. */
export const secretPutArgv = (t: WorkerTarget, name: string): string[] => ['exec', 'wrangler', 'secret', 'put', name, '--name', t.workerName];

/** The env's Workers that hold secrets (or, for `files`, none), in deploy order. */
export function workerTargets(m: Manifest): WorkerTarget[] {
  const main = { accountId: m.cloudflare.accountId, accountField: 'cloudflare.accountId' };
  const out: WorkerTarget[] = [{ id: 'api', workerName: m.cloudflare.workerName, dir: 'apps/api', ...main }];
  if (m.emailIssuer) out.push({ id: 'issuer', workerName: m.emailIssuer.cloudflare.workerName, dir: 'apps/email-issuer', ...main });
  if (m.console) out.push({ id: 'console', workerName: m.console.workerName, dir: 'apps/console', ...main });
  if (m.admin) out.push({ id: 'admin', workerName: m.admin.workerName, dir: 'apps/admin', ...main });
  if (m.files) out.push({ id: 'files', workerName: m.files.workerName, dir: 'apps/files', ...main });
  if (m.watchdog) {
    const id = m.watchdog.cloudflare.accountId;
    out.push({ id: 'watchdog', workerName: m.watchdog.cloudflare.workerName, dir: 'apps/watchdog', accountId: id === 'UNSET' ? undefined : id, accountField: 'watchdog.cloudflare.accountId' });
  }
  return out;
}

const ED25519_SECRET_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/u;
const B64_32_RE = /^[A-Za-z0-9+/]{43}=$/u;

/** Reads one source; a thrown error becomes `invalid` with its message (which names the file, never its contents). */
function item(worker: WorkerId, name: string, source: string, required: boolean, file: string, read: () => string, note?: string): SecretItem {
  if (!existsSync(file)) return { worker, name, source, required, status: 'missing', ...(note ? { note } : {}) };
  try {
    return { worker, name, source, required, status: 'ok', value: read(), ...(note ? { note } : {}) };
  } catch (err) {
    return { worker, name, source, required, status: 'invalid', note: (err as Error).message };
  }
}

/** A JSON secret file (0600 checked; a parse error names the file only). */
function readJson(file: string): unknown {
  assertPrivate(file);
  return parseSecretJson<unknown>(readFileSync(file, 'utf8'), file);
}

function readPool(file: string): string {
  const keys = readJson(file);
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string' && ED25519_SECRET_RE.test(k))) {
    throw new Error(`${file} must be a non-empty JSON array of ed25519:<base58> secret keys`);
  }
  return JSON.stringify(keys);
}

function readText(file: string, re: RegExp, what: string): string {
  assertPrivate(file);
  const v = readFileSync(file, 'utf8').trim();
  if (!re.test(v) || (re === B64_32_RE && Buffer.from(v, 'base64').length !== 32)) throw new Error(`${file} is not ${what}`);
  return v;
}

/** Every secret of every selected Worker, with its status and (when readable) its value. */
export function secretInventory(m: Manifest, root: string = repoRoot, only?: WorkerId): SecretItem[] {
  const dir = secretsDir(m.name, root);
  const f = (name: string) => join(dir, name);
  const shown = (name: string, field?: string) => `.secrets/${m.name}/${name}${field ? ` (${field})` : ''}`;
  const out: SecretItem[] = [];
  const want = (w: WorkerId) => only === undefined || only === w;

  if (want('api')) {
    out.push(item('api', 'RELAYER_KEYS', shown(SECRET_FILES.relayerKeys), true, f(SECRET_FILES.relayerKeys), () => readPool(f(SECRET_FILES.relayerKeys))));
    out.push(item('api', 'OWNER_RELAYER_KEYS', shown(SECRET_FILES.ownerRelayerKeys), true, f(SECRET_FILES.ownerRelayerKeys), () => readPool(f(SECRET_FILES.ownerRelayerKeys))));
    out.push(
      item('api', 'KEYS_UPDATER_KEY', shown(SECRET_FILES.keysUpdater, 'private_key'), true, f(SECRET_FILES.keysUpdater), () => {
        const k = (readJson(f(SECRET_FILES.keysUpdater)) as { private_key?: unknown } | null)?.private_key;
        if (typeof k !== 'string' || !ED25519_SECRET_RE.test(k)) throw new Error(`${f(SECRET_FILES.keysUpdater)} has no ed25519 private_key`);
        return k;
      }),
    );
    const next = existsSync(f(KEK_FILES.next));
    const kek = item('api', 'VAULT_KEK', shown(KEK_FILES.current), true, f(KEK_FILES.current), () => readKekFile(f(KEK_FILES.current)).value);
    out.push(next ? { ...kek, status: 'invalid', note: `${shown(KEK_FILES.next)} exists: a rotation stopped part way (finish it with \`vault-kek ${m.name} rotate\` first)`, value: undefined } : kek);
    if (existsSync(f(KEK_FILES.previous))) {
      const prev = item('api', 'VAULT_KEK_PREVIOUS', shown(KEK_FILES.previous), true, f(KEK_FILES.previous), () => readKekFile(f(KEK_FILES.previous)).value, 'a rotation in progress');
      const ids = kek.status === 'ok' && prev.status === 'ok' ? [readKekFile(f(KEK_FILES.current)).id, readKekFile(f(KEK_FILES.previous)).id] : null;
      out.push(ids && ids[0] === ids[1] ? { ...prev, status: 'invalid', note: `the same key id as ${shown(KEK_FILES.current)}`, value: undefined } : prev);
    }
    const t = m.identityToken;
    if (t?.signer.kind === 'worker-secret') {
      const activeKid = t.signer.activeKid;
      // The slot the active key is in on the old Worker (identity-slots.json, D177), so the new Worker matches the file.
      let slot = 'IDENTITY_SIGNING_KEY';
      const slotsFile = f(IDENTITY_SECRET_FILES.slots);
      if (existsSync(slotsFile)) {
        const slots = readJson(slotsFile) as Record<string, unknown> | null;
        if (slots?.IDENTITY_SIGNING_KEY_STANDBY === activeKid) slot = 'IDENTITY_SIGNING_KEY_STANDBY';
      }
      out.push(
        item('api', slot, shown(IDENTITY_SECRET_FILES.signingKey), true, f(IDENTITY_SECRET_FILES.signingKey), () => {
          const key = readP256KeyFile(f(IDENTITY_SECRET_FILES.signingKey));
          if (p256Thumbprint(key) !== activeKid) throw new Error(`${shown(IDENTITY_SECRET_FILES.signingKey)} doesn't have the manifest's active kid ${activeKid}`);
          return JSON.stringify(key);
        }, `active kid ${activeKid}; the standby stays offline (D177)`),
      );
    }
    if (t) out.push(item('api', 'IDENTITY_SUB_KEY', shown(IDENTITY_SECRET_FILES.subKey), true, f(IDENTITY_SECRET_FILES.subKey), () => readSubKeyFile(f(IDENTITY_SECRET_FILES.subKey))));
    if (t?.signer.kind === 'aws-kms') {
      for (const name of ['IDENTITY_AWS_ACCESS_KEY_ID', 'IDENTITY_AWS_SECRET_ACCESS_KEY']) {
        out.push({ worker: 'api', name, source: 'not kept on disk', required: true, status: 'missing', note: `create a new access key for the signer's IAM user and run \`identity-key ${m.name} kms-put-aws-key --yes\`` });
      }
    }
    // Email sharing's keys (D419, D420; `identity-key <env> email-keys`): optional, set when their files exist.
    out.push(item('api', 'IDENTITY_SEAL_KEY', shown(IDENTITY_SECRET_FILES.sealKey), false, f(IDENTITY_SECRET_FILES.sealKey), () => readSealKeyFile(f(IDENTITY_SECRET_FILES.sealKey)), "email sharing: the issuer's copy is the same value"));
    out.push(item('api', 'EMAIL_CONSENT_KEY', shown(IDENTITY_SECRET_FILES.emailConsentKey), false, f(IDENTITY_SECRET_FILES.emailConsentKey), () => readSubKeyFile(f(IDENTITY_SECRET_FILES.emailConsentKey)), 'email sharing: keep it, a new key forgets every consent'));
    out.push(item('api', 'USER_ID_KEY', shown(USER_ID_KEY_FILE), m.usage !== undefined, f(USER_ID_KEY_FILE), () => readText(f(USER_ID_KEY_FILE), B64_32_RE, 'base64 of 32 bytes'), 'never replaced: a new key makes every user a new user'));
  }

  const t = m.emailIssuer;
  if (t && want('issuer')) {
    const F = EMAIL_ISSUER_SECRET_FILES;
    const activeKid = t.signer.kind === 'worker-secret' ? t.signer.activeKid : undefined;
    // The key file with the active kid: the primary, or the standby after a switch (`email-issuer put --standby`).
    const candidates = [F.signingKey, F.standbyKey].filter((n) => existsSync(f(n)));
    const file = candidates.find((n) => {
      try {
        assertPrivate(f(n));
        const v = parseSecretJson<unknown>(readFileSync(f(n), 'utf8'), f(n));
        return isRsaPrivateJwk(v) && rsaPublicEntry(v).kid === activeKid;
      } catch {
        return false;
      }
    });
    if (activeKid === undefined) {
      out.push({ worker: 'issuer', name: 'ISSUER_SIGNING_KEY', source: 'AWS KMS', required: false, status: 'missing', note: 'a KMS signer has no key on the Worker' });
    } else {
      const src = file ?? F.signingKey;
      out.push(
        item('issuer', 'ISSUER_SIGNING_KEY', shown(src), true, f(src), () => {
          if (!file) throw new Error(`no key file in .secrets/${m.name}/ has the manifest's active kid ${activeKid}`);
          return JSON.stringify(parseSecretJson<unknown>(readFileSync(f(file), 'utf8'), f(file)));
        }, `active kid ${activeKid}`),
      );
    }
    const hmac = [
      ['EMAIL_SUB_KEY', F.subKey, 'K_sub: never replaced (a new one moves every email address)'],
      ['EMAIL_CODE_KEY', F.codeKey, undefined],
      ['EMAIL_RL_KEY', F.rlKey, undefined],
    ] as const;
    const hmacItems = hmac.map(([name, file, note]) => item('issuer', name, shown(file), true, f(file), () => readKey32(f(file)), note));
    const values = hmacItems.filter((i) => i.status === 'ok').map((i) => i.value);
    if (values.length === 3 && new Set(values).size !== 3) for (const i of hmacItems) Object.assign(i, { status: 'invalid', note: 'K_sub, K_code and K_rl must differ', value: undefined });
    out.push(...hmacItems);
    out.push(item('issuer', 'IDENTITY_SEAL_KEY', shown(IDENTITY_SECRET_FILES.sealKey), false, f(IDENTITY_SECRET_FILES.sealKey), () => readSealKeyFile(f(IDENTITY_SECRET_FILES.sealKey)), "email sharing (D419): the API's same value"));
    out.push(item('issuer', 'SENDGRID_API_KEY', shown(F.sendgridKey), t.sender === 'sendgrid', f(F.sendgridKey), () => readText(f(F.sendgridKey), SENDGRID_RE, 'a SendGrid API key (SG.<id>.<secret>)'), 'Mail Send only (D194)'));
  }

  // The watchdog's secrets file (flat {NAME: value}); the admin Worker's WATCHDOG_STATUS_TOKEN is its copy.
  const watchdogFile = f('watchdog-secrets.json');
  const watchdogSecrets = (): Record<string, unknown> => {
    const v = readJson(watchdogFile);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${watchdogFile} must be a JSON object`);
    return v as Record<string, unknown>;
  };
  const field = (name: string, re: RegExp) => () => {
    const v = watchdogSecrets()[name];
    if (typeof v !== 'string' || !re.test(v)) throw new Error(`${shown('watchdog-secrets.json')} has no valid ${name}`);
    return v;
  };

  if (m.watchdog && want('watchdog')) {
    const pager = { ntfy: ['NTFY_TOPIC_URL'], pushover: ['PUSHOVER_TOKEN', 'PUSHOVER_USER'], pagerduty: ['PAGERDUTY_ROUTING_KEY'] }[m.watchdog.pager];
    const rules: [string, RegExp, boolean][] = [
      ['WATCHDOG_KEY', /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/u, true],
      ['WATCHDOG_STATUS_TOKEN', /^[A-Za-z0-9_-]{32,256}$/u, true],
      ['SENDGRID_API_KEY', SENDGRID_RE, true],
      ['SLACK_WEBHOOK_URL', /^https:\/\/hooks\.slack\.com\/services\/\S+$/u, true],
      ...pager.map((n): [string, RegExp, boolean] => [n, /^\S+$/u, true]),
      ['HEARTBEAT_URL', /^https:\/\/\S+$/u, true],
      ['NTFY_TOKEN', /^tk_[A-Za-z0-9]{8,200}$/u, false],
    ];
    for (const [name, re, required] of rules) {
      const base = item('watchdog', name, shown('watchdog-secrets.json', name), required, watchdogFile, field(name, re));
      // An optional field absent from a valid file is just not set.
      const absent = base.status === 'invalid' && existsSync(watchdogFile) && (() => {
        try {
          return watchdogSecrets()[name] === undefined;
        } catch {
          return false;
        }
      })();
      out.push(absent ? { ...base, status: 'missing', note: undefined } : base);
    }
  }

  if (m.console && want('console')) {
    const file = 'console-google-client.json';
    out.push(
      item('console', 'CONSOLE_GOOGLE_CLIENT_SECRET', shown(file, 'web.client_secret'), true, f(file), () => {
        const v = (readJson(f(file)) as { web?: { client_secret?: unknown } } | null)?.web?.client_secret;
        if (typeof v !== 'string' || !/^\S{8,200}$/u.test(v)) throw new Error(`${shown(file)} has no web.client_secret`);
        return v;
      }),
    );
  }

  if (m.admin && want('admin')) {
    out.push(item('admin', 'EMAIL_API_KEY', shown('admin-sendgrid-key'), true, f('admin-sendgrid-key'), () => readText(f('admin-sendgrid-key'), SENDGRID_RE, 'a SendGrid API key (SG.<id>.<secret>)'), 'SendGrid, Mail Send only, never the issuer\'s subuser (D401)'));
    out.push(item('admin', 'CANCEL_LINK_KEY', shown('cancel-link-key'), true, f('cancel-link-key'), () => readText(f('cancel-link-key'), B64_32_RE, 'base64 of 32 bytes'), 'keep it: a new key breaks the cancel links already emailed'));
    out.push(item('admin', 'INVITE_LINK_KEY', shown('invite-link-key'), true, f('invite-link-key'), () => readText(f('invite-link-key'), B64_32_RE, 'base64 of 32 bytes'), 'keep it: a new key breaks the invite links already emailed'));
    if (m.watchdog?.url) {
      out.push(item('admin', 'WATCHDOG_STATUS_TOKEN', shown('watchdog-secrets.json', 'WATCHDOG_STATUS_TOKEN'), true, watchdogFile, field('WATCHDOG_STATUS_TOKEN', /^[A-Za-z0-9_-]{32,256}$/u), "the watchdog's copy (D330)"));
    }
    out.push(item('admin', 'COINGECKO_API_KEY', shown('coingecko-api-key'), false, f('coingecko-api-key'), () => readText(f('coingecko-api-key'), /^[A-Za-z0-9_-]{8,200}$/u, 'a CoinGecko API key')));
  }
  return out;
}

/**
 * Why a Worker's generated config can't be the upload target, or null: it is missing, names another Worker, or pins
 * another account than the manifest (generated before the manifest's move commit).
 */
export function configProblem(t: WorkerTarget, root: string): string | null {
  const path = join(root, t.dir, 'wrangler.jsonc');
  if (!existsSync(path)) return `no ${t.dir}/wrangler.jsonc: run its gen first (it names the account the secrets go to)`;
  let config: { name?: unknown; account_id?: unknown };
  try {
    config = JSON.parse(readFileSync(path, 'utf8').replace(/^\/\/.*\n/u, '')) as typeof config;
  } catch {
    return `${t.dir}/wrangler.jsonc doesn't parse: run its gen again`;
  }
  if (config.name !== t.workerName) return `${t.dir}/wrangler.jsonc is for Worker ${String(config.name)}, not ${t.workerName}: run its gen for this env`;
  if (t.accountId !== undefined && config.account_id !== t.accountId) return `${t.dir}/wrangler.jsonc deploys to ${String(config.account_id ?? "wrangler's default account")}, not ${t.accountField} ${t.accountId}: run its gen again`;
  return null;
}

/** Runs `env-secrets <argv>`. */
export function envSecrets(argv: readonly string[], deps: EnvSecretsDeps): void {
  const args = parseCli(argv, { strings: ['worker'], booleans: ['yes', 'help'] });
  if (args.flag('help')) return void deps.log(ENV_SECRETS_USAGE);
  const [envName, ...rest] = args.positionals;
  if (!envName) throw new CliError('Expected <env>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  const only = args.str('worker');
  if (only !== undefined && !(WORKER_IDS as readonly string[]).includes(only)) throw new CliError(`--worker must be one of ${WORKER_IDS.join(', ')}`);
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env`);
  const root = deps.root ?? repoRoot;
  const env = deps.env ?? process.env;
  const targets = workerTargets(m).filter((t) => only === undefined || t.id === only);
  if (only !== undefined && targets.length === 0) throw new Error(`envs/${m.name}.json has no ${only} Worker`);
  const items = secretInventory(m, root, only as WorkerId | undefined);

  for (const t of targets) {
    const mine = items.filter((i) => i.worker === t.id);
    deps.log(`Worker ${t.workerName} (${t.dir}; account ${t.accountId ?? "wrangler's (CLOUDFLARE_ACCOUNT_ID or the login's)"}):`);
    if (t.id === 'files') deps.log('  no secrets');
    for (const i of mine) {
      const state = i.status === 'ok' ? 'ok' : i.status === 'missing' ? (i.required ? 'MISSING' : 'not set (optional)') : 'INVALID';
      deps.log(`  ${i.name} <- ${i.source}: ${state}${i.note ? ` (${i.note})` : ''}`);
    }
  }
  deps.log('Never uploaded: the offline standby signing keys (IDENTITY_SIGNING_KEY_STANDBY stays empty, email-issuer-signing-key-standby.json stays offline). The page Workers and console-auth have no secrets.');
  const blockers = items.filter((i) => i.required && i.status !== 'ok');
  if (blockers.length) deps.log(`${blockers.length} required secret(s) missing or invalid: ${blockers.map((i) => `${i.worker} ${i.name}`).join(', ')}.`);
  if (!args.flag('yes')) return void deps.log(DRY_RUN_LINE);

  if (blockers.length) throw new Error('Refusing to upload while a required secret is missing or invalid (listed above): restore the file, or make a new secret with its own command (docs/operations.md "Moving an env to another Cloudflare account").');
  const problems = targets.map((t) => configProblem(t, root)).filter((p): p is string => p !== null);
  for (const t of targets) accountIdFields(t.accountId, t.accountField, env);
  if (problems.length) throw new Error(problems.join('; '));
  for (const t of targets) {
    for (const i of items.filter((x) => x.worker === t.id && x.status === 'ok')) {
      const res = deps.spawn(secretPutArgv(t, i.name), { cwd: join(root, t.dir), input: i.value! });
      if (res.error) throw new Error(`wrangler secret put ${i.name} on ${t.workerName} failed: ${res.error.message}`);
      if (res.status !== 0) throw new Error(`wrangler secret put ${i.name} on ${t.workerName} failed (exit ${res.status})`);
      deps.log(`Set ${i.name} on Worker ${t.workerName}.`);
    }
  }
}
