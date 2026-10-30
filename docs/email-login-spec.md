# Email login and account linking spec (pre-mainnet)

**Status: APPROVED (2026-10-30), not built.** Every open question is answered (below and
[Open questions](#open-questions-for-the-user)): `docs/decisions.md` D4 (confirmed), D119, D121–D123, and the
amendments to D25 and D96.

This file is the source of truth for the batch once approved. If code and this spec disagree, fix the code or raise
the problem. Reference docs (`contract-interface.md`, `security.md`, `architecture.md`, `api.md`, `integration.md`,
`operations.md`) are updated in the same branches as the code, not now.

## Confirmed by the user (2026-10-29/30)

1. **Hana runs the email issuer** (D4). No vendor. An email one-time-code flow on `authOrigin` plus a Hana issuer
   service that mints RS256 OIDC-shaped ID tokens, verified on chain like Google's. Vendors (Auth0, Stytch, Firebase)
   were considered and rejected ([Vendors considered and rejected](#vendors-considered-and-rejected)). The email
   provider behind the sender interface is still to confirm with the colleague (D87 is provisional).
2. **Automatic linking like Privy, with the email kept off chain** (option B; replaces an earlier "explicit linking
   only" instruction of the same day). The user tested `demo.privy.io`: an email login and then a Google login with the
   same Gmail address landed on the same Privy user and wallets. Hana does the same:
   - the Google ID token that goes on chain stays openid-only (D25's goal: no email or other PII on chain);
   - at login the Hana popup also obtains the Google account's verified email **off chain** (an access token for the
     `email` scope, checked by the issuer against Google's userinfo endpoint; [How the popup gets Google's
     email](#how-the-popup-gets-googles-verified-email));
   - when Google says the email is verified and an email identity with that address exists, the issuer mints a Hana
     email token for it and the contract links the two identities using pseudonymous ids only; an email login whose
     address belongs to a Google-linked account resolves to that account;
   - explicit "add a login method" (`hana.linkAccount()`) stays available for identities whose emails differ;
   - safeguards: a notice on every new link, never a second wallet for a matched person (decision 5), the
     Workspace-domain rule of decision 4 ([Automatic linking](#automatic-linking-privy-style)).
3. **Signing key (Q2, D121).** Testnet now: an RSA key held as a Cloudflare Worker secret of the issuer. Before
   mainnet: AWS KMS `RSA_2048` in a dedicated AWS account; root access held by both founders with hardware security
   keys, recovery details offline; the issuer Worker's IAM access key limited to `kms:Sign` on the issuer's keys with
   the algorithm pinned, rotated every 90 days and on suspicion; CloudTrail; an hourly reconciliation of the KMS `Sign`
   count against the issuer's own login log; volume and budget alarms; alerts on any IAM or KMS policy change. The
   contract's email issuer config and the token format are **two-signer-ready from day one**: signers with their keys
   plus a required count (1-of-1 at launch), tokens that can carry several signatures, the watchdog pinning every
   signer key. Staged plan: Level 1 (an independent audit-and-throttle co-signer on another cloud) once email users
   hold meaningful funds; Level 2 (the code split between two senders) only if "no single Hana compromise" becomes a
   product promise; Level 3 (TEE) later ([Signing key](#signing-key-staged)).
4. **Automatic linking rules (Q15, Q16, D119)**, decided by whether Google hosts the mailbox in the same account.
   **Google-hosted** = an `@gmail.com` / `@googlemail.com` address, or a Workspace account whose `hd` equals the
   email's domain; `hd` absent or different = not Google-hosted.
   - Case A (an email-login wallet exists, a Google login with the same email joins): Google-hosted → linked at once;
     otherwise a one-time code to the address first, then linked at once. Always a notice.
   - Case B (a Google wallet exists, an email login joins): the user continues with Google and reaches the wallet at
     once; the email → wallet link is created from that Google sign-in. Google-hosted → linked at once; otherwise the
     link takes effect after 24 h (`change_delay_ms`), with a notice in the wallet and in the partner app (not only by
     mail: the mailbox may be the attacker's), cancellable within the window.
5. **No second wallet for a matched person (Q18, D122).** When a match is detected the popup offers only "Link and
   continue" (under decision 4's rules) or "Sign in with {the other method}". No switcher (its build step is removed).
   Case D (both already have a wallet) can't arise: sandbox-dev's test data is discarded at the address freeze, and
   different emails or different apps are separate wallets by design ([The four cases](#the-four-cases)).
6. **Every other open question takes this spec's recommendation** (D123, listed under
   [Open questions](#open-questions-for-the-user)): the separate issuer Worker, per-scope `aud` (a partner turns
   email off with `remove_client`), disposable-email domains blocked, 72 h delay for email issuer keys, links per
   scope, partners enable email per app, no stored user email addresses (D96), the proposed limits and budget.

## Amends

| Document | Amendment |
|---|---|
| `decisions.md` D4 | Email login specified here; confirmed 2026-10-30 (with D119, D121–D123). |
| `decisions.md` D25 | Hana now asks Google for the `email` scope in the login popup and handles the verified address **off chain, transiently**, keeping only an HMAC of it; the on-chain token stays openid-only. Amended 2026-10-30 ([Decisions recorded](#decisions-recorded)). |
| `decisions.md` D96 | Hana still stores no user email address. It now sends end users two kinds of message they triggered themselves: sign-in codes and link notices. |
| `contract-interface.md` | New issuer kind (self-issued, with a signer policy: signers, keys, required count), multi-signature tokens for it, identity-link registry, `opened` wallets, link methods and layouts, session path resolution; state layout v3. No change to any existing byte layout or to the path of an unlinked identity. |
| `batch-b-spec.md` "Login" | The popup offers Google and email; Google adds the `email` scope (off-chain use only); the vault resolves the path through the link registry instead of fixing `scope#google#sub#k`. |
| `governance-spec.md` "Watchdog service" | Checks every email signer's keys and the signer policy against pins; email keys are owner-posted only and wait `governance_delay_ms`; the signer list and required count change only through a governed upgrade. |
| `batch-c-spec.md` admin and partner consoles | Email-issuer and link monitoring views; per-app email toggle ([Admin portal hooks](#admin-portal-hooks-batch-c)). |

## Goal

A user can sign in with an email address and a one-time code, get a Stellar and an EVM wallet exactly as with Google,
and use Google and email interchangeably on one wallet. Concretely, the batch is done when:

- An app with email enabled shows "Continue with Google" and an email field in the Hana login popup. An email login
  sends a 6-digit code, the user types it in the popup, and the wallet appears with no PII on chain (the token carries
  `iss aud sub iat exp nonce jti` only; `sub` is a pseudonym).
- The same person signing in with email and then Google (same address) gets the same addresses after "Link and
  continue" (a code first unless Google-hosted), and the reverse order does too (through a Google step, see
  [case B](#the-four-cases)). A matched person never gets a second wallet.
- `hana.linkAccount()` adds a login method with different credentials after a delay and a notice.
- An existing Google user who never touches email keeps the same address, bit for bit.
- The email issuer's key changes are owner-only, public for `governance_delay_ms`, and cancelled by the watchdog
  unless they match pinned fingerprints; the contract verifies email tokens against a signer policy (1-of-1 at launch)
  that can require more signers without a format change. The signing key is a Worker secret on testnet and
  non-exportable (AWS KMS) before mainnet.
- Every behaviour under [Tests](#tests) has a passing test, including a Playwright run with a stub email sender.

## Address impact (read first)

**No existing address changes.** An identity that isn't linked resolves to exactly today's path
`{scope_id}#{provider}#{sub}#{key_index}` (`sessions.rs` `create_session`); the CKD request, nonce layouts,
derivation v1 and the signer account are untouched.

New, and **frozen at the address freeze** (after it, never changed; before it, any change moves every email user's
address on sandbox-dev and must be called out):

| Input | Value | Why it decides addresses |
|---|---|---|
| Provider name in the path | `email` | path = `s1#email#<sub>#0` |
| Email normalization | [Email normalization](#email-normalization), including the Gmail canonical form | feeds `sub` |
| `sub` derivation | `"e1." ‖ b64url(HMAC-SHA256(K_sub, "hana-id/email-sub/v1" ‖ 0x00 ‖ utf8(normalized)))` | the path's `sub` |
| `K_sub` | 32 random bytes, generated once per env | losing it locks every email user out; replacing it moves every email address |

Linking never changes an address either: a linked identity opens its account's root path, which is the root
identity's existing path; unlinking returns an identity to its own path. A wallet's address is always the path of the
identity that created it. The signing key and the signer policy don't feed `sub` or the path, so adding a co-signer
or moving the key to KMS changes no address.

## Current state (verified against the code, `develop` at 97388f3)

- `verify_token` (`issuers.rs`) maps `iss` → provider through `iss_index`, needs an **active** kid of that issuer,
  RS256 only (`oidc.rs`), `exp` in the future, `sub` 1..=255 bytes without `#` (`lib.rs` `valid_sub`), `aud` 1..=256
  bytes. It is provider-generic: an `email` issuer is `set_issuer("email", [iss])` plus keys.
- `create_session` (`sessions.rs`) resolves the scope from `(provider, aud)` (`registry.rs` `session_scope`: a scope
  client only in its scope, a shared client in an `allow_shared` scope), checks the session nonce, and stores
  `path = format!("{}#{}#{}#{}", scope_id, token.provider, token.sub, key_index)`. `create_session_and_derive` is
  `create_session` then `derive_key(…, 1, …)` in one receipt.
- Issuer keys (`issuers.rs`): `set_issuer_key` by the owner or "self" (the updater key) queues an `Add` that waits
  `key_change_executable_at` (issuer-key delay, `keys_slow_until_ms`, governance delay while no watchdog may confirm);
  a watchdog may confirm early; the owner or a watchdog cancels; `remove_issuer_key` (owner) is immediate.
- The watchdog (`apps/watchdog/src/run.ts`) checks Google only: a pending change for another provider is an
  `unverifiable_key_change` critical alert (alert only), except one the updater proposed, which it cancels as
  `updater_other_provider` and then deletes the updater keys. The active-key check reads `get_issuer_keys("google")`
  only.
- The API knows Google's `iss` values only (`apps/api/src/jwt.ts` `ISSUER_PROVIDERS`); `GET /v1/app` returns a Google
  client only (`handlers.ts` `handleAppConfig`, 409 `no_google_client`); the claim allow-list
  (`iss azp aud sub iat exp nonce nbf jti auth_time`) is on `/v1/login`.
- The vault and export window hard-code Google in the path (`packages/web/src/vault/login.ts:357`,
  `auth/export-page.ts:457`) and the record check (`vault/vault.ts:1208`, `startsWith(scope#google#)`). `/login` makes
  no API call and has no `connect-src` (D77).
- An `Email` sender interface exists in the watchdog (`apps/watchdog/src/channels.ts`, Resend adapter); batch C
  specifies an `EmailSender` for the admin Worker (not built). State layout is v2 (`governance.rs` `STATE_VERSION`).

## Email issuer (Hana-run)

### Components and trust boundaries

A new Worker, **`apps/email-issuer`**, separate from the API Worker (Q1), on Hana's main Cloudflare account, routed at
`{apiUrl}/v1/email/*` (Q5). It alone holds the signing credential (the key itself on testnet, the AWS credential
that can call KMS `Sign` before mainnet), `K_sub`, the email provider key for user mail and the code-hash key. The
API Worker holds none of them, so the API's large attack surface (relays, vault, owner actions) doesn't reach the
signing path. The issuer has no chain-write keys; it
reads chain views through the manifest `rpc`.

| Part | Holds | Can |
|---|---|---|
| Login popup (`authOrigin`, `/login/email`) | the email address the user typed, the code, the challenge id, `relayKey` | start and verify a challenge; relay the token to the vault (as batch B's callback does) |
| `apps/email-issuer` | `ISSUER_SIGNING_KEY` (testnet: the RSA private JWK) or `ISSUER_AWS_*` (mainnet: KMS `Sign` only), `K_sub`, `K_code`, `USER_EMAIL_API_KEY` | send codes, mint tokens for the purposes below, publish its JWKS |
| `EmailChallenge` Durable Object (in the issuer) | per challenge: email (for resend only), code HMAC, purpose, commitment, attempts, expiry | single-use code check |
| AWS KMS (dedicated AWS account; before mainnet) | the RSA private keys, non-exportable | sign a 32-byte digest for the issuer's IAM principal |
| Co-signer (Level 1, later; another cloud) | its own key | audit, throttle and co-sign ([Signing key](#signing-key-staged)) |
| Email provider | each message while it delivers it | see every code it delivers (a trust root, below) |

### Issuer configuration

- Manifest (`packages/env`): `emailIssuer: { iss, signer: { kind: "worker-secret" } | { kind: "aws-kms",
  kmsKeyArns: [primary, standby], awsRegion }, from }`; `local*` and testnet envs take `worker-secret`, mainnet only
  `aws-kms` (`gen` refuses otherwise). `iss` = `{apiUrl}/v1/email` on sandbox-dev, `https://<api-domain>/v1/email` in
  production; `iss` is not in the path, so it may change later (`set_issuer` keeps up to 4 values).
- On chain: `set_issuer("email", [iss])`, `mark_self_issued("email")`, which sets the signer policy `{signers:
  ["hana"], required: 1}` ([Contract changes](#contract-changes-contractshana-signer)), then one
  `set_issuer_key("email", key, signer: "hana")` per key (primary, standby), posted by the owner DAO.
- Per app: the scope gets the client `("email", "email:" + scope_id)`. Registered by Hana in `admin_register_scope`
  for new scopes, or by `propose_change(AddClient)` with a client proof the issuer mints for staff only (below).
  `remove_client` turns email off for that app at once (the partner's on-chain veto); re-adding is timelocked like
  any client. A per-scope `aud` (instead of one shared email client, Q4) means email works in scopes without
  `allow_shared` (Enterprise own-client apps, D42), keeps `Token is for another app` isolation, and needs no change to
  `session_scope`.
- `GET /v1/email/.well-known/openid-configuration` and `GET /v1/email/jwks.json` publish `iss`, the JWKS (every
  signer's keys, `kid` = RFC 7638 JWK thumbprint), `id_token_signing_alg_values_supported: ["RS256"]`. Informational:
  the contract never fetches it and the watchdog doesn't trust it (it pins).

### Endpoints

All are `POST` with JSON, CORS-allowed for `authOrigin` only, no cookies (D70), and every response is
`Cache-Control: no-store`. Bodies carry no `email` field except `start`.

| Endpoint | Body | Result |
|---|---|---|
| `/v1/email/start` | `{pk, email, purpose, commitment}` | always `202 {challengeId, expiresAtMs, resendAfterMs}` for any syntactically valid address on an allowed domain (enumeration-safe); `400 invalid_email`; `400 email_domain_not_allowed` (a disposable-address domain: says nothing about the user); `429 rate_limited` (same body and timing whatever the address) |
| `/v1/email/resend` | `{challengeId}` | `202` (a new code, the old one dies; ≤ 2 resends) |
| `/v1/email/verify` | `{challengeId, code}` | `200 {idToken, googleWallet: bool, linkTicket?}`; `400 code_invalid {attemptsLeft}`; `410 challenge_expired` (expired, used, or out of attempts); `429`. `googleWallet` is the `email_hints` lookup (case B); `linkTicket` (32 random bytes, single use, 10 min, bound to the app and this address's `sub`) lets the following Google step join this email identity without a second code |
| `/v1/email/google-match` | `{pk, accessToken, googleIdToken, commitment, linkTicket?, link: bool}` | `200 {decision, googleHosted, emailToken?}` ([Automatic linking](#automatic-linking-privy-style)); `emailToken` is an `auto_link` token for the joining email identity, minted only when the user chose "Link and continue" (`link`) and the case allows it (Google-hosted case A, or a `linkTicket` whose `sub` equals the Google account's verified address) |
| `/v1/email/jwks.json`, `/.well-known/openid-configuration` | — | public keys |
| `/v1/email/admin/client-proof` | `{scopeId, actionNonce}` | a token for `("email","email:"+scopeId)` whose nonce is `client_proof_nonce(signer, scopeId, actionNonce)`; behind Cloudflare Access plus the staff allowlist (D88), audited |

`purpose` is one of `session`, `link_new`, `link_account`, `link_change`, `auto_link`. `commitment` carries every
input of that purpose's nonce (never the nonce itself): for `session`, the session nonce fields `{scopeId,
sessionPublicKey, expiresAtMs, keyIndex, maxUses, salt}`; for the link purposes, the fields in [Byte
layouts](#byte-layouts-new). **The issuer computes the nonce itself** (with the pinned `signer`), so an email token can
only ever serve the purpose it was minted for: never a register proof, an owner-action token or a client proof for
another app. The scope comes from `pk` (D1 app → `scope_id`) and must equal `commitment.scopeId`; the app must be
active, have email on (D1 `login_methods`), and its scope must hold the email client (cached chain read, 60 s).

### The token

**Two-signer-ready format: JWS General JSON Serialization** (RFC 7515 §7.2.1) from day one, with one signature at
launch:

```json
{"payload":"<b64url(claims)>","signatures":[{"protected":"<b64url({\"alg\":\"RS256\",\"kid\":\"<thumbprint>\"})>","signature":"<b64url>"}]}
```

Each entry signs `protected_i ‖ "." ‖ payload` (ASCII) on its own, so a co-signer needs only the payload and adds an
entry; no header is shared between signers. The string goes where a JWT goes today (`jwt`, `link_jwt`, `/v1/login`
`idToken`); Google tokens stay compact. At most 3 entries, each `kid` distinct. Claims, exactly:

| Claim | Value |
|---|---|
| `iss` | the manifest `emailIssuer.iss` |
| `aud` | `"email:" + scope_id` |
| `sub` | `"e1." + b64url(HMAC-SHA256(K_sub, "hana-id/email-sub/v1" ‖ 0x00 ‖ utf8(normalized)))` (46 characters, no `#`) |
| `iat`, `exp` | now, now + 600 s (only needs to land in one `create_session*`; the vault retries within it) |
| `nonce` | computed by the issuer for the purpose ([Byte layouts](#byte-layouts-new)) |
| `jti` | 16 random bytes, b64url |

Every claim is in the batch B allow-list, so `/v1/login` applies it unchanged to the payload (it parses the JSON form
for self-issued providers); no `email`, `email_verified` or name claim ever appears. Signing: `digest =
sha256(protected ‖ "." ‖ payload)`, RS256 (PKCS #1 v1.5 over SHA-256, exactly what `oidc.rs` `verify_rs256`
checks): WebCrypto with the Worker-secret key on testnet, KMS `Sign` with `MessageType=DIGEST`,
`SigningAlgorithm=RSASSA_PKCS1_V1_5_SHA_256` before mainnet. The issuer verifies each signature with the public key
before answering (a KMS or wiring fault never reaches the chain). It logs `jti`, purpose, app, `kid`, time; never the
email, code, `sub` or the token.

### `sub`: HMAC of the normalized email (decided, Q6) vs a stored random id

The contract only sees `sub`. It must be stable across apps (the path already separates apps), never reveal the
address on chain, and be recomputable whenever the user returns.

| | HMAC with `K_sub` (decided) | Random id in an issuer table |
|---|---|---|
| Stable across apps and devices | yes, a pure function of the address | yes, while the row exists |
| What reveals the email | `K_sub` plus a guess (offline dictionary over on-chain subs) | the table (it maps an address hash to the id) |
| Data Hana must keep forever | `K_sub` (32 bytes, backed up offline) | every row; losing a row strands that user's wallet |
| Recovery after a Hana data loss | from the backup of one secret | from database backups only, as of the last backup |
| Email change | a new address is a new identity: link it ([Explicit linking](#explicit-linking-add-a-login-method)) | could re-point a row, but that is a silent key move Hana alone decides: refused anyway |
| Erasure request | nothing to erase (Hana stores no address); the wallet stays derivable by the user | deleting the row destroys the user's access, not their data on chain |
| Index for linking | the chain itself: `get_identity(scope, "email", sub)` | an extra table lookup |

`K_sub` is not a signing key: a leak lets the holder test guessed addresses against on-chain subs (privacy), never
mint a token. So it can be a Worker secret of the issuer with two offline backups (`.secrets/<env>/email-sub-key`,
0600, plus the offline copy the user keeps with the council backup, D81), not a non-exportable KMS HMAC key: a KMS
key whose material can't leave AWS would make every email wallet depend on one AWS account forever (Q6). It is never
rotated; a future scheme would be `e2.` subs with an opt-in link from `e1.`.

### Email normalization

Applied by the issuer before HMAC; implemented once in `packages/email` with frozen vectors (`vectors/email-v1.json`)
and a guard test, like derivation v1.

1. Trim ASCII whitespace; reject anything over 254 bytes, without exactly one `@`, or with a local part over 64
   bytes.
2. Domain: IDNA to ASCII (UTS #46, non-transitional), lowercase, strip one trailing dot; must be a valid DNS name with
   at least one dot.
3. Local part: ASCII only in the MVP (no SMTPUTF8; `400 invalid_email`), lowercase (every large provider treats it
   case-insensitively; RFC 5321 allows otherwise, and the rare case-sensitive mailbox loses nothing but a merge).
4. **Gmail canonical form**, for `gmail.com` and `googlemail.com` only: domain → `gmail.com`, drop everything from the
   first `+`, remove every `.` from the local part. Google documents that dots don't change a Gmail address and that
   `+suffix` delivers to the same inbox (to cite in the guard test's comment; Q7). Without it, `a.b@gmail.com` typed
   at email login and `ab@gmail.com` reported by Google would be two identities and never merge.
5. No other provider-specific rules (`+tags` elsewhere may be distinct mailboxes).

### Codes, attempts, expiry, replay

- Code: 6 decimal digits from `crypto.getRandomValues` with rejection sampling. Stored only as
  `HMAC-SHA256(K_code, challengeId ‖ code)` in the challenge object; compared in constant time.
- Expiry 10 min; 5 wrong attempts kill the challenge; a correct code is single-use (the object is deleted, then the
  token minted). Resend: new code, old one dead, ≥ 30 s apart, ≤ 2 per challenge. A guess succeeds with probability
  ≤ 5 × 10⁻⁶ per challenge, ≤ 5 × 10⁻⁵ per address per day under the limits below.
- The challenge binds `{appId, purpose, commitment hash, email}` at `start`; `verify` needs only `{challengeId, code}`
  and can mint only that one token. The token's own replay protection is its nonce: a session nonce is spent by
  `session_key_in_use`; link nonces commit to the account `epoch`, which every link change bumps.
- The popup keeps `challengeId` in its own `sessionStorage` under the login's `relayId`, like batch B's state.

### Rate limits and abuse

Keys use `email_key = HMAC-SHA256(K_rl, normalized)` (a separate key, so limiter state never holds an on-chain id).

| Limit | Value (provisional) | Store |
|---|---|---|
| Codes per address | 3 per 15 min, 10 per day | `RateLimiter` object (exact) |
| Wrong codes per address | 10 per hour over all challenges → 1 h lock (silent: `start` still answers 202, nothing is sent) | same |
| `start` per IP | 10 per 10 min, 50 per day | Rate Limiting binding (approximate, D95) |
| `verify` per IP | 30 per 10 min | binding |
| Per app | `start` 20 × `per_minute` of the app's plan per minute, a daily cap; partners see refusals in their console | `RateLimiter` |
| Global | a daily send budget per env with a breaker (refuse new `start` at the cap, critical alert) | `RateLimiter` |

Email bombing is bounded by the per-address limits; cost abuse by the per-app and global budgets. Cloudflare
Turnstile would add a third-party script to `authOrigin`, against batch B's "no third-party script" rule, so it is not
used (Q9). Disposable-address domains are blocked (Q10): a vendored, pinned domain list in `packages/email`
(updated by PR, reviewed like code; never containing a Google-hosted domain, guard test), checked at `start` after
normalization; `400 email_domain_not_allowed`. Partners can't turn the block off in the MVP.

### Enumeration resistance

The issuer keeps no user list (`sub` is a function of the address), so there is nothing to enumerate server-side.
`start` answers the same `202` and the same timing for every valid address, whether it has a wallet, is suppressed
(bounced or complained) or is locked; suppressed and locked addresses simply get no mail. `verify` reveals only
whether the code was right. Chain state is keyed by `sub`, which needs `K_sub` to compute.

### Phishing: codes, not magic links

Codes keep the whole flow in the Hana popup that holds the login's `relayKey` and session commitment. A magic link
opens in whatever browser the mail app picks (often an in-app webview on mobile), outside that popup, and mail link
scanners that prefetch URLs would spend single-use links. Codes are phishable: an attacker can start a challenge for a
victim's address with the attacker's own commitment and talk the victim into reading out the code, which gives the
attacker the victim's email wallet **in the scope named in the email**. Mitigations, none complete (as for every OTP
system): the mail names the app ("named by the app", D118 display rules) and `authOrigin`, and says "type this code
only in the Hana window you opened; Hana never asks for it by phone, chat or on another site"; 10-minute expiry; the
link purposes use different wording ("add this email to an existing wallet"); CORS limits browser-based relays to
`authOrigin` (not scripts). The vault's existing guarded flows (approval, export with a fresh sign-in, D27) still
apply after login.

### Deliverability

A dedicated sending subdomain for user mail, separate from the partner-notice subdomain (D87), so a complaint spike on
codes can't hurt partner notices, with SPF, DKIM and DMARC (`p=quarantine` at launch). Plain text plus simple HTML, no
images, no links in code mails (better filtering, nothing to phish with); link notices link only to `authOrigin`.
Subject "Your sign-in code for {app}" (the code stays out of the subject, so lock-screen previews don't show it to
bystanders; Q8). The provider's bounce and complaint webhooks feed `email_suppressions(email_key, reason, at)`.
Bounce and complaint rates per day are shown in the admin portal and alert above provider thresholds.

### Privacy and what is stored

| Data | Where | Retention |
|---|---|---|
| The email address | issuer memory during `start`; the challenge object (for resend) until it ends (≤ 10 min); the provider while it delivers (its log retention set to the minimum the plan allows) | never in D1, logs or chain |
| `email_key` (HMAC under `K_rl`) | limiter objects, `email_suppressions` | limiter windows; suppressions until the user asks (by entering the address on a Hana page) |
| `sub` (HMAC under `K_sub`) | chain (paths, tokens in tx args), `email_hints` | chain: forever (public); hints: while the scope exists, refreshed at every Google login (an expired hint would let a matched person get a second wallet, D122) |
| Issuance log `email_issuance(jti, app_id, purpose, kid, iat)` | issuer D1 | 24 months (D90 raw usage) |
| The Google email (auto-linking) | issuer memory during one `google-match` call | never stored; only the `sub` derived from it |

On chain: tokens (with `sub`), paths in MPC requests and link records are public forever. Linking reveals that two
pseudonymous ids belong to one person ([Privacy of links](#privacy-of-links)). D90's retention applies to the logs.

### Signing key (staged)

Decided by the user (Q2, D121). `IssuerSigner` (`sign(digest) → signature`, `publicKeys()`) has a WebCrypto adapter
(Worker-secret key) and a KMS adapter; the manifest's `emailIssuer.signer` picks one.

| Stage | Signer(s) | Policy on chain | When |
|---|---|---|---|
| Testnet now | `hana`: an RSA-2048 private JWK as the Worker secret `ISSUER_SIGNING_KEY`, backed up in `.secrets/<env>/email-issuer-signing-key.json` (0600), never printed (`scripts/email-issuer.ts init`) | 1-of-1 | `local*`, sandbox-dev |
| Mainnet launch | `hana`: AWS KMS, below | 1-of-1 | before mainnet (rehearsed on staging) |
| Level 1 | `hana` plus an independent **audit-and-throttle co-signer** on another cloud (e.g. Google Cloud KMS in a separate project and account, its own admins): it gets the payload from the issuer, enforces a per-`sub` hourly cap and a global daily cap, keeps its own log, and co-signs | 2-of-2 | once email users hold meaningful funds |
| Level 2 | the 6-digit code split between two senders (each signer sends and checks its half) | 2-of-2 | only if "no single Hana compromise" becomes a product promise |
| Level 3 | an issuer in a TEE with attested code holding a sealed key | to decide | later |

A Worker-secret key is exportable: anyone who can deploy the Worker or read its secrets can copy it once and forge
undetected. Accepted for testnet only (no real funds); mainnet never takes `worker-secret` (`gen` refuses).

**Signer policy (two-signer-ready from day one).** The contract keeps, per self-issued provider, `signers` (ids, each
with its active keys: `hana` has the primary and the standby) and `required` (1 at launch). A token passes when
signatures from at least `required` **distinct** signers verify, each against an active key of that signer (two
`hana` keys count once); a signature whose `kid` isn't a listed signer's active key is refused. Signer keys rotate
through `set_issuer_key(provider, key, signer)` (owner, 72 h, pinned). The signer list and `required` change only
through a governed contract upgrade (`migrate`, 2-of-3 DAO, `governance_delay_ms`, D33, D81), never a method: going
to 2-of-2 is one upgrade that adds the co-signer with its keys (pinned by the watchdog before it executes) and sets
`required: 2` with a ~10-minute overlap (`overlap_until_ms = now + 600 s`, the token lifetime) during which tokens
valid under the previous policy (one `hana` signature) still pass; the issuer adds the co-signature as soon as it reads the new policy. No
address changes: `sub` doesn't depend on any signing key.

**Mainnet: AWS KMS asymmetric keys, `RSA_2048`, `SIGN_VERIFY`, in a dedicated AWS account.**

- Account: root access held by both founders, each with hardware security keys; recovery details kept offline.
- Non-exportable: the private key never leaves KMS's HSMs in plaintext; only `Sign` with the issuer's credential uses
  it. A stolen Worker secret is then a credential to revoke, not a key to remove from the chain, and every use is
  logged.
- How the Worker calls it: `POST https://kms.<region>.amazonaws.com/` with `X-Amz-Target: TrentService.Sign`, SigV4
  signed with `aws4fetch` (a small, dependency-free SigV4 client for Workers), body `{KeyId, Message: base64(digest),
  MessageType: "DIGEST", SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256"}`.
- IAM: a dedicated IAM user (Workers can't assume roles without another long-lived secret) whose only permission is
  `kms:Sign` on the issuer's key ARNs, with conditions `kms:SigningAlgorithm = RSASSA_PKCS1_V1_5_SHA_256` and
  `kms:MessageType = DIGEST`. The key policy grants administration to a break-glass role with MFA, denies
  `kms:ScheduleKeyDeletion`, `kms:PutKeyPolicy`, `kms:CreateGrant` to everyone else, and `kms:Sign` to every principal
  but the issuer user. The access key rotates every 90 days and at once on any suspicion
  (`scripts/email-issuer.ts rotate-aws-key`), stored as a Worker secret and in `.secrets/<env>/email-issuer-aws.json`
  (0600).
- Audit: CloudTrail (management events, which include KMS `Sign`) to a separate log-archive account; EventBridge
  rules alert on any IAM or KMS policy change (`PutKeyPolicy`, `CreateGrant`, `DisableKey`, `ScheduleKeyDeletion`,
  `Put/Attach/CreateUserPolicy`, `CreateAccessKey`, …) and on `Sign` by any other principal. An hourly
  reconciliation compares the count of `Sign` events with the issuer's own `email_issuance` rows; a gap is a critical
  alert (a signature Hana's issuer didn't log). Volume and budget alarms on `Sign` per hour and on the AWS bill.
- Region and latency: the API runs in `aws:ap-east-1` (D97); the issuer Worker gets the same placement and KMS in
  `ap-east-1`, one HTTPS round trip per token. Budget for `verify` (server side): challenge object ≤ 50 ms, KMS ≤
  100 ms p95, total ≤ 250 ms; to measure on staging. It is small next to the user reading their mail.
- Cost and limits: see [KMS figures (verified)](#kms-figures-verified). At one signature per login it is a rounding
  error next to gas (~$0.02 per login, `docs/context.md`).
- Standby key: two KMS keys of signer `hana`, both active on chain, the standby in a second region (Q11), so a
  suspected key compromise is `remove_issuer_key(email, primary)` (owner, immediate) with email logins continuing on
  the standby while a replacement waits its delay.

#### KMS figures (verified)

Checked against AWS's docs and price list on 2026-10-29:

- `RSA_2048` `SIGN_VERIFY` keys support `RSASSA_PKCS1_V1_5_SHA_256` (AWS prefers PSS and keeps PKCS #1 v1.5 "for
  compatibility"; RS256 is PKCS #1 v1.5, which is what `oidc.rs` verifies), and "the private key never leaves AWS KMS
  unencrypted" ([key specs](https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html)).
- `Sign` takes 0–4096-byte messages; `DIGEST` skips the hashing step, which is only safe on a real digest
  ([Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)).
- CloudTrail logs every `Sign` with `keyId`, `messageType` and `signingAlgorithm`, not the message
  ([CloudTrail Sign](https://docs.aws.amazon.com/kms/latest/developerguide/ct-sign.html)): the reconciliation counts
  calls, and the issuer's own log ties each one to a `jti`.
- Price: $1 per key per month; RSA 2048 requests $0.03 per 10,000 (other asymmetric requests $0.15); the free tier
  (20,000 requests a month) excludes asymmetric requests (AWS price list, us-east-1, published 2026-10-26;
  [pricing](https://aws.amazon.com/kms/pricing/)). Two keys and 1 million logins a month ≈ $5.
- Quota: RSA cryptographic operations 1,000 per second per account and region, shared by `Sign`, `Verify` and the
  RSA encrypt calls, adjustable ([quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)).
- IAM condition keys `kms:SigningAlgorithm` and `kms:MessageType` apply to `Sign`
  ([conditions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html)).
- Key deletion waits 7–30 days (default 30) ([deleting keys](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)),
  so a mistaken deletion can be cancelled, and the key policy denies scheduling it anyway.
- Imported key material is supported for asymmetric and HMAC keys
  ([importing](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html)); HMAC keys exist
  (`GenerateMac`) ([HMAC](https://docs.aws.amazon.com/kms/latest/developerguide/hmac.html)); multi-Region keys
  cover asymmetric keys ([multi-Region](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html)).
  The standby key is a separate key (its own thumbprint), not a replica, so removing one never removes both.
- `aws4fetch` is Cloudflare's suggested SigV4 client for Workers (no Node dependencies, `fetch` and SubtleCrypto)
  ([Cloudflare](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/), [repo](https://github.com/mhart/aws4fetch)).

| Alternative to KMS for the mainnet key | Why not (for now) |
|---|---|
| RSA private key as a Cloudflare Worker secret (WebCrypto sign) | Fast (< 5 ms) and free, but exportable: anyone who can deploy the Worker or read its secrets copies the key once and forges forever, undetected (no signing log). Used on `local*` and testnet only (above) |
| Cloudflare Secrets Store | Same: the Worker reads the value itself (`await env.BINDING.get()`, [docs](https://developers.cloudflare.com/secrets-store/integrations/workers/)); Cloudflare's HSM support found is for Keyless SSL only, no signing service for Workers |
| AWS CloudHSM | Single-tenant HSM, far more than the MVP needs in cost and operation |
| Google Cloud KMS (HSM protection level) | Equivalent: `RSA_SIGN_PKCS1_2048_SHA256` at HSM level ([algorithms](https://docs.cloud.google.com/kms/docs/algorithms)), about $1 per key version a month and $0.03 per 10,000 HSM operations ([pricing](https://cloud.google.com/kms/pricing)). AWS is already the planned home for HSM-grade keys (`docs/context.md` batch C infra note), and Google already signs the Google tokens: keeping the email key off Google spreads trust (Q12). Its natural use is the Level 1 co-signer |
| Azure Key Vault Premium | Equivalent: RSA-HSM keys, RS256 over a 32-byte digest, no export ([keys](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys), [details](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details)); no other Azure use |

### Trust statement

**While the policy is 1-of-1, whoever can make the `hana` key sign (on testnet: anyone who can read the Worker's
secrets; on mainnet: the issuer's AWS credential, the AWS account's administrators, AWS itself) or can change what the
issuer Worker does (Hana's Cloudflare account) can mint email tokens for any `sub`, and so derive the wallet of any
email user, and of any account an email identity is linked to.** That is the price of email login and the reason D4
made it its own decision. Level 1 caps that power by the co-signer's limits and leaves an independent log; Level 2
removes it. Bounds:

- A key **swap** (installing an attacker's key on chain) is bounded by governance: email keys are owner-posted only,
  wait `governance_delay_ms` (72 h on mainnet) and can't be confirmed early, and the watchdog cancels any key whose
  thumbprint isn't in its pinned list for that signer (its own Cloudflare account, D86) and pauses if one is ever
  active. So a compromised owner DAO can't add its own email key. Weakening the policy (fewer signers, a lower
  `required`) needs a governed upgrade, public for 72 h.
- **Use of the real key** by a compromised issuer isn't bounded by the chain at 1-of-1: it is detected (CloudTrail
  reconciliation, link-volume alerts) and stopped by revoking the AWS credential or removing the key on chain
  (immediate), then `set_sessions_valid_from_ms` for sessions it opened. On testnet there is no signing log.
- Linking never lets the email issuer reach a Google wallet the user didn't choose to open by email: case B needs the
  user's own Google sign-in, and waits 24 h unless the address is Google-hosted ([The four cases](#the-four-cases)).
  For a Google-hosted case B link the user accepted that the email issuer reaches that Google wallet at once.
- The **email provider** and the **user's mail service** are trust roots too: whoever reads the code can log in.
  Anyone can start a challenge for any address, so a provider that logs message bodies is a credential store for the
  10 minutes a code lives. A Workspace (or any custom-domain) administrator controls every mailbox of the domain and so
  every email-login wallet on it, with or without linking.
- The page-serving trust root (vault and auth bundles) is unchanged from batch B.
- **Later:** the staged plan above. Level 1 and 2 need only a governed upgrade of the signer policy (the token format
  and the verifier are multi-signer from day one); Level 3 removes Hana's operators but not the email provider. None
  changes an address.

## Vendors considered and rejected

Rejected by the user's decision 1, for the reasons below. Claims checked against the vendors' current docs
(2026-10-29); see the sources.

| Vendor | What its docs say (2026-10-29) | Why it doesn't fit |
|---|---|---|
| **Auth0 passwordless** | The email-code grant (`POST /passwordless/start`, then `POST /oauth/token` with `grant_type=http://auth0.com/oauth/grant-type/passwordless/otp`) is for native and regular web apps: "You cannot use this endpoint from Single Page Applications", which use Auth0.js `passwordlessLogin` (cross-origin auth, third-party cookies unless on a custom domain) ([endpoints](https://auth0.com/docs/authenticate/passwordless/implement-login/embedded-login/relevant-api-endpoints), [grant](https://auth0.com/docs/api/authentication/passwordless/authenticate-user), [SPA](https://auth0.com/docs/authenticate/passwordless/implement-login/embedded-login/spa)). No `nonce` parameter is documented for that grant. `/authorize` flows put the request's `nonce` in the ID token ([implicit](https://auth0.com/docs/api/authentication/implicit-flow/authorize), [replay](https://auth0.com/docs/get-started/authentication-and-authorization-flow/implicit-flow-with-form-post/mitigate-replay-attacks-when-using-the-implicit-flow)). RS256 with a per-tenant JWKS at `https://{domain}/.well-known/jwks.json` ([JWKS](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets)). User ids are Auth0-generated `{provider}\|{id}` ([ids](https://auth0.com/docs/manage-users/user-accounts/identify-users)) | The code exchange needs a server (Hana's API) or Universal Login; with Universal Login the nonce works, but Auth0 then signs tokens for any user it chooses and rotates keys on its schedule, which the watchdog would have to follow; `sub` contains `\|` and Auth0's id (fine for `valid_sub`, but the address would depend on an Auth0 tenant forever: leaving Auth0 moves every email address) |
| **Stytch** | Email OTP (`POST /v1/otps/authenticate`) returns a session token and a session JWT with a fixed 5-minute life, not an ID token ([OTP](https://stytch.com/docs/api/authenticate-otp)); custom claims up to 4 KB, reserved `iss sub aud exp nbf iat jti` (the API reference says ignored, the guide says an error: the two pages disagree), `nonce` not reserved ([claims](https://stytch.com/docs/guides/sessions/custom-claims)); session JWKS per project, rotated every 6 months ([JWKS](https://stytch.com/docs/api/jwks-get), [JWTs](https://stytch.com/docs/guides/sessions/using-jwts)). "Connected Apps" is an OIDC provider (RS256, code flow, nonce accepted at authorize) whose authorize UI the customer hosts ([config](https://stytch.com/docs/api-reference/consumer/api/connected-apps/configuration/get-openid-configuration), [authorize](https://stytch.com/docs/api/connected-apps-oauth-authorize)); no page read says the nonce is echoed into the ID token | A session JWT's `aud` and `iss` are Stytch's project, so per-app scopes would need custom claims the contract doesn't read; Connected Apps would work but again needs Hana-hosted UI and a server, with Stytch as an extra trust root that can mint for any user |
| **Firebase Authentication** | No email codes: email **link** sign-in only ([email link](https://firebase.google.com/docs/auth/web/email-link-auth)). ID tokens are RS256, `iss` `https://securetoken.google.com/<project>`, `aud` the project id, `sub` the uid, keys at `…/securetoken@system.gserviceaccount.com` ([verify](https://firebase.google.com/docs/auth/admin/verify-id-tokens)). Custom claims ≤ 1000 bytes, set by the Admin SDK only, visible after a token refresh ([claims](https://firebase.google.com/docs/auth/admin/custom-claims)); `nonce` is a **reserved** claim ([custom tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens)) | A Firebase ID token can't carry the session nonce, so it can't open a session; magic links only (rejected above); one `aud` per project |

**Why Hana-run.** Every vendor would become a trust root equal to the KMS key (it can mint tokens for any user), and
none fits the on-chain verifier without a Hana server in the loop anyway: the nonce must commit to the session key,
the token must carry no email, `sub` must not be the vendor's account id format with the email or provider inside it,
and the signing keys must be pinned by the watchdog, which needs advance notice of vendor key rotations. A Hana issuer
with a KMS key keeps one trust root fewer, costs nothing per user, and keeps `sub` under Hana's control, so a later
move (TEE or co-signed issuer) keeps every address.

## Automatic linking (Privy-style)

### Model

Per scope, identities `(provider, sub)` form **accounts**. An account has a **root** (the identity whose own path is
the account's wallet) and up to 3 **members** (identities that open the root's path). An identity is in at most one
account per scope. An identity **has a wallet** in a scope when a session was ever opened on its own path there: the
contract records that in `opened` at every `create_session*` (it is the only definition the rules use: testable on
chain, independent of RPCs and balances). Links are per scope: logging in to app X never changes which wallet an
identity opens in app Y (Q14; a Hana Home "link everywhere" may come later).

What Privy does, for comparison (docs read 2026-10-29):

- A Privy user has a Privy DID and `linkedAccounts`; the embedded wallet is one of them (`type: 'wallet'`,
  `walletClientType: 'privy'`), so the wallet belongs to the user, not to a login method
  ([user object](https://docs.privy.io/user-management/users/the-user-object)).
- Linking is an explicit `linkEmail` / `linkGoogle` / … call while logged in, and "Users are only permitted to link a
  single account for a given account type, except for wallets and passkeys"; the page warns "Account access is wallet
  access" ([linking accounts](https://docs.privy.io/user-management/users/linking-accounts)).
- Linking a method that already belongs to another user fails with `linked_to_another_user`
  ([client errors](https://docs.privy.io/basics/troubleshooting/error-handling/client-errors)); an optional dashboard
  "login method transfer" moves it only when the other user has that single method, and then deletes the other user,
  so its embedded wallet must be exported first ([account transfer](https://docs.privy.io/recipes/dashboard/account-transfer)).
  The docs don't describe merging two users that both have wallets.
- Automatic merging: the user's own test on `demo.privy.io` (2026-10-29): an email login then a Google login with the
  same Gmail address gave the same user and wallets (Privy asks Google for the email and profile). Hana copies the
  outcome for Google-hosted addresses without putting the address on chain, with one "Link and continue" click, and is
  stricter elsewhere (a code first in case A, 24 h in case B).

### How the popup gets Google's verified email

- The Google request gains the `email` scope and an access token: `response_type=id_token token`, `scope=openid
  email`, everything else as batch B ("Login" step 5). Google's consent screen then lists "See your primary Google
  Account email address" for Hana's client (or the partner's own client).
- **The ID token must stay openid-only.** OpenID Connect Core §5.4 says the `email` scope's claims go to the UserInfo
  endpoint when an access token is issued; whether Google still puts `email` in the ID token is **not known** and is
  the spike's first check (`apps/smoke/spike.html`, both a personal and a Workspace account). If it does, the
  fallback is a second, silent request after the login (`response_type=token`, `scope=email`, `prompt=none`,
  `login_hint=<sub>`), and the login's on-chain token comes from the first, openid-only request. The batch B claim
  allow-list keeps refusing any ID token with `email` (`token_has_pii`), so a Google change can never put the address
  on chain through the API.
- `/login/callback` relays `{idToken, accessToken}` through the same end-to-end encrypted slot. The vault sends
  `POST /v1/email/google-match {pk, accessToken, googleIdToken, commitment}` to the issuer.
- The issuer verifies the Google ID token (RS256, JWKS, `aud`, `exp`) and its nonce against `commitment` (the session
  nonce), then calls Google's `tokeninfo` for the access token (its `aud`/`azp` must be the app's Google client and its
  `sub` the ID token's) and `userinfo` (`email`, `email_verified`, `hd`), then revokes the access token at Google's
  revoke endpoint. The address lives only in that call's memory: normalized, turned into `sub_E`, dropped. Neither the
  address nor the access token is logged.

### The four cases

Decided by the user (Q15, Q16, Q18; D119, D122). The issuer reads `get_identity(scope, "google", G)` and
`get_identity(scope, "email", sub_E)` and answers with a `decision` and `googleHosted`. Linking happens inside the
login's own `create_session_and_derive`, through its new `link_jwt` argument (an email token whose `auto_link` nonce
commits to this session's nonce, the Google identity, the target account's epoch and the link mode), so it needs this
live Google login and can't be replayed into another session.

**Google-hosted** (computed by the issuer from Google's userinfo, never stored): the normalized address's domain is
`gmail.com` (after the Gmail canonical form, so `googlemail.com` too), or userinfo's `hd` is present and equal to the
address's normalized domain (a Workspace account whose mailbox Google hosts). `hd` absent or different (a Google
account registered with an outside address, or a Workspace account using another domain's address): not
Google-hosted.

**A match** is a Google identity and an email identity with the same verified address in the scope, one of which has
a wallet, that aren't an `unlinked` pair. On a match the popup never creates a second wallet: it offers only **"Link
and continue"** (the rules below) or **"Sign in with {the other method}"** (the identity that has the wallet), and
explains why. The token of the identity without a wallet is never used for a session unless it links, so it never
gets a wallet. The vault runs `google-match` before any chain call, so a Google login's choice is made first.

| Case | Google identity G | Email identity E | Google-hosted | Not Google-hosted |
|---|---|---|---|---|
| A | no wallet, not linked | has a wallet (root or account) | "Link and continue": G joins E's account **at once**; the login opens E's wallet | "Link and continue": a code to a…@domain first (purpose `auto_link`), then G joins **at once** |
| B | has a wallet | no wallet, not linked | after the email code (`verify` says `googleWallet`), "Link and continue" = continue with Google: the login opens G's wallet at once and E joins **at once** | the same Google step opens G's wallet at once; E joins **pending 24 h** (`change_delay_ms`), cancellable |
| C | no wallet | no wallet | nothing linked; whichever logs in becomes a root (a Google login stores the hint) | same |
| D | has a wallet | has a wallet | can't arise (below) | same |

Both cases send a notice ([Notices](#notices)) on every link. "Sign in with {the other method}" in case A is an email
login to E's wallet; in case B a Google login to G's wallet without linking. A case A join that the contract refuses
(`Account already has a sign-in method of this kind`: E's account already has another Google member) shows only "Sign
in with email".

Why each rule:

- **A, Google-hosted, at once.** Google hosts the mailbox in that same account, so whoever passes Google's sign-in as
  G can already read E's codes, and Google says deleted Gmail usernames are never reissued (to verify, Q7). The link
  adds no power to anyone: Google could already reach E's wallet, and the email issuer already could.
- **A, not Google-hosted, a code first.** Google's `email_verified` then only says the address was verified once
  (when the account was made or the address added), not that the person still holds the mailbox (a former employee's
  or a recycled address), and a Workspace or Cloud Identity administrator can create a Google account for any address
  on the domain. A fresh code proves current control of the same address, which is exactly what an email login proves.
- **B, the user's own Google step.** Making a Google wallet reachable by email is the one direction that extends the
  email issuer's power: afterwards a forged email token opens the Google wallet. So it happens only when the user signs
  in with email and continues with Google (never silently at a Google login: pre-linking every Gmail user would hand
  the email issuer every such Google wallet). Google-hosted: at once, since the mailbox and the Google account are the
  same account (the user accepts the issuer trust for that wallet). Otherwise the mailbox may be the attacker's (a
  recycled or administrator-controlled address), so the link waits 24 h with a notice in the wallet and in the partner
  app, not only by mail, and any active identity can cancel it. The login itself opens G's wallet at once (its
  session token is G's); only later email-only logins wait for the link.
- **C.** Nothing to match yet; whichever identity later finds the other's wallet follows A or B.
- **D can't arise.** Every login after v3 checks for a match in both directions (case A from Google's userinfo at
  each Google login; case B from the hint every Google login writes), and a match never opens a second wallet. Wallets
  opened on sandbox-dev before v3 aren't in `opened` and are test data, discarded at the address freeze; mainnet
  starts with v3. Different emails, or the same email in different apps, are separate wallets by design (explicit
  `linkAccount` joins the former). If a Google account's address changes between logins, its old hint no longer
  matches and the new address is a different email: two wallets can then exist, and nothing merges them (the contract
  refuses `Both sign-in methods already have a wallet`); each method keeps opening its own. An `unlinked` pair is not
  a match.

How the email side proves itself in each flow: Google-hosted case A needs nothing more (the issuer mints from
Google's answer); case A otherwise sends a code with purpose `auto_link` whose commitment is this login's `auto_link`
fields, so `verify` returns the `auto_link` token itself; case B starts as an email login (purpose `session`), and
`verify`'s `linkTicket` is handed to the Google step's `google-match`, which mints the `auto_link` token only if the
Google account's verified address normalizes to the same `sub`. If the user picks a Google account with another
address, nothing is joined and the popup offers explicit linking. The link mode (`immediate` or after
`change_delay_ms`) is in the `auto_link` nonce, set by the issuer: immediate for case A and Google-hosted case B.

A pending link refuses logins by the joining identity with `link_pending` (the popup shows when it activates and a
Cancel). The issuer mints an `auto_link` email token only after checking `email_verified = true`, the normalized
address equality, the Google-hosted rule and the chain state; the contract can't see any of that and trusts the
issuer's purpose and mode, which is why the `auto_link` nonce domain exists only in the issuer.

### Explicit linking ("add a login method")

`hana.linkAccount({method})`, from a click while logged in, for an identity whose email differs (a second Google
account, a work address):

1. The popup signs in the **new** identity N (Google, or an email code with purpose `link_new`); its nonce commits to
   the account root and N's provider (N's `sub` isn't known yet).
2. Then a fresh sign-in of **any active identity** A of the account (purpose `link_account`), whose nonce commits to
   the root, N's identity and the epoch.
3. `POST /v1/link` relays `link_identity(scope_id, account_jwt, new_jwt, epoch, salt)`. N must not have a wallet, nor
   be in an account; the account must have room and no member of N's provider.
4. The link is pending for `change_delay_ms`, then active. Notices below.

Why the delay: someone with momentary access to the user's sign-in (a shared computer, a stolen Google session, a
compromised page) could add their own identity and keep access after the user recovers. Once the link is active and
the attacker logs in once, they hold the key (export is mandatory, D41), and only a `key_index` move helps; the delay
is the real protection, unlinking only stops future access.

### Notices

| When | Who gets it, how |
|---|---|
| Any link created (auto or explicit, pending or active) | Every Hana popup and the vault of the account show a banner "A sign-in method was added: {provider} on {date}" with Cancel (pending) or Remove (active), from `get_account` on the vault's own RPC; the SDK emits `linkChanged` to the partner page; on-chain event `identity_linked` / `identity_link_proposed` |
| A pending link (case B not Google-hosted, explicit) | Also in the partner app, not only by mail (the mailbox may be the attacker's): `linkChanged {status: "pending", effectiveAtMs}` and `hana.account()`, which `integration.md` asks partners to show with a link to cancel; Hana Home lists it |
| A link that joins an email identity | A mail to that address at once (the issuer has it during that call): "This email now opens a Hana wallet in {app} together with a Google sign-in. Not you? {authOrigin}/link/cancel" (cancel needs a code for that address) |
| Unlink, cancel | banner and event; the API revokes the account's vault shares in that scope |

Hana stores no address, so a Google-only account gets no out-of-band notice (D96). No encrypted address is kept for
security notices (Q17): in-product notices only in the MVP.

### Unlink and cancel

- `cancel_link`: a pending member is cancelled by any active identity of the account, or by the pending identity
  itself. Immediate.
- `unlink_identity`: an active member is removed by the root or by itself. Immediate. The root can't be removed (its
  path is the wallet); moving the root is out of scope. After an unlink the member opens its own path again (a new
  wallet unless it had one before: the user's explicit choice), and an `unlinked` mark stops automatic linking of
  that pair from matching again (an explicit link still can).
- The API, which relays both, revokes every vault share of the account's path in that scope (`vault_shares.path_hash`)
  after success, so other devices log out. A direct contract caller can skip that; the user's devices then end at
  their absolute limit (≤ 12 h by default).

### Privacy of links

Hashing the registry keys hides little: the link transaction carries both tokens (with both `sub`s) in its arguments,
public forever, and the root `sub` is in every MPC request's path. What stays private is the address: an email `sub`
is an HMAC, so a link reveals "Google account `110…` and email pseudonym `e1.…` are one person", never the email.
State is keyed by `sha256` identity keys anyway, so state-only readers learn nothing directly, and events carry keys,
not `sub`s.

## Contract changes (`contracts/hana-signer`)

Layout **v3**, migrated in place through `execute_upgrade` (`migrate` reads a copy of the v2 struct, appends the new
fields; no record rewritten). Events version `1.2.0`, additive.

### New state (appended to the root struct)

```rust
/// Providers whose keys Hana itself holds (one way): owner-posted keys only, governance delay, no early confirm,
/// and a signer policy.
self_issued: Vec<SelfIssued>,                     // ≤ 4
/// identity key → account root key, for members (pending or active).
links: LookupMap<[u8; 32], MemberRecord>,        // StorageKey::Links
/// root identity key → account.
accounts: LookupMap<[u8; 32], Account>,          // StorageKey::Accounts
/// identity keys that opened a session on their own path in their scope.
opened: LookupSet<[u8; 32]>,                     // StorageKey::Opened

struct SelfIssued {
    provider: String,
    signers: Vec<String>,                          // signer ids, ≤ 3; ["hana"] at launch; changed only by migrate
    key_signer: Vec<(String, String)>,             // (kid, signer id) for the provider's keys, ≤ 8
    required: u8,                                  // distinct signers a token needs; 1 at launch
    overlap: Option<(Vec<String>, u8, u64)>,       // previous (signers, required) and until_ms: set by the migrate that changes the policy
}
struct MemberRecord { root: [u8; 32], effective_at_ms: u64 }
struct Account {
    root_provider: String, root_sub: String,       // the path's identity (public anyway)
    members: Vec<Member>,                          // ≤ 3
    unlinked: Vec<[u8; 32]>,                       // pairs auto-linking must not re-add, ≤ 8 (oldest dropped)
    epoch: u64,                                    // bumped by every link change
}
struct Member { key: [u8; 32], provider: String, effective_at_ms: u64, active: bool, auto: bool }
```

Identity key: `ik = sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))`.

### Self-issued issuers

- `mark_self_issued(provider)`, owner, one way, `Unknown issuer`; sets `{signers: ["hana"], required: 1}`. Event
  `issuer_self_issued {provider}`.
- For such a provider: `set_issuer_key` takes `signer` (one of `signers`, else `Unknown signer`); by "self" it panics
  `Only the owner posts keys for this issuer`; `executable_at_ms` is also at least `now + governance_delay_ms`;
  `confirm_issuer_key_change` panics `Keys of a self-issued issuer can't be confirmed early`. Removal by the owner
  stays immediate (DoS only).
- `verify_token` for such a provider takes the JWS General JSON form only ([The token](#the-token)): ≤ 3 signatures,
  distinct `kid`s, each an active key of a listed signer (`Unknown key` otherwise), each RS256-valid; it passes when
  the distinct signers ≥ `required`, or, while `now < overlap.until_ms`, it satisfies the previous policy (its
  signers and count) (`Not enough signatures`). The claim checks are today's. Other providers are unchanged (compact only).
- No method changes `signers` or `required`: a governed upgrade's `migrate` does (D121), adding the new signer's
  `key_signer` entries and keys with it. View `get_self_issued(provider)` → `{signers: [{id, kids}], required,
  overlap_until_ms?}` (the watchdog pins it).

### Sessions

`create_session` and `create_session_and_derive`, after the scope and nonce checks:

1. `X = ik(scope, token.provider, token.sub)`. If X is a pending member: `Sign-in method link is pending`. If X is an
   active member (or a pending one past `effective_at_ms` and `now ≥ changes_unlock_floor_ms`, which it then marks
   active, event `identity_link_activated`): the path identity is the account's root. Else X itself.
2. `create_session_and_derive` only, new optional arguments (serde reads a missing `Option` as `None`; a unit test
   proves old callers are unaffected):
   - `link_jwt: Option<String>`: an email token for the scope's email client (`verify_token`, provider in
     `self_issued`, `session_scope` gives the same scope) whose nonce is the `auto_link` nonce over this call's session
     nonce, X, the target epoch and `link_immediate: Option<bool>` (a second new argument, default `false`). Then the
     [four cases](#the-four-cases) on chain: E has a wallet and X none → X joins E's account, active now (`auto:
     true`; the issuer sets `link_immediate` for case A); X has a wallet (or is getting one in this call) and E none →
     E joins X's account, active now if `link_immediate`, else pending `max(now + change_delay_ms,
     changes_unlock_floor_ms)`; both have wallets → `Both sign-in methods already have a wallet`;
     an `unlinked` pair → `This sign-in method was unlinked`. Panics also: `Link token nonce doesn't match`,
     `Account is full`, `Account already has a sign-in method of this kind`.
3. Path = `{scope}#{path provider}#{path sub}#{key_index}`, unchanged format. If the path identity's key isn't in
   `opened`, insert it.

The session nonce layout is unchanged: it commits to the scope, not the path. A race (a link activating between the
vault's read and the transaction) makes the vault's pairing check fail; the vault re-reads and retries once.

### Link methods

| Method | Who | Effect |
|---|---|---|
| `link_identity(scope_id, account_jwt, new_jwt, epoch, salt)` payable | anyone with both tokens (relayer sponsored) | N joins A's account, pending `max(now + change_delay_ms, changes_unlock_floor_ms)`; returns `effective_at_ms` |
| `cancel_link(scope_id, jwt, member_key, epoch, salt)` | an active identity of the account, or the pending identity | removes a pending member |
| `unlink_identity(scope_id, jwt, member_key, epoch, salt)` | the root or the member itself | removes an active member, adds the pair to `unlinked` |
| `get_identity(scope_id, provider, sub)` view | — | `{key, status: "own" \| "member" \| "pending", opened, root?: {provider, sub}, effective_at_ms?, account_epoch}` |
| `get_account(scope_id, provider, sub)` view | — | `{root: {provider, sub}, members: [{key, provider, effective_at_ms, active, auto}], epoch}` or `null` |
| `identity_key(scope_id, provider, sub)` view | — | hex `ik` (for monitors and tests) |

Every token passes `verify_token` and `session_scope` for `scope_id` (so a member is always a client of that scope or
a shared client in an `allow_shared` scope). Panics, in order: `Paused`; token panics; `Token is for another app`;
`Link nonce doesn't match`; `Identities must differ`; `Sign-in method is not in this account` (A); `Sign-in method
link is pending` (A pending); `Sign-in method already has a wallet` (N in `opened`); `Sign-in method is already
linked` (N member or root of an account with members); `Account is full`; `Account already has a sign-in method of
this kind`; `Wrong epoch`; `No such member`; `Cannot unlink the root`. Payable as `register_scope` (`charge_storage`,
sponsors free).

Events: `identity_link_proposed {scope_id, root, member, provider, effective_at_ms, auto}`, `identity_linked` (an
immediate auto join), `identity_link_activated`, `identity_link_cancelled {by}`, `identity_unlinked {by}`, with
identity keys in hex, never `sub`s.

### Byte layouts (new)

All nonces `b64url(sha256(preimage))`, implemented in Rust and independently in `gen-fixtures.mjs`, with worked
examples in `test_fixture.json` (D14).

```
link_new     = "hana-id/link-new/v1"     ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ borsh(new provider) ‖ epoch u64 LE ‖ salt
link_account = "hana-id/link-account/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ new_ik ‖ epoch u64 LE ‖ salt
link_change  = "hana-id/link-change/v1"  ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh("cancel" | "unlink") ‖ root_ik ‖ member_ik ‖ epoch u64 LE ‖ salt
auto_link    = "hana-id/auto-link/v1"    ‖ borsh(signer) ‖ borsh(scope_id) ‖ sha256(session nonce preimage) ‖ session_ik ‖ target epoch u64 LE ‖ mode u8
```

`salt` 16..=64 bytes. `target epoch` is the epoch of the account the joining identity joins (0 for none yet). `mode`
is 1 for `link_immediate`, else 0. `signer` is the signer contract's account id (as in the existing layouts), not an
email signer id.

### Gas and storage (estimates, to measure in the sandbox and on testnet)

| Call | Extra over today |
|---|---|
| `create_session*`, no link | one `links` read and one `opened` check (+ one insert at an identity's first login, ≈ 113 bytes ≈ 0.0011 NEAR, contract-paid): ≈ +1–2 Tgas |
| `create_session_and_derive` with `link_jwt` | one more RS256 verification and the account writes: ≈ +8–12 Tgas; attach 150 Tgas (was 100) |
| any email token at 2-of-2 (Level 1) | one more RS256 verification per token: to measure before that upgrade, and the attached gas raised with it |
| `link_identity` | two RS256 verifications and ≤ ~800 bytes: ≈ 25–35 Tgas burnt, attach 100; ≈ 0.008 NEAR storage, relayer-sponsored |
| `cancel_link`, `unlink_identity` | one verification: ≈ 15 Tgas |

## API changes (`apps/api`)

- `ISSUER_PROVIDERS` gains the email `iss`; `/v1/login` and `/v1/sessions` accept email tokens (same allow-list,
  nonce and scope checks; the JWKS from the issuer's endpoint, cached like Google's); `/v1/login` accepts and
  prechecks `linkJwt` and `linkImmediate` (verifies it, recomputes the `auto_link` nonce). Email tokens are the JWS
  JSON form, checked against `get_self_issued("email")` like the contract (signers, `required`, overlap).
- `GET /v1/app`: `loginMethods: ("google" | "email")[]` (D1 setting ∩ the scope's on-chain clients), `email: {aud}`
  when on. 409 `no_login_method` replaces `no_google_client` when nothing is available (the old code stays for
  Google-only apps).
- New relays (session pool, their own per-app quota and per-IP limits): `POST /v1/link` → `link_identity`,
  `POST /v1/link/cancel` → `cancel_link`, `POST /v1/link/unlink` → `unlink_identity`; each revokes the account's
  shares after success. The session-pool allowlist gains the three methods (keys deleted and re-added, as in batch B).
- D1 migration: `apps.login_methods` (default `'google'`), `email_hints`, `email_suppressions`, the issuer's own
  `email_issuance`. Usage counts email logins and links per app.

## Vault, popup and SDK changes (`packages/web`)

- **Popup** `/login`: a method chooser when the app has more than one ("Continue with Google", an email field). The
  email path navigates to `/login/email` in the same window (keeping `/login` fetch-free, D77), whose CSP adds
  `connect-src {issuer origin}`: address → code → `verify` → relay `{idToken}` to the vault through the existing slot.
  Codes are typed in, `autocomplete="one-time-code"`. On a match the popup shows only "Link and continue" and "Sign
  in with {the other method}" ([The four cases](#the-four-cases)): case A sends a code first unless Google-hosted;
  case B continues with Google; a pending link shows when it activates and a Cancel.
- **Vault**: verifies email tokens against the on-chain email keys (`get_issuer_keys("email")`, defence in depth);
  computes the path from `get_identity` on its own RPC (never from the API), so `login.ts`, `export-page.ts` and the
  record check in `vault.ts` stop assuming `#google#`; runs `google-match` after a Google token and before the chain
  call; shows link banners from `get_account`.
- **SDK**: `createHana({ ..., loginMethods?: ('google' | 'email')[] })` narrows what the popup offers (it can't add a
  method the app hasn't enabled); `hana.login({ method?, emailHint? })` preselects (an `emailHint` the partner page
  knows prefills the field; the page then knows the address, its own business); `hana.linkAccount({ method })` (in a
  click, like login); `hana.account()` → `{ methods: [{provider, status, effectiveAtMs}] }` (no subs, no addresses of
  mailboxes); events `linkChanged` (with `status: "pending" | "active" | "removed"`, `effectiveAtMs`; partners show
  pending ones, [Notices](#notices)), `loginProgress` gains `email_code` and `linking`. Errors:
  `link_pending`, `link_refused {reason}`, `code_invalid`, `challenge_expired`.
- **Export** resolves the path the same way; Hana Home (D40) lists methods per app.

## Admin portal hooks (batch C)

Following D83 (every check surfaces in the portal):

- **Email issuer view** (admin console): issuance per app and day by purpose, `start`/`verify` refusals by limit,
  bounce and complaint rates, the CloudTrail reconciliation result and its last run, the AWS key age, the signer
  policy (signers, `required`) and every signer key with on-chain and pinned thumbprints, the `Sign` volume and budget
  alarms.
- **Links view**: links proposed, activated, cancelled and unlinked per app and day (counts only), auto vs explicit,
  an alert when an app's link rate jumps (provisional: 5× its 7-day median); Support ID (D96) lookups show a user's
  methods by provider and pending links, never a `sub` or address. Staff can't create or cancel links (they need the
  user's proofs).
- **Partner console**: the email toggle per app (D1 `login_methods` plus the on-chain `AddClient`, guarded like an
  origin change, D32; removal immediate through `remove_client`), and email deliverability for the app. Partners
  enable email themselves (Q20).

## Watchdog (`apps/watchdog`)

- Manifest `watchdog.pinnedIssuerKeys: { email: { required: 1, signers: { hana: [thumbprint, …] } } }`, set on the
  watchdog's own account (a pin change is a watchdog redeploy by the operator, outside Hana's main account). Every
  signer's keys are pinned; Level 1 adds `cosign: […]` and `required: 2` before its upgrade executes.
- Pending change for `email`: an `Add` whose thumbprint isn't pinned for its signer → cancel and critical
  `forged_key_change`; a
  pinned one → no confirm (self-issued keys can't be confirmed early), info. A change by "self" for `email` stays
  `updater_other_provider` (cancel, delete updater keys).
- Active `email` key not pinned → pause and critical `forged_active_key` (the same rule as Google, D82).
- `get_issuer("email")` and `get_self_issued("email")` diffed each run against the pins (signers, `required`; critical
  on any difference, pause on a weaker policy); a pending upgrade is already checked by the governance rules (D82).
  Hana's published JWKS compared with the pins (warning on a mismatch: informational, Hana controls it).
- Link-volume check from `identity_link_*` events (warning above the threshold); new check ids and alert kinds
  registered in `checks.ts` with their portal rendering (D83).

## Migration

- **sandbox-dev:** contract v3 through the DAO upgrade path (`upgrade-contract propose|execute`); `set_issuer`,
  `mark_self_issued`, two `set_issuer_key(…, "hana")` proposals by the owner (they wait 60 s there); the signing keys
  (primary, standby) as Worker secrets, `K_sub`, `K_code`, `K_rl`, all generated by `scripts/email-issuer.ts init` into
  `.secrets/sandbox-dev/` (0600) and the Worker (never printed); `AddClient` for `s1` and `s2`; D1 migration;
  watchdog pins. Sessions and wallets opened before v3 aren't in `opened`, so on sandbox-dev an old wallet can be
  merged over by mistake: test data, discarded at the address freeze (mainnet starts with v3).
- **Staging, before mainnet:** the dedicated AWS account and KMS keys set up as in [Signing key](#signing-key-staged),
  the reconciliation and alarms running, KMS latency measured.
- **Mainnet:** the signer is created with v3 code at the address freeze (`docs/governance-spec.md` "Mainnet"), so
  `opened` is complete from the first login. `K_sub` is generated offline, backed up twice before the first email
  login, and never changed. Email keys are KMS keys only.

## Tests

### Contract unit (`tests.rs`)

- Self-issued: self can't post, owner's post waits `governance_delay_ms`, confirm refused, one-way flag, Google
  unaffected; `set_issuer_key` needs a listed signer.
- Signer policy: the JSON form only for email (compact refused), ≤ 3 signatures, duplicate `kid` refused, unknown
  `kid` refused, two keys of one signer count once, 1-of-1 passes, 2-of-2 refuses one signature after the overlap
  and accepts it during it, a `migrate` fixture raising `required` sets the overlap, no method changes the policy.
- Resolution: an unlinked Google and email identity's path is byte-identical to v2's (golden paths); a member opens
  the root path; a pending member is refused; lazy activation respects `changes_unlock_floor_ms`; `opened` set once.
- The four cases with `link_jwt`, each panic, `unlinked` blocking, epoch replay refused, front-run of the combined call
  without the session signature reverts everything (no link left behind).
- `link_identity` / `cancel_link` / `unlink_identity`: every rule and panic in order, storage charged, sponsor free,
  limits, events.
- `link_immediate`: case B active at once with it, pending without it; a token minted for one mode refused with the
  other (nonce).
- Layouts: the four new nonces (with `mode`) and `ik` against `gen-fixtures.mjs`; multi-signature fixtures; old JSON
  without the new arguments still deserializes.
- `migrate` v2 → v3 from a v2 state fixture keeps every field.

### Sandbox (`contracts/integration-tests`)

- Email issuer end to end with a local RSA key: set issuer, owner-posted key after the delay, email login, same CKD
  `app_id` as the expected path; link then login through the member gives the same `big_y`-derived key as the root.
- Upgrade v2 → v3 through the DAO; the relayer allowlist test gains the link methods; gas of each new call recorded.

### Issuer (`apps/email-issuer`, vitest with miniflare and a fake KMS)

- Normalization and `sub` vectors (frozen file, guard test); Gmail canonical form; the disposable-domain list
  (pinned, no Google-hosted domain on it, `email_domain_not_allowed`).
- Codes: entropy source, HMAC storage, attempts, expiry, single use, resend rules, constant-time compare.
- Each rate limit, enumeration-identical responses (body and a timing tolerance), suppressions.
- Purpose-bound nonces: the issuer computes each purpose's nonce from the commitment; a request for another app's
  scope is refused; `client-proof` only behind Access.
- KMS adapter: SigV4 request shape against recorded vectors, `DIGEST` mode, signature self-check, error mapping;
  Worker-secret adapter parity; `gen` refuses `worker-secret` for mainnet; the JWS JSON form with one and two
  signatures; the reconciliation job (a missing `email_issuance` row alerts).
- `google-match`: tokeninfo `aud` mismatch refused, `email_verified=false` refused, the Google-hosted rule (Gmail,
  googlemail, `hd` equal, `hd` absent, `hd` different), every case's decision and link mode, no token without `link`,
  the access token revoked, nothing logged (a log-capture test greps for the address, code, `sub` and token).

### API, web, watchdog

- API: email tokens through `/v1/login`, `linkJwt` prechecks, the link relays and share revocation, `GET /v1/app`
  methods.
- Web unit: chooser, `/login/email` CSP and flow, vault path resolution (no `#google#` left), banners, SDK methods and
  events.
- Watchdog: pinned and unpinned email keys per signer (cancel, pause), self-issued confirm skipped, issuer and
  signer-policy diff, link volume.

### Playwright (Chromium, WebKit, Firefox)

An email stub (`EMAIL_SENDER=outbox`, only in `local*` envs, refused by `gen` elsewhere) writes messages to a test-only
Durable Object that the suite reads through a binding, never a public route. Flows: email login; email then Google
(Google-hosted, case A, "Link and continue") gives the same addresses; case A on another domain with the code; "Sign
in with email" opens E's wallet and G gets none; Google then email (case B) Google-hosted (at once) and not (the
pending banner in the popup and the partner page's `linkChanged`, then cancel); `linkAccount` with delay (manifest
`changeDelayMs` short); cancel from the mail's link; unlink logs out the other tab. Google is stubbed with the
existing e2e test issuer (its userinfo stub returns `hd` as set by the test).

### Testnet (sandbox-dev)

Email login latency (issuer server time), gas of each new call, the Google `email` scope spike (ID token claims,
consent text, userinfo `hd` for a personal and a Workspace account) before any web code. KMS p95 on staging.

## Build order

Rough sizes (lines with tests, engineer-days). Step 0 decides the Google flow.

0. **Spike** (0.2k, 1 d): Google `response_type=id_token token` with `scope=openid email`: ID token claims and
   consent text for a personal and a Workspace account; tokeninfo and userinfo answers.
1. **Contract v3** (2.5k, 6 d): self-issued issuers with the signer policy and multi-signature verification,
   identity keys, `opened`, resolution, `link_jwt` and `link_immediate`, link methods, layouts and fixtures, migrate,
   unit and sandbox tests.
2. **`packages/email`** (0.5k, 1 d): normalization, vectors, guard, disposable-domain list.
3. **`apps/email-issuer`** (2.8k, 6 d): challenges, limits, sender adapter (user-mail subdomain), token minting (JWS
   JSON), `google-match` with the Google-hosted rule, Worker-secret and KMS signers, JWKS, client proofs, CloudTrail
   reconciliation job.
4. **AWS and secrets tooling** (0.4k, 1.5 d; needed before mainnet, not for testnet): `scripts/email-issuer.ts`
   (init, rotate-aws-key, key thumbprints), KMS key, IAM policy and alarm templates, `operations.md` steps.
5. **API** (0.9k, 2 d): issuer map, `/v1/app`, `/v1/login` link fields, link relays, D1 migration, allowlist state.
6. **Web** (2.6k, 6 d): chooser, `/login/email`, Google `email` scope and relay, vault resolution, banners, export,
   SDK methods, errors.
7. **Watchdog** (0.6k, 1.5 d): pins, self-issued rules, diff, link volume, check registry.
8. **Admin and partner console views** (0.6k, 1.5 d; needs batch C's Workers).
9. **Playwright, sandbox-dev deploy and measurements** (0.9k, 3 d).

No switcher (D122). About 12.0k lines and 30 engineer-days; steps 2–4 can run beside 1.

## Decisions recorded

In `docs/decisions.md` (2026-10-30): D4 confirmed; D25 and D96 amended; D119 automatic linking; D121 signing key and
signer policy; D122 no second wallet, no switcher; D123 the remaining questions' defaults.

## Open questions for the user

All answered (2026-10-29/30). The defaults the user approved are D123.

1. **Issuer choice**: Hana-run (decision 1, D4); the separate `apps/email-issuer` Worker (D123).
2. **Signing key**: Worker secret on testnet; AWS KMS in a dedicated AWS account before mainnet, root held by both
   founders with hardware security keys; two-signer-ready policy and the staged plan (decision 3, D121).
3. **Email provider** for user mail: Resend (D87, still provisional until the colleague confirms), behind the one
   adapter; message-log retention at the minimum (D123).
4. **`aud` per scope** (`email:<scope_id>`; a partner turns email off with `remove_client`) (D123).
5. Issuer hostname: under `apiUrl` (`{apiUrl}/v1/email`) (D123).
6. **`sub`**: HMAC with `K_sub`; `K_sub` a Worker secret with two offline backups (D123).
7. **Gmail canonical form** and "deleted Gmail usernames aren't reissued": adopted; cited from Google's help pages in
   the guard test before the freeze (D123).
8. Code not in the mail subject (D123).
9. No Turnstile on `authOrigin`; rate limits instead (D123).
10. **Disposable-address domains blocked** (D123).
11. Standby KMS key in a second region (D123).
12. Trust spread: Google signs Google tokens, AWS holds the email key; Google Cloud KMS only as a Level 1 co-signer
    (D123, D121).
13. Email issuer keys wait `governance_delay_ms` (72 h on mainnet) (D123).
14. **Links per scope**; a Hana Home "link in all my apps" maybe later (D123).
15. **Case A**: Google-hosted → linked at once; otherwise a code first, then at once; always a notice (decision 4,
    D119).
16. **Case B**: the user's Google step; Google-hosted → at once; otherwise 24 h, notice in the wallet and the partner
    app, cancellable (decision 4, D119).
17. No stored addresses for security notices; in-product notices only (D96, D123).
18. **Never a second wallet** for a match; "Link and continue" or "Sign in with {the other method}"; no switcher
    (decision 5, D122).
19. Delay for explicit and non-Google-hosted case B links: `change_delay_ms` (24 h production, D93) (D123).
20. **Partners enable email per app** (partner console toggle with the on-chain client) (D123).
21. One method per provider per account and 3 members (D123).
22. Rate limits and the global daily budget as proposed (provisional values, tuned on sandbox-dev) (D123).
