// Hana Embed (testnet MPC): Google sign-in on our page → session key → hana-signer contract → NEAR MPC.
// Everything here is public. The only secret in the flow is the relayer's NEAR gas key, which stays server-side.

/** Our Google OAuth web client id (Google Cloud console). hana-signer only accepts tokens whose `aud` is listed. */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

/** Session limits the user's Google login commits to (the contract caps them at 24 h / 500). */
export const SESSION = { scope: 'global', lifetimeMs: 60 * 60 * 1000, maxSignatures: 50 } as const;

export const SIGNER_CONTRACT = import.meta.env.VITE_EMBED_SIGNER_CONTRACT || 'hana-signer.testnet';
export const MPC_CONTRACT = 'v1.signer-prod.testnet';
export const MPC_DOMAIN = { secp256k1: 0, ed25519: 1, ckd: 2 } as const;
export const NEAR_RPC = 'https://test.rpc.fastnear.com';

/** Our relayer (server/embed-relayer.ts): pays the NEAR gas for hana-signer calls. */
export const RELAYER_ENDPOINT = '/api/embed-sign';

/** Contract methods named in the envelope: which chain, so which hash and curve the MPC uses. */
export const ENVELOPE_METHOD = { stellar: 'sign_stellar', evm: 'sign_evm' } as const;
