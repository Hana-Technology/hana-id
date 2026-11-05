import { describe, expect, it } from 'vitest';
import { CUSTOM_DOMAIN, customDomainManifest, customDomainRaw } from './custom-domain.fixture.ts';
import { accountIdFields, customDomainPlacement, manifestSchema, siteOf } from './index.ts';

const messages = (m: unknown) => manifestSchema.safeParse(m).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];
const ID = '0123456789abcdef0123456789abcdef';
const OTHER = 'ffffffffffffffffffffffffffffffff';

describe('accountIdFields (D404)', () => {
  it("pins the manifest's account, and nothing without one", () => {
    expect(accountIdFields(ID, 'cloudflare.accountId', {})).toEqual({ account_id: ID });
    expect(accountIdFields(undefined, 'cloudflare.accountId', {})).toEqual({});
    expect(accountIdFields(undefined, 'cloudflare.accountId', { CLOUDFLARE_ACCOUNT_ID: OTHER })).toEqual({});
    expect(accountIdFields(ID, 'cloudflare.accountId', { CLOUDFLARE_ACCOUNT_ID: ID })).toEqual({ account_id: ID });
  });

  it('refuses a CLOUDFLARE_ACCOUNT_ID naming another account, or a malformed one', () => {
    expect(() => accountIdFields(ID, 'cloudflare.accountId', { CLOUDFLARE_ACCOUNT_ID: OTHER })).toThrow(/CLOUDFLARE_ACCOUNT_ID is f+ but cloudflare.accountId is 0123/u);
    expect(() => accountIdFields(undefined, 'x', { CLOUDFLARE_ACCOUNT_ID: 'nope' })).toThrow(/not a Cloudflare account id/u);
    expect(() => accountIdFields('UNSET', 'watchdog.cloudflare.accountId', {})).toThrow(/not a Cloudflare account id/u);
  });
});

describe('customDomainPlacement', () => {
  it('routes the whole hostname as a Custom Domain, with no workers.dev or preview URL', () => {
    expect(customDomainPlacement('apiUrl', 'https://api.id-dev.hanawallet.io')).toEqual({
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'api.id-dev.hanawallet.io', custom_domain: true }],
    });
    expect(customDomainPlacement('apiUrl', 'https://api.id-dev.hanawallet.io/').routes[0]!.pattern).toBe('api.id-dev.hanawallet.io');
  });

  it('refuses what a Custom Domain cannot be', () => {
    expect(() => customDomainPlacement('f', 'http://api.example.com')).toThrow(/https/u);
    expect(() => customDomainPlacement('f', 'https://api.example.com:8443')).toThrow(/port/u);
    expect(() => customDomainPlacement('f', 'https://api.example.com/v1')).toThrow(/bare origin/u);
    expect(() => customDomainPlacement('f', 'https://api.example.com/?x=1')).toThrow(/bare origin/u);
    expect(() => customDomainPlacement('f', 'https://a.b.workers.dev')).toThrow(/workers.dev/u);
    expect(() => customDomainPlacement('f', 'https://localhost')).toThrow(/loopback/u);
    expect(() => customDomainPlacement('f', 'not a url')).toThrow(/not a URL/u);
  });
});

describe('manifest: a dev env on custom domains of one registrable domain (D404)', () => {
  it('parses: api, vault, auth and the email issuer under id-dev.hanawallet.io, the account pinned', () => {
    const m = customDomainManifest();
    expect(m.cloudflare.accountId).toBe(CUSTOM_DOMAIN.accountId);
    // One site: allowed in a dev env only (the vault shares a site with the pages and the API there).
    expect(new Set([m.apiUrl, m.vaultOrigin!, m.authOrigin!].map(siteOf))).toEqual(new Set(['https://hanawallet.io']));
  });

  it('the same layout is refused outside local*/sandbox* envs: production keeps the vault on its own site (D38)', () => {
    const issues = messages({ ...customDomainRaw(), name: 'staging' });
    expect(issues.join('\n')).toMatch(/authOrigin: vaultOrigin and authOrigin must be different sites outside local\*\/sandbox\* envs/u);
    expect(issues.join('\n')).toMatch(/vaultOrigin: vaultOrigin must be a different site from apiUrl/u);
  });

  it('cloudflare.accountId is 32 lowercase hex and never the watchdog account (D86)', () => {
    const raw = customDomainRaw() as { cloudflare: Record<string, unknown>; watchdog: { cloudflare: Record<string, unknown> } };
    expect(messages({ ...raw, cloudflare: { ...raw.cloudflare, accountId: 'ABC' } }).join()).toContain('32 lowercase hex');
    const same = { ...raw, watchdog: { ...raw.watchdog, cloudflare: { ...raw.watchdog.cloudflare, accountId: CUSTOM_DOMAIN.accountId } } };
    expect(messages(same).join()).toContain("watchdog.cloudflare.accountId must be the watchdog's own account");
  });

  it("the email issuer's iss follows its own custom-domain URL", () => {
    const raw = customDomainRaw() as { emailIssuer: Record<string, unknown> };
    const stale = { ...raw, emailIssuer: { ...raw.emailIssuer, iss: 'https://hana-id-email-issuer-sandbox-dev.tingtc.workers.dev/v1/email' } };
    expect(messages(stale).join()).toContain(`emailIssuer.iss must be ${CUSTOM_DOMAIN.emailIssuerUrl}/v1/email`);
  });
});
