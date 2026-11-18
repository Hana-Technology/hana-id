// Temporary directories for the scripts' tests: one private parent per test file (`hana-t-…` under the OS temp
// directory, short enough for a unix socket path on macOS), every directory a test asks for made inside it, and the
// parent removed when the file's tests end. Nothing is left in, or searched for in, the shared temp directory.
// Importing this module registers the file-level afterAll (vitest evaluates it again for each test file).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

let parent: string | undefined;

/** This test file's private temp directory (made on first use). */
export function testTempRoot(): string {
  parent ??= mkdtempSync(join(tmpdir(), 'hana-t-'));
  return parent;
}

/** A fresh directory inside this file's private temp directory (`prefix` + random suffix). */
export const testTempDir = (prefix: string): string => mkdtempSync(join(testTempRoot(), prefix));

afterAll(() => {
  if (parent) rmSync(parent, { recursive: true, force: true });
  parent = undefined;
});
