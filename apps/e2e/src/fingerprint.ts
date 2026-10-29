// Which checkout, and which code in it, a running stack serves. The ports are fixed for a run (stack.ts:
// HANA_E2E_PORT_BASE, 4410 by default) and Playwright reuses a stack that is already listening outside CI, so a stack
// started from another worktree on the same ports, or from this one before an edit, would otherwise be tested in this
// run's place. The stack reports the fingerprint it computed at startup on
// GET /__e2e/health; tests/global-setup.ts compares it with the checkout's own and fails the run on a mismatch.
//
// It hashes this package's absolute path and every file the stack builds or runs from source: the e2e stack and
// partner app, @hana-id/web and @hana-id/core (the bundles), apps/api's Worker and migrations, and the demo (its page,
// sources and Worker).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portBase } from './stack.ts';

const E2E_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Source trees the stack is made from, relative to the repo root. */
export const FINGERPRINT_DIRS: readonly string[] = [
  'apps/e2e/src',
  'apps/e2e/partner',
  'packages/web/src',
  'packages/web/scripts',
  'packages/core/src',
  'apps/api/src',
  'apps/api/migrations',
  'apps/demo/src',
  'apps/demo/worker',
  'apps/demo/public',
  'apps/demo/index.html',
];

/** The files under `dir` (or `dir` itself when it is a file), sorted. */
function files(dir: string): string[] {
  let names: string[];
  try {
    if (statSync(dir).isFile()) return [dir];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** sha256 (hex) over the e2e package's path, the port base the bundles are built for, and each source file. */
export function stackFingerprint(): string {
  const h = createHash('sha256').update(`hana-id/e2e-stack/v1\0${E2E_ROOT}\0${portBase()}\0`);
  for (const dir of FINGERPRINT_DIRS) {
    for (const file of files(join(REPO_ROOT, dir))) {
      h.update(`${relative(REPO_ROOT, file)}\0`);
      h.update(readFileSync(file));
      h.update('\0');
    }
  }
  return h.digest('hex');
}
