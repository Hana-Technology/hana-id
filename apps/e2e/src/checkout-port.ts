// The stack's default port base per checkout (Node only: stack.ts stays importable by the browser bundles). The main
// checkout keeps 4410; a linked git worktree (its `.git` is a file) gets a base of its own, picked by a hash of its
// path, so two worktrees running the suite (or `pnpm verify`) at the same time don't meet on one stack's ports.
// HANA_E2E_PORT_BASE still wins. `port-env.ts` applies it before stack.ts reads the environment.
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_BLOCKED_PORTS, DEFAULT_PORT_BASE, portsFrom } from './ports.ts';

/** This checkout's root (apps/e2e/src → the repo). */
export const CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The bases a linked worktree can get: 4510, 4610, … below 49152 (macOS's and the IANA ephemeral range, where the
 * near-sandbox nodes and other servers get their OS-assigned ports), never one with a port browsers refuse.
 */
export const WORKTREE_PORT_BASES: readonly number[] = Object.freeze(
  Array.from({ length: 446 }, (_, k) => DEFAULT_PORT_BASE + 100 * (k + 1)).filter((b) => b + 50 < 49_152 && !Object.values(portsFrom(b)).some((p) => BROWSER_BLOCKED_PORTS.has(p))),
);

/** Whether `root` is a linked worktree (git writes a `.git` file there, a directory in the main checkout). */
export function isLinkedWorktree(root: string): boolean {
  try {
    return statSync(join(root, '.git')).isFile();
  } catch {
    return false;
  }
}

/** The default port base of the checkout at `root`: 4410 for the main checkout, a hashed one for a linked worktree. */
export function checkoutPortBase(root: string = CHECKOUT_ROOT, linked: boolean = isLinkedWorktree(root)): number {
  if (!linked) return DEFAULT_PORT_BASE;
  let path = root;
  try {
    path = realpathSync(root);
  } catch {
    // a path that doesn't exist (tests) hashes as given
  }
  const h = createHash('sha256').update(path.replace(/\/+$/u, '')).digest().readUInt32BE(0);
  return WORKTREE_PORT_BASES[h % WORKTREE_PORT_BASES.length]!;
}
