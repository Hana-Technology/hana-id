// Every Google token the API relays goes to the chain, where it is public, so each verification must be followed by
// the claim allow-list (claims.ts `disallowedClaim`, `token_has_pii`; D271, D274). The one token verified and not
// relayed, a console member's step-up (changes/step-up.ts), is held to the same list. The route tests check each
// route; this scan makes a new verifyIdToken caller fail here until it is reviewed and listed.
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
  it('only login-token.ts, owner-actions.ts and changes/step-up.ts verify a Google token', () => {
    const callers = files.filter((f) => calls(readFileSync(f, 'utf8'), 'verifyIdToken') > 0).map((f) => relative(srcDir, f).replaceAll('\\', '/'));
    expect(callers.sort()).toEqual(['changes/step-up.ts', 'login-token.ts', 'owner-actions.ts']);
  });

  it('changes/step-up.ts holds the step-up token to the allow-list too (never relayed, but never PII either)', () => {
    const source = read('changes/step-up.ts');
    expect(calls(source, 'verifyIdToken')).toBe(1);
    expect(source).toMatch(/const claim = disallowedClaim\(jwt\);\n\s*if \(claim !== null\) return refuse\(/u);
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
    // On every path: no option (ConsoleRpc's `console` or any other) gates the allow-list.
    expect(source).toMatch(/const pii = piiRefusal\(jwt, 'The owner token'\);\n\s*if \(pii\) return pii;/u);
    expect(source).not.toMatch(/opts\.console && .*pii/iu);
  });

  it('the API allow-list is the one the vault and the login popup apply (@hana-id/core), and refuses every named PII claim', () => {
    expect(TOKEN_CLAIM_ALLOW_LIST).toHaveLength(11);
    expect(TOKEN_CLAIM_ALLOW_LIST).toContain('at_hash'); // D342
    expect(NAMED_PII_CLAIMS).toHaveLength(9);
    expect([...ALLOWED_CLAIMS].sort()).toEqual([...TOKEN_CLAIM_ALLOW_LIST].sort());
    expect([...TEST_NAMED_PII_CLAIMS].sort()).toEqual([...NAMED_PII_CLAIMS].sort());
    for (const claim of NAMED_PII_CLAIMS) expect(ALLOWED_CLAIMS.has(claim), claim).toBe(false);
  });

  it('no source reads the retired REJECT_PII_ON_SESSIONS flag', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), relative(srcDir, f)).not.toMatch(/REJECT_PII_ON_SESSIONS/u);
  });
});

// The partner console verifies its own Google tokens (batch C9's sign-in; C10's step-ups and owner actions, whose
// tokens the API verifies again here and relays). Every one is held to the allow-list by scope (D290): `openid` exactly
// the API's list (with `at_hash`, D342), sign-in's `openid email` the list plus exactly email, email_verified and hd.
describe('Google tokens the console verifies', () => {
  const appsDir = join(import.meta.dirname, '..', '..', '..');
  const consoleFiles = ['console', 'console-auth'].flatMap((app) => {
    const dir = join(appsDir, app, 'src');
    return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => ({ name: `${app}/src/${f.replaceAll('\\', '/')}`, text: readFileSync(join(dir, f), 'utf8') }));
  });
  const tokenFile = consoleFiles.find((f) => f.name === 'console/src/auth-token.ts')!.text;

  it('only console/src/auth-token.ts verifies a Google token (console-auth verifies none)', () => {
    expect(consoleFiles.filter((f) => calls(f.text, 'verifyIdToken') > 0).map((f) => f.name)).toEqual(['console/src/auth-token.ts']);
    expect(calls(tokenFile, 'verifyIdToken')).toBe(1);
  });

  it('applies the allow-list right after the token checks, with no option to skip it', () => {
    expect(tokenFile).toMatch(/const claim = disallowedClaim\(jwt, c\.scope\);\n\s*if \(claim !== null\) return \{ ok: false, code: 'claim_not_allowed', claim \};/u);
    expect(tokenFile).not.toMatch(/claimAllowList|skipAllowList/u);
    // Every caller passes the flow's own scope, read from its auth_flows row.
    for (const f of consoleFiles.filter((x) => /verifyConsoleToken\(/u.test(x.text) && x.name !== 'console/src/auth-token.ts')) {
      for (const m of f.text.matchAll(/verifyConsoleToken\([^;]*scope: ([^,}]+)/gu)) expect(m[1]!.trim(), f.name).toBe('flow.scope');
    }
  });

  it("its openid list is the API's and core's; sign-in adds exactly email, email_verified and hd", () => {
    expect(listIn(tokenFile, 'TOKEN_CLAIM_ALLOW_LIST')).toEqual(TOKEN_CLAIM_ALLOW_LIST);
    expect([...ALLOWED_CLAIMS]).toEqual(TOKEN_CLAIM_ALLOW_LIST);
    expect(listIn(tokenFile, 'SIGN_IN_EXTRA_CLAIMS')).toEqual(['email', 'email_verified', 'hd']);
    // A code-flow token's at_hash is checked against the access token of the same exchange, in both scopes.
    expect(tokenFile).toMatch(/if \(Object\.hasOwn\(raw, 'at_hash'\)\) \{\n\s*if \(typeof raw\.at_hash !== 'string' \|\| !c\.accessToken \|\| raw\.at_hash !== \(await atHash\(c\.accessToken\)\)\) return \{ ok: false, code: 'at_hash_mismatch' \};/u);
    expect(tokenFile).toMatch(/scope === 'openid' \? TOKEN_CLAIM_ALLOW_LIST : \[\.\.\.TOKEN_CLAIM_ALLOW_LIST, \.\.\.SIGN_IN_EXTRA_CLAIMS\]/u);
  });

  it('a console flow asks Google for openid email (sign-in) or openid (step-ups): never profile, never more', () => {
    const migration = readFileSync(join(appsDir, 'console', 'migrations', '0001_init.sql'), 'utf8');
    expect(migration).toMatch(/scope\s+TEXT NOT NULL CHECK \(scope IN \('openid email', 'openid'\)\)/u);
    expect(migration).toMatch(/CHECK \(purpose = 'step_up' OR scope = 'openid email'\)/u);
  });
});
