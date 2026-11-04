// Auto-approve policies in the console (docs/batch-c-spec.md "Policy and raw-signing input rules"): the same validator
// the API, the CLI and the vault run (@hana-id/core/policy `validateAutoApprovePolicy`, against the app's session TTL),
// as the owner edits (`POST …/policy/check`, the editor's preview) and before the fresh sign-in (`policy.set`). The API
// validates the policy again when the step-up reaches it; the console's answer is only what the screen shows.
import { errorResponse, json, readJson } from './http.ts';

/** The biggest policy body the editor sends. */
export const MAX_POLICY_BODY = 32 * 1024;

export type PolicyCheck = { ok: true; policy: unknown; policyId: string; label: string } | { ok: false; problems: readonly string[] };

/** The validated policy in its canonical form with its policyId, or the validator's problems. */
export async function validatePolicy(policy: unknown, sessionTtlMs: number): Promise<PolicyCheck> {
  const { canonicalJson, policyId, validateAutoApprovePolicy } = await import('@hana-id/core/policy');
  const r = validateAutoApprovePolicy(policy, { sessionTtlMs });
  if (!r.ok) return { ok: false, problems: r.problems };
  return { ok: true, policy: JSON.parse(canonicalJson(r.policy)) as unknown, policyId: policyId(r.policy, { sessionTtlMs }), label: r.policy.label };
}

/** `POST /api/orgs/:org/apps/:app/policy/check {policy}` → `{policyId, label, policy}` or 400 `policy_invalid`. */
export async function policyCheckRoute(request: Request, sessionTtlMs: number): Promise<Response> {
  const body = await readJson(request, MAX_POLICY_BODY);
  if (!body.ok) return errorResponse(body.code);
  const v = body.value as { policy?: unknown } | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).some((k) => k !== 'policy') || !('policy' in v)) return errorResponse('bad_request', 'Expected {policy}');
  const r = await validatePolicy(v.policy, sessionTtlMs);
  if (!r.ok) return json(400, { error: { code: 'policy_invalid', message: r.problems.join('; ').slice(0, 2000) }, problems: r.problems.slice(0, 50) });
  return json(200, { policyId: r.policyId, label: r.label, policy: r.policy });
}
