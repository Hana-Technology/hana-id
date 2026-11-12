import { normaliseOrigin as normaliseOriginCore } from '@hana-id/console-core';
import { hanaOwnOrigins, loadEnv } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { originContext } from '../lib/admin-apps.ts';
import { sql, sqlValue } from '../lib/sql.ts';
import {
  assertAppName,
  assertAppOrigins,
  assertEnvironment,
  assertOrgId,
  printable,
  assertPlanId,
  assertScopeId,
  committedSql,
  findAppSql,
  normaliseOrigin,
  writeCommand,
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
  it('finds an app by id or by any of its keys, never by apps.publishable_key', () => {
    const s = findAppSql("a'");
    expect(s).toContain("a.id = 'a''' OR a.id IN (SELECT app_id FROM app_keys WHERE key = 'a''')");
    expect(s).not.toMatch(/publishable_key/u);
  });

  it('a write ends with the read-back of its commit row', () => {
    expect(writeCommand({ statements: ['SELECT 1', 'SELECT 2'], requestId: "r'1" })).toBe("SELECT 1;\nSELECT 2;\nSELECT COUNT(*) AS committed FROM app_changes WHERE request_id = 'r''1';");
    expect(committedSql('r1')).toBe("SELECT COUNT(*) AS committed FROM app_changes WHERE request_id = 'r1'");
  });

  it('validates scope, plan, org and environment', () => {
    expect(assertScopeId('global')).toBe('global');
    expect(assertScopeId('s1a')).toBe('s1a');
    expect(() => assertScopeId("s1'")).toThrow();
    expect(() => assertScopeId('x')).toThrow();
    expect(assertPlanId('free')).toBe('free');
    expect(() => assertPlanId('Free Plan')).toThrow();
    expect(assertOrgId('org_legacy')).toBe('org_legacy');
    expect(() => assertOrgId('org_other')).toThrow('until the console database exists');
    expect(assertEnvironment('live')).toBe('live');
    expect(() => assertEnvironment('prod')).toThrow("'test' or 'live'");
  });
});

describe('origins: console-core normaliseOrigin, the one form (no copy in the CLI)', () => {
  it('normalises as console-core does, byte for byte', () => {
    for (const o of ['https://Example.com', 'https://example.com/', 'https://example.com:443', 'http://localhost:5173', 'http://localhost:*', 'https://bücher.example', 'https://example.com.', 'http://[::1]:8080']) {
      expect(normaliseOrigin(o), o).toBe(normaliseOriginCore(o));
    }
    expect(normaliseOrigin('https://Example.com')).toBe('https://example.com');
    expect(normaliseOrigin('https://bücher.example')).toBe('https://xn--bcher-kva.example');
  });

  it('refuses what is not an origin', () => {
    expect(() => normaliseOrigin('https://example.com/path')).toThrow('path');
    expect(() => normaliseOrigin('https://example.com?x=1')).toThrow();
    expect(() => normaliseOrigin('https://u:p@example.com')).toThrow('credentials');
    expect(() => normaliseOrigin('ftp://example.com')).toThrow();
    expect(() => normaliseOrigin('example.com')).toThrow();
  });
});

describe('app origins the admin CLI accepts (console-core originProblem; OPER-6, APIV-7)', () => {
  const sandbox = loadEnv('sandbox-dev');
  const ctx = originContext(sandbox);
  const staging = { ...ctx, envName: 'staging' };

  it('accepts real partner origins', () => {
    expect(() => assertAppOrigins(ctx, 'test', ['https://wallet.example.com', 'https://app.partner.io:8443'])).not.toThrow();
    expect(() => assertAppOrigins(staging, 'live', ['https://wallet.example.com'])).not.toThrow();
  });

  it("refuses Hana's own origins (REFUSED_ORIGINS) for any app", () => {
    expect(ctx.refusedOrigins).toEqual(hanaOwnOrigins(sandbox));
    for (const o of [sandbox.vaultOrigin!, sandbox.authOrigin!, new URL(sandbox.apiUrl).origin]) {
      expect(() => assertAppOrigins(ctx, 'test', [o]), o).toThrow(/refused \(refused\)/u);
    }
  });

  it('loopback origins and the localhost wildcard only for test scopes in dev envs (D142)', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:*']) {
      expect(() => assertAppOrigins(ctx, 'test', [o]), o).not.toThrow();
      expect(() => assertAppOrigins(ctx, 'live', [o]), `${o} live`).toThrow(/refused \((loopback|wildcard)\)/u);
      expect(() => assertAppOrigins(staging, 'test', [o]), `${o} staging`).toThrow(/refused \((loopback|wildcard)\)/u);
    }
  });

  it('refuses what the API would silently drop, plain http, and a mixed-script label on live scopes', () => {
    for (const o of ['https://*.example.com', 'https://10.0.0.1', 'https://workers.dev', 'https://intranet', 'http://example.com']) {
      expect(() => assertAppOrigins(ctx, 'test', [o]), o).toThrow();
    }
    const mixed = normaliseOrigin('https://аpple.example'); // Cyrillic а + Latin
    expect(() => assertAppOrigins(staging, 'live', [mixed])).toThrow(/mixed_script/u);
    expect(() => assertAppOrigins(staging, 'test', [mixed])).not.toThrow();
  });
});

describe('app names (OPER-11)', () => {
  it('normalises to NFC and refuses controls, bidi and zero-width characters', () => {
    expect(assertAppName('  Café Wallet ')).toBe('Café Wallet');
    for (const bad of ['Wallet‮', 'A​B', 'A\u0007B', 'A\u001b[31mB', 'A B', 'A⁦B⁩', 'AB']) {
      expect(() => assertAppName(bad), JSON.stringify(bad)).toThrow(/control, format/u);
    }
    expect(assertAppName('Sodax · Stellar 🌸')).toBe('Sodax · Stellar 🌸');
  });

  it('refuses the service\'s names (D686 as extended by D765): "Hana", "Journear" and their look-alikes, "Passport Home"; "Passport" alone passes', () => {
    for (const bad of ['Hana Pay', 'Journear', 'J0urnear', 'JOURNEAR', 'journear-pay', `J${String.fromCharCode(0x043e)}urnear`, 'J o u r n e a r', 'Passport Home']) {
      expect(() => assertAppName(bad), bad).toThrow(/App name: The name must not contain/u);
    }
    expect(assertAppName('Passport Travel')).toBe('Passport Travel');
    expect(assertAppName('Passport')).toBe('Passport');
  });

  it('prints stored names with unsafe characters escaped (an ANSI escape or bidi override in D1 never reaches the terminal raw)', () => {
    expect(printable('Wal‮let\u001b[2J')).toBe('Wal\\u{202e}let\\u{1b}[2J');
    expect(printable('Plain name')).toBe('Plain name');
  });
});
