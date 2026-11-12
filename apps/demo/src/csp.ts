// The demo's response headers. The page's CSP is computed from the configuration (scripts/gen-wrangler.ts passes it
// to the Worker as the CSP var; the e2e stack computes it the same way) and allows exactly what the page needs:
//
// - its own script and stylesheet (no inline code, no third-party script, no analytics);
// - one frame: the env's vaultOrigin (docs/integration.md section 5: the SDK reports `vault_unavailable` otherwise);
// - connections to exactly these origins: the EVM chain's RPC, where the SDK forwards read-only calls; the env's NEAR
//   RPC (and its fallback), where the NEAR card reads the user's access key, the latest block and the guestbook; and
//   the env's Hana API, which the SDK's `hana.near.relay` and `hana.near.activate` call from the page. Every other
//   Hana API call is the vault frame's, under the vault page's own CSP;
// - nothing may frame it, and Trusted Types are required (the page writes text only, never HTML).
//
// The Hana login, approval and export windows are popups (window.open), which CSP doesn't restrict. COOP is
// `same-origin-allow-popups`, which docs/integration.md allows (`same-origin` would sever the login popup).
import { type DemoConfig, webOrigin } from './config.ts';

/** The page's connect-src origins, in a fixed order, each once. */
export function connectOrigins(c: Pick<DemoConfig, 'evm' | 'near' | 'apiUrl'>): string[] {
  const origins = [
    webOrigin(c.evm.rpcUrl, 'evm.rpcUrl'),
    webOrigin(c.near.rpcUrl, 'near.rpcUrl'),
    ...(c.near.rpcFallbackUrl !== null ? [webOrigin(c.near.rpcFallbackUrl, 'near.rpcFallbackUrl')] : []),
    webOrigin(c.apiUrl, 'apiUrl'),
  ];
  return [...new Set(origins)];
}

/** The page's Content-Security-Policy. */
export function pageCsp(c: Pick<DemoConfig, 'vaultOrigin' | 'evm' | 'near' | 'apiUrl'>): string {
  const vault = webOrigin(c.vaultOrigin, 'vaultOrigin');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    // Hana's fonts (D426), from this origin only.
    "font-src 'self'",
    `connect-src ${connectOrigins(c).join(' ')}`,
    `frame-src ${vault}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

/** Every response that isn't the page (assets, errors): it runs nothing, loads nothing and can't be framed. */
export const NON_PAGE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** The headers every response carries, with `csp` as its policy. */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin-allow-popups',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'strict-transport-security': 'max-age=31536000',
  };
}
