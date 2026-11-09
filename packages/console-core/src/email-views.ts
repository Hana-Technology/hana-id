// The email login views of the consoles (build plan batch 9, spec "Admin portal hooks", D444–D450): what the API's
// `AdminRpc.linkStats`, the issuer's `DirectoryRpc.issuerStats` and `ConsoleIssuerRpc`, and the admin and partner BFFs
// agree on. Counts per app and day only, never an address, a sub, a token or a key.
import { z } from '@hana-id/env/zod';
import { staffCall } from './directory.ts';
import { appIdInput, orgIdInput, scopeIdInput } from './rpc.ts';
import { ctx, requestId } from './types.ts';

/** The days a stats view can cover. */
export const EMAIL_STATS_DAYS_DEFAULT = 14;
export const EMAIL_STATS_DAYS_MAX = 31;

export const emailStatsDays = z.number().int().min(1).max(EMAIL_STATS_DAYS_MAX);

// ---- the links view ----

export const linkStatsInput = ctx.extend({ days: emailStatsDays.optional(), appId: appIdInput.optional() }).strict();
export type LinkStatsInput = z.infer<typeof linkStatsInput>;

export interface LinkStatsRow {
  appId: string;
  day: string;
  appName: string;
  orgId: string;
  environment: 'test' | 'live';
  /** Pending links (identity_link_proposed). */
  proposed: number;
  /** Links active at once (identity_linked). */
  linked: number;
  /** Pending links marked active (identity_link_activated). */
  activated: number;
  cancelled: number;
  unlinked: number;
  /** Of `proposed` + `linked`: with `auto: true` / `auto: false`. */
  auto: number;
  explicit: number;
}

/** An app's links on `day` (proposed + linked at once): the number the rate alert watches. */
export const linksMade = (r: Pick<LinkStatsRow, 'proposed' | 'linked'>): number => r.proposed + r.linked;

/** The rate alert (spec "Links view", provisional): today's links ≥ 5× the app's 7-day median, and at least this many. */
export const LINK_JUMP_FACTOR = 5;
export const LINK_JUMP_MIN_LINKS = 10;

/** The median of the app's prior 7 days (0 for missing days), and whether today's count jumped over it. */
export function linkJump(today: number, prior7: readonly number[]): { median: number; jumped: boolean } {
  const days = [...prior7].slice(0, 7);
  while (days.length < 7) days.push(0);
  const sorted = days.sort((a, b) => a - b);
  const median = sorted[3]!;
  return { median, jumped: today >= LINK_JUMP_MIN_LINKS && today >= LINK_JUMP_FACTOR * Math.max(median, 1) };
}

// ---- the email issuer view (DirectoryRpc.issuerStats) ----

export const directoryIssuerStatsInput = staffCall.extend({ days: emailStatsDays }).strict();
export type DirectoryIssuerStatsInput = z.infer<typeof directoryIssuerStatsInput>;

/** Tokens minted per day, app and purpose (`email_issuance`; `appId` null: staff client proofs). */
export interface IssuanceRow {
  day: string;
  appId: string | null;
  purpose: string;
  count: number;
}

/**
 * The issuer's daily counters (`email_daily`): `metric` is `sent`, `bounced`, `complained`, `refused:<limit name>`
 * (limit names say the endpoint: `ip:start:10m`, `ip:verify:10m`, `mailbox:…`, `app:start:1d`), or `alert:<event>[:code]`
 * (the five alert kinds). `appId` is null for a counter no app belongs to.
 */
export interface DailyMetricRow {
  day: string;
  appId: string | null;
  metric: string;
  count: number;
}

export interface IssuerStats {
  days: number;
  /** Past the row caps: the views say the list was cut. */
  truncated: boolean;
  issuance: IssuanceRow[];
  metrics: DailyMetricRow[];
}

export interface PinnedEmailKeys {
  required: number;
  signers: Record<string, string[]>;
}

/** One key of the chain's signer policy as the issuer view shows it (the JWK thumbprint is the kid). */
export interface SignerKeyView {
  kid: string;
  signer: string;
  /** In `get_issuer_keys("email")`. */
  onChain: boolean;
  /** Among the signer's pinned thumbprints (`watchdog.pinnedIssuerKeys.email`, a manifest copy in the admin's vars). */
  pinned: boolean;
}

/** `GET /api/email/issuer`: the counters, the signer policy, and the parts that need KMS (batch 10). */
export interface IssuerViewAnswer {
  days: number;
  /** The names of the apps the stats name (`AdminRpc.appNames`, at most 50; an id not listed shows as its id). */
  appNames: Record<string, string>;
  stats: IssuerStats | { unavailable: string };
  policy: ({ required: number; signers: string[]; keys: SignerKeyView[]; iss: string[]; matchesPins: boolean; pinsConfigured: boolean } | { unavailable: string });
  /** Batch 10's panels: the signer kind this env runs, and a plain line saying those figures don't apply. */
  kms: { signerKind: 'worker-secret' | 'aws-kms'; note: string };
}

// ---- the partner console's reads (ConsoleIssuerRpc, bound only by the console Worker; the console checked the org) ----

export const partnerDeliverabilityInput = z.object({ requestId, appId: appIdInput, days: emailStatsDays }).strict();
export type PartnerDeliverabilityInput = z.infer<typeof partnerDeliverabilityInput>;

export interface DeliverabilityDay {
  day: string;
  sent: number;
  bounced: number;
  complained: number;
  refused: number;
}
export type PartnerDeliverability = { ok: true; days: DeliverabilityDay[] } | { ok: false; code: 'internal' | 'bad_request' };

/** An AddClient("email", "email:<scope>") client proof for an owner action the console built (D446). */
export const partnerClientProofInput = z.object({ requestId, actorId: z.string().min(1).max(128), orgId: orgIdInput, scopeId: scopeIdInput, actionNonce: z.number().int().nonnegative() }).strict();
export type PartnerClientProofInput = z.infer<typeof partnerClientProofInput>;
export type PartnerClientProof = { ok: true; token: string; client: [string, string] } | { ok: false; code: 'email_not_enabled' | 'stale_action_nonce' | 'unknown_scope' | 'rate_limited' | 'unavailable' | 'bad_request'; error?: string };

/** Service binding `ISSUER` of the console Worker (entrypoint `ConsoleIssuerRpc`). */
export interface ConsoleIssuerRpcClient {
  clientProof(input: PartnerClientProofInput): Promise<PartnerClientProof>;
  deliverability(input: PartnerDeliverabilityInput): Promise<PartnerDeliverability>;
}

/** The aud of the scope's email client on chain (issuer: `client-proof.ts` emailClientAud). */
export const emailClientAudOf = (scopeId: string): string => `email:${scopeId}`;

/** `GET /api/orgs/:org/apps/:app/email`: what the app's Email login page shows. */
export interface AppEmailAnswer {
  /** Email login is offered by this app (`apps.login_methods`). */
  emailOn: boolean;
  scopeId: string;
  /** The scope's on-chain state, or why it couldn't be read. */
  scope: { clientOnChain: boolean; pending: { changeId: number; unlockAt: number; executable: boolean } | null; youAreOnChainOwner: boolean } | { unavailable: true };
  /** Other apps of the scope with email on (the scope's client must stay while any does). */
  otherAppsEmailOn: number;
  /** Whether this environment has an email issuer (without it, the page says email isn't offered here). */
  available: boolean;
  deliverability: { days: DeliverabilityDay[] } | { unavailable: true };
}
