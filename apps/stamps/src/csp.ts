// The stamps site's response headers. The page's CSP is computed from the configuration (scripts/gen-wrangler.ts
// passes it to the Worker as the CSP var; the e2e stack computes it the same way) and allows exactly what the page
// needs, as the hosted demo's does (apps/demo/src/csp.ts) but with no EVM RPC (D798):
//
// - its own script and stylesheet (no inline code, no third-party script, no analytics);
// - one frame: the env's vaultOrigin;
// - connections to exactly the env's NEAR RPC (and its fallback), where the page reads the passports, the recent
//   stamps, the user's access key, the latest block and the balance and sends an own-fare transaction, and the env's
//   API, which the SDK's `hana.near.relay` and `hana.near.activate` call from the page;
// - nothing may frame it, and Trusted Types are required (the page writes text only, never HTML).
//
// The login and approval windows are popups (window.open), which CSP doesn't restrict. The headers themselves
// (COOP `same-origin-allow-popups`, nosniff, no referrer, …) are the demo's, imported.
import { NON_PAGE_CSP, securityHeaders } from '../../demo/src/csp.ts';
import { type StampsConfig, webOrigin } from './config.ts';

export { NON_PAGE_CSP, securityHeaders };

/** The page's connect-src origins, in a fixed order, each once. */
export function connectOrigins(c: Pick<StampsConfig, 'near' | 'apiUrl'>): string[] {
  const origins = [
    webOrigin(c.near.rpcUrl, 'near.rpcUrl'),
    ...(c.near.rpcFallbackUrl !== null ? [webOrigin(c.near.rpcFallbackUrl, 'near.rpcFallbackUrl')] : []),
    webOrigin(c.apiUrl, 'apiUrl'),
  ];
  return [...new Set(origins)];
}

/** The page's Content-Security-Policy. */
export function pageCsp(c: Pick<StampsConfig, 'vaultOrigin' | 'near' | 'apiUrl'>): string {
  const vault = webOrigin(c.vaultOrigin, 'vaultOrigin');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    // The brand's fonts (D426), from this origin only.
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
