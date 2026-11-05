// Cloudflare deployment targets shared by every Worker's `gen` (apps/*/scripts/gen-wrangler.ts): which account a
// generated config deploys to, and a Custom Domain on a hostname of a zone in that account (D404).
import { isLoopbackHost } from './origins.ts';

/** A Cloudflare account id: 32 lowercase hex characters (Workers & Pages → Account details). Not a secret. */
export const CLOUDFLARE_ACCOUNT_ID_RE = /^[0-9a-f]{32}$/u;

/**
 * The `account_id` a generated wrangler config pins, as an object to spread into the config: `{account_id}` when the
 * manifest names the account (`cloudflare.accountId`, `watchdog.cloudflare.accountId`), else `{}` (wrangler then
 * deploys to `CLOUDFLARE_ACCOUNT_ID`, or to the login's only account, and asks when the login has several).
 *
 * Refuses a `CLOUDFLARE_ACCOUNT_ID` in the environment that is malformed or names another account than the manifest:
 * during an account move (docs/operations.md "Moving an env to another Cloudflare account") the shell can hold either
 * account's id, and a config deployed with the other one would put a Worker, or a secret, on the wrong account.
 */
export function accountIdFields(expected: string | undefined, where: string, env: Readonly<Record<string, string | undefined>> = process.env): { account_id?: string } {
  const fromEnv = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv && !CLOUDFLARE_ACCOUNT_ID_RE.test(fromEnv)) throw new Error('CLOUDFLARE_ACCOUNT_ID is not a Cloudflare account id (32 lowercase hex characters)');
  if (expected === undefined) return {};
  if (!CLOUDFLARE_ACCOUNT_ID_RE.test(expected)) throw new Error(`${where} ${expected} is not a Cloudflare account id (32 lowercase hex characters)`);
  if (fromEnv && fromEnv !== expected) {
    throw new Error(`CLOUDFLARE_ACCOUNT_ID is ${fromEnv} but ${where} is ${expected}: unset it, or set it to the manifest's account, before generating this config`);
  }
  return { account_id: expected };
}

/**
 * The placement of a Worker served on its own hostname as a Cloudflare Custom Domain: `routes: [{pattern: <host>,
 * custom_domain: true}]`, no `workers.dev` URL and no preview URLs (the Worker exists on that hostname only). The zone
 * must be on the Worker's account; `wrangler deploy` creates the DNS record and the certificate, and refuses a hostname
 * that already has a DNS record (https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
 *
 * `origin` must be a bare https origin on a DNS name: a Custom Domain covers the whole hostname (no path), always on
 * 443 (no port).
 */
export function customDomainPlacement(field: string, origin: string): { workers_dev: false; preview_urls: false; routes: { pattern: string; custom_domain: true }[] } {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`${field} ${origin} is not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${field} ${origin}: a Custom Domain is https`);
  if (url.port) throw new Error(`${field} ${origin}: a Custom Domain can't have a port`);
  if (url.origin !== origin.replace(/\/+$/u, '') || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${field} ${origin}: a Custom Domain covers a whole hostname, so this must be a bare origin (no path, query or fragment)`);
  }
  if (isLoopbackHost(url.hostname)) throw new Error(`${field} ${origin}: a loopback host can't be a Custom Domain`);
  if (url.hostname.endsWith('.workers.dev')) throw new Error(`${field} ${origin}: a workers.dev hostname is the Worker's workers.dev URL, not a Custom Domain`);
  return { workers_dev: false, preview_urls: false, routes: [{ pattern: url.hostname, custom_domain: true }] };
}
