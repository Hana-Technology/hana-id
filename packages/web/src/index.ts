// @hana-id/web: the partner client (`createHana`: vault iframe, handshake, login popup, EIP-1193 provider, Stellar and
// raw signers) and the Hana pages (vault, login, callback, approve, export), built per env from envs.generated.ts.
// Batch B fills it (docs/batch-b-spec.md, Packages and Standard interfaces). The Stellar Wallets Kit module is the
// `@hana-id/web/stellar-wallets-kit` subpath.

export { VERSION } from './version.ts';

export type { HanaEnv } from './hana-env.ts';

// ---- partner client ----
export { HANA_ENVIRONMENTS, createHana } from './create-hana.ts';
// HanaClient is a type only (sweep PART-5, D114): its constructor takes Hana origins, so the only way to build one is
// createHana, which resolves them from the build's pinned envs.
export type { HanaClient, MainnetDemo, MainnetDemoPrice, MainnetDemoPrices } from './client/client.ts';
export {
  type HanaAddresses,
  type HanaConfig,
  type HanaDisconnect,
  type HanaEvents,
  type HanaOrigins,
  type HanaStatus,
  type IdentityTokenOptions,
  type SignRawParams,
} from './client/client.ts';
export { type ApprovalTicket } from './client/approval-window.ts';
export type { LoginOptions } from './client/login.ts';
// The wallet's sign-in methods (`hana.account()`, `linkChanged`, `hana.linkAccount()`; build plan batches 7 and 8b).
export type { AccountMethod, AccountResult, LinkChange } from '@hana-id/core';
// `disconnect`'s `reason` (`signed_out`: Hana signed this device out).
export type { DisconnectReason } from '@hana-id/core';
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
export { isLoopbackHost, serviceUrl } from './client/urls.ts';
