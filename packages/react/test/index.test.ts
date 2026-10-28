import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as react from '../src/index.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json')) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe('@hana-id/react', () => {
  it('exports its package.json version', () => {
    expect(pkg.name).toBe('@hana-id/react');
    expect(react.VERSION).toBe(pkg.version);
  });

  it('exports HanaProvider, useHana and useWallet', () => {
    for (const name of ['HanaProvider', 'HanaContext', 'useHana', 'useWallet', 'INITIAL_STATE']) expect(react).toHaveProperty(name);
  });

  it("marks the provider and hooks modules 'use client' (Next.js app router)", () => {
    for (const file of ['provider.tsx', 'hooks.ts']) expect(read(`../src/${file}`).startsWith("'use client';\n")).toBe(true);
  });

  it("takes react as a peer dependency, so the partner's single React is used (18 or 19)", () => {
    expect(pkg.dependencies?.react).toBeUndefined();
    expect(pkg.peerDependencies?.react).toBe('^18.0.0 || ^19.0.0');
  });
});
