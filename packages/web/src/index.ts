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
// `hana.getProfile()`, `hana.profile` and `profileChanged`: the name the user shared, read from the identity token.
export type { HanaProfile } from './client/profile.ts';
export { type ApprovalTicket } from './client/approval-window.ts';
export type { LoginOptions } from './client/login.ts';
// The wallet's sign-in methods (`hana.account()`, `linkChanged`, `hana.linkAccount()`; build plan batches 7 and 8b).
export type { AccountMethod, AccountResult, LinkChange } from '@hana-id/core';
// `disconnect`'s `reason` (`signed_out`: Hana signed this device out).
export type { DisconnectReason } from '@hana-id/core';
export { HanaError, ProviderRpcError, RpcCode, type ClientErrorCode, type SwkError } from './client/errors.ts';
// The plain sentence for an error's code (`error.userMessage` on HanaError and ProviderRpcError), for a code read
// elsewhere (the SWK module's `ext[0]`, a wrapped provider error's `data.code`).
// The reason NAMES only, to branch on: the sentences are reached through `userMessage` / `userMessageFor` and may be
// reworded at any time.
export {
  NEAR_RELAY_REASON_NAMES,
  SPONSOR_REASON_NAMES,
  SPONSORSHIP_REASON_NAMES,
  userMessageFor,
  type KnownSponsorReason,
  type KnownSponsorshipReason,
  type NearRelayReason,
  type SponsorReason,
  type SponsorshipReason,
  type UserMessageSource,
} from './client/user-messages.ts';
export {
  CALLS_VERSION,
  EIP5792,
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
export {
  HanaNear,
  NEAR_RELAY_TIMEOUT_MS,
  type NearActivateResult,
  type NearBytes,
  type NearRelayErrorData,
  type NearRelayParams,
  type NearRelayResult,
  type NearSignDelegateActionParams,
  type NearSignDelegateActionResult,
  type NearSignMessageParams,
  type NearSignMessageResult,
  type NearSignTransactionParams,
  type NearSignTransactionResult,
} from './client/near.ts';
export type { NearNetwork } from '@hana-id/core';
// `hana.evm`: gas sponsorship for EVM actions (D838; not live: no environment sponsors a chain yet).
export {
  HanaEvm,
  HanaSponsorError,
  isHanaSponsorError,
  type EvmSponsorErrorData,
  type EvmSponsorProviderErrorData,
  type SendSponsoredParams,
  type SendSponsoredResult,
  type SponsoredCall,
  type SponsorshipStatus,
} from './client/evm-sponsor.ts';
export { isInAppWebView, partnerPageIssues, type PartnerIssue, type PartnerIssueCode } from './client/requirements.ts';
export { HANA_ID_ICON, HANA_ID_NAME } from './client/icon.ts';
export { isLoopbackHost, serviceUrl } from './client/urls.ts';
