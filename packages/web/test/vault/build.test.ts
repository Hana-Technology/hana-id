// The vault's per-env build (docs/batch-b-spec.md "Packages"): one self-contained `/vault.js` per env in the vault
// origin's own assets root, with that env's constants inlined and nothing loaded from anywhere else.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '@hana-id/env';
import { parseVaultBanner } from '@hana-id/env/build-id';
import { localBuild } from '@hana-id/env/local-build';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VAULT_SCRIPT, VAULT_ORIGIN_DIR, type BuiltVault, buildVault } from '../../scripts/build-vault.ts';
import { hanaEnv } from '../../scripts/gen-envs.ts';
import type { HanaEnv } from '../../src/hana-env.ts';

const sandbox = hanaEnv(loadEnv('sandbox-dev')) as HanaEnv;

describe('vault build', () => {
  let out: string;
  let built: BuiltVault;
  // A second env with its own signer, relayer and origins, to show each bundle carries only its env's constants.
  const prod: HanaEnv = {
    ...sandbox,
    name: 'prod-test',
    signer: 'hana-signer-prod.example',
    relayer: 'hana-relayer-prod.example',
    apiUrl: 'https://api.hana-prod.example',
    vaultOrigin: 'https://vault.hana-prod.example',
    authOrigin: 'https://auth.hana-login.example',
    devEnv: false,
  };
  let builtProd: BuiltVault;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'hana-vault-build-'));
    built = await buildVault(sandbox, out, '0485faa1c2d3');
    builtProd = await buildVault(prod, out, '0485faa1c2d3-dirty');
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('writes one module, <env>/vault/vault.js, the path the vault page loads (apps/api VAULT_SCRIPT_PATH)', () => {
    expect(VAULT_SCRIPT).toBe('vault.js');
    expect(built.dir).toBe(join(out, 'sandbox-dev', VAULT_ORIGIN_DIR));
    expect(built.script).toBe(join(built.dir, 'vault.js'));
    expect(builtProd.dir).toBe(join(out, 'prod-test', 'vault'));
    // Nothing else in the vault root (no chunks, no HTML: the page itself is rendered by the API Worker).
    expect(readdirSync(built.dir)).toEqual(['vault.js']);
    expect(readdirSync(join(out, 'sandbox-dev'))).toEqual(['vault']);
  });

  it('loads no other script: no static or dynamic import, no script URL, no Google script', () => {
    const src = readFileSync(built.script, 'utf8');
    expect(src).not.toMatch(/\}\s*from\s*"[^"]*\.m?js"|\bimport\s*\(\s*["'`]/u);
    expect(src).not.toMatch(/https?:\/\/[^"'`\s]*\.m?js\b/u);
    expect(src).not.toMatch(/accounts\.google\.com\/gsi/u);
  });

  it('D426, D765: loads no font: the launcher takes Journear’s ink with the system font, so vault.js stays one request', () => {
    const src = readFileSync(built.script, 'utf8');
    expect(src).not.toMatch(/woff2?|@font-face|FontFace|Montserrat|url\(/u);
    expect(src).toContain('#0b1f1e');
    expect(src).not.toContain('#16073a');
  });

  it('inlines each env’s own pinned constants', () => {
    const sandboxJs = readFileSync(built.script, 'utf8');
    const prodJs = readFileSync(builtProd.script, 'utf8');
    for (const v of [sandbox.signer, sandbox.relayer, sandbox.vaultOrigin, sandbox.authOrigin, sandbox.apiUrl, sandbox.ckdNetworkKey]) expect(sandboxJs).toContain(v);
    for (const v of [prod.signer, prod.relayer, prod.vaultOrigin, prod.authOrigin, prod.apiUrl]) expect(prodJs).toContain(v);
    expect(prodJs).not.toContain(sandbox.signer);
    expect(prodJs).not.toContain(sandbox.vaultOrigin);
    expect(sandboxJs).not.toContain(prod.signer);
    expect(sandboxJs).not.toContain('__HANA_ENV__');
    expect(prodJs).not.toContain('__HANA_ENV__');
  });

  it('D384: starts with the build id it was given (by default this checkout’s), which deploy-check reads', async () => {
    const js = readFileSync(built.script, 'utf8');
    expect(js.split('\n')[0]).toBe('/* hana-build 0485faa1c2d3 */');
    expect(parseVaultBanner(js)).toEqual({ id: '0485faa1c2d3', commit: '0485faa1c2d3', dirty: false });
    expect(parseVaultBanner(readFileSync(builtProd.script, 'utf8'))?.id).toBe('0485faa1c2d3-dirty');
    expect(built.buildId).toBe('0485faa1c2d3');
    const local = await buildVault(prod, out);
    expect(parseVaultBanner(readFileSync(local.script, 'utf8'))?.id).toBe(localBuild().id);
    // An id that isn't one never reaches the bundle (a JS comment), and deletes nothing.
    await expect(buildVault(prod, out, '0485faa1c2d3 */ x() /*')).rejects.toThrow(/build id/u);
    expect(existsSync(local.script)).toBe(true);
  }, 60_000);

  it('replaces only its own root on a rebuild: stale vault files go, the auth root stays', async () => {
    const authDir = join(out, 'sandbox-dev', 'auth');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'login.html'), '<!-- auth -->');
    writeFileSync(join(built.dir, 'stale.js'), '// stale');
    const again = await buildVault(sandbox, out);
    expect(readFileSync(join(authDir, 'login.html'), 'utf8')).toBe('<!-- auth -->');
    expect(existsSync(join(again.dir, 'stale.js'))).toBe(false);
    expect(readdirSync(again.dir)).toEqual(['vault.js']);
    rmSync(authDir, { recursive: true, force: true });
  }, 60_000);

  it('refuses an env name that is not a plain manifest name (it becomes a deleted path)', async () => {
    await expect(buildVault({ ...sandbox, name: '../x' }, out)).rejects.toThrow(/Invalid environment name/u);
  });

  it('fails for an env whose pinned CKD key is unusable, and writes nothing for it', async () => {
    await expect(buildVault({ ...sandbox, name: 'sandbox-bad', ckdNetworkKey: 'UNSET' }, out)).rejects.toThrow(/sandbox-bad\.json ckdNetworkKey/u);
    expect(existsSync(join(out, 'sandbox-bad'))).toBe(false);
  });
});
