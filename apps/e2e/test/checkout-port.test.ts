// The stack's default port base per checkout (src/checkout-port.ts, src/port-env.ts): the main checkout on 4410, each
// linked worktree on a base of its own, so two checkouts' suites (or `pnpm verify`s) run side by side.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKOUT_ROOT, WORKTREE_PORT_BASES, checkoutPortBase, isLinkedWorktree } from '../src/checkout-port.ts';
import { BROWSER_BLOCKED_PORTS, DEFAULT_PORT_BASE, portBase, portsFrom } from '../src/ports.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('checkoutPortBase', () => {
  it('the main checkout keeps 4410 (the documented ports)', () => {
    expect(checkoutPortBase('/Users/dev/hana-id', false)).toBe(DEFAULT_PORT_BASE);
  });

  it('a linked worktree gets a base of its own, the same every time, from its path', () => {
    const a = checkoutPortBase('/Users/dev/hana-id/.claude/worktrees/agent-a', true);
    expect(a).not.toBe(DEFAULT_PORT_BASE);
    expect(WORKTREE_PORT_BASES).toContain(a);
    expect(checkoutPortBase('/Users/dev/hana-id/.claude/worktrees/agent-a/', true)).toBe(a);
    // Different worktrees spread over the bases (a clash between two is possible but rare: 1 in ~440).
    const bases = new Set(Array.from({ length: 40 }, (_, i) => checkoutPortBase(`/Users/dev/hana-id/.claude/worktrees/agent-${i}`, true)));
    expect(bases.size).toBeGreaterThanOrEqual(36);
  });

  it('every worktree base is a valid HANA_E2E_PORT_BASE below the ephemeral range, apart from 4410’s ports', () => {
    expect(WORKTREE_PORT_BASES.length).toBeGreaterThan(400);
    const main = new Set(Object.values(portsFrom(DEFAULT_PORT_BASE)));
    for (const b of WORKTREE_PORT_BASES) {
      expect(portBase(String(b))).toBe(b);
      const ports = Object.values(portsFrom(b));
      expect(Math.max(...ports)).toBeLessThan(49_152);
      for (const p of ports) {
        expect(BROWSER_BLOCKED_PORTS.has(p)).toBe(false);
        expect(main.has(p)).toBe(false);
      }
    }
    // Bases 100 apart, a stack spans 50: no two worktree bases share a port.
    const all = WORKTREE_PORT_BASES.flatMap((b) => Object.values(portsFrom(b)));
    expect(new Set(all).size).toBe(all.length);
  });

  it('tells a linked worktree (a `.git` file) from the main checkout (a `.git` directory) and from no checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hana-e2e-checkout-'));
    try {
      const main = join(dir, 'main');
      const linked = join(dir, 'linked');
      mkdirSync(join(main, '.git'), { recursive: true });
      mkdirSync(linked);
      writeFileSync(join(linked, '.git'), `gitdir: ${main}/.git/worktrees/linked\n`);
      expect(isLinkedWorktree(main)).toBe(false);
      expect(isLinkedWorktree(linked)).toBe(true);
      expect(isLinkedWorktree(join(dir, 'none'))).toBe(false);
      expect(checkoutPortBase(main)).toBe(DEFAULT_PORT_BASE);
      expect(WORKTREE_PORT_BASES).toContain(checkoutPortBase(linked));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('port-env', () => {
  it('sets HANA_E2E_PORT_BASE to this checkout’s default when it is unset or blank', async () => {
    for (const unset of [undefined, '', '  ']) {
      vi.stubEnv('HANA_E2E_PORT_BASE', unset);
      vi.resetModules();
      await import('../src/port-env.ts');
      expect(process.env.HANA_E2E_PORT_BASE).toBe(String(checkoutPortBase(CHECKOUT_ROOT)));
    }
  });

  it('leaves a base that is set alone', async () => {
    vi.stubEnv('HANA_E2E_PORT_BASE', '4510');
    await import('../src/port-env.ts');
    expect(process.env.HANA_E2E_PORT_BASE).toBe('4510');
  });

  it('runs before stack.ts reads its ports when imported first', async () => {
    vi.stubEnv('HANA_E2E_PORT_BASE', undefined);
    await import('../src/port-env.ts');
    const { PORTS } = await import('../src/stack.ts');
    expect(PORTS.partner).toBe(checkoutPortBase(CHECKOUT_ROOT));
  });
});
