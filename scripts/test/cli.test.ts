import { describe, expect, it } from 'vitest';
import { CliError, parseCli } from '../lib/cli.ts';
import { assertCommandPositionals, clientsFromArgs, ownersFromArgs } from '../lib/admin-args.ts';

describe('parseCli', () => {
  const spec = { strings: ['name', 'n'], multiple: ['origin'], booleans: ['yes', 'remote'] };

  it('parses positionals, strings, repeatable and boolean flags', () => {
    const a = parseCli(['sandbox-dev', 'app:create', '--name', 'Sodax', '--origin', 'https://a.com', '--origin=https://b.com', '--yes'], spec);
    expect(a.positionals).toEqual(['sandbox-dev', 'app:create']);
    expect(a.str('name')).toBe('Sodax');
    expect(a.list('origin')).toEqual(['https://a.com', 'https://b.com']);
    expect(a.flag('yes')).toBe(true);
    expect(a.flag('remote')).toBe(false);
    expect(a.list('name')).toEqual(['Sodax']);
    expect(a.list('missing')).toEqual([]);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseCli(['x', '--nope'], spec)).toThrow(CliError);
    expect(() => parseCli(['x', '--name'], spec)).toThrow(CliError);
  });

  it('required and int', () => {
    const a = parseCli(['--n', '5'], spec);
    expect(() => a.required('name')).toThrow('--name is required');
    expect(a.int('n', 3, { min: 1, max: 20 })).toBe(5);
    expect(a.int('other', 3)).toBe(3);
    expect(() => parseCli(['--n', '0'], spec).int('n', 3, { min: 1 })).toThrow(CliError);
    expect(() => parseCli(['--n', '1.5'], spec).int('n', 3)).toThrow(CliError);
  });
});

describe('scope:register arguments', () => {
  it('builds owners in the contract JSON form', () => {
    expect(ownersFromArgs(['alice.testnet'], ['1234567890'])).toEqual([
      { Near: { account_id: 'alice.testnet' } },
      { Oidc: { provider: 'google', sub: '1234567890' } },
    ]);
  });

  it('rejects bad owners', () => {
    expect(() => ownersFromArgs([], [])).toThrow('1..5 owners');
    expect(() => ownersFromArgs(['Bad Account'], [])).toThrow('Invalid NEAR account');
    expect(() => ownersFromArgs([], ['a#b'])).toThrow('Invalid Google sub');
    // A Google sub is digits: anything else (a shell word, an email-style id) is refused.
    for (const bad of ['abc', '123 4', '12;3', '', '1'.repeat(256)]) expect(() => ownersFromArgs([], [bad]), bad).toThrow(bad === '' ? /owners|Invalid Google sub/u : 'Invalid Google sub');
    expect(() => ownersFromArgs(['a1.testnet', 'a2.testnet', 'a3.testnet', 'a4.testnet', 'a5.testnet', 'a6.testnet'], [])).toThrow('1..5 owners');
  });

  it('builds (provider, aud) client tuples', () => {
    expect(clientsFromArgs(['x.apps.googleusercontent.com'])).toEqual([['google', 'x.apps.googleusercontent.com']]);
    expect(() => clientsFromArgs([])).toThrow();
    expect(() => clientsFromArgs(['a', 'a'])).toThrow('Duplicate');
  });

  it('allows zero clients only with --allow-shared', () => {
    expect(() => clientsFromArgs([])).toThrow('--allow-shared');
    expect(clientsFromArgs([], { allowShared: true })).toEqual([]);
    expect(clientsFromArgs(['x.apps'], { allowShared: true })).toEqual([['google', 'x.apps']]);
  });

  it("refuses Hana's shared client as an app's own client, and more than 10", () => {
    expect(() => clientsFromArgs(['shared.apps'], { allowShared: true, sharedClientIds: ['shared.apps'] })).toThrow("Hana's shared Google client");
    expect(() => clientsFromArgs(Array.from({ length: 11 }, (_, i) => `c${i}`))).toThrow('at most 10');
  });
});

describe('admin positionals', () => {
  it('only app:settings takes a positional after <env> <command>', () => {
    expect(() => assertCommandPositionals('app:settings', ['app_x'])).not.toThrow();
    expect(() => assertCommandPositionals('app:list', [])).not.toThrow();
    for (const command of ['app:create', 'app:origins:add', 'app:suspend', 'app:list', 'scope:register']) {
      expect(() => assertCommandPositionals(command, ['app_x'])).toThrow('Unexpected argument app_x');
    }
  });
});
