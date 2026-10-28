import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.ts';

describe('@hana-id/web', () => {
  it('exports its package.json version (sent as `sdk` in hana:hello)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    expect(pkg.name).toBe('@hana-id/web');
    expect(VERSION).toBe(pkg.version);
  });
});
