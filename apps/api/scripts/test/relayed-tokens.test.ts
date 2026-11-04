// Every Google token the API verifies is relayed to the chain, where it is public, so each verification must be
// followed by the claim allow-list (claims.ts `disallowedClaim`, `token_has_pii`; D271, D274). The route tests check
// each route; this scan makes a new verifyIdToken caller fail here until it is reviewed and listed.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_CLAIMS } from '../../src/claims.ts';

const srcDir = join(import.meta.dirname, '..', '..', 'src');
const files = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => join(srcDir, f));
const read = (name: string): string => readFileSync(join(srcDir, name), 'utf8');
const calls = (source: string, fn: string): number => source.match(new RegExp(`\\b${fn}\\(`, 'gu'))?.length ?? 0;
/** The string literals of `name`'s array in `source` (these modules don't load here: workerd, or core's DOM types). */
const listIn = (source: string, name: string): string[] =>
  [...(new RegExp(`${name}: readonly string\\[\\] = (?:Object\\.freeze\\()?\\[([^\\]]*)\\]`, 'u').exec(source)?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
const core = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'core', 'src', 'id-token.ts'), 'utf8');
const TOKEN_CLAIM_ALLOW_LIST = listIn(core, 'TOKEN_CLAIM_ALLOW_LIST');
const NAMED_PII_CLAIMS = listIn(core, 'NAMED_PII_CLAIMS');
const TEST_NAMED_PII_CLAIMS = listIn(readFileSync(join(import.meta.dirname, '..', '..', 'test', 'helpers.ts'), 'utf8'), 'NAMED_PII_CLAIMS');

describe('Google tokens relayed by the API', () => {
  it('only login-token.ts and owner-actions.ts verify a Google token', () => {
    const callers = files.filter((f) => calls(readFileSync(f, 'utf8'), 'verifyIdToken') > 0).map((f) => relative(srcDir, f).replaceAll('\\', '/'));
    expect(callers.sort()).toEqual(['login-token.ts', 'owner-actions.ts']);
  });

  it('login-token.ts applies the allow-list unconditionally, with no option to skip it', () => {
    const source = read('login-token.ts');
    expect(calls(source, 'verifyIdToken')).toBe(1);
    expect(source).toMatch(/const claim = disallowedClaim\(jwt\);/u);
    expect(source).not.toMatch(/claimAllowList/u);
  });

  it('owner-actions.ts checks the claims of each token it verifies (the owner token and the client proof)', () => {
    const source = read('owner-actions.ts');
    expect(calls(source, 'verifyIdToken')).toBe(2);
    expect(calls(source, 'piiRefusal')).toBe(3); // the helper and its two uses
  });

  it('the API allow-list is the one the vault and the login popup apply (@hana-id/core), and refuses every named PII claim', () => {
    expect(TOKEN_CLAIM_ALLOW_LIST).toHaveLength(10);
    expect(NAMED_PII_CLAIMS).toHaveLength(9);
    expect([...ALLOWED_CLAIMS].sort()).toEqual([...TOKEN_CLAIM_ALLOW_LIST].sort());
    expect([...TEST_NAMED_PII_CLAIMS].sort()).toEqual([...NAMED_PII_CLAIMS].sort());
    for (const claim of NAMED_PII_CLAIMS) expect(ALLOWED_CLAIMS.has(claim), claim).toBe(false);
  });

  it('no source reads the retired REJECT_PII_ON_SESSIONS flag', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), relative(srcDir, f)).not.toMatch(/REJECT_PII_ON_SESSIONS/u);
  });
});
