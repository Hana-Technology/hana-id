// Run with plain Node in the throwaway project `pnpm run pack:check` installs the four tarballs into: every published
// entry point imports as ESM (no bundler, no browser), the env table is the one the package was built with, and
// HanaProvider server-renders its initial state without touching `window`. scripts/pack-check.ts.
//
//   node run.mjs '<expected env names as JSON>' '<package.json "exports" keys per package as JSON>'
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const [expectedEnvs, subpaths] = process.argv.slice(2).map((a) => JSON.parse(a));

// Every subpath each package exports loads.
for (const [pkg, keys] of Object.entries(subpaths)) {
  for (const key of keys) {
    if (key === './package.json') continue;
    const specifier = key === '.' ? pkg : `${pkg}/${key.slice(2)}`;
    const mod = await import(specifier);
    assert.ok(Object.keys(mod).length > 0, `${specifier} exports nothing`);
  }
}

const web = await import('@hana-id/web');
const core = await import('@hana-id/core');
const react = await import('@hana-id/react');
const sodax = await import('@hana-id/sodax');
const swk = await import('@hana-id/web/stellar-wallets-kit');

// One version across the four, equal to each package.json.
for (const [name, mod] of [['core', core], ['web', web], ['react', react], ['sodax', sodax]]) {
  const { default: pkg } = await import(`@hana-id/${name}/package.json`, { with: { type: 'json' } });
  assert.equal(mod.VERSION, pkg.version, `@hana-id/${name} VERSION`);
}

// The environments built in, and createHana resolving one (it then refuses Node: no window).
assert.deepEqual([...web.HANA_ENVIRONMENTS], expectedEnvs);
assert.equal(typeof web.createHana, 'function');
for (const env of expectedEnvs) {
  assert.throws(() => web.createHana({ publishableKey: 'pk_test_x', environment: env }), /createHana runs in a browser page/);
}
assert.throws(() => web.createHana({ publishableKey: 'pk_test_x', environment: 'no-such-env' }), /Unknown Hana environment "no-such-env"/);
assert.equal(typeof swk.HanaIdModule, 'function');

// React: the hooks and the provider, server-rendered (the client is created in an effect, so no window is needed).
for (const name of ['HanaProvider', 'useHana', 'useWallet']) assert.equal(typeof react[name], 'function', name);
function Status() {
  const { status, addresses } = react.useHana();
  const { signer } = react.useWallet('stellar');
  return createElement('p', null, `${status}|${addresses === null}|${signer === null}`);
}
const html = renderToString(createElement(react.HanaProvider, { config: { publishableKey: 'pk_test_x', environment: expectedEnvs[0] } }, createElement(Status)));
assert.equal(html, '<p>unlocking|true|true</p>');

// Sodax adapters: functions over a client; the type-level check is types.ts.
assert.equal(typeof sodax.createSodaxEvmProvider, 'function');
assert.equal(typeof sodax.createSodaxStellarProvider, 'function');

// Core's Stellar signer subpath (@stellar/stellar-base, a CommonJS package) loads under Node's ESM loader.
const stellar = await import('@hana-id/core/signers/stellar');
assert.equal(typeof stellar.parseStellarEnvelope, 'function');

console.log(`smoke ok: ${Object.values(subpaths).flat().length} exports, envs ${expectedEnvs.join(', ')}`);
