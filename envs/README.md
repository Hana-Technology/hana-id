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
