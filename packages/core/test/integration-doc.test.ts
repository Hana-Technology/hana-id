// docs/integration.md (the partner guide) quotes values partners copy as they are: the example auto-approve policy,
// the policy limits and the sandbox-dev Hana origins. These checks fail when the code or the manifest moves on
// without the guide.
import { describe, expect, it } from 'vitest';
import { functionSelector } from '../src/decode/abi.ts';
import { MAX_PER_DAY_COUNT, MIN_CONSENT_MS, POLICY_LABEL_MAX, policyId, validateAutoApprovePolicy } from '../src/policy/index.ts';
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

  it("lists sandbox-dev's Hana origins as the manifest sets them", () => {
    const m = JSON.parse(readText('../../../envs/sandbox-dev.json')) as { vaultOrigin: string; authOrigin: string };
    expect(guide).toContain(`| \`vaultOrigin\` | \`${m.vaultOrigin}\` |`);
    expect(guide).toContain(`| \`authOrigin\` | \`${m.authOrigin}\` |`);
    expect(guide).toContain(`\`${m.authOrigin}/login/callback\``);
  });
});
