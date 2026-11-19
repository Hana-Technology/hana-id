// reviewed-near-rebuild.ts
//
// Rebuilds Journear's reviewed NEAR contracts with the deploy tool's command and compares their code hashes with every
// deploy core records (D885). Skips when the recorded toolchain isn't installed. Run by `pnpm verify --full`. See
// lib/reviewed-near-rebuild.ts.
import { reviewedNearRebuild } from './lib/reviewed-near-rebuild.ts';

process.exitCode = reviewedNearRebuild();
