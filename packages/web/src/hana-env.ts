/**
 * One env's build constants for the Hana pages (vault, login, callback, approve, export), generated into
 * envs.generated.ts by scripts/gen-envs.ts from envs/<name>.json. The pages are built per env with these values and
 * never read them at runtime: `signer`, `relayer` and `ckdNetworkKey` are pinned, and any inlined, API-supplied or
 * opener-supplied value that differs stops the flow (docs/batch-b-spec.md, Decisions). Public values only.
 */
export interface HanaEnv {
  readonly name: string;
  readonly network: 'testnet';
  readonly apiUrl: string;
  /** Origin of the key vault page (hidden iframe in partner pages). */
  readonly vaultOrigin: string;
  /** Origin of the login, callback, approval and export pages; Google redirects to `{authOrigin}/login/callback`. */
  readonly authOrigin: string;
  /** hana-signer account (`SIGNER`): in every session nonce, CKD `app_id` and vault record. */
  readonly signer: string;
  /** Relayer account (`RELAYER`), used only as `sender_account_id` when polling transactions. */
  readonly relayer: string;
  readonly rpc: string;
  /** Pinned MPC CKD public key (`bls12381g2:…`). */
  readonly ckdNetworkKey: string;
  /** `isDevEnv(name)` from @hana-id/env (`local*`/`sandbox*`): dev-only privileges such as same-site Hana origins. */
  readonly devEnv: boolean;
}
