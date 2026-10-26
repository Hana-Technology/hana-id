import { z } from 'zod';

const nearAccount = z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u, 'Invalid NEAR account id');

/** One environment's accounts and endpoints. Every account name the code uses comes from here. */
export const manifestSchema = z.object({
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
  googleClientIds: z.array(z.string().min(1)),
  /** Client IDs of the Hana console, accepted for OIDC owner actions: [provider, aud]. */
  consoleAudiences: z.array(z.tuple([z.string(), z.string()])),
  cloudflare: z.object({
    workerName: z.string().min(1),
    d1Name: z.string().min(1),
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;
