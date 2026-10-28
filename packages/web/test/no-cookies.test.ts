// No Hana code sets a cookie (docs/security.md): no source of the pages (vault, auth pages, partner client) or of the
// API and page Workers writes `document.cookie`, uses the Cookie Store API or sets a `Set-Cookie` header. The runtime
// checks are apps/api/test/no-cookies.test.ts (every Worker response) and the Playwright suite (every response of every
// flow, and no cookie on a Hana origin afterwards).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOTS = ['packages/web/src', 'packages/core/src', 'apps/api/src'];
const SETS_COOKIE = /document\s*\.\s*cookie|\bcookieStore\b|\.(?:set|append)\(\s*['"`]set-cookie['"`]|['"`]set-cookie['"`]\s*:/iu;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs)$/u.test(name) ? [path] : [];
  });
}

describe('no cookies', () => {
  it('no source of the Hana pages, the client or the Workers sets one', () => {
    const files = ROOTS.flatMap((r) => sources(join(repo, r)));
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter((f) => SETS_COOKIE.test(readFileSync(f, 'utf8'))).map((f) => relative(repo, f));
    expect(hits).toEqual([]);
  });

  it('the pattern catches the ways a cookie gets set', () => {
    for (const s of ['document.cookie = "a=1"', "headers.set('Set-Cookie', x)", "h.append('set-cookie', v)", "{ 'set-cookie': 'sid=1' }", 'await cookieStore.set("a", "1")']) expect(SETS_COOKIE.test(s), s).toBe(true);
    for (const s of ["headers.delete('set-cookie')", "res.headers.has('set-cookie')"]) expect(SETS_COOKIE.test(s), s).toBe(false);
  });
});
