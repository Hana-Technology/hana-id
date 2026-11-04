// The partner SPA's build under the console's CSP (docs/batch-c-spec.md "Response headers": `script-src 'self';
// style-src 'self'; connect-src 'self'`, no third-party script): the Vite build emits no inline script or style, no
// external URL and no data: script; and the SPA's sources keep to the rules that make that hold (no HTML injection, no
// browser storage, no fetch to another origin, nothing but types from console-core, so no server code is bundled; no
// inline style or script set from React either: the CSP has no 'unsafe-inline', and the sources don't lean on it).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appDir = new URL('../../', import.meta.url).pathname;
const webSrc = join(appDir, 'web', 'src');
let out: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'console-spa-'));
  await build({ configFile: join(appDir, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the SPA build', () => {
  it('index.html loads one module script and one stylesheet from /assets, nothing inline, nothing external', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).toMatch(/type="module"[^>]*src="\/assets\/[\w-]+\.js"/u);
    expect(scripts[0]![2]).toBe('');
    expect(html).not.toMatch(/<style\b|\sstyle=|\son\w+=/iu);
    expect(html).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[\w-]+\.css"/u);
    expect(html).not.toMatch(/https?:\/\//u);
  });

  it('every asset is a file under /assets; no source map, no data: script', () => {
    const files = readdirSync(join(out, 'assets'));
    expect(files.every((f) => /^[\w-]+\.(js|css)$/u.test(f))).toBe(true);
    for (const f of files) {
      const text = readFileSync(join(out, 'assets', f), 'utf8');
      expect(text, f).not.toMatch(/sourceMappingURL/u);
      expect(text, f).not.toMatch(/data:(text|application)\/javascript/u);
    }
  });

  it('bundles no server code (zod schemas, console-core layouts)', () => {
    const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(js).not.toMatch(/ZodError|hana-console\/login\/v1/u);
  });
});

describe('the SPA sources', () => {
  const sources = (readdirSync(webSrc, { recursive: true }) as string[]).filter((f) => /\.tsx?$/u.test(f)).map((f) => ({ f, text: readFileSync(join(webSrc, f), 'utf8') }));

  it('import only types from @hana-id/console-core', () => {
    for (const { f, text } of sources) {
      for (const m of text.matchAll(/^import ([^;]*) from '@hana-id\/console-core';/gmu)) expect(m[1], f).toMatch(/^type\b/u);
    }
  });

  it('set no inline style or script: no style prop, no <style> or <script> element, no javascript: URL (the report screens included)', () => {
    expect(sources.map((s) => s.f)).toEqual(expect.arrayContaining([expect.stringMatching(/Usage\.tsx$/u), expect.stringMatching(/Statements\.tsx$/u), expect.stringMatching(/Upgrades\.tsx$/u)]));
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/\sstyle=\{|<style\b|<script\b|javascript:|\.style\.|setAttribute\(\s*['"](style|on)/u);
    }
  });

  it('inject no HTML, keep nothing in browser storage, and call only their own origin', () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|eval\(|new Function/u);
      for (const m of text.matchAll(/fetch\(([^,)]+)/gu)) expect(m[1], f).toBe('path');
    }
  });
});
