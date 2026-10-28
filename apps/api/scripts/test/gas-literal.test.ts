// contracts/integration-tests parses apps/api/src/gas.ts (api_gas_table): every DEFAULT_GAS_TGAS value must stay a
// plain numeric literal. This checks the batch B entry is one, at its spec value.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'gas.ts'), 'utf8');

describe('gas.ts', () => {
  it('create_session_and_derive defaults to the literal 100 Tgas', () => {
    const table = /DEFAULT_GAS_TGAS[^{]*\{([^}]*)\}/u.exec(source)?.[1] ?? '';
    expect(/^\s*create_session_and_derive: (\d+),\s*$/mu.exec(table)?.[1]).toBe('100');
  });
});
