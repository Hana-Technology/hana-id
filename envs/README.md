# Environments

One JSON manifest per environment, validated by `packages/env` (`manifestSchema`). Every NEAR account name, endpoint and
Cloudflare resource name comes from here. Names in `sandbox-dev.json` are throwaway; wallets derived on them are
disposable. Add an environment by copying `sandbox-dev.json`, changing `name` (must match the file name) and the accounts.

Google client fields:

- `googleClientIds`: Hana's own app's Google OAuth client IDs, registered as clients of the reserved `global` scope.
- `sharedGoogleClientIds`: Hana's shared login client(s), set with `set_shared_clients` (at most 5). Partner apps
  registered with `--allow-shared` log in through these instead of their own Google client. A client ID can be in only
  one of the two lists (the contract rejects a client that is both shared and a scope's own).

Values containing `UNSET` are placeholders: `deploy-contract` skips the step that needs them (with a warning) until
they are filled in.

`cloudflare.durableObjectLocation` (optional): the region for the Durable Objects every login shares (relayer keys, the
per-app and owner-action limiters), as a Cloudflare location hint (`apac`, `weur`, `enam`, …). Without it each object
lives wherever its first request happened to arrive. Pick the region of most users (sandbox-dev: `apac`, next to its
D1 database). Per-IP limiters always stay near their client. Changing it creates new objects in the new region.

`vaultOrigin` and `authOrigin` (batch B; optional in the schema until every deployed env has them): the origins of
Hana's key vault page and of its login, approval and export pages. Set both or neither. Each is a bare origin
(`https://host[:port]`, no path or trailing slash); `https` is required, and loopback (`http://localhost:…`,
`http://127.0.0.1:…`) is allowed only in envs whose name starts with `local`. The two must be different origins, and
outside `local*`/`sandbox*` envs different sites (registrable domains, Public Suffix List rules), so the key-holding
frame shares no cookies or storage with the pages that handle tokens. sandbox-dev's two `*.tingtc.workers.dev`
hostnames are one site, which only a dev env allows. Google redirects to `{authOrigin}/login/callback`, so changing
`authOrigin` breaks own-client partners' redirect registrations (not addresses). `@hana-id/web` builds its pages only
for envs that set both.
