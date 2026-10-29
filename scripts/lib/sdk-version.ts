// One version for the four SDK packages (lockstep): sets `version` in each package.json and the `VERSION` constant in
// its source (web's is sent to the vault as `sdk` in `hana:hello`). docs/operations.md "Releasing the SDK packages".
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SDK_PACKAGES } from './pack-check.ts';

/** Plain semver, with an optional prerelease (`0.2.0`, `1.0.0-rc.1`); no build metadata, no leading `v`. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u;

export function checkVersion(version: string): void {
  if (!SEMVER.test(version)) throw new Error(`${JSON.stringify(version)} is not a version (x.y.z or x.y.z-pre)`);
}

/** package.json text with its top-level `"version"` set; the rest of the file is kept byte for byte. */
export function withPackageVersion(text: string, version: string): string {
  const re = /^(  "version": )"[^"]*"/mu;
  if (!re.test(text)) throw new Error('package.json has no top-level "version"');
  return text.replace(re, `$1${JSON.stringify(version)}`);
}

/** Source text with `export const VERSION = '…';` set. */
export function withVersionConstant(text: string, version: string): string {
  const re = /^export const VERSION = '[^']*';$/mu;
  if (!re.test(text)) throw new Error("no `export const VERSION = '…';` line");
  return text.replace(re, `export const VERSION = '${version}';`);
}

/** Sets the version everywhere under `root`; returns the files written. */
export function setSdkVersion(root: string, version: string): string[] {
  checkVersion(version);
  const written: string[] = [];
  for (const pkg of SDK_PACKAGES) {
    for (const [file, edit] of [
      [join(pkg.dir, 'package.json'), withPackageVersion],
      [join(pkg.dir, pkg.versionFile), withVersionConstant],
    ] as const) {
      const path = join(root, file);
      const before = readFileSync(path, 'utf8');
      const after = edit(before, version);
      if (after !== before) {
        writeFileSync(path, after);
        written.push(file);
      }
    }
  }
  return written;
}
