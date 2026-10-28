import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.ts';

describe('@hana-id/sodax', () => {
  it('exports its package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    expect(pkg.name).toBe('@hana-id/sodax');
    expect(VERSION).toBe(pkg.version);
  });
});
