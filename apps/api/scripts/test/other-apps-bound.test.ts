// The API's bound on the names GET /v1/app's `otherApps` carries (src/other-apps.ts, D912) equals @hana-id/core's
// OTHER_APPS_NAMES_MAX, which the windows' validator requires exactly (the worker code doesn't import core's root, so
// the two are compared as source here).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OTHER_APPS_NAMES_MAX } from '../../src/other-apps.ts';

const core = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'core', 'src', 'protocol.ts'), 'utf8');

describe('otherApps names bound', () => {
  it('is core’s OTHER_APPS_NAMES_MAX', () => {
    const m = /export const OTHER_APPS_NAMES_MAX = (\d+);/u.exec(core);
    expect(m).not.toBeNull();
    expect(OTHER_APPS_NAMES_MAX).toBe(Number(m![1]));
  });
});
