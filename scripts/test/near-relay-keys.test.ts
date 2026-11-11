// near-relay-keys (D734): generates the NEAR relay's keys once into .secrets/<env>/ (0600), prints public keys and the
// user's commands only, and refuses an env without near.relay.
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';
import { loadEnv, type Manifest } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { nearRelayKeys } from '../lib/near-relay-keys.ts';

const sandbox = loadEnv('sandbox-dev');

describe('near-relay-keys', () => {
  it('writes the keys once (0600), prints only public keys and the add-key and upload commands, keeps them on a rerun', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hana-near-relay-'));
    const lines: string[] = [];
    const pks = await nearRelayKeys(['sandbox-dev', '--count', '3'], { root, log: (l) => lines.push(l) });
    const file = join(root, '.secrets', 'sandbox-dev', 'near-relay-keys.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const secrets = JSON.parse(readFileSync(file, 'utf8')) as string[];
    expect(secrets.map((s) => KeyPair.fromString(s as `ed25519:${string}`).getPublicKey().toString())).toEqual(pks);
    const out = lines.join('\n');
    for (const s of secrets) expect(out).not.toContain(s.slice('ed25519:'.length));
    expect(lines.filter((l) => l.includes(`near account add-key ${sandbox.near!.relay!.account} grant-full-access`)).length).toBe(3);
    expect(out).toContain('wrangler secret put NEAR_RELAY_KEYS');
    expect(await nearRelayKeys(['sandbox-dev'], { root, log: () => undefined })).toEqual(pks);
  });

  it('refuses an env without near.relay, and bad arguments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hana-near-relay-'));
    const { near: _, ...noNear } = sandbox;
    await expect(nearRelayKeys(['sandbox-dev'], { root, loadManifest: () => noNear as Manifest, log: () => undefined })).rejects.toThrow(/no near.relay/u);
    await expect(nearRelayKeys([], { root })).rejects.toThrow(/<env>/u);
    await expect(nearRelayKeys(['sandbox-dev', '--count', '9'], { root })).rejects.toThrow(/between/u);
  });
});
