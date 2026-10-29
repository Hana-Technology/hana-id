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
- `issuerKeyDelayMs` (≤ 7 days), `governanceDelayMs` (≤ 30 days): the delays `new` and `migrate_v1` start with (D80;
  sandbox-dev 120 000 and 60 000). `deploy-contract` sets them on chain if they differ (decreases wait, per contract).
- `allowSignerFullAccessKey`: the signer may keep a full-access key (D86). Only for `local*` / `sandbox*` envs on
  testnet: the schema refuses it outside testnet, `deploy-contract` refuses it in any other env, and a test checks that
  no committed manifest but sandbox-dev's sets it. Without it, `deploy-contract` blocks on any full-access key on the
  signer, and a new env's signer is created with the `--creation-plan` batch.

Values containing `UNSET` are placeholders: `deploy-contract` skips the step that needs them (with a warning) until
they are filled in.

`cloudflare.durableObjectLocation` (optional): the region for the Durable Objects every login shares (relayer keys, the
per-app and owner-action limiters), as a Cloudflare location hint (`apac`, `weur`, `enam`, …). Without it each object
lives wherever its first request happened to arrive. Pick the region of most users (sandbox-dev: `apac`, next to its
D1 database). Per-IP limiters always stay near their client. Changing it creates new objects in the new region.

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
