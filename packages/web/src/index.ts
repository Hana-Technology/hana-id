// @hana-id/web: the partner client (`createHana`: vault iframe, handshake, login popup, EIP-1193 provider, Stellar and
// raw signers) and the Hana pages (vault, login, callback, approve, export), built per env from envs.generated.ts.
// Batch B fills it (docs/batch-b-spec.md, Packages and Standard interfaces). The Stellar Wallets Kit module is the
// `@hana-id/web/stellar-wallets-kit` subpath.

export { VERSION } from './version.ts';

export type { HanaEnv } from './hana-env.ts';

// ---- partner client ----
export { HANA_ENVIRONMENTS, createHana } from './create-hana.ts';
export {
  HanaClient,
  type HanaAddresses,
  type HanaConfig,
  type HanaEvents,
  type HanaOrigins,
  type HanaStatus,
  type SignRawParams,
} from './client/client.ts';
export { HanaError, ProviderRpcError, RpcCode, type ClientErrorCode, type SwkError } from './client/errors.ts';
export {
  HanaEthereumProvider,
  READ_ONLY_METHODS,
  type Eip6963ProviderInfo,
  type EthereumEvents,
  type EvmChainConfig,
  type EvmConfig,
  type ProviderConnectInfo,
  type RequestArguments,
} from './client/ethereum.ts';
export { HanaStellarSigner, STELLAR_NETWORKS, type StellarConfig, type StellarSignOptions } from './client/stellar.ts';
export { isInAppWebView, partnerPageIssues, type PartnerIssue, type PartnerIssueCode } from './client/requirements.ts';
export { HANA_ID_ICON, HANA_ID_NAME } from './client/icon.ts';
