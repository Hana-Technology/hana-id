// Every error code the console's `/api/*` answers (console-core's RpcCode and CONSOLE_ERROR_STATUS, the console's own
// extras, and the SPA's `network`), in plain language with what to do next. The code itself is still shown, small,
// for support. The server's message is shown under it when it says something the code doesn't (an origin's reason,
// a validator's problems, a limit); it is the console's own text, never an upstream one (apps/console/src/http.ts).

export const ERROR_TEXT: Record<string, string> = {
  // The session and the request
  unauthenticated: 'Your session ended. Sign in again to continue.',
  session_ended: 'Not sent: your session had ended. Sign in again (the banner at the top), then do it again.',
  csrf: 'The console refused this request because it didn’t come from this page. Reload the page and try again.',
  network: 'The console couldn’t be reached. Check your connection, then try again.',
  rate_limited: 'Too many requests in a short time. Wait a minute, then try again.',
  internal: 'Something went wrong on Hana’s side. Try again; if it keeps happening, send Hana the code below.',
  near_unavailable: 'The NEAR network couldn’t be read just now. Try again in a minute.',
  payload_too_large: 'That is too large to send.',
  unsupported_media_type: 'The console can’t take that kind of file.',
  method_not_allowed: 'The console doesn’t accept that request. Reload the page and try again.',
  bad_request: 'The console couldn’t accept that. Check what you entered.',
  not_found: 'Not found, or you aren’t a member of it.',
  // Who may do what
  forbidden: 'Only an owner of this organisation can do this. Ask an owner to do it, or to make you an owner.',
  org_frozen: 'Hana has frozen this organisation: only cancels and kill switches work until it is unfrozen. Contact Hana.',
  not_owner: 'Your Google account isn’t an on-chain owner of this scope, so it can’t sign this. Ask an on-chain owner, or Hana.',
  passkeys_required: 'Joining a second organisation needs passkeys, which Hana hasn’t turned on yet. Contact Hana.',
  // Changes
  version_conflict: 'This changed while you were looking at it. Reload the page to see the current state, then try again.',
  conflict: 'That clashes with something already in place.',
  already_applied: 'That was already done. Reload the page to see the current state.',
  not_pending: 'It is no longer pending: it was cancelled, or it has already taken effect. Reload the page to see the current state.',
  no_security_contact: 'Your organisation has no security contact to announce this change to. Ask Hana to add one, then try again.',
  env_mismatch: 'That doesn’t fit this app’s environment (test or live).',
  scope_conflict: 'That clashes with the app’s scope on chain. Contact Hana.',
  token_used: 'That confirmation was already used. Start the change again.',
  owner_nonce_mismatch: 'Another owner action ran on this scope meanwhile. Reload the page and start again.',
  key_limit: 'An app can have at most 5 active keys. Revoke one you no longer ship, then create the new one.',
  origin_refused: 'Hana can’t accept that origin.',
  policy_invalid: 'The policy has problems. Fix them, then check it again.',
  invalid_client_proof: 'The pasted token isn’t a valid proof for that client. Run the helper again and paste its new token.',
  logo_type: 'Hana can’t use that image. Use a still PNG, JPEG or WebP, 128 to 2048 px a side and nearly square.',
  logo_too_large: 'That image is over 512 KiB. Export a smaller one and upload it again.',
  // Fresh sign-in
  step_up_expired: 'This confirmation expired or was already used. Nothing was changed: start the change again.',
  step_up_required: 'This change needs a fresh Google sign-in. Start it again from its page.',
  // Sign-in and invites
  not_invited: 'This Google account isn’t a member of any organisation on the console. Ask an owner of your organisation, or Hana, for an invite.',
  invite_invalid: 'This invite can’t be used: it was used, revoked or has expired, or it was sent to another address. Ask for a new one.',
  already_member: 'You’re already a member of that organisation. Sign in without the invite.',
  user_disabled: 'This account is disabled. Contact Hana.',
};

/** Server messages that only restate the code: not worth a second line. */
const GENERIC = new Set([
  'Not found',
  'Something went wrong',
  'Too many requests; try again in a minute',
  'Sign in again',
  'Method not allowed',
  'The request body is too large',
  'NEAR RPC is unavailable: try again',
  'Only an owner of the organisation can do this',
  'Hana has frozen this organisation: only cancels and kill switches work until it is unfrozen',
  'This confirmation has expired or was used: start again',
  'This invite link is not valid any more: it was used, revoked or has expired',
  'The logo is larger than 512 KiB',
]);

/** The plain text for `code`, and the server's message when it adds something. */
export function explain(code: string, message: string, status = 0): { text: string; detail: string | undefined } {
  const text = ERROR_TEXT[code] ?? (message && message !== code ? message : ERROR_TEXT.internal!);
  const adds = message && message !== code && !GENERIC.has(message) && message !== text;
  // A 404 on a page is "not found or not yours"; elsewhere the server's own words.
  return { text: status === 404 && code === 'not_found' ? ERROR_TEXT.not_found! : text, detail: adds && ERROR_TEXT[code] ? message : undefined };
}
