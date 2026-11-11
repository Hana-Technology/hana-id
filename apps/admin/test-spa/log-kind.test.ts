// The staff SPA's app-change titles (`LOG_KIND` in public/app.js, a copy: the SPA has no build step) say what the
// partner console and the feed digests say for the same code (`@hana-id/console-core` `ACTION_TITLES`, D704).
import { readFileSync } from 'node:fs';
import { ACTION_TITLES, APP_CHANGE_KINDS } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('LOG_KIND', () => {
  it('every title is the shared one for its code', () => {
    const block = /const LOG_KIND = \{([\s\S]*?)\n\};/u.exec(source)![1]!;
    const pairs = [...block.matchAll(/^\s*'([^']+)': '([^']+)',$/gmu)].map((m) => [m[1]!, m[2]!] as const);
    // Every line of the block was read (no entry in another shape slipped past).
    expect(pairs).toHaveLength(block.trim().split('\n').length);
    expect(pairs.length).toBeGreaterThan(10);
    for (const [code, title] of pairs) expect(title, code).toBe(ACTION_TITLES[code]);
    // The app-change kinds it names are ones the API writes, or the console's own rows it shows beside them.
    for (const [code] of pairs) expect((APP_CHANGE_KINDS as readonly string[]).includes(code) || ['app.suspended', 'app.resumed', 'change.proposed'].includes(code), code).toBe(true);
  });
});
