import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_MANIFEST } from '../gen-wrangler.ts';
import { addKeyCommand, initSecrets, main, missingSecrets, readWatchdogSecrets, secretFile, secretProblems } from '../secrets.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hana-watchdog-secrets-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('initSecrets', () => {
  it('creates the watchdog key and the status token once, 0600, and keeps other values', () => {
    const root = tmp();
    const first = initSecrets(TEST_MANIFEST, root);
    expect(first.created).toEqual(['WATCHDOG_KEY', 'WATCHDOG_STATUS_TOKEN']);
    const file = secretFile('sandbox-test', root);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    expect(KeyPair.fromString(saved.WATCHDOG_KEY as `ed25519:${string}`).getPublicKey().toString()).toBe(first.publicKey);
    expect(saved.WATCHDOG_STATUS_TOKEN!.length).toBeGreaterThanOrEqual(32);
    writeFileSync(file, JSON.stringify({ ...saved, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' }), { mode: 0o600 });
    const second = initSecrets(TEST_MANIFEST, root);
    expect(second).toMatchObject({ created: [], publicKey: first.publicKey });
    expect(readWatchdogSecrets('sandbox-test', root)?.SLACK_WEBHOOK_URL).toBe('https://hooks.slack.com/services/T/B/x');
  });

  it('refuses a file other users can read', () => {
    const root = tmp();
    initSecrets(TEST_MANIFEST, root);
    chmodSync(secretFile('sandbox-test', root), 0o644);
    expect(() => readWatchdogSecrets('sandbox-test', root)).toThrow(/0600/u);
  });
});

describe('validation', () => {
  it('names bad keys and values, never the values', () => {
    const problems = secretProblems({ WATCHDOG_KEY: 'ed25519:short', SLACK_WEBHOOK_URL: 'http://evil.example/hook', OTHER: 'x' });
    expect(problems).toEqual(['WATCHDOG_KEY has an invalid value', 'SLACK_WEBHOOK_URL has an invalid value', 'OTHER is not a watchdog secret']);
    expect(problems.join(' ')).not.toContain('evil');
    expect(secretProblems([])).toEqual(['watchdog-secrets.json must be a JSON object']);
    // The email key is a SendGrid key (D401); the old Resend name is named as retired, its value never shown.
    expect(secretProblems({ SENDGRID_API_KEY: 'SG.fixture-not-real-key.fixture-secret-not-real-0123456789ab' })).toEqual([]);
    expect(secretProblems({ SENDGRID_API_KEY: 're_oldresendkey123' })).toEqual(['SENDGRID_API_KEY has an invalid value']);
    const retired = secretProblems({ RESEND_API_KEY: 're_oldresendkey123' });
    expect(retired).toEqual(['RESEND_API_KEY is no longer used: the watchdog emails through SendGrid (SENDGRID_API_KEY, D401)']);
    expect(retired.join(' ')).not.toContain('oldresendkey');
  });

  it('lists what the env still needs, by its paging app', () => {
    expect(missingSecrets(TEST_MANIFEST, {})).toEqual(['WATCHDOG_KEY', 'WATCHDOG_STATUS_TOKEN', 'SENDGRID_API_KEY', 'SLACK_WEBHOOK_URL', 'NTFY_TOPIC_URL', 'HEARTBEAT_URL']);
    const pushover = { ...TEST_MANIFEST, watchdog: { ...TEST_MANIFEST.watchdog!, pager: 'pushover' as const } };
    expect(missingSecrets(pushover, { WATCHDOG_KEY: 'x' })).toContain('PUSHOVER_USER');
  });
});

describe('addKeyCommand', () => {
  it('grants exactly the four watchdog methods on the signer, 1 NEAR allowance, testnet', () => {
    const cmd = addKeyCommand(TEST_MANIFEST, 'ed25519:PUB');
    expect(cmd).toContain('near account add-key watchdog.test.near grant-function-call-access');
    expect(cmd).toContain("--allowance '1 NEAR' --contract-account-id signer.test.near");
    expect(cmd).toContain("--function-names 'cancel_issuer_key_change, confirm_issuer_key_change, pause, delete_updater_key'");
    expect(cmd).toContain('use-manually-provided-public-key ed25519:PUB network-config testnet');
  });
});

describe('main', () => {
  it('prints the public key and the names, never a secret value', () => {
    const root = tmp();
    mkdirSync(join(root, '.secrets'), { recursive: true });
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    main(['sandbox-test', 'init'], { root, loadManifest: () => TEST_MANIFEST });
    const saved = readWatchdogSecrets('sandbox-test', root)!;
    const text = out.join('\n');
    expect(text).toContain('watchdog public key: ed25519:');
    expect(text).toContain('set: WATCHDOG_KEY, WATCHDOG_STATUS_TOKEN');
    expect(text).toContain('missing: SENDGRID_API_KEY');
    expect(text).not.toContain(saved.WATCHDOG_KEY!.slice(8));
    expect(text).not.toContain(saved.WATCHDOG_STATUS_TOKEN!);
  });
});
