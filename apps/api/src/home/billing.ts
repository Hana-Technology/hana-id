// Who pays for a Hana Home derive (docs/hana-home-spec.md "Cost and latency", D461): the org a `home_login` usage event
// is written for. A Home derive names a scope and no app, so the question is asked of the scope's apps.
//
// THE RULE IS `HOME_PAYER`, BELOW, AND NOWHERE ELSE. To change who pays for a suspended app's Home derives (still to be
// agreed, D461's note), change that one line and its test (test/home-login.test.ts, "by the single rule"). Nothing else reads an app's status
// for billing: the ledger, the reports, the statement and settlement only see the org this file chose.
//
// The rule is applied once, when the event is written, after the response (usage/record.ts) and only when usage capture
// is on. It never changes or delays a derive, and a change to it applies to events written after it ships.
import { LEGACY_ORG_ID } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

/**
 * Where a scope's apps stand: `active` when at least one app that isn't deleted is running; `suspended` when it has
 * apps that aren't deleted and every one is suspended (by Hana, its org or the partner); `gone` when every app is
 * deleted or the hot DB holds no row for the scope.
 */
export type HomeScopeStanding = 'active' | 'suspended' | 'gone';

/**
 * Who pays for a Home derive, by where the scope's apps stand. `partner`: the scope's org, as a "Hana Home logins" line
 * on its statement. `hana`: Hana's own org.
 */
export const HOME_PAYER: Readonly<Record<HomeScopeStanding, 'partner' | 'hana'>> = {
  active: 'partner',
  // Hana pays while an app is suspended, for now: to be discussed before it is final (D461's note).
  suspended: 'hana',
  gone: 'hana',
};

const ORG_ID_RE = /^org_[A-Za-z0-9]{1,60}$/u;

/**
 * Hana's own org in the ledger: the var HANA_ORG_ID (manifest `hanaOrgId`, an internal org staff made in the admin
 * console) when it is an org id, else the legacy org, which no partner can read and no statement bills. Only the shape
 * is checked here: `deploy-check <env> --d1` checks that the org exists and is internal, and a statement refuses a Home
 * line for a scope that isn't its org's unless the org is internal, so a wrong id can't bill a partner.
 */
export function hanaOrgId(env: Pick<Env, 'HANA_ORG_ID'>): string {
  const v = env.HANA_ORG_ID;
  return v !== undefined && ORG_ID_RE.test(v) ? v : LEGACY_ORG_ID;
}

/** A scope's standing from its app counts (null: the hot DB has no row for the scope). */
export function homeScopeStanding(apps: { live: number; active: number } | null): HomeScopeStanding {
  if (!apps || apps.live <= 0) return 'gone';
  return apps.active > 0 ? 'active' : 'suspended';
}

/** The org that pays, for a scope's org (null: no row) and its standing. A partner org that can't be named falls to Hana. */
export function homePayerOrg(env: Pick<Env, 'HANA_ORG_ID'>, scopeOrg: string | null, standing: HomeScopeStanding): string {
  return HOME_PAYER[standing] === 'partner' && scopeOrg ? scopeOrg : hanaOrgId(env);
}

/**
 * The org a Home derive's usage event is written for: one hot-DB read. When the read fails Hana pays (a partner is
 * never billed on a guess), logged as `usage_org_unavailable`. Never throws.
 */
export async function homeBillingOrg(env: Pick<Env, 'DB' | 'HANA_ORG_ID'>, scopeId: string, at: { requestId: string; endpoint: string }): Promise<string> {
  try {
    const row = await env.DB.prepare(
      `SELECT s.org_id AS org_id,
              (SELECT COUNT(*) FROM apps a WHERE a.scope_id = s.scope_id AND a.deleted_at IS NULL) AS live,
              (SELECT COUNT(*) FROM apps a WHERE a.scope_id = s.scope_id AND a.deleted_at IS NULL AND a.status = 'active' AND a.suspended_by = 0) AS active
         FROM scopes s WHERE s.scope_id = ?1`,
    )
      .bind(scopeId)
      .first<{ org_id: string; live: number; active: number }>();
    return homePayerOrg(env, row?.org_id ?? null, homeScopeStanding(row ? { live: row.live, active: row.active } : null));
  } catch {
    log({ event: 'usage_org_unavailable', ...at, code: 'config_unavailable' }, 'warn');
    return hanaOrgId(env);
  }
}
