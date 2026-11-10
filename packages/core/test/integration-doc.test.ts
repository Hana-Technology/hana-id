// docs/integration.md (the partner guide) quotes values partners copy as they are: the example auto-approve policy,
// the policy limits and the sandbox-dev Hana origins. These checks fail when the code or the manifest moves on
// without the guide.
import { describe, expect, it } from 'vitest';
import { functionSelector } from '../src/decode/abi.ts';
import { MAX_PER_DAY_COUNT, MIN_CONSENT_MS, POLICY_LABEL_MAX, policyId, validateAutoApprovePolicy } from '../src/policy/index.ts';
import { supportIdFromSub } from '../src/support-id.ts';
import { readText } from './helpers.ts';

const guide = readText('../../../docs/integration.md');

/** The first ```json block after the guide's "**Example**" marker in the auto-approve section. */
function examplePolicy(): unknown {
  const at = guide.indexOf('**Example**');
  expect(at).toBeGreaterThan(-1);
  const m = /```json\n([\s\S]*?)\n```/u.exec(guide.slice(at));
  if (!m?.[1]) throw new Error('no json block after **Example** in docs/integration.md');
  return JSON.parse(m[1]);
}

describe('docs/integration.md', () => {
  it('the example auto-approve policy passes the validator the CLI, the API and the vault use', () => {
    const policy = examplePolicy();
    const r = validateAutoApprovePolicy(policy, { sessionTtlMs: 12 * 3_600_000 });
    expect(r.ok ? [] : r.problems).toEqual([]);
    expect(policyId(policy)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("the example's EVM selectors are the keccak selectors of their signatures", () => {
    const policy = examplePolicy() as { evm: { chains: { contracts: { selectors: { selector: string; signature: string }[] }[] }[] } };
    const selectors = policy.evm.chains.flatMap((c) => c.contracts.flatMap((k) => k.selectors));
    expect(selectors.length).toBeGreaterThan(0);
    for (const s of selectors) expect(s.selector).toBe(functionSelector(s.signature));
  });

  it('states the policy limits the validator enforces', () => {
    expect(MIN_CONSENT_MS).toBe(60_000);
    expect(guide).toContain('1 min up to your session limit');
    expect(guide).toContain(`1 to ${MAX_PER_DAY_COUNT}`);
    expect(guide).toContain(`≤ ${POLICY_LABEL_MAX} characters`);
  });

  it("lists sandbox-dev's partner portal, identity issuer and identity key pins as the manifest sets them", () => {
    const m = JSON.parse(readText('../../../envs/sandbox-dev.json')) as {
      console: { origin: string };
      identityToken: { iss: string };
      watchdog: { pinnedIdentityKeys: string[] };
    };
    expect(guide).toContain(`(sandbox-dev: \`${m.console.origin}\`)`);
    expect(guide).toContain(`| \`HANA_IDENTITY_ISSUER\` | \`${m.identityToken.iss}\` |`);
    expect(guide).toContain(`| \`HANA_IDENTITY_PINS\` | \`${m.watchdog.pinnedIdentityKeys.join(',')}\``);
    expect(readText('../../web/README.md')).toContain(`(sandbox-dev: \`${m.console.origin}\`)`);
  });

  it("the Support ID vector it gives is supportIdFromSub's", () => {
    expect(guide).toContain("supportIdFromSub('u1_ASNFZ4mrze8BI0VniavN7w'); // 'HANA-04HM-ASW9'");
    expect(supportIdFromSub('u1_ASNFZ4mrze8BI0VniavN7w')).toBe('HANA-04HM-ASW9');
    expect(readText('../README.md')).toContain("supportIdFromSub('u1_ASNFZ4mrze8BI0VniavN7w'); // 'HANA-04HM-ASW9'");
  });

  it("the Sodax install lines name the @sodax/types version the adapter is typed and tested against", () => {
    const sodax = JSON.parse(readText('../../sodax/package.json')) as { devDependencies: Record<string, string>; peerDependencies: Record<string, string> };
    const v = sodax.devDependencies['@sodax/types']!;
    expect(sodax.peerDependencies['@sodax/types']).toBe(`^${v}`);
    for (const doc of [guide, readText('../../sodax/README.md')]) {
      const installs = [...doc.matchAll(/@sodax\/types@(\d+\.\d+\.\d+)/gu)].map((x) => x[1]);
      expect(installs.length).toBeGreaterThan(0);
      expect(new Set(installs)).toEqual(new Set([v]));
    }
  });

  // Partners get the guide and the four READMEs, not this repository: no path into it, no decision number, no batch
  // or build-plan name, no admin CLI command.
  it.each([
    ['docs/integration.md', guide],
    ['packages/core/README.md', readText('../README.md')],
    ['packages/web/README.md', readText('../../web/README.md')],
    ['packages/react/README.md', readText('../../react/README.md')],
    ['packages/sodax/README.md', readText('../../sodax/README.md')],
  ])('%s points at nothing a partner cannot open', (_name, text) => {
    const internal = [
      /\bD\d{2,3}\b/u,
      /(?<![\w@/.-])(docs|apps|examples|scripts|contracts|envs|legacy)\/[\w.-]/u,
      /\bpackages\/\w/u,
      /\.secrets\b/u,
      /\bbatch [A-C]?\d|\bbatch [A-C]\b|\bbuild plan\b/iu,
      /\badmin app:|--google-web-client|--auto-approve\b/u,
      /\bprivate Hana ID repository\b/u,
      /\bsend Hana the tarballs\b|self-serve dashboard/iu,
    ];
    for (const re of internal) expect(text.match(re)?.[0] ?? null, String(re)).toBeNull();
  });

  it('onboarding: the owners accept before the scope is set up, and the changes the contract checks name on-chain owners', () => {
    const s1 = guide.slice(guide.indexOf('## 1. Your app and the partner portal'), guide.indexOf('## 2. Install'));
    expect(s1.indexOf('Sign in with Google to accept')).toBeLessThan(s1.indexOf('Hana registers your scope'));
    expect(s1).toContain('<a id="on-chain-owners"></a>**On-chain owners.**');
    expect(s1).toContain('**Propose: set the on-chain owners to your organisation\'s owners**');
    expect(s1).toMatch(/- \*\*Add\*\*: on-chain owners/u);
    // The policy and raw signing name who proposes them; the client id goes to Hana only before the scope exists.
    expect(guide).toMatch(/An on-chain owner of your scope \(\[section 1\]\(#on-chain-owners\)\) writes the policy/u);
    expect(guide).toContain('An on-chain owner of your scope turns it on');
    expect(guide).not.toMatch(/Or send Hana the client ID\./u);
    expect(guide).toContain('works only before your scope is set up');
  });

  it('starts with the content: one short Last verified line, not a changelog', () => {
    const lines = guide.split('\n').filter((l) => l.startsWith('Last verified'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(200);
    expect(guide.indexOf('Last verified')).toBeLessThan(guide.indexOf('## How it works'));
  });

  it("lists sandbox-dev's Hana origins as the manifest sets them", () => {
    const m = JSON.parse(readText('../../../envs/sandbox-dev.json')) as { vaultOrigin: string; authOrigin: string };
    expect(guide).toContain(`| \`vaultOrigin\` | \`${m.vaultOrigin}\` |`);
    expect(guide).toContain(`| \`authOrigin\` | \`${m.authOrigin}\` |`);
    expect(guide).toContain(`\`${m.authOrigin}/login/callback\``);
  });
});
