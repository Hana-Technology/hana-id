// The relay's answers to a page (POST /v1/near/relay and /activate past the relay, docs/api.md "NEAR relay"): pure, so
// test-sandbox/stamps-site.test.ts holds a real node's outcome against exactly the body a page receives.

type Obj = Record<string, unknown>;

/** What the relayer key reports (relayer-key.ts RelayResult), as far as the answer reads it. */
export type RelayOutcome = { ok: true; nearTx: string } | { ok: false; status: number; code: string; error: string; nearTx?: string; executor?: string | null };

/** Why NEAR refused the delegate action itself (in the sender's receipt), from the failure's text; null for a call's own failure. */
export function delegateFailure(error: string): string | null {
  if (/DelegateActionExpired/u.test(error)) return 'expired';
  if (/DelegateActionInvalidNonce/u.test(error)) return 'invalid_nonce';
  if (/DelegateActionNonceTooLarge/u.test(error)) return 'nonce_too_large';
  if (/DelegateActionAccessKeyError/u.test(error)) return 'access_key';
  if (/DelegateActionInvalidSignature/u.test(error)) return 'invalid_signature';
  if (/DelegateActionSenderDoesNotMatchTxReceiver/u.test(error)) return 'sender_mismatch';
  if (/AccountDoesNotExist/u.test(error)) return 'account_missing';
  return null;
}

/** An answer of the relay: its HTTP status, JSON body and extra headers. */
export interface RelayAnswer {
  status: number;
  body: Obj;
  headers: Record<string, string>;
}

/**
 * The relay's answer for a result: `{transactionHash, status}` (D737), with the API's error fields on a failure. Pure,
 * so a test can hold a real node's outcome against exactly what a page receives (test-sandbox/stamps-site.test.ts).
 */
export function relayAnswerBody(result: RelayOutcome, sender: string, extra: Obj = {}): RelayAnswer {
  if (result.ok) return { status: 200, body: { transactionHash: result.nearTx, status: 'executed', nearTx: result.nearTx, ...extra }, headers: {} };
  const tx = result.nearTx ? { transactionHash: result.nearTx, nearTx: result.nearTx } : {};
  if (result.code === 'timeout') return { status: 504, body: { error: 'Timed out waiting for the transaction outcome; poll the transaction', code: 'timeout', status: 'pending', ...tx }, headers: {} };
  if (result.code === 'contract_rejected') {
    const reason = result.executor === sender || result.executor === null ? delegateFailure(result.error) : null;
    if (reason) return { status: 422, body: { error: 'NEAR refused the delegate action', code: 'delegate_rejected', reason, status: 'failed', ...tx }, headers: {} };
    return { status: 422, body: { error: result.error, code: 'contract_rejected', status: 'failed', executor: result.executor ?? null, ...tx }, headers: {} };
  }
  return { status: result.status, body: { error: result.error, code: result.code, ...tx }, headers: result.code === 'relayer_busy' || result.code === 'relayer_unavailable' ? { 'retry-after': '1' } : {} };
}
