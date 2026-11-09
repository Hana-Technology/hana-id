// Hana ID email issuer (docs/email-login-spec.md "Email issuer (Hana-run)"; apps/email-issuer/README.md): a Worker
// separate from the API that alone holds the email signing key, K_sub, K_code, K_rl and the user-mail key. It sends
// sign-in codes, mints JWS JSON email tokens whose nonces it computes per purpose, answers google-match (automatic
// linking), publishes its JWKS, and mints staff client proofs. It keeps the user directory (verified addresses, for
// Hana staff only, D269) in its own D1, which the admin console reads through `DirectoryRpc` (no route; bound only by the
// admin Worker, D275). It reads the chain; it writes nothing to it.
import { depsFromEnv } from './deps.ts';
import type { Env } from './env.ts';
import { route } from './handlers.ts';

export type { Env } from './env.ts';
export { Challenge } from './challenge.ts';
export { ConsoleIssuerRpc } from './console-rpc.ts';
export { DirectoryRpc } from './directory-rpc.ts';
export { Outbox } from './outbox.ts';
export { RateLimiter } from './rate-limiter.ts';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, depsFromEnv(env, (p) => ctx.waitUntil(p)));
  },
} satisfies ExportedHandler<Env>;
