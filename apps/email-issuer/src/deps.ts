import { globalFetch } from './http.ts';
// What a request needs, built once per isolate from the bindings (keys, signer, chain and Google clients cached while
// the bindings don't change). Tests build their own (fake chain, Google, sender and fetch).
import { AccessVerifier, accessConfig } from './access.ts';
import { type Chain, NearChain } from './chain.ts';
import type { Env } from './env.ts';
import { Google } from './google.ts';
import type { SealKey } from '@hana-id/email';
import { type IssuerKeys, importKeys, importSealKey } from './keys.ts';
import { OutboxSender } from './outbox.ts';
import type { EmailSender } from './sender.ts';
import { SendGridSender } from './sendgrid.ts';
import { type IssuerSigner, type PublicJwk, SignerUnavailable, WorkerSecretSigner, parsePublicKeys } from './signer.ts';

export interface Deps {
  env: Env;
  now: () => number;
  chain: Chain;
  google: Google;
  sender: EmailSender;
  /** The signers of one token, in order (one `hana` signer at 1-of-1). */
  signers: () => Promise<IssuerSigner[]>;
  publicKeys: () => Promise<PublicJwk[]>;
  keys: () => Promise<IssuerKeys>;
  /** IDENTITY_SEAL_KEY (D419), or null when the env has none (or a malformed one): then no answer carries `sealedEmail`. */
  sealKey: () => Promise<SealKey | null>;
  access: AccessVerifier | null;
  waitUntil: (p: Promise<unknown>) => void;
}

const memo = <T>(f: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => {
    p ??= f().catch((err: unknown) => {
      p = null;
      throw err;
    });
    return p;
  };
};

let cached: { fingerprint: string; deps: Omit<Deps, 'waitUntil' | 'sealKey'> } | null = null;

/** The sender an env names: SendGrid, or the outbox stub where the binding exists (local* envs only, gen-enforced). */
export function senderFor(env: Env, fetcher: typeof fetch = globalFetch): EmailSender {
  if (env.EMAIL_SENDER === 'outbox') return new OutboxSender(env.OUTBOX);
  return new SendGridSender(env.SENDGRID_API_KEY, env.MAIL_FROM, fetcher);
}

export function depsFromEnv(env: Env, waitUntil: (p: Promise<unknown>) => void): Deps {
  const fingerprint = [env.ENV_NAME, env.NEAR_RPC, env.NEAR_RPC_FALLBACK, env.SIGNER_ACCOUNT, env.EMAIL_PUBLIC_KEYS, env.EMAIL_ACTIVE_KID, env.ISSUER_SIGNING_KEY?.length, env.EMAIL_SENDER].join('|');
  if (!cached || cached.fingerprint !== fingerprint) {
    const publicKeys = memo(() => parsePublicKeys(env.EMAIL_PUBLIC_KEYS));
    const signers = memo(async (): Promise<IssuerSigner[]> => {
      if (env.EMAIL_SIGNER_KIND !== 'worker-secret') throw new SignerUnavailable(`signer kind ${env.EMAIL_SIGNER_KIND} is not wired`);
      return [await WorkerSecretSigner.create(env.ISSUER_SIGNING_KEY, env.EMAIL_ACTIVE_KID)];
    });
    const cfg = accessConfig(env);
    cached = {
      fingerprint,
      deps: {
        env,
        now: Date.now,
        chain: new NearChain([env.NEAR_RPC, ...(env.NEAR_RPC_FALLBACK ? [env.NEAR_RPC_FALLBACK] : [])], env.SIGNER_ACCOUNT),
        google: new Google(),
        sender: senderFor(env),
        signers,
        publicKeys,
        keys: memo(() => importKeys(env)),
        access: cfg ? new AccessVerifier(cfg) : null,
      },
    };
  }
  // The seal key is read from this request's bindings (importSealKey caches it per value).
  return { ...cached.deps, env, sender: senderFor(env), sealKey: () => importSealKey(env.IDENTITY_SEAL_KEY), waitUntil };
}
