// Test fixture (not shipped code): sandbox-dev's manifest moved onto custom domains of one registrable domain in
// another Cloudflare account, the layout D404 allows a dev env. The `gen` tests of every Worker generate from it.
import { readFileSync } from 'node:fs';
import { manifestPath } from './index.ts';
import { type Manifest, manifestSchema } from './schema.ts';

export const CUSTOM_DOMAIN = {
  name: 'sandbox-cd',
  accountId: '0123456789abcdef0123456789abcdef',
  watchdogAccountId: 'fedcba9876543210fedcba9876543210',
  apiUrl: 'https://api.id-dev.hanawallet.io',
  vaultOrigin: 'https://vault.id-dev.hanawallet.io',
  authOrigin: 'https://auth.id-dev.hanawallet.io',
  emailIssuerUrl: 'https://email.id-dev.hanawallet.io',
  watchdogUrl: 'https://watchdog.hana-watch.example',
} as const;

/** The raw manifest (before validation), for tests that change a field and expect a refusal. */
export function customDomainRaw(): Record<string, unknown> {
  const m = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, any>;
  const c = CUSTOM_DOMAIN;
  return {
    ...m,
    name: c.name,
    apiUrl: c.apiUrl,
    vaultOrigin: c.vaultOrigin,
    authOrigin: c.authOrigin,
    cloudflare: { ...m.cloudflare, accountId: c.accountId },
    watchdog: { ...m.watchdog, url: c.watchdogUrl, cloudflare: { ...m.watchdog.cloudflare, accountId: c.watchdogAccountId } },
    emailIssuer: { ...m.emailIssuer, url: c.emailIssuerUrl, iss: `${c.emailIssuerUrl}/v1/email` },
    identityToken: { ...m.identityToken, iss: `${c.apiUrl}/v1/identity` },
  };
}

export function customDomainManifest(): Manifest {
  return manifestSchema.parse(customDomainRaw());
}
