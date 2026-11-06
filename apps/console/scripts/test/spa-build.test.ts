// The partner SPA's build under the console's CSP (docs/batch-c-spec.md "Response headers": `script-src 'self';
// style-src 'self'; connect-src 'self'`, no third-party script): the Vite build emits no inline script or style, no
// external URL and no data: script; and the SPA's sources keep to the rules that make that hold (no HTML injection, no
// browser storage, no fetch to another origin, nothing but types from console-core, so no server code is bundled; no
// inline style or script set from React either: the CSP has no 'unsafe-inline', and the sources don't lean on it).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FONT_FILES } from '@hana-id/brand';
import { buildMeta, parseBuildMeta } from '@hana-id/env/build-id';
import { localBuild } from '@hana-id/env/local-build';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildStamp, stampIndexHtml } from '../build-stamp.ts';

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

  it('index.html carries this checkout’s build id, once (D406), for deploy-check', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(parseBuildMeta(html)?.id).toBe(localBuild().id);
    expect(html.match(/name="hana-build"/gu)).toHaveLength(1);
    // Only index.html: the content-hashed assets don't change with each commit.
    for (const f of readdirSync(join(out, 'assets'))) expect(readFileSync(join(out, 'assets', f), 'utf8'), f).not.toContain(localBuild().commit);
  });

  it('every asset is a file under /assets: scripts, styles, Hana’s fonts and their licence; no source map, no data: script', () => {
    const files = readdirSync(join(out, 'assets'));
    expect(files.filter((f) => !/^[\w-]+\.(js|css|woff2)$/u.test(f))).toEqual(['OFL.txt']);
    for (const f of files.filter((x) => /\.(js|css)$/u.test(x))) {
      const text = readFileSync(join(out, 'assets', f), 'utf8');
      expect(text, f).not.toMatch(/sourceMappingURL/u);
      expect(text, f).not.toMatch(/data:(text|application)\/javascript/u);
    }
  });

  it('ships Hana’s fonts (D426) as the brand package’s exact files, with the OFL beside them, loaded only from /assets', () => {
    const files = readdirSync(join(out, 'assets'));
    const fonts = files.filter((f) => f.endsWith('.woff2'));
    const known = new Map(FONT_FILES.map((f) => [f.sha256, f.file]));
    // Every face fonts.css declares, each byte-identical to packages/brand's file (no other font, no re-encoding).
    const shipped = fonts.map((f) => known.get(createHash('sha256').update(readFileSync(join(out, 'assets', f))).digest('hex')));
    expect(shipped.sort()).toEqual(FONT_FILES.map((f) => f.file).sort());
    for (const f of fonts) expect(f).toMatch(/^(?:Montserrat|MontserratAlternates)-[4-7]00-[\w-]+\.woff2$/u);
    expect(readFileSync(join(out, 'assets', 'OFL.txt'), 'utf8')).toBe(readFileSync(new URL('../../../../packages/brand/fonts/OFL.txt', import.meta.url), 'utf8'));
    // The stylesheet's only URLs are those fonts, same-origin under /assets: no data: URL, no other host.
    const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(css).toContain('@font-face');
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gu)].map((m) => m[1]!);
    expect(urls.length).toBe(FONT_FILES.length);
    for (const u of urls) expect(u, u).toMatch(/^(?:\/assets\/|\.\/)?[\w-]+\.woff2$/u);
    expect(css).not.toMatch(/@import|https?:\/\/|data:/u);
  });

  it('bundles no server code (zod schemas, console-core layouts)', () => {
    const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(js).not.toMatch(/ZodError|hana-console\/login\/v1/u);
  });

  it('builds nothing of the local preview harness (preview/: its plugin, scenarios or fake data)', () => {
    const all = readdirSync(join(out, 'assets')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n') + readFileSync(join(out, 'index.html'), 'utf8');
    expect(all).not.toMatch(/hana-console-preview-api|__preview|hana_preview|Sora Labs|lumenpay/u);
  });
});

describe('the build stamp (scripts/build-stamp.ts)', () => {
  const page = '<!doctype html>\n<html>\n  <head>\n    <title>x</title>\n  </head>\n  <body></body>\n</html>';

  it('puts the meta just before </head>, in the form deploy-check parses', () => {
    const stamped = stampIndexHtml(page, '0485faa1c2d3-dirty');
    expect(stamped).toContain(`${buildMeta('0485faa1c2d3-dirty')}\n  </head>`);
    expect(parseBuildMeta(stamped)).toEqual({ id: '0485faa1c2d3-dirty', commit: '0485faa1c2d3', dirty: true });
  });

  it('refuses a page without one </head>, a second stamp, and anything but a build id', () => {
    expect(() => stampIndexHtml('<html><body></body></html>', '0485faa1c2d3')).toThrow(/exactly one/u);
    expect(() => stampIndexHtml(`${page}</head>`, '0485faa1c2d3')).toThrow(/exactly one/u);
    expect(() => stampIndexHtml(stampIndexHtml(page, '0485faa1c2d3'), '0485faa1c2d3')).toThrow(/already/u);
    expect(() => stampIndexHtml(page, '"><script>')).toThrow(/Not a build id/u);
  });

  it('runs on builds only, reading the id once per build', () => {
    const build = vi.fn(() => ({ id: '0485faa1c2d3' }));
    const plugin = buildStamp(build);
    expect(plugin.apply).toBe('build');
    const hook = plugin.transformIndexHtml as { order: string; handler: (html: string) => string };
    expect(hook.order).toBe('post');
    expect(() => hook.handler(page)).toThrow(/no build id/u);
    (plugin.buildStart as () => void)();
    expect(parseBuildMeta(hook.handler(page))?.id).toBe('0485faa1c2d3');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('`deploy` builds the SPA, then deploys through the shared stamped wrapper', () => {
    const scripts = (JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.deploy).toBe('vite build && tsx ../../packages/env/src/stamped-deploy.ts');
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
