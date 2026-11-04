// Workers' fetch throws "Illegal invocation" when it is called as another object's method, so a class field that holds
// the global `fetch` itself (`private readonly fetcher: typeof fetch = fetch`, called as `this.fetcher(...)`) fails
// every call in production while tests that inject a fetcher pass. This happened on sandbox-dev: every chain read of
// the issuer answered `near_unavailable`. Stored fetchers default to `globalFetch` (src/http.ts) instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKER_SOURCES = ['apps/email-issuer/src', 'apps/api/src', 'apps/watchdog/src', 'apps/console/src'];
/** `= fetch` as a stored default, or `fetch` handed to a constructor or factory to keep. */
const UNBOUND = /(?:typeof fetch\s*=\s*fetch\b|fetcher\s*[:=]\s*fetch\b(?!\s*\())/u;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('stored fetchers are bound', () => {
  it('no Worker source stores the global fetch as a field or default', () => {
    const offenders: string[] = [];
    for (const root of WORKER_SOURCES) {
      let list: string[];
      try {
        list = files(join(REPO, root));
      } catch {
        continue;
      }
      for (const f of list) {
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (UNBOUND.test(line)) offenders.push(`${f.slice(REPO.length)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('globalFetch keeps working when called as a method of another object', async () => {
    const { globalFetch } = await import('../../src/http.ts');
    const calls: unknown[] = [];
    const real = globalThis.fetch;
    // A fetch that, like workerd's, refuses a foreign `this`.
    globalThis.fetch = function (this: unknown, ...args: unknown[]) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(args[0]);
      return Promise.resolve(new Response('ok'));
    } as typeof fetch;
    try {
      const holder = { fetcher: globalFetch };
      await holder.fetcher('https://example.test/');
      const raw = { fetcher: globalThis.fetch };
      expect(() => raw.fetcher('https://example.test/')).toThrow(/Illegal invocation/u);
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toEqual(['https://example.test/']);
  });
});
