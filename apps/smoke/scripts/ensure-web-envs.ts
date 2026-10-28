// Writes packages/web/src/envs.generated.ts (the env constants @hana-id/web is built with, gitignored) only when it is
// missing, so a standalone `pnpm --filter @hana-id/smoke typecheck` works in a fresh checkout. It never rewrites an
// existing file: under `pnpm -r` this runs next to other packages that read it, and @hana-id/web's own build, test and
// typecheck regenerate it first. `dev` and `build` regenerate it in full (gen:envs), after a manifest change.
import { existsSync } from 'node:fs';
import { GENERATED_PATH, main } from '../../../packages/web/scripts/gen-envs.ts';

if (!existsSync(GENERATED_PATH)) {
  const names = main();
  console.log(`wrote ${GENERATED_PATH} (${names.join(', ') || 'no env sets vaultOrigin and authOrigin'})`);
}
