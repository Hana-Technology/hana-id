// Auto-approve policy and raw-signing values as the RPC reads and writes them (docs/batch-c-spec.md "Policy and
// raw-signing input rules"): validated by @hana-id/core's validateAutoApprovePolicy against the app's session TTL (the
// same validator the console, the CLI and the vault run), stored as canonical JSON with its policyId. What is in force
// follows batch B's `matured()` (vault/settings.ts): a pending value once its effective time has passed.
const SESSION_TTL_MAX_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;

export interface StoredPolicy {
  /** Canonical JSON, as `policy_json` and the `auto_approve_*` columns hold it. */
  json: string;
  /** 64 hex. */
  id: string;
  label: string;
}

interface SettingsCols {
  raw_sign: string;
  raw_sign_pending: string | null;
  raw_sign_effective_at: number | null;
  auto_approve_policy: string | null;
  auto_approve_pending: string | null;
  auto_approve_effective_at: number | null;
}

export const matured = (pending: unknown, effectiveAt: number | null, now: number): boolean => pending !== null && effectiveAt !== null && now >= effectiveAt;

export const rawSignInForce = (r: SettingsCols, now: number): 'off' | 'approval' =>
  r.raw_sign === 'approval' || (r.raw_sign_pending === 'approval' && matured(r.raw_sign_pending, r.raw_sign_effective_at, now)) ? 'approval' : 'off';

export const policyInForce = (r: SettingsCols, now: number): string | null =>
  matured(r.auto_approve_pending, r.auto_approve_effective_at, now) ? r.auto_approve_pending : r.auto_approve_policy;

/** A pending value not yet in force (the cancel and turn-off paths clear it). */
export const pendingPolicy = (r: SettingsCols, now: number): string | null =>
  r.auto_approve_pending !== null && !matured(r.auto_approve_pending, r.auto_approve_effective_at, now) ? r.auto_approve_pending : null;

/** Validates a policy (a JSON value) against a session TTL: its stored form, or the validator's problems. */
export async function validatePolicy(policy: unknown, sessionTtlMs: number): Promise<{ ok: true; policy: StoredPolicy } | { ok: false; problems: readonly string[] }> {
  const { canonicalJson, policyId, validateAutoApprovePolicy } = await import('@hana-id/core/policy');
  const r = validateAutoApprovePolicy(policy, { sessionTtlMs });
  if (!r.ok) return r;
  return { ok: true, policy: { json: canonicalJson(r.policy), id: policyId(r.policy, { sessionTtlMs }), label: r.policy.label } };
}

/** A stored policy text read back (null when it doesn't validate: the API never serves it then). */
export async function storedPolicy(text: string, sessionTtlMs = SESSION_TTL_MAX_MS): Promise<StoredPolicy | null> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const r = await validatePolicy(value, sessionTtlMs);
  return r.ok ? r.policy : null;
}

/** Whether a stored policy text that validates at the longest TTL also validates at `sessionTtlMs`. */
export async function fitsTtl(text: string, sessionTtlMs: number): Promise<boolean> {
  if ((await storedPolicy(text, SESSION_TTL_MAX_MS)) === null) return true; // never served anyway
  return (await storedPolicy(text, sessionTtlMs)) !== null;
}
