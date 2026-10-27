import { z } from 'zod';

const nearAccount = z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u, 'Invalid NEAR account id');

/** Cloudflare Durable Object location hints (https://developers.cloudflare.com/durable-objects/reference/data-location/). */
export const DO_LOCATION_HINTS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'] as const;

const clientId = z.string().min(1).max(255).regex(/^\S+$/u, 'Client IDs contain no whitespace');

/** One environment's accounts and endpoints. Every account name the code uses comes from here. */
export const manifestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/u),
    network: z.enum(['testnet']),
    /** hana-signer contract account: the MPC predecessor, so it is part of every user's address. */
    signer: nearAccount,
    /** Account whose function-call keys the API uses to pay gas. */
    relayer: nearAccount,
    /** Contract admin (`owner` in hana-signer). */
    owner: nearAccount,
    mpc: nearAccount,
    ckdDomainId: z.number().int().nonnegative(),
    /** The MPC's CKD public key, pinned (fetch with scripts/fetch-ckd-key.ts). */
    ckdNetworkKey: z.string(),
    rpc: z.string().url(),
    apiUrl: z.string().url(),
    /** Timelock for adding client IDs / changing owners, in ms (contract allows 0..7 days). */
    changeDelayMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000),
    /** Hana's own Google client IDs, registered to the reserved `global` scope at deploy. */
    googleClientIds: z.array(clientId),
    /**
     * Hana's shared Google login client(s) (`set_shared_clients` at deploy; the contract allows 5). Apps without their
     * own Google client log in through one of these into a scope registered with `allow_shared`. A client ID can't be
     * both shared and a scope's own client.
     */
    sharedGoogleClientIds: z.array(clientId).max(5),
    /** Client IDs of the Hana console, accepted for OIDC owner actions: [provider, aud]. */
    consoleAudiences: z.array(z.tuple([z.string(), z.string()])),
    cloudflare: z.object({
      workerName: z.string().min(1),
      d1Name: z.string().min(1),
      /**
       * Region for the Durable Objects every request shares (relayer keys, per-app and owner-action limiters), passed
       * as a location hint when they are first created. Per-IP limiters stay near their client. Optional: without it
       * Cloudflare places each object near the first request that uses it. Changing it creates new objects there.
       */
      durableObjectLocation: z.enum(DO_LOCATION_HINTS).optional(),
    }),
  })
  .superRefine((m, ctx) => {
    const dup = (list: string[]) => list.find((v, i) => list.indexOf(v) !== i);
    for (const field of ['googleClientIds', 'sharedGoogleClientIds'] as const) {
      const d = dup(m[field]);
      if (d !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `Duplicate client ID ${d}` });
    }
    // The contract rejects a (provider, aud) that is both a shared client and a scope's client; googleClientIds and
    // the console audiences become clients of the `global` scope.
    const scopeClients = new Set([...m.googleClientIds, ...m.consoleAudiences.filter(([p]) => p === 'google').map(([, a]) => a)]);
    for (const id of m.sharedGoogleClientIds) {
      if (scopeClients.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sharedGoogleClientIds'], message: `${id} is also in googleClientIds or consoleAudiences; a client is either shared or a scope's own` });
      }
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;
