// The email issuer of the local stack (build plan batch 8a): apps/email-issuer's own Worker, run in Node like the API
// (api-modules.ts), on its own origin (ISSUER_URL, as on sandbox-dev, D230), with its real handlers, Durable Objects
// (Challenge, RateLimiter, Outbox on in-memory storage), its D1 migrations (node:sqlite), and as its `API` binding the
// API's real read-only IssuerRpc entrypoint (apps/api/src/rpc/issuer.ts, D432) on the stack's API D1.
// Mail goes to the `outbox` stub (`EMAIL_SENDER=outbox`, a `local*` env: the manifest and gen refuse it anywhere
// else); the tests read it through `GET /__e2e/outbox` (no CORS, refused with an Origin, so no page can read a code).
//
// Per stack: a throwaway RSA-2048 signing key (its kid the RFC 7638 thumbprint, as the manifest requires) and three
// random HMAC keys, never written anywhere. The mocked chain (chain.ts) lists the key as the active `email` key of
// signer `hana`, so the vault's on-chain check and the API's both pass.
//
// Every request gets a fresh client address from 198.18.0.0/15 (RFC 2544, benchmarking) as `cf-connecting-ip`: the
// issuer's per-IP and per-requester limits are its own tests' concern (apps/email-issuer), and every page in the suite
// is one client, so a fixed address would make the three browsers' runs fail each other's limits. The per-address
// limits still apply, which is why each test uses its own address.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AUTH_ORIGIN, E2E_ENV, EMAIL_ISS, ENV_NAME, NEAR_RPC, VAULT_ORIGIN } from '../stack.ts';
import { D1Shim } from './d1.ts';
import { type Handler, json } from './http.ts';
import { ExecContext, MemoryNamespace, registerCloudflareModule } from './workers.ts';

const ISSUER_SRC = new URL('../../../email-issuer/src/', import.meta.url);
/** apps/api's IssuerRpc, loaded at runtime like api-modules.ts (so this package's typecheck doesn't pull the Worker in). */
const ISSUER_RPC = new URL('../../../api/src/rpc/issuer.ts', import.meta.url);
const ISSUER_MIGRATIONS = fileURLToPath(new URL('../../../email-issuer/migrations/', import.meta.url));

interface IssuerModules {
  default: { fetch(request: Request, env: Record<string, unknown>, ctx: ExecContext): Promise<Response> };
  Challenge: new (state: unknown, env: unknown) => object;
  RateLimiter: new (state: unknown, env: unknown) => object;
  Outbox: new (state: unknown, env: unknown) => { list(): OutboxMessage[]; clear(): Promise<void> };
}

/** apps/api/src/rpc/issuer.ts: the entrypoint class (constructed with a context and the API's env, as workerd does). */
type IssuerRpcClass = new (ctx: unknown, env: { DB: D1Shim }) => object;

/** What the outbox stub keeps per mail (apps/email-issuer src/sender.ts MailMessage, plus its time). */
export interface OutboxMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
  atMs: number;
}

/** The issuer's public signing key, as the chain lists it (`get_issuer_keys("email")`). */
export interface EmailChainKey {
  kid: string;
  n: string;
  e: string;
}

/** A throwaway signing key for this stack: the private JWK (the Worker secret) and its public part. */
export function newIssuerKey(): { privateJwk: string; publicJwk: EmailChainKey & { kty: 'RSA'; use: 'sig'; alg: 'RS256' } } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const kid = createHash('sha256').update(`{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`).digest('base64url');
  return { privateJwk: JSON.stringify({ ...jwk, kty: 'RSA' }), publicJwk: { kty: 'RSA', n: jwk.n as string, e: jwk.e as string, kid, use: 'sig', alg: 'RS256' } };
}

const key32 = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

/** A client address from 198.18.0.0/15 (RFC 2544), new per request. */
function benchmarkIp(): string {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return `198.${18 + ((b[0] as number) & 1)}.${b[1]}.${b[2]}`;
}

export class LocalIssuer {
  private readonly env: Record<string, unknown>;
  private readonly exec = new ExecContext();
  private outbox: { list(): OutboxMessage[] } | null = null;

  private constructor(
    private readonly modules: IssuerModules,
    api: object,
    key: ReturnType<typeof newIssuerKey>,
  ) {
    const env: Record<string, unknown> = {
      DB: new D1Shim(ISSUER_MIGRATIONS),
      API: api,
      ENV_NAME,
      NEAR_RPC,
      SIGNER_ACCOUNT: E2E_ENV.signer,
      EMAIL_ISS,
      EMAIL_PUBLIC_KEYS: JSON.stringify([key.publicJwk]),
      EMAIL_ACTIVE_KID: key.publicJwk.kid,
      EMAIL_SIGNER_KIND: 'worker-secret',
      EMAIL_SENDER: 'outbox',
      MAIL_FROM: 'Hana E2E <login@e2e.invalid>',
      AUTH_ORIGIN,
      VAULT_ORIGIN,
      ISSUER_SIGNING_KEY: key.privateJwk,
      EMAIL_SUB_KEY: key32(),
      EMAIL_CODE_KEY: key32(),
      EMAIL_RL_KEY: key32(),
    };
    env.EMAIL_CHALLENGE = new MemoryNamespace(modules.Challenge, () => env);
    env.RATE_LIMITER = new MemoryNamespace(modules.RateLimiter, () => env);
    const outbox = new MemoryNamespace(modules.Outbox, () => env);
    env.OUTBOX = outbox;
    this.outbox = outbox.get(outbox.idFromName('outbox'));
    this.env = env;
  }

  static async start(appDb: D1Shim, key: ReturnType<typeof newIssuerKey>): Promise<LocalIssuer> {
    registerCloudflareModule();
    const modules = (await import(new URL('index.ts', ISSUER_SRC).href)) as IssuerModules;
    const { IssuerRpc } = (await import(ISSUER_RPC.href)) as { IssuerRpc: IssuerRpcClass };
    return new LocalIssuer(modules, new IssuerRpc(new ExecContext(), { DB: appDb }), key);
  }

  /** Every mail the outbox holds, oldest first. */
  messages(): OutboxMessage[] {
    return this.outbox?.list() ?? [];
  }

  /** The issuer's directory rows of `sub` (every provider): its identity rows and its app rows. */
  async directory(sub: string): Promise<{ identities: Record<string, unknown>[]; apps: Record<string, unknown>[] }> {
    const db = this.env.DB as D1Shim;
    const identities = await db.prepare('SELECT provider, sub, email, email_verified, hosted FROM user_emails WHERE sub = ?1 ORDER BY provider').bind(sub).all();
    const apps = await db.prepare('SELECT provider, sub, app_id, scope_id FROM user_email_apps WHERE sub = ?1 ORDER BY provider, app_id').bind(sub).all();
    return { identities: identities.results, apps: apps.results };
  }

  handler(): Handler {
    return async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__e2e/outbox') {
        // Tests only: no CORS, and a browser request (which always has an Origin on a cross-origin fetch) is refused.
        if (request.headers.get('origin') !== null) return json(403, { error: 'forbidden' });
        const to = url.searchParams.get('to');
        return json(200, this.messages().filter((m) => to === null || m.to === to));
      }
      if (url.pathname === '/__e2e/directory') {
        // The user directory (D269, migrations/0002) of one identity, as Hana staff would read it: tests only, no CORS,
        // refused with an Origin (so no page can read an address), and only for a named `sub`.
        if (request.headers.get('origin') !== null) return json(403, { error: 'forbidden' });
        const sub = url.searchParams.get('sub');
        if (!sub) return json(400, { error: 'sub_required' });
        return json(200, await this.directory(sub));
      }
      const headers = new Headers(request.headers);
      headers.set('cf-connecting-ip', benchmarkIp());
      const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer();
      }
      return this.modules.default.fetch(new Request(request.url, init), this.env, this.exec);
    };
  }
}
