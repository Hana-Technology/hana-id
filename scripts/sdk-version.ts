// Sets the one version of @hana-id/core, web, react and sodax (package.json and each VERSION constant):
//
//   pnpm --filter @hana-id/scripts sdk-version 0.2.0
//
// See lib/sdk-version.ts and docs/operations.md "Releasing the SDK packages".
import { join } from 'node:path';
import { setSdkVersion } from './lib/sdk-version.ts';

const version = process.argv[2];
if (!version) {
  console.error('usage: pnpm --filter @hana-id/scripts sdk-version <version>');
  process.exit(1);
}
const written = setSdkVersion(join(import.meta.dirname, '..'), version);
console.log(written.length ? `set ${version} in:\n  ${written.join('\n  ')}` : `already ${version}`);
