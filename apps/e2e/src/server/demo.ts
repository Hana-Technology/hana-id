// The hosted demo on the stack: apps/demo's own Worker handler (worker/index.ts) over its e2e build, with the page CSP
// computed as scripts/gen-wrangler.ts computes it for a deploy, so the suite runs the page under its real headers.
import { pageCsp } from '../../../demo/src/csp.ts';
import { handleDemo } from '../../../demo/worker/index.ts';
import { DEMO_CONFIG, DEMO_DIR } from '../build.ts';
import { DEMO_ORIGIN } from '../stack.ts';
import { assetsFetcher } from './hosts.ts';
import type { Handler } from './http.ts';

export function demoHost(): Handler {
  const env = { DEMO_ORIGIN, CSP: pageCsp(DEMO_CONFIG), ASSETS: assetsFetcher(DEMO_DIR) };
  return (request) => handleDemo(request, env);
}
