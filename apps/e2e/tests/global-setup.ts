// Runs once per Playwright run, after the webServer is up: fails the run unless the stack listening on this run's
// ports is this checkout's, built from the code as it is now (src/fingerprint.ts). Outside CI Playwright reuses a
// running stack, which may be another worktree's or this one's from before an edit.
import { stackFingerprint } from '../src/fingerprint.ts';
import { API_URL, portBase } from '../src/stack.ts';

export default async function globalSetup(): Promise<void> {
  const body = await fetch(`${API_URL}/__e2e/health`)
    .then((res) => res.json() as Promise<{ fingerprint?: unknown } | null>)
    .catch(() => null);
  if (body?.fingerprint !== stackFingerprint()) {
    throw new Error(
      `The server on ${API_URL} is not this checkout's current e2e stack (another worktree's, an unrelated server, or ` +
        'this stack started before an edit). Stop it (the stack is `node --import tsx src/server/main.ts`, or `pnpm serve`), ' +
        `or run on other ports: HANA_E2E_PORT_BASE=<base> (now ${portBase()}; the stack uses base … base + 50).`,
    );
  }
}
