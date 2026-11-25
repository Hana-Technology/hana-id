// The API's bound on the names GET /v1/app's `otherApps` carries (src/other-apps.ts, D912) equals @hana-id/core's
// OTHER_APPS_NAMES_MAX, which the windows' validator requires exactly. Compared as source: the worker code doesn't
// import core's root, and its modules don't load here (workerd types).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const bound = (path: string[]): number => {
  const m = /export const OTHER_APPS_NAMES_MAX = (\d+);/u.exec(readFileSync(join(import.meta.dirname, ...path), 'utf8'));
  if (!m) throw new Error(`no OTHER_APPS_NAMES_MAX in ${path.join('/')}`);
  return Number(m[1]);
};

describe('otherApps names bound', () => {
  it('is core’s OTHER_APPS_NAMES_MAX', () => {
    expect(bound(['..', '..', 'src', 'other-apps.ts'])).toBe(bound(['..', '..', '..', '..', 'packages', 'core', 'src', 'protocol.ts']));
  });
});
