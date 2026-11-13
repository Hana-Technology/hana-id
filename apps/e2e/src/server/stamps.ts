// The stamps site on the stack: apps/stamps' own Worker handler (worker/index.ts) over its e2e build, with the page CSP
// computed as scripts/gen-wrangler.ts computes it for a deploy, so the suite runs the page under its real headers.
import { pageCsp } from '../../../stamps/src/csp.ts';
import { handleStamps } from '../../../stamps/worker/index.ts';
import { STAMPS_CONFIG, STAMPS_DIR } from '../build.ts';
import { STAMPS_ORIGIN } from '../stack.ts';
import { assetsFetcher } from './hosts.ts';
import type { Handler } from './http.ts';

export function stampsHost(): Handler {
  const env = { STAMPS_ORIGIN, CSP: pageCsp(STAMPS_CONFIG), ASSETS: assetsFetcher(STAMPS_DIR) };
  return (request) => handleStamps(request, env);
}
