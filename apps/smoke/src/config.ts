// Page configuration: the public fields of envs/<VITE_HANA_ENV>.json, validated by @hana-id/env at build time
// (vite.config.ts) and injected as __HANA_SMOKE_ENV__. Everything here is public.

export const DEFAULT_ENV = 'sandbox-dev';

/** The manifest fields the page reads (a structural slice of @hana-id/env's Manifest, which needs Node to load). */
export type ManifestFields = Pick<PageEnv, 'name' | 'network' | 'signer' | 'relayer' | 'mpc' | 'ckdDomainId' | 'ckdNetworkKey' | 'rpc' | 'apiUrl'> & {
  vaultOrigin?: string | undefined;
  authOrigin?: string | undefined;
};

export interface PageEnv {
  name: string;
  network: string;
  /** hana-signer account: the MPC predecessor, part of every nonce and every app_id. */
  signer: string;
  /** Account whose keys relay transactions (sender for gas lookups). */
  relayer: string;
  mpc: string;
  ckdDomainId: number;
  /** Pinned MPC CKD public key (`bls12381g2:…`). */
  ckdNetworkKey: string;
  rpc: string;
  /** The API this page calls: VITE_HANA_API_URL when set, else the manifest's. */
  apiUrl: string;
  /** True when VITE_HANA_API_URL overrode the manifest's apiUrl (e.g. a local `wrangler dev`). */
  apiUrlOverridden: boolean;
  /** The manifest's apiUrl: the one the vault and login pages were built with, whatever this page calls. */
  manifestApiUrl: string;
  /** The vault page's origin (manifest `vaultOrigin`), or null when the env has no Hana pages. */
  vaultOrigin: string | null;
  /** The login, approval and export pages' origin (manifest `authOrigin`), or null. */
  authOrigin: string | null;
}

/** Only the fields the page needs; `apiUrlOverride` (VITE_HANA_API_URL) replaces `apiUrl` when set. */
export function pageEnvFrom(m: ManifestFields, apiUrlOverride?: string): PageEnv {
  const override = apiUrlOverride?.trim();
  if (override) {
    const url = new URL(override);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('VITE_HANA_API_URL must be https (or http on localhost)');
    }
  }
  return {
    name: m.name,
    network: m.network,
    signer: m.signer,
    relayer: m.relayer,
    mpc: m.mpc,
    ckdDomainId: m.ckdDomainId,
    ckdNetworkKey: m.ckdNetworkKey,
    rpc: m.rpc,
    apiUrl: override || m.apiUrl,
    apiUrlOverridden: Boolean(override),
    manifestApiUrl: m.apiUrl,
    vaultOrigin: m.vaultOrigin ?? null,
    authOrigin: m.authOrigin ?? null,
  };
}

// The pinned-key check (`ckdKeyProblem`) moved to @hana-id/core (ckd.ts).
