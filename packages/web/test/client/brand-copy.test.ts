// The product's names in the strings this package's partners and their users read (D765): "Journear Passport", and
// "Journear" for the company or service, never the old "Hana ID" / "Hana". Code identifiers keep "hana" (HanaError,
// createHana, hana.*, `hana-vault-`, error codes): this looks only at words inside string literals, outside comments.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../../src/', import.meta.url));
const FILES: readonly string[] = [...readdirSync(DIR + 'client').filter((f) => f.endsWith('.ts')).map((f) => `client/${f}`), 'index.ts', 'create-hana.ts', 'stellar-wallets-kit.ts'];
/** The old names as words: "Hana" not followed by a letter (so HanaError, HanaProvider and hana-id don't count). */
const OLD_NAME = /\bHana(?![A-Za-z_])/u;
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gu;

function offenders(file: string): string[] {
  const code = readFileSync(DIR + file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/u.test(l))
    .join('\n');
  return [...code.matchAll(LITERAL)].map((m) => m[0]).filter((s) => OLD_NAME.test(s)).map((s) => `${file}: ${s.slice(0, 120)}`);
}

describe('user- and partner-visible strings', () => {
  it('name the product Journear Passport, never Hana', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.flatMap(offenders)).toEqual([]);
  });
});
