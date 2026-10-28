// Runs once per Playwright run, after the webServer is up: fails the run unless the stack listening on the fixed
// ports is this checkout's, built from the code as it is now (src/fingerprint.ts). Outside CI Playwright reuses a
// running stack, which may be another worktree's or this one's from before an edit.
import { stackFingerprint } from '../src/fingerprint.ts';
import { API_URL } from '../src/stack.ts';

export default async function globalSetup(): Promise<void> {
  const res = await fetch(`${API_URL}/__e2e/health`);
  const body = (await res.json().catch(() => null)) as { fingerprint?: unknown } | null;
  if (body?.fingerprint !== stackFingerprint()) {
    throw new Error(
      `The stack on ${API_URL} is not this checkout's current code (another worktree's, or started before an edit). ` +
        'Stop it (it is `node --import tsx src/server/main.ts`, or `pnpm serve`) and run again.',
    );
  }
}
