// Auto-approve consent rules (docs/batch-b-spec.md "Auto-approve policies", "Consent"). A request is signed without a
// popup only when the app has a policy in force, the user accepted exactly that policy (its policyId) in a Hana popup,
// the consent hasn't ended, and @hana-id/core's matcher accepts the request with today's usage. The vault keeps the
// consent in the encrypted record ('session' mode) or in memory ('none'), with its per-UTC-day counters. Hana Home: a
// consent the API hasn't recorded (no `consentId`, one made before registering existed) never signs anything.
import type { AutoApproveStatus } from '@hana-id/core';
import { type AutoApproveUsage, usageToday } from '@hana-id/core/policy';
import type { PolicyInForce } from './config.ts';
import type { ConsentV1 } from './record.ts';

/** True while `consent` is for the policy in force and hasn't ended (its own end, or the session's). */
export function consentActive(consent: ConsentV1 | null, policy: PolicyInForce | null, nowMs: number, sessionExpiresAtMs: number): consent is ConsentV1 {
  return !!consent && !!policy && !!consent.consentId && consent.policyId === policy.policyId && nowMs < consent.expiresAtMs && nowMs < sessionExpiresAtMs;
}

/** When a consent granted now would end: min(now + maxConsentMs, session expiry). */
export const consentEnd = (policy: PolicyInForce, nowMs: number, sessionExpiresAtMs: number): number => Math.min(nowMs + policy.policy.maxConsentMs, sessionExpiresAtMs);

/** A fresh consent for `policy` under the id the API recorded, ending at `expiresAtMs`, with today's counters at zero. */
export function newConsent(policy: PolicyInForce, nowMs: number, expiresAtMs: number, consentId: string): ConsentV1 {
  const usage = usageToday(null, nowMs);
  return { consentId, policyId: policy.policyId, grantedAt: nowMs, expiresAtMs, day: usage.day, count: usage.count, valueWeiByChain: { ...usage.valueWeiByChain } };
}

/** The consent with its usage replaced. */
export const withUsage = (consent: ConsentV1, usage: AutoApproveUsage): ConsentV1 => ({
  ...consent,
  day: usage.day,
  count: usage.count,
  valueWeiByChain: { ...usage.valueWeiByChain },
});

/** hana_autoApproveStatus: the active consent, with today's count and native value (wei, all chains). */
export function autoApproveStatus(consent: ConsentV1, policy: PolicyInForce, nowMs: number): AutoApproveStatus {
  const today = usageToday(consent, nowMs);
  const native = Object.values(today.valueWeiByChain).reduce((sum, v) => sum + BigInt(v), 0n);
  return { policyId: policy.policyId, label: policy.policy.label, expiresAtMs: consent.expiresAtMs, used: { count: today.count, native: native.toString() } };
}
