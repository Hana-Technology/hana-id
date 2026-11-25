// The platform API's app operations (D929; docs/partner-platform-spec.md A1, A4, A5, A8, A9, piece P4): the request
// bodies (strict: an unknown field is `bad_request`, so a caller can't think it set something the API ignores), the
// app view a network's backend reads (an allowlist), and the operations' own quotas. Shared by the API and, for the
// network's guide (piece P8), by anyone writing a client from `docs/api.md`.
import { z } from '@hana-id/env/zod';
import { APP_NAME_MAX } from './names.ts';
import { MAX_APP_ORIGINS } from './origins.ts';
import { scopeIdInput } from './rpc.ts';

const originInput = z.string().min(1).max(2048);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** `POST /v1/platform/apps`: a test app on one of the key's shared scopes, its name and its first web addresses. */
export const platformCreateAppBody = z
  .object({
    scopeId: scopeIdInput,
    name: z.string().min(1).max(4 * APP_NAME_MAX),
    origins: z.array(originInput).max(MAX_APP_ORIGINS).optional(),
  })
  .strict();
/** `POST /v1/platform/apps/:appId/origins`: web addresses to propose (each waits; A4.5). */
export const platformAddOriginsBody = z.object({ add: z.array(originInput).min(1).max(MAX_APP_ORIGINS), expectedVersion: version }).strict();
/** `POST /v1/platform/apps/:appId/origins/remove`: web addresses to stop at once. */
export const platformRemoveOriginsBody = z.object({ remove: z.array(originInput).min(1).max(MAX_APP_ORIGINS), expectedVersion: version }).strict();
/** `POST /v1/platform/apps/:appId/suspend`: suspend (true) or resume (false) the app's partner suspension. */
export const platformSuspendBody = z.object({ suspended: z.boolean() }).strict();
/** The writes that take nothing (a cancel, a publishable key's create and revoke): `{}`. */
export const platformEmptyBody = z.object({}).strict();

/**
 * The operations' own limits (A5, provisional and kept low while a network has few partners, L14). Per org: app
 * creations 2 a clock hour and (by default, `platform_orgs.creations_per_day`) 5 a UTC day; origin proposals, counted
 * per web address, 20 a clock hour (A5 says 10, but a create may carry 20: one full app's worth fits, D929) and (by
 * default, `platform_orgs.proposals_per_day`) 30 a UTC day; at most 30 web
 * addresses waiting (proposed, not yet in force) across the org's apps; at most `platform_orgs.max_apps` (default 10)
 * apps the platform created and not deleted. Per app: `MAX_APP_ORIGINS` (20) web addresses in force or waiting, the
 * widget's origin included; 5 unrevoked publishable keys, and the org's platform keys create at most 20 publishable
 * keys a clock hour and 50 a UTC day (revoked keys are kept, so churn is bounded). A list answers 50 apps a page; an
 * app view lists its 20 newest publishable keys.
 */
export const PLATFORM_OPS_LIMITS = {
  creationsPerHour: 2,
  proposalsPerHour: 20,
  waitingPerOrg: 30,
  /** Publishable keys the org's platform keys create (D929 after PR 157's review: revoked keys are kept). */
  keyCreationsPerHour: 20,
  keyCreationsPerDay: 50,
  listPage: 50,
  keysShown: 20,
  /** How long `platform_requests` tells a retry from another call with the same Idempotency-Key (A9). */
  idempotencyMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** A web address of an app as the platform sees it. `state`: not announced yet, announced and waiting, or in force. */
export interface PlatformOrigin {
  origin: string;
  display: string;
  idn: boolean;
  state: 'waiting_announcement' | 'waiting' | 'active';
  /** When it comes into force (or came into force); null until announced. */
  activeFrom: number | null;
  /** When an owner confirmed it (piece P10); null until then. Never who. */
  confirmedAt: number | null;
  /** The guarded change that proposed it, when there is one. */
  changeId?: string;
}

/** The app view (A8): an allowlist, never settings outside it, staff identities, Google subs or the mainnet demo. */
export interface PlatformApp {
  id: string;
  name: string;
  scopeId: string;
  environment: 'test';
  createdBy: 'platform';
  createdAt: number;
  userIds: 'app' | 'scope';
  suspended: {
    /** Journear stopped the app (its per-app bit or the organisation's), not why. */
    byJournear: boolean;
    /** A member of the organisation suspended it in the partner portal (only they can resume it). */
    byOrganisation: boolean;
    /** The platform suspended it, and no member has taken the suspension over. */
    byYou: boolean;
    youCanResume: boolean;
  };
  originsVersion: number;
  origins: PlatformOrigin[];
  keys: { id: string; key: string; createdAt: number; revokedAt: number | null }[];
}

/** A waiting web address the platform cancelled (`POST /v1/platform/changes/:changeId/cancel`). */
export interface PlatformChange {
  changeId: string;
  appId: string;
  origin: string;
  display: string;
  idn: boolean;
  status: 'pending' | 'active' | 'cancelled' | 'ended';
  activeFrom: number | null;
  cancelledAt: number | null;
}
