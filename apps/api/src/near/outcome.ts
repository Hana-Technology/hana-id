// Reading a settled NEAR outcome: whether it settled, which receipt failed and the failure's text. Pure (rpc.ts's
// types only), so a test that holds a real node's outcome against the relay's answer (test-sandbox/stamps-site.test.ts)
// needs nothing of the Worker. tx.ts re-exports these.
import type { FinalOutcome } from './rpc.ts';

export const statusObject = (s: FinalOutcome['status'] | undefined): { SuccessValue?: string; Failure?: unknown } | null =>
  s && typeof s === 'object' ? s : null;

/** Settled = the tx has a final SuccessValue or Failure. */
export function isSettled(o: Partial<FinalOutcome> | null | undefined): o is FinalOutcome {
  const s = statusObject(o?.status);
  return !!s && ('SuccessValue' in s || 'Failure' in s);
}

const failedReceipt = (outcome: FinalOutcome): NonNullable<FinalOutcome['receipts_outcome']>[number] | undefined =>
  outcome.receipts_outcome?.find((r) => {
    const s = r.outcome.status;
    return typeof s === 'object' && s !== null && 'Failure' in s && s.Failure;
  });

/**
 * The account that ran the first failed receipt (receipts in execution order), or null when no receipt failed (a
 * transaction-level failure) or the RPC did not say. Tells a contract panic from a failure in a contract it called.
 */
export function failedExecutor(outcome: FinalOutcome): string | null {
  const executor = failedReceipt(outcome)?.outcome.executor_id;
  return typeof executor === 'string' && executor ? executor : null;
}

/** The first failure anywhere in the receipt tree, as readable text. */
export function failureText(outcome: FinalOutcome): string | null {
  const failed = failedReceipt(outcome);
  const failedStatus = failed?.outcome.status;
  const failure = statusObject(outcome.status)?.Failure ?? (typeof failedStatus === 'object' ? failedStatus.Failure : undefined);
  if (!failure) return null;
  const text = JSON.stringify(failure);
  const panic = /"panic_msg":"((?:[^"\\]|\\.)+)"/u.exec(text)?.[1] ?? /ExecutionError":"((?:[^"\\]|\\.)+)"/u.exec(text)?.[1];
  return (panic ?? text).slice(0, 500);
}
