// The other apps that use a wallet, as the sign-in and approval windows take them (protocol.ts `isOtherApps`): a count
// of at least one and exactly the first min(count, OTHER_APPS_NAMES_MAX) names, each a display-safe line.
import { describe, expect, it } from 'vitest';
import { OTHER_APPS_COUNT_MAX, OTHER_APPS_NAMES_MAX, OTHER_APP_NAME_MAX, isOtherApps } from '../src/index.ts';

const names = (n: number) => Array.from({ length: n }, (_, i) => `App ${i + 1}`);

describe('isOtherApps', () => {
  it('takes a count and exactly the names a window lists', () => {
    expect(OTHER_APPS_NAMES_MAX).toBe(5);
    expect(isOtherApps({ count: 1, names: ['Stamp Trail'] })).toBe(true);
    expect(isOtherApps({ count: 5, names: names(5) })).toBe(true);
    expect(isOtherApps({ count: OTHER_APPS_COUNT_MAX, names: names(5) })).toBe(true);
    expect(isOtherApps({ count: 1, names: ['x'.repeat(OTHER_APP_NAME_MAX)] })).toBe(true);
  });

  it.each([
    ['a count of 0 (an app alone sends no field)', { count: 0, names: [] }],
    ['a count over the bound', { count: OTHER_APPS_COUNT_MAX + 1, names: names(5) }],
    ['a count that is not a whole number', { count: 1.5, names: ['A'] }],
    ['fewer names than the count asks for', { count: 4, names: names(3) }],
    ['more names than a window lists', { count: 9, names: names(6) }],
    ['a name over the bound', { count: 1, names: ['x'.repeat(OTHER_APP_NAME_MAX + 1)] }],
    ['an empty name', { count: 1, names: [''] }],
    ['a name with spaces around it', { count: 1, names: [' Stamp Trail'] }],
    ['a bidi override', { count: 1, names: ['Pay\u202Egnp.exe'] }],
    ['an invisible character', { count: 1, names: ['Zero\u200Bwidth'] }],
    ['a line break', { count: 1, names: ['Two\nlines'] }],
    ['a name that is not text', { count: 1, names: [7] }],
    ['an extra key', { count: 1, names: ['A'], origins: ['https://a.example'] }],
    ['a missing key', { count: 1 }],
    ['an array', [1, ['A']]],
    ['null', null],
  ])('refuses %s', (_, v) => {
    expect(isOtherApps(v)).toBe(false);
  });
});
