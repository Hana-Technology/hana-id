// contracts/integration-tests parses apps/api/src/gas.ts (api_gas_table): every DEFAULT_GAS_TGAS value must stay a
// plain numeric literal. This checks the login and link entries are, at their D155 values (email login batch 6).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'gas.ts'), 'utf8');

describe('gas.ts', () => {
  it.each([
    ['create_session', '100'],
    ['create_session_and_derive', '150'],
    ['link_identity', '250'],
    ['cancel_link', '150'],
    ['unlink_identity', '150'],
  ])('%s defaults to the literal %s Tgas', (method, tgas) => {
    const table = /DEFAULT_GAS_TGAS[^{]*\{([^}]*)\}/u.exec(source)?.[1] ?? '';
    expect(new RegExp(`^\\s*${method}: (\\d+),\\s*$`, 'mu').exec(table)?.[1]).toBe(tgas);
  });
});
