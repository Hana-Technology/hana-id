# Environments

One JSON manifest per environment, validated by `packages/env` (`manifestSchema`). Every NEAR account name, endpoint and
Cloudflare resource name comes from here. Names in `sandbox-dev.json` are throwaway; wallets derived on them are
disposable. Add an environment by copying `sandbox-dev.json`, changing `name` (must match the file name) and the accounts.

Google client fields:

- `googleClientIds`: Hana's own app's Google OAuth client IDs, registered as clients of the reserved `global` scope.
- `sharedGoogleClientIds`: Hana's shared login client(s), set with `set_shared_clients` (at most 5). Partner apps
  registered with `--allow-shared` log in through these instead of their own Google client. A client ID can be in only
  one of the two lists (the contract rejects a client that is both shared and a scope's own).

Governance fields (`docs/governance-spec.md`, `docs/operations.md` "Governance"):

- `ownerKind` (default `account`): `account` = `owner` is a plain account whose keychain key signs owner calls;
  `sputnik` = `owner` is the council DAO (`owner` must equal `council.dao`) and owner calls are DAO proposals.
  `deploy-contract --transfer-owner` switches it once the DAO has accepted ownership.
- `council` (optional): `{factory, dao, members}`, the owner council (D81): a Sputnik DAO v2 named
  `<one label>.<factory>` with exactly three distinct members, none of them an env account. sandbox-dev's is created by
  `council-setup` (member keys in `.secrets/sandbox-dev/council/`); it exists before it becomes the owner.
- `watchdogs` (default none, ≤ 3): accounts the contract lets cancel, confirm and pause (`add_watchdog`); none may be
  an env or council account.
- `issuerKeyDelayMs` (≤ 7 days), `governanceDelayMs` (≤ 30 days): the delays `new` starts with (D80;
  sandbox-dev 120 000 and 60 000). `deploy-contract` sets them on chain if they differ (decreases wait, per contract).
- `allowSignerFullAccessKey`: the signer may keep a full-access key (D86). Only for `local*` / `sandbox*` envs on
  testnet: the schema refuses it outside testnet, `deploy-contract` refuses it in any other env, and a test checks that
  no committed manifest but sandbox-dev's sets it. Without it, `deploy-contract` blocks on any full-access key on the
  signer, and a new env's signer is created with the `--creation-plan` batch.

Values containing `UNSET` are placeholders: `deploy-contract` skips the step that needs them (with a warning) until
they are filled in.

Batch C fields (`docs/batch-c-spec.md` "Manifest", `packages/env/src/dashboard.ts`; plan: `docs/batch-c-build-plan.md`):

- `appChangeDelayMs` (required, 60 000 … 7 days): how long a guarded change (an origin add, an auto-approve policy, a
  raw-signing enable) waits after its notice. At least 24 h on a production network, where `changeDelayMs` must be no
  shorter. sandbox-dev: 60 000 (its `changeDelayMs`). `gen` passes it to the API as `APP_CHANGE_DELAY_MS`; nothing
  reads it until batch C3.
- `console`, `files`, `admin`, `usage`, `email`, `ownerGrantDelayMs` (optional, all or none): the dashboard. Without
  them the env runs the API only (sandbox-dev today, until its console, files and admin origins exist).
  - `console`: `{workerName, d1Name, origin, authWorkerName, authOrigin}` (the partner console and its script-free
    Google sign-in origin; the console client's only redirect URI is `authOrigin + "/callback"`).
  - `files`: `{workerName, origin, logosBucket, statementsBucket, exportsBucket}` (logos origin and the R2 buckets).
  - `admin`: `{workerName, origin, accessTeamDomain, accessAud, staffEmails}`: `accessTeamDomain` is
    `<team>.cloudflareaccess.com`, `accessAud` the Access application's 64-hex AUD tag (or `UNSET`), `staffEmails`
    the admin Worker's own lowercased allowlist behind the Access policy (D88), and the exact emails that policy
    includes: `access-setup <env>` creates the application and policies from this block, prints the team domain and
    AUD tag (`--yes --write-manifest` writes both here) and `--check` reports drift (D409).
  - `usage`: `{neonRegion: "aws-ap-southeast-2", writerHyperdrive, adminHyperdrive}` (D73).
  - `email`: `{from, securityAlias}`: `from` is `Name <address>` or an address on the sending subdomain (D87), with no
    line break, quote or second address; `securityAlias` gets every blocking notice and direct alert.
  - `ownerGrantDelayMs`: how long a new owner stays a viewer (D89); the bounds of `appChangeDelayMs`.
  - Every dashboard origin is a Hana origin by the `vaultOrigin` rules, distinct from every other Hana origin (the
    API's, `vaultOrigin`, `authOrigin`) and, outside dev envs, on a different site from `vaultOrigin` (D38). Worker,
    D1, bucket and Hyperdrive names are distinct (the API's and the watchdog's included). `gen` passes the list of
    all Hana origins to the API as `REFUSED_ORIGINS` (`hanaOwnOrigins`) and `files.origin` as `FILES_ORIGIN`; the
    same `files.origin` goes to the auth page Worker (`FILES_ORIGIN`) and into the page build (`HanaEnv.filesOrigin`),
    the logo pages' `img-src` (batch C11), and to the files Worker (`apps/files`, `gen <env>`), which is deployed on it:
    a `workers.dev` files origin must be `<files.workerName>.<subdomain>.workers.dev`.

`cloudflare.durableObjectLocation` (optional): the region for the Durable Objects every login shares (relayer keys, the
per-app and owner-action limiters), as a Cloudflare location hint (`apac`, `weur`, `enam`, …). Without it each object
lives wherever its first request happened to arrive. Pick the region of most users (sandbox-dev: `apac`, next to its
D1 database). Per-IP limiters always stay near their client. Changing it creates new objects in the new region.

`watchdog` (optional): the independent watchdog service of the governance batch (`apps/watchdog/README.md`,
`docs/operations.md` "Watchdog service"). Without it the env has no watchdog Worker (`watchdog gen` refuses it).

```json
"watchdog": {
  "account": "hana-id-watchdog-dev1.testnet",
  "cloudflare": { "accountId": "UNSET", "workerName": "hana-id-watchdog-sandbox-dev", "d1Name": "hana-id-watchdog-sandbox-dev" },
  "alertEmails": ["founder-a@example.com", "founder-b@example.com"],
  "alertFrom": "alerts@notify.example.com",
  "pager": "ntfy",
  "digestHourUtc": 0
}
```

- `account`: the watchdog's own NEAR account; never the signer, relayer, owner or MPC account. It must also be listed
  in `watchdogs` (the schema refuses it otherwise), which is how `deploy-contract` adds it on chain with
  `add_watchdog`. Its key (`WATCHDOG_KEY`) is a function-call key on it.
- `cloudflare.accountId`: the watchdog's **own** Cloudflare account (separate login and MFA from the API's, D86;
  sandbox-dev alone uses the API's account, D125),
  32 hex characters; `UNSET` until it exists (`gen` refuses `UNSET`). `workerName` must differ from the API's.
- `url` (optional, batch C14, D330): the watchdog Worker's https origin on its own account
  (`https://<workerName>.<subdomain>.workers.dev`, or a custom domain), no path, port or credentials; a workers.dev
  host must name `cloudflare.workerName`. The admin Worker reads `/status`, `/alerts`, `/actions` and posts acks there
  (`WATCHDOG_URL`, with the `WATCHDOG_STATUS_TOKEN` secret). Not a secret. A production manifest's admin `gen` refuses
  without it (`docs/operations.md` "Admin Worker" → "Security & monitoring").
- `alertEmails`: both founders (D85); `alertFrom`: an address on the dedicated sending subdomain (D87).
- `pager`: `ntfy`, `pushover` or `pagerduty` (D85, chosen at setup); its credentials are Worker secrets.
- `digestHourUtc` (0–23, default 0): the daily digest goes out on the first run after this hour (UTC).
- `relayerFunds` (optional, D150): thresholds in NEAR of the watchdog's read-only relayer funds check, each pair
  optional, `critical` below `warn`: `balance` (the `relayer` account's available balance; default 5 / 1),
  `sessionAllowance` (each session-pool key; 0.5 / 0.1), `ownerAllowance` (each owner-pool key; 0.1 / 0.02). Raise the
  allowance pairs when `deploy-contract` runs with larger allowances. A change needs `watchdog gen` and a redeploy.
- `pinnedIssuerKeys.email` (optional; email login, `docs/email-login-spec.md` "Watchdog", D190, D191): the signer
  policy the watchdog expects of Hana's email issuer, `{"required": 1, "signers": {"hana": ["<thumbprint>", …]}}`,
  each key by its RFC 7638 JWK thumbprint (43 base64url characters, the email issuer's `kid` for it), 1–3 signers,
  ≤ 8 keys in all, each key pinned once; optional `jwksUrl` (https; default `{emailIssuer.url}/v1/email/jwks.json`, or under `apiUrl` without `emailIssuer.url`). Absent
  means **nothing is pinned**: every email key is then unpinned (a pending one is cancelled, an active one pauses the
  contract) and an email issuer on chain is a critical alert. So pin before the owner posts the first email key
  (build plan batch 6). sandbox-dev has none until batch 4 creates the key. Order around a signer-policy upgrade
  (D191): pin a new signer's keys before the upgrade executes, raise `required` after it. A change needs
  `watchdog gen` and a redeploy (on the watchdog's own account: a pin change is the operator's, outside Hana's main
  account).
- `pinnedIdentityKeys` (optional; the partner identity token, `docs/identity-token-spec.md` "JWKS and discovery",
  D210, D211): the RFC 7638 thumbprints (43 base64url characters; the kids) of the identity token's P-256 keys the
  watchdog accepts in Hana's identity JWKS, 1–8, each once. With `identityToken` in the manifest, **every one of its
  `publicKeys` must be pinned** (the schema refuses the manifest otherwise; extra pins are allowed and warn
  `identity_key_missing` until published). `scripts/identity-key.ts` writes them with the keys: `init` and `next` pin
  (deploy the watchdog first, then the API), `retire` unpins (deploy the API first, then the watchdog). Absent means
  nothing is pinned: every published identity key pages as unpinned. sandbox-dev pins its active and standby keys.

`emailIssuer` (optional; no env has it yet): the email login's issuer Worker (`apps/email-issuer/README.md`,
`docs/operations.md` "Email issuer", D196). Written by `scripts/email-issuer.ts <env> init`, never by hand for the keys:
`url` (the origin the issuer is reached at, D230: required when `apiUrl` is on `workers.dev`, and then the issuer's own
`https://<emailIssuer.cloudflare.workerName>.<the API's subdomain>.workers.dev`; absent, the API's URL, with a zone
route sending `/v1/email/*` to the issuer), `iss` (`{url}/v1/email`, `url` defaulting to `apiUrl`), `cloudflare` (its
own Worker and D1, never the API's or the watchdog's), `signer`
(`{kind: "worker-secret", activeKid}` on testnet; `aws-kms` is refused by `gen` until batch 10 and by the schema off
testnet for `worker-secret`), `publicKeys` (the JWKS: 2048–4096-bit RSA, e = 65537, kid = RFC 7638 thumbprint, the
standby included), `from` (user mail's `From`, on the user-mail sending subdomain), `sender` (`sendgrid`; `outbox` only
in `local*` envs), and optionally `dailySendBudget` (default 1000), `access` (`{teamDomain, aud, staffEmails}` for staff
client proofs) and `sendgridWebhookPublicKey`. A change needs `email-issuer gen` and a redeploy; a key change is also an
owner proposal on chain and a watchdog pin change.

`rpcFallback` (optional): a second NEAR JSON-RPC endpoint, `https` only and not `rpc` itself, ideally from another
provider. The vault and the export window read from it (session re-syncs, the login's registry check, transaction
polling) only when `rpc` errors or doesn't answer within 8 s; each read's answer comes from one endpoint. It is built
into the pages and joins `rpc` in their CSP (`NEAR_RPC_FALLBACK` in the generated Worker configs), so a change needs
`gen`, a page build and a redeploy of the API and both page Workers (`docs/decisions.md` D65). sandbox-dev uses
`https://rpc.testnet.near.org` (primary `test.rpc.fastnear.com`; the fallback answered in ~3.5 s when probed, slow but
fine for a fallback).

`vaultOrigin` and `authOrigin` (optional in the schema until every deployed env has them; `gen` refuses an env
without them and the page build skips it): the origins of Hana's key vault page and of its login, approval and export pages. Set both or neither. Each is a bare origin
(`https://host[:port]`, no path or trailing slash); `https` is required, and loopback (`localhost`, `*.localhost`,
127.0.0.0/8, `[::1]`, also with a trailing dot or as IPv4-mapped `[::ffff:7f00:1]`) is allowed only in envs whose name
starts with `local`. Any other host must be a real DNS name under a registrable domain: no IP address (`0.0.0.0` and
private ranges included), bare public suffix (`workers.dev`), single label or trailing dot, in any env. The two must be
different origins, neither may be `apiUrl`'s origin, and outside `local*`/`sandbox*` envs all three must be different
sites (registrable domains, Public Suffix List rules), so the key-holding frame shares no cookies or storage with the
pages that handle tokens or with the API. sandbox-dev's two `*.tingtc.workers.dev`
hostnames are one site, which only a dev env allows. Google redirects to `{authOrigin}/login/callback`, so changing
`authOrigin` breaks own-client partners' redirect registrations (not addresses). `@hana-id/web` builds its pages only
for envs that set both, and its published package (`build:lib`) carries exactly those envs. Both builds fail if one
of them still has an `UNSET` value; the package build also fails on a `local*` env (`docs/operations.md` "Releasing
the SDK packages").
