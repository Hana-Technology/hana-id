// The stack's port base and ports (no side effects, no Node imports): stack.ts reads this run's PORTS from them, and
// checkout-port.ts picks a checkout's default base before stack.ts is first imported (port-env.ts).

/** The default HANA_E2E_PORT_BASE. */
export const DEFAULT_PORT_BASE = 4410;

/**
 * The first of the stack's ports, from HANA_E2E_PORT_BASE (default 4410); the stack uses base … base + 50. The entry
 * points (playwright.config.ts, src/server/main.ts, src/build.ts) set it first to the checkout's default when unset
 * (port-env.ts: 4410 in the main checkout, a base of its own in each linked worktree), and Playwright passes its
 * environment to the webServer, so the build, the servers and the tests all see the same value.
 */
export function portBase(value: string | undefined = process.env.HANA_E2E_PORT_BASE): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT_BASE;
  const n = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(n) || n < 1024 || n + 50 > 65535) {
    throw new Error(`HANA_E2E_PORT_BASE must be an integer from 1024 to 65485 (the stack uses base … base + 50), not ${JSON.stringify(value)}`);
  }
  const blocked = Object.values(portsFrom(n)).filter((p) => BROWSER_BLOCKED_PORTS.has(p));
  if (blocked.length) {
    throw new Error(`HANA_E2E_PORT_BASE ${n} puts the stack on port ${blocked.join(', ')}, which browsers refuse to connect to (the Fetch standard's bad ports): pick another base`);
  }
  return n;
}

/**
 * The Fetch standard's "bad ports" at or above 1024 (https://fetch.spec.whatwg.org/#port-blocking): every browser
 * refuses requests to them, so a stack port there fails its tests (base 5010 puts the EVM RPC on 5060, SIP).
 */
export const BROWSER_BLOCKED_PORTS: ReadonlySet<number> = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** The stack's ports for `base`. */
export function portsFrom(base: number) {
  return Object.freeze({
    partner: base,
    /**
     * A second partner site, neither localhost nor the Hana pages' 127.0.0.1: the storage-partitioning case, where
     * two partner sites are each cross-site to the vault. A `*.localhost` name (browsers resolve it to loopback and
     * treat it as potentially trustworthy) rather than [::1]: CSP source expressions have no IPv6 form, so no
     * browser lets a [::1] page embed the vault through its frame-ancestors.
     */
    siteB: base + 1,
    /** The hosted demo (apps/demo), served by its own Worker handler over its e2e build. */
    demo: base + 2,
    vault: base + 10,
    /** Live mode's vault, auth and API hosts (LIVE_ENV): reached only through the test's routes from https origins. */
    liveVault: base + 11,
    auth: base + 20,
    liveAuth: base + 21,
    api: base + 30,
    liveApi: base + 31,
    /** The email issuer (apps/email-issuer's Worker), on its own origin as on sandbox-dev (D230). */
    issuer: base + 32,
    near: base + 40,
    /**
     * A second NEAR RPC on the same mocked chain: the env's `rpcFallback`, the independent provider a member's path is
     * confirmed on (D263).
     */
    nearFallback: base + 41,
    evm: base + 50,
  });
}
