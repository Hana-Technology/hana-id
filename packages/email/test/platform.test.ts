// The package must run in Cloudflare Workers and browsers: no Node API in src or its dependencies. Bundled for the
// browser platform (a Node built-in import fails the build) and run in a bare V8 context that has only the Web
// globals the code needs (Web Crypto, TextEncoder, btoa): no require, process, Buffer or node: modules.
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PKG, V, testKey } from './helpers.ts';

interface Bundle {
  normalizeEmail(input: string): { ok: boolean; email?: string };
  emailSub(key: Uint8Array, email: string): Promise<string>;
  isGoogleHosted(i: { email: string; hd?: string }): boolean;
  isDisposableDomain(d: string): boolean;
}

async function bundle(): Promise<{ code: string; inputs: string[] }> {
  const out = await build({
    entryPoints: [`${PKG}/src/index.ts`],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'hanaEmail',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return { code: out.outputFiles[0]!.text, inputs: Object.keys(out.metafile.inputs) };
}

describe('Workers and browser compatibility', () => {
  it('bundles for the browser with no Node built-in', async () => {
    const { inputs } = await bundle();
    expect(inputs.some((p) => p.includes('tr46'))).toBe(true);
    expect(inputs.some((p) => p.includes('punycode'))).toBe(true);
    expect(inputs.filter((p) => p.startsWith('node:') || /(^|\/)(fs|crypto|buffer|url|util)$/.test(p))).toEqual([]);
  });

  it('reproduces the frozen vectors in a context with Web globals only', async () => {
    const { code } = await bundle();
    const ctx = createContext({ crypto: globalThis.crypto, TextEncoder, btoa });
    runInContext(`${code};globalThis.hanaEmail = hanaEmail;`, ctx);
    expect(runInContext('typeof require + typeof process + typeof Buffer', ctx)).toBe('undefinedundefinedundefined');
    const m = (ctx as { hanaEmail: Bundle }).hanaEmail;
    for (const v of V.normalize) expect(m.normalizeEmail(v.in).email).toBe(v.out);
    for (const v of V.reject) expect(m.normalizeEmail(v.in).ok).toBe(false);
    // The key is made inside the context: its own Uint8Array, as a Worker would hold it.
    const key = runInContext(`new Uint8Array(${JSON.stringify([...testKey()])})`, ctx) as Uint8Array;
    for (const v of V.sub) expect(await m.emailSub(key, v.email)).toBe(v.sub);
    expect(m.isGoogleHosted({ email: 'ab@gmail.com' })).toBe(true);
    expect(m.isDisposableDomain('x.mailinator.com')).toBe(true);
  });
});
