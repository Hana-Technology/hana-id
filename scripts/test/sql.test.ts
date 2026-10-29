import { describe, expect, it } from 'vitest';
import { sql, sqlValue } from '../lib/sql.ts';
import {
  addOriginsSql,
  assertPlanId,
  assertScopeId,
  createAppSql,
  findAppSql,
  normaliseOrigin,
  removeOriginsSql,
  scopeConflictSql,
  setStatusSql,
} from '../lib/admin-sql.ts';

describe('sqlValue', () => {
  it('escapes strings by doubling single quotes', () => {
    expect(sqlValue("O'Brien")).toBe("'O''Brien'");
    expect(sqlValue("'; DROP TABLE apps; --")).toBe("'''; DROP TABLE apps; --'");
    expect(sqlValue('back\\slash "q"')).toBe(`'back\\slash "q"'`);
  });

  it('renders numbers, booleans, bigints and null', () => {
    expect(sqlValue(42)).toBe('42');
    expect(sqlValue(-1)).toBe('-1');
    expect(sqlValue(10n ** 20n)).toBe('100000000000000000000');
    expect(sqlValue(true)).toBe('1');
    expect(sqlValue(null)).toBe('NULL');
  });

  it('rejects values that cannot be represented safely', () => {
    expect(() => sqlValue(1.5)).toThrow();
    expect(() => sqlValue(Number.NaN)).toThrow();
    expect(() => sqlValue('a\0b')).toThrow('NUL');
    expect(() => sqlValue('\uD800')).toThrow('Unicode');
    expect(() => sqlValue({} as unknown as string)).toThrow();
  });

  it('sql tag escapes every interpolation', () => {
    const name = "x' OR '1'='1";
    expect(sql`SELECT * FROM apps WHERE name = ${name} AND n = ${3}`).toBe("SELECT * FROM apps WHERE name = 'x'' OR ''1''=''1' AND n = 3");
  });
});

describe('admin SQL', () => {
  it('creates an app with its origins', () => {
    const s = createAppSql({ id: 'app_1', name: "Bob's app", scopeId: 's1', publishableKey: 'pk_test_x', plan: 'free', createdAt: 1700000000000, origins: ['https://a.com', 'http://localhost:5173'] });
    expect(s).toBe(
      "INSERT INTO apps (id, name, scope_id, publishable_key, status, plan, created_at) VALUES ('app_1', 'Bob''s app', 's1', 'pk_test_x', 'active', 'free', 1700000000000);\n" +
        "INSERT INTO app_origins (app_id, origin) VALUES ('app_1', 'https://a.com');\n" +
        "INSERT INTO app_origins (app_id, origin) VALUES ('app_1', 'http://localhost:5173');",
    );
  });

  it('other statements', () => {
    expect(findAppSql("a'")).toContain("WHERE id = 'a''' OR publishable_key = 'a'''");
    expect(addOriginsSql('app_1', ['https://a.com'])).toContain("SELECT 'app_1', 'https://a.com' WHERE NOT EXISTS");
    expect(removeOriginsSql('app_1', ['https://a.com', 'https://b.com']).split(';\n')).toHaveLength(2);
    expect(setStatusSql('app_1', 'suspended')).toBe("UPDATE apps SET status = 'suspended' WHERE id = 'app_1'");
  });

  it('finds the other key type on a scope (pk_test_ and pk_live_ apps never share one)', () => {
    expect(scopeConflictSql('s1', 'pk_test_abc')).toBe("SELECT id FROM apps WHERE scope_id = 's1' AND publishable_key LIKE 'pk\\_live\\_%' ESCAPE '\\'");
    expect(scopeConflictSql("s'1", 'pk_live_abc')).toBe("SELECT id FROM apps WHERE scope_id = 's''1' AND publishable_key LIKE 'pk\\_test\\_%' ESCAPE '\\'");
  });

  it('normalises and validates origins', () => {
    expect(normaliseOrigin('https://Example.com')).toBe('https://example.com');
    expect(normaliseOrigin('https://example.com/')).toBe('https://example.com');
    expect(normaliseOrigin('https://example.com:443')).toBe('https://example.com');
    expect(normaliseOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normaliseOrigin('http://localhost:*')).toBe('http://localhost:*');
    expect(() => normaliseOrigin('http://example.com')).toThrow('localhost');
    expect(() => normaliseOrigin('https://example.com/path')).toThrow('path');
    expect(() => normaliseOrigin('https://example.com?x=1')).toThrow();
    expect(() => normaliseOrigin('https://u:p@example.com')).toThrow('credentials');
    expect(() => normaliseOrigin('ftp://example.com')).toThrow();
    expect(() => normaliseOrigin('example.com')).toThrow();
  });

  it('validates scope and plan ids', () => {
    expect(assertScopeId('global')).toBe('global');
    expect(assertScopeId('s1a')).toBe('s1a');
    expect(() => assertScopeId("s1'")).toThrow();
    expect(() => assertScopeId('x')).toThrow();
    expect(assertPlanId('free')).toBe('free');
    expect(() => assertPlanId('Free Plan')).toThrow();
  });
});
