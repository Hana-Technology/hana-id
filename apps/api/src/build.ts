// The build id this Worker was deployed with (D384): the HANA_BUILD var that `pnpm --filter @hana-id/api run deploy`
// and `deploy:pages` set from git (scripts/deploy.ts), e.g. `0485faa1c2d3` or `0485faa1c2d3-dirty`. A Worker deployed
// any other way (a raw `wrangler deploy`, `wrangler dev`) has none and reports null, which `deploy-check` flags.
// The format and paths are @hana-id/env/build-id's (test/build-id.test.ts keeps them equal; the Workers don't import
// it, as @hana-id/env is a dev dependency here).

/** A build id: 12 hex characters of the commit, `-dirty` for a tree with uncommitted changes. */
export const BUILD_ID_RE = /^[0-9a-f]{12}(?:-dirty)?$/u;

/** Each page Worker's build endpoint (`{"build": <id> | null}`). */
export const BUILD_PATH = '/.well-known/hana-build';

/** The deployed build id, or null when the var is absent or isn't one. */
export function deployedBuild(value: string | undefined): string | null {
  return value !== undefined && BUILD_ID_RE.test(value) ? value : null;
}
