// The API sizes its cancel_change ceilings from hana-signer's per-scope limits (D100, APIW-3): keep the copies in
// apps/api/src/handlers.ts equal to the contract's (the Worker can't read Rust at runtime).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@hana-id/env';
import { describe, expect, it } from 'vitest';

const rust = readFileSync(join(repoRoot, 'contracts', 'hana-signer', 'src', 'registry.rs'), 'utf8');
const api = readFileSync(join(repoRoot, 'apps', 'api', 'src', 'handlers.ts'), 'utf8');
const rustConst = (name: string) => Number(new RegExp(`pub const ${name}: usize = (\\d+);`, 'u').exec(rust)?.[1]);
const apiConst = (name: string) => Number(new RegExp(`export const ${name} = (\\d+);`, 'u').exec(api)?.[1]);

describe('contract limits copied into the API', () => {
  it('CONTRACT_MAX_OWNERS and CONTRACT_MAX_PENDING equal registry.rs MAX_OWNERS and MAX_PENDING', () => {
    expect(rustConst('MAX_OWNERS')).toBeGreaterThan(0);
    expect(apiConst('CONTRACT_MAX_OWNERS')).toBe(rustConst('MAX_OWNERS'));
    expect(apiConst('CONTRACT_MAX_PENDING')).toBe(rustConst('MAX_PENDING'));
  });
});
