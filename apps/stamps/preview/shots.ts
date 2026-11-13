// Screenshots of the UI preview (dev only): every fixture in light and dark, at 1280 and 390 px wide, plus the
// enlarged stamp sheet, with Chromium from the repo's Playwright. `corepack pnpm --filter @hana-id/stamps shots <dir>`
// (the directory is required: keep the images out of the repository). The clock is fixed at fixtures.ts's NOW, and
// reduced motion is on, so each image is the settled state; `--ink` also saves frames of the inked animation.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { FIXTURES, NOW } from './fixtures.ts';

const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!outArg) {
  console.error('usage: shots <output dir> [--ink] [--only <fixture>]');
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;

const server = await createServer({ configFile: new URL('./vite.config.ts', import.meta.url).pathname, server: { port: 5182 } });
await server.listen();
const base = 'http://127.0.0.1:5182/';
const browser = await chromium.launch();
try {
  const sizes = [
    { tag: 'desktop', width: 1280, height: 900 },
    { tag: 'phone', width: 390, height: 844 },
  ];
  for (const theme of ['light', 'dark'] as const) {
    for (const size of sizes) {
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.clock.setFixedTime(NOW);
      for (const f of FIXTURES) {
        if (only && f.name !== only) continue;
        await page.goto(`${base}?f=${f.name}&theme=${theme}&shot=1`);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(150);
        const file = join(out, `${f.name}-${theme}-${size.tag}.png`);
        await page.screenshot({ path: file, fullPage: true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        console.log(file, overflow > 0 ? `HORIZONTAL OVERFLOW ${overflow}px` : '');
      }
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${base}?sheet=1&theme=${theme}&shot=1`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const file = join(out, `sheet-${theme}.png`);
    await page.locator('.pv-sheet').screenshot({ path: file });
    console.log(file);
    await ctx.close();
  }
  if (process.argv.includes('--ink')) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto(`${base}?f=complete&theme=light`);
    await page.evaluate(() => document.fonts.ready);
    const slot = page.locator('[data-stamp="layover"] .pp-art');
    await page.click('#pv-ink');
    for (const ms of [0, 120, 260, 420, 700]) {
      await page.waitForTimeout(ms === 0 ? 0 : 130);
      await slot.screenshot({ path: join(out, `ink-${String(ms).padStart(3, '0')}.png`) });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
