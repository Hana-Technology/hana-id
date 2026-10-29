// Builds the SDK package in the current directory for publishing (each package's `build:lib`):
//
//   pnpm --filter @hana-id/core build:lib
//
// See lib/sdk-build.ts.
import { buildPackage } from './lib/sdk-build.ts';

const files = buildPackage(process.cwd());
console.log(`built ${files.length} files`);
