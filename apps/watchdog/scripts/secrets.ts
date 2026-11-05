// The watchdog's Worker secrets in .secrets/<env>/watchdog-secrets.json (0600, gitignored): a flat {NAME: value}
// object, so `wrangler secret bulk` can upload it as is. Nothing here prints a secret value.
//
//   pnpm --filter @hana-id/watchdog secrets <env> init    create WATCHDOG_KEY and WATCHDOG_STATUS_TOKEN if absent;
//                                                         prints the public key and the near CLI command adding it
//   pnpm --filter @hana-id/watchdog secrets <env> check   which secrets are set (names only) and which are missing
//
// The other values (SendGrid key, Slack webhook, paging-app credentials, heartbeat URL) are pasted into the file by
// hand; `check` validates them.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from '@near-js/crypto';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { SENDGRID_KEY_RE } from '@hana-id/sendgrid';
import { readSecretJson, secretsDir, writeSecretJson } from '../../../scripts/lib/secrets.ts';

export const SECRET_FILE = 'watchdog-secrets.json';

/** Allowed names, and the check each value must pass. */
export const SECRET_RULES: Record<string, RegExp> = {
  WATCHDOG_KEY: /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/u,
  WATCHDOG_STATUS_TOKEN: /^[A-Za-z0-9_-]{32,256}$/u,
  SENDGRID_API_KEY: SENDGRID_KEY_RE,
  SLACK_WEBHOOK_URL: /^https:\/\/hooks\.slack\.com\/services\/\S+$/u,
  NTFY_TOPIC_URL: /^https:\/\/[^/\s]+\/[A-Za-z0-9_-]{16,64}$/u,
  NTFY_TOKEN: /^tk_[A-Za-z0-9]{8,200}$/u,
  PUSHOVER_TOKEN: /^[A-Za-z0-9]{30}$/u,
  PUSHOVER_USER: /^[A-Za-z0-9]{30}$/u,
  PAGERDUTY_ROUTING_KEY: /^[A-Za-z0-9]{32}$/u,
  HEARTBEAT_URL: /^https:\/\/\S+$/u,
};

/** Secrets each pager needs (D85). */
export const PAGER_SECRETS: Record<string, string[]> = {
  ntfy: ['NTFY_TOPIC_URL'],
  pushover: ['PUSHOVER_TOKEN', 'PUSHOVER_USER'],
  pagerduty: ['PAGERDUTY_ROUTING_KEY'],
};

export const secretFile = (envName: string, root: string = repoRoot): string => join(secretsDir(envName, root), SECRET_FILE);

/** Problems with a secrets object, naming keys only (never values). */
export function secretProblems(secrets: unknown): string[] {
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) return [`${SECRET_FILE} must be a JSON object`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(secrets)) {
    const rule = SECRET_RULES[k];
    if (k === 'RESEND_API_KEY') problems.push('RESEND_API_KEY is no longer used: the watchdog emails through SendGrid (SENDGRID_API_KEY, D401)');
    else if (!rule) problems.push(`${k} is not a watchdog secret`);
    else if (typeof v !== 'string' || !rule.test(v)) problems.push(`${k} has an invalid value`);
  }
  return problems;
}

/** Reads and validates the file (must be 0600); undefined when it doesn't exist. */
export function readWatchdogSecrets(envName: string, root: string = repoRoot): Record<string, string> | undefined {
  const file = secretFile(envName, root);
  const secrets = readSecretJson<unknown>(file);
  if (secrets === undefined) return undefined;
  const problems = secretProblems(secrets);
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return secrets as Record<string, string>;
}

/** Which secrets the env still needs (names only). */
export function missingSecrets(m: Manifest, secrets: Record<string, string>): string[] {
  const pager = m.watchdog ? (PAGER_SECRETS[m.watchdog.pager] ?? []) : [];
  return ['WATCHDOG_KEY', 'WATCHDOG_STATUS_TOKEN', 'SENDGRID_API_KEY', 'SLACK_WEBHOOK_URL', ...pager, 'HEARTBEAT_URL'].filter((k) => !secrets[k]);
}

/** The near CLI (near-cli-rs) command that installs the watchdog key with exactly the watchdog methods. */
export function addKeyCommand(m: Manifest, publicKey: string): string {
  if (!m.watchdog) throw new Error(`envs/${m.name}.json has no watchdog block`);
  return [
    `near account add-key ${m.watchdog.account} grant-function-call-access`,
    `--allowance '1 NEAR' --contract-account-id ${m.signer}`,
    `--function-names 'cancel_issuer_key_change, confirm_issuer_key_change, pause, delete_updater_key'`,
    `use-manually-provided-public-key ${publicKey} network-config ${m.network} sign-with-legacy-keychain send`,
  ].join(' \\\n  ');
}

/** Creates WATCHDOG_KEY and WATCHDOG_STATUS_TOKEN when absent; keeps every other value. Returns the public key. */
export function initSecrets(m: Manifest, root: string = repoRoot): { file: string; publicKey: string; created: string[] } {
  if (!m.watchdog) throw new Error(`envs/${m.name}.json has no watchdog block`);
  const file = secretFile(m.name, root);
  const secrets = readWatchdogSecrets(m.name, root) ?? {};
  const created: string[] = [];
  if (!secrets.WATCHDOG_KEY) {
    secrets.WATCHDOG_KEY = KeyPair.fromRandom('ed25519').toString();
    created.push('WATCHDOG_KEY');
  }
  if (!secrets.WATCHDOG_STATUS_TOKEN) {
    secrets.WATCHDOG_STATUS_TOKEN = randomBytes(32).toString('base64url');
    created.push('WATCHDOG_STATUS_TOKEN');
  }
  if (created.length) writeSecretJson(file, secrets);
  const publicKey = KeyPair.fromString(secrets.WATCHDOG_KEY as `ed25519:${string}`).getPublicKey().toString();
  return { file, publicKey, created };
}

export function main(argv: string[], opts: { root?: string; loadManifest?: (name: string) => Manifest } = {}): void {
  const [envName, command] = argv;
  if (!envName || (command !== 'init' && command !== 'check')) {
    console.error('usage: secrets <env> init|check');
    process.exit(2);
  }
  const m = (opts.loadManifest ?? loadEnv)(envName);
  if (!m.watchdog) throw new Error(`envs/${m.name}.json has no watchdog block`);
  if (command === 'init') {
    const { file, publicKey, created } = initSecrets(m, opts.root);
    console.log(`${file}: ${created.length ? `created ${created.join(', ')}` : 'nothing new'} (values not shown)`);
    console.log(`watchdog public key: ${publicKey}`);
    console.log(`install it on ${m.watchdog.account} (receiver ${m.signer}, the four watchdog methods only):\n  ${addKeyCommand(m, publicKey)}`);
  }
  const secrets = readWatchdogSecrets(m.name, opts.root) ?? {};
  console.log(`set: ${Object.keys(secrets).sort().join(', ') || '(none)'}`);
  const missing = missingSecrets(m, secrets);
  console.log(missing.length ? `missing: ${missing.join(', ')}` : 'missing: none');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
