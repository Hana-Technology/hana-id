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

// `admin owner:call` refuses any method not in OWNER_METHODS, and the recovery playbooks send every owner-only call
// through it (`set_sessions_valid_from_ms` in forged-active-key, D126): keep it a superset of the contract's list.
describe('OWNER_METHODS', () => {
  it("covers every owner-only call of the contract's own test list", async () => {
    const { OWNER_METHODS } = await import('../lib/contract.ts');
    const tests = readFileSync(join(repoRoot, 'contracts', 'hana-signer', 'src', 'tests.rs'), 'utf8');
    const body = /fn owner_only_calls\(\)[\s\S]*?\n\}\n/u.exec(tests)?.[0] ?? '';
    const contractOwnerOnly = [...body.matchAll(/\(\s*"([a-z_]+)",\s*Box::new/gu)].map((m) => m[1]!);
    expect(contractOwnerOnly.length).toBeGreaterThan(20);
    for (const method of contractOwnerOnly) expect(OWNER_METHODS as readonly string[], method).toContain(method);
  });
});
