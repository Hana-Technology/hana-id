// The Hana API's request ID on the client side (D405; batch C15's follow-up): the `requestId` every API answer and
// error carries (apps/api index.ts `newRequestId`: the `cf-ray` header when it matches `[A-Za-z0-9-]{1,64}`, else a
// random UUID), and the key staff look a request up by (`admin <env> support:lookup --request-id`, the admin console's
// Support ID lookup). The usage ledger keeps a user's uid only on ok events, so a failed request is found by its ID:
// the vault puts it in `data.requestId` of an error that came from an API answer, so a partner has one to escalate
// with. Not to be confused with the approval requests' own ids (protocol.ts `newRequestId`, 32 lowercase hex).
//
// A request ID is not secret (it names a request, not a user, and opens nothing), but it comes from an HTTP body, so a
// client takes only exactly that shape: never anything else of the API's answer.

/**
 * 8 to 64 of `A–Z a–z 0–9 -`: what the API sends (a cf-ray is 16 hex digits, `-` and the data centre, a UUID 36
 * characters), within what the lookup takes (console-core `requestId`, `[A-Za-z0-9_-]{8,128}`).
 */
export const API_REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/u;

export const isApiRequestId = (v: unknown): v is string => typeof v === 'string' && API_REQUEST_ID_RE.test(v);

/** `v` when it is a request ID, else null (a malformed value is dropped, never a reason to refuse anything). */
export const apiRequestIdOf = (v: unknown): string | null => (isApiRequestId(v) ? v : null);

/**
 * The first SDK version told `data.requestId` in a port error. The vault adds it only for an SDK whose `hana:hello`
 * names this version or a later one (support-id.ts `sdkAtLeast`), as the SDK gate does for `supportId`: an older SDK gets
 * exactly the error shapes it was built against. Ships with 0.2.0, the release that brings `supportId`.
 */
export const API_REQUEST_ID_SDK_MIN = '0.2.0';
