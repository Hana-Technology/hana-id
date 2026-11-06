# Email sharing with partners: build note (D411)

**Status: built on `feat/email-sharing` (2026-11-06), not merged.** It merges into `develop` after the user's first
round of M4 dashboard testing on sandbox-dev (D411 point 9 as amended 2026-11-06). Decided by the user as D411
("all as recommended", 2026-11-05); the details below that D411 left open were decided while building and are **to
confirm**: D420–D425. This note is a spec (history once merged): the current state is in `docs/api.md`
("Email sharing"), `docs/architecture.md` ("Email sharing with partners"), `docs/integration.md` section 15,
`docs/security.md` and `docs/operations.md` ("Email sharing keys"). It replaces `docs/identity-token-spec.md`
"Verified email: opt-in per app" and its email endpoints where they differ (D127's Q6/Q7 as amended by D411).

## What it does

A partner sees a user's email only after the user shares it with that app. The app setting `identity_email` decides
when Hana asks: `off` (default: never asked, never shared), `on_request` (only when the partner calls
`hana.requestEmailSharing()`), `at_login` (once per user and app, at the first login, before the wallet opens). The
user answers on one sheet that names the app and shows the exact address: **Share email** / **Not now**. "Not now"
always continues; nothing is mandatory. Once shared, the app's identity tokens carry `email` and
`email_verified: true` (`emailStatus: 'included'`), and the partner console's Users screen shows the address (an
**Email** column, "Not shared" otherwise). The user stops sharing from the approval popup's account line or from the
sheet `requestEmailSharing()` opens; a revoke drops the email from new tokens and from the dashboard at once.

No wallet address, path or key derivation changes: nothing here reaches the contract, the CKD request, the session
nonce or a path. The consent rows are keyed by the identity token's `sub` (`u1_…`), which is computed from the
session's on-chain path, never the other way round.

## Where the address comes from (D420)

Only the email issuer reads an address from its source (Google's userinfo, or the code the user proved), as before.
It hands the API the address **sealed**, as `docs/identity-token-spec.md` "The sealed email" specified (D127):

```
sealed_email = "se1." ‖ b64url( u32le(key_id) ‖ u64le(not_after_ms) ‖ iv(12) ‖ ct )
ct           = AES-256-GCM(IDENTITY_SEAL_KEY[key_id], json{"email","src"}, aad)
aad          = "hana-id/sealed-email/v1" ‖ 0x00 ‖ borsh(app_id) ‖ session_pk(32) ‖ u64le(not_after_ms)
not_after_ms = the session commitment's expiresAtMs
```

- Sealed by the issuer (`packages/email/src/sealed.ts`, shared with the API) in every successful google-match and
  google-record (a Google-verified address only: userinfo's, lowercased) and in a `verify` that mints a `session`
  token (the normalized login address), whatever the app's setting, whenever `IDENTITY_SEAL_KEY` is set. The session
  key comes from the commitment the issuer already checks against the token's nonce (google-match, google-record), or
  from the `session` challenge's commitment, now kept in the challenge record (`seal`).
- The vault keeps the blob with the session (memory and the IndexedDB record; it can't open it) and sends it with each
  mint and consent call: from the google-match or google-record answer for a Google session, from the popup's relay
  payload (`sealedEmail`, beside the email token) for an email session.
- The sheet shows the address in the auth popup, which asks the API to open the blob
  (`POST /v1/identity/email-consent/preview`, `Origin: AUTH_ORIGIN`) with a single-use session proof the vault made
  for that purpose. So the address reaches the issuer, the API (which keeps it only on a grant) and the popup, never
  the vault frame or the partner page.

## Data model: migration 0012 (D421)

`apps/api/migrations/0012_email_sharing.sql`, hot D1:

| Change | Columns |
|---|---|
| `apps` | `identity_email TEXT NOT NULL DEFAULT 'off' CHECK (identity_email IN ('off','on_request','at_login'))` |
| new `email_consents` | `app_id`, `user_sub` (the User ID `u1_…`), `email_mac` (32 bytes), `state` (`granted` / `declined`), `email` (the copy: set exactly when granted), `scope_id`, `decided_at`; PK `(app_id, user_sub, email_mac)`; indexes on `user_sub` and `(email_mac, state)` |

- One row per app × account × address. `email_mac = HMAC-SHA256(EMAIL_CONSENT_KEY, "hana-id/email-consent/v1" ‖ 0x00
  ‖ lowercase(trim(address)))`: a consent covers only the address it was given for (D411 point 5), and a declined row
  keeps no address. A grant writes the address in clear (`email`): the copy the partner console reads through
  `ConsoleRpc` (D275: never the issuer). A decline or a revoke sets `declined` and clears `email`.
- **`EMAIL_CONSENT_KEY` is a new API secret** (32 bytes, `.secrets/<env>/email-consent-key`), not `IDENTITY_SUB_KEY`
  or `USER_ID_KEY`: no doc gives either that purpose. **`IDENTITY_SEAL_KEY` is new too** (`<id>:<32 bytes base64>`,
  `.secrets/<env>/identity-seal-key`), on both the API and the issuer, as the identity token spec planned; the API also
  reads `IDENTITY_SEAL_KEY_PREVIOUS` during a rotation. Both are generated and uploaded by
  `scripts/identity-key.ts <env> email-keys` (flagged for the user: a setup step before any env shares emails).
  Without them every consent endpoint answers `503 email_sharing_unavailable` and tokens carry no email.
- Not on chain (public) and not in the vault's storage (per device), as D411 point 4 says.
- Deleted: by `uid-erase` (C13, the account's User IDs), with the app (the monthly retention job, 30 days after the
  app's deletion, with the wallet directory's purge), and never otherwise: a decline must be remembered.

## API (D422, D423)

Every endpoint takes the identity token's session proof (`sessionPublicKey`, `issuedAtMs`, `nonce`, `signature`;
±60 s, single use, the same marker as a mint) over the payload `"email-consent" ‖ borsh(action) ‖ borsh(parent_origin)
‖ sha256(sealed_email or "")`, then checks the share ('session' mode) and the on-chain session as a mint does, and
computes the `sub` from the session's path.

| Endpoint | Caller | Does |
|---|---|---|
| `POST /v1/identity/email-consent/state` | vault | `{setting, state}`: `state` is `granted`, `declined` or `not_asked` for the session's sealed address, `unavailable` when the session has no address the API can read |
| `POST /v1/identity/email-consent` | vault | `decision` `granted` / `declined` for the sealed address (`409 identity_email_off` when the setting is off) |
| `POST /v1/identity/email-consent/revoke` | vault | every address of this app × account → `declined`, copies deleted (allowed whatever the setting) |
| `POST /v1/identity/email-consent/preview` | auth popup | `{email}`: the sealed address, for the sheet only |

The mint (`POST /v1/identity/token`, D423): setting `off` → `emailStatus: 'off'`; a sealed address that opens →
its own consent decides (`included` with that address, `declined`, `not_asked`); no readable seal (`missing`,
`invalid`) → the account's most recently shared address for the app, if any (`included`). `GET /v1/app` gains
`identityEmail`.

## Screens (D424)

- **The sheet**, `/share-email` on the auth origin (its own page, entry and CSP: `connect-src` the API only): the app's
  logo and name, the address, "{App} can then email you and recognise your account. You can stop sharing later; {App}
  may keep the address it already received." For an app on its own Google client, the D42 caveat: "{App} signs you in
  with its own Google client, so Google may give it your address whatever you choose here." Buttons **Share email**
  (the approval popup's guarded click, D36) and **Not now**. Already shared: "You share {address} with {App}" with
  **Stop sharing** and **Done**.
- **At login (`at_login`)**: when the vault's auth-params say `emailShare`, the login popup doesn't close at its end:
  the callback (record-only Google login) or the email page's follow-up mode (on `done`) navigates the same window to
  `/share-email?from=login`. The vault, after the key passed its check and before it answers `hana_login`, asks the
  API the state; `not_asked` → it sends that window the sheet (`hana:email-share-request`) and waits for the answer,
  else it tells the window to close. A closed window, no hello within 20 s, or any failure: the login finishes
  without asking (asked again at the next login). For a Google record-only login the vault awaits google-record (its
  30 s limit) to get the blob.
- **`requestEmailSharing()`**: the SDK opens `/share-email?from=partner&v=<vault frame>` in the click (popup blocked:
  the vault's launcher), the vault sends the sheet for the session's address, records the answer and resolves
  `'granted'`, `'declined'` or `'dismissed'` (the window closed: nothing recorded).
- **Revoke**: the approval popup's account line shows "Email shared with {App} · Stop sharing" while the state is
  `granted` (D424); the sheet above too. A revoke covers every address of the app × account.

## SDK (D425)

`packages/web` 0.3.0 (all four packages move together): `hana.requestEmailSharing(): Promise<'granted' | 'declined' |
'dismissed'>`; the event `emailSharingChanged` (`'granted' | 'declined'`) after any change made on this device (the
vault drops its cached identity token, so the next `getIdentityToken()` mints with or without the email); the vault
sends the event only to an SDK of 0.3.0 or later (`EMAIL_SHARING_SDK_MIN`, D393's gate). Errors:
`email_sharing_unavailable` (`data.reason`: `off`, `no_address`, `unavailable`), 4100 when logged out, `busy` during a
sign-in. `packages/react`: `useEmailSharing()` → `{request, state, error}`.

## Settings, consoles, CLI

- `identity_email` through `updateSettings` (`identityEmail`, immediate: turning it on shares nothing until users
  agree; off stops at once, the vault's 30 s app cache aside): `admin <env> app:settings <app> --identity-email
  off|on_request|at_login`, the partner console's app settings, `AdminRpc.updateSettings`. Recorded in `app_changes`
  (`settings.changed`) like every setting.
- Partner console Users screen: `PartnerUser.email` (the most recently shared address among the org's apps in the
  user's scope, or null → "Not shared") and, in a user's detail, `emails` per app. Search by a full address only, as an
  exact MAC lookup over `granted` rows of the org's apps (D315's rule: an unshared address can't be probed, and no
  prefix search). No new audit rows: the console audits no reads, and setting changes are in `app_changes`.
- Staff: the admin Users screen already shows the issuer's address; no change. The admin's monthly retention job adds
  "email consents of deleted apps" to its counts.
- The demo (`apps/demo`): a "Share email…" button beside "Get identity token".

## Open questions (to confirm)

1. Usage counts of emails included per app and day (`identity_usage`): not built (D411 doesn't ask for it).
2. Hana Home will list every consent; until then the approval popup and the sheet are the only revoke paths, so an
   app whose signing is all auto-approved shows its users only the sheet (when the partner offers it).
3. A linked account's second address: tokens carry the session's own address; a session without a readable seal
   falls back to the latest shared address (D423).
