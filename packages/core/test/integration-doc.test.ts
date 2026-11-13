// docs/integration.md (the partner guide) quotes values partners copy as they are: the example auto-approve policy,
// the policy limits and the sandbox-dev Hana origins. These checks fail when the code or the manifest moves on
// without the guide.
import { describe, expect, it } from 'vitest';
import { functionSelector } from '../src/decode/abi.ts';
import { MAX_PER_DAY_COUNT, MIN_CONSENT_MS, POLICY_LABEL_MAX, policyId, validateAutoApprovePolicy } from '../src/policy/index.ts';
import { supportIdFromSub } from '../src/support-id.ts';
import { NEP413_TAG } from '../src/near/codec.ts';
import { NEAR_DELEGATE_MAX_BLOCKS } from '../src/near/delegate.ts';
import { readText } from './helpers.ts';

const guide = readText('../../../docs/integration.md');
/** The partner's first page, sent with the SDK files beside the guide. */
const startHere = readText('../../../docs/partner-start-here.md');

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
    ['docs/partner-start-here.md', startHere],
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
    expect(guide).not.toMatch(/send its client ID|Sending Hana the client ID/u);
    expect(guide).toContain('Hana never registers a client ID you send');
    expect(s1).toContain('An on-chain owner stays one even after leaving your organisation');
  });

  it('starts with the content: one short Last verified line, not a changelog', () => {
    const lines = guide.split('\n').filter((l) => l.startsWith('Last verified'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(200);
    expect(guide.indexOf('Last verified')).toBeLessThan(guide.indexOf('## How it works'));
  });

  it("partner-start-here.md: sandbox-dev's console and vault origins as the manifest sets them, plain punctuation, one short Last verified line", () => {
    const m = JSON.parse(readText('../../../envs/sandbox-dev.json')) as { console: { origin: string }; vaultOrigin: string; authOrigin: string; appChangeDelayMs: number };
    expect(startHere).toContain(`\`${m.console.origin}\``);
    expect(startHere).toContain(`\`${m.vaultOrigin}\``);
    // Hana Home, on the auth origin (nothing links to it yet, so the page gives its address).
    expect(startHere).toContain(`\`${m.authOrigin}/home\``);
    // The signed_out reason ships in SDK 0.3.1.
    expect(startHere).toContain("`reason: 'signed_out'` (SDK 0.3.1 or later)");
    // "1 minute after the announcement" is the manifest's appChangeDelayMs.
    expect(m.appChangeDelayMs).toBe(60_000);
    expect(startHere).toContain('1 minute after the announcement');
    expect(startHere).toContain("environment: 'sandbox-dev'");
    expect(startHere.match(/[–—]/u)?.[0] ?? null).toBeNull();
    const lines = startHere.split('\n').filter((l) => l.startsWith('Last verified'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThan(200);
  });

  it('names the current SDK release: the tarballs, the Last verified line and its release notes', () => {
    const version = (JSON.parse(readText('../package.json')) as { version: string }).version;
    for (const doc of [guide, ...['../README.md', '../../web/README.md', '../../react/README.md', '../../sodax/README.md'].map(readText)]) {
      const tarballs = [...doc.matchAll(/hana-id-(?:core|web|react|sodax)-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.tgz/gu)].map((x) => x[1]);
      expect(tarballs.length).toBeGreaterThan(0);
      expect(new Set(tarballs)).toEqual(new Set([version]));
    }
    expect(guide.split('\n').find((l) => l.startsWith('Last verified'))).toContain(`SDK ${version}.`);
    const s2 = guide.slice(guide.indexOf('## 2. Install'), guide.indexOf('## 3. Create the client'));
    expect(s2).toContain(`### Release notes\n\n**${version}**`);
  });

  it("lists sandbox-dev's Hana origins as the manifest sets them", () => {
    const m = JSON.parse(readText('../../../envs/sandbox-dev.json')) as { vaultOrigin: string; authOrigin: string };
    expect(guide).toContain(`| \`vaultOrigin\` | \`${m.vaultOrigin}\` |`);
    expect(guide).toContain(`| \`authOrigin\` | \`${m.authOrigin}\` |`);
    expect(guide).toContain(`\`${m.authOrigin}/login/callback\``);
  });
});

describe('docs/integration.md: NEAR (section 8)', () => {
  const s8 = guide.slice(guide.indexOf('### NEAR'), guide.indexOf('### Raw signing'));
  const client = readText('../../web/src/client/near.ts');
  const vault = readText('../../web/src/vault/vault.ts') + readText('../../web/src/vault/signing.ts') + readText('../src/near/delegate.ts');

  it('names the SDK methods and the refusal reasons the code has', () => {
    for (const m of ['signTransaction', 'signDelegateAction', 'signMessage', 'relay']) {
      expect(s8).toContain(`hana.near.${m}(`);
      expect(client).toMatch(new RegExp(`\\n  async ${m}\\(p: `, 'u'));
    }
    // activate takes no argument: the user's own account.
    expect(s8).toContain('hana.near.activate()');
    expect(client).toContain('\n  async activate(): Promise<NearActivateResult> {');
    expect(client).toContain('/v1/near/${path}');
    expect(s8).toContain('POST /v1/near/activate');
    for (const reason of ['near_block_unknown', 'near_network_mismatch', 'near_relayed_delegate', 'near_key_unknown', 'near_delegate_nonce_used', 'near_delegate_nonce_stale', 'near_delegate_test_app_action', 'near_delegate_test_app_receiver', 'near_rpc_single_provider', 'near_delegate_nonce_too_large', 'near_delegate_expiry', 'near_rpc_unavailable']) {
      expect(s8).toContain(reason);
      expect(vault).toContain(`'${reason}'`);
    }
  });

  it("states NEP-413's tag and the delegate expiry bound the vault enforces", () => {
    expect(NEP413_TAG).toBe(2 ** 31 + 413);
    expect(s8).toContain('`u32le(2^31 + 413)`');
    expect(NEAR_DELEGATE_MAX_BLOCKS).toBe(10_000);
    expect(s8).toMatch(/^import \{ [^}]*\bnearDelegateNonce\b[^}]* \} from '@hana-id\/core\/near';$/mu);
    expect(s8).toContain('nonce: nearDelegateNonce({ keyNonce, blockHeight }),');
    expect(vault).toContain('near_delegate_nonce_stale');
    expect(s8).toContain('by at most 10,000 blocks');
  });

  // Hana's relay as sandbox-dev runs it: the manifest's `near.relay` and the API's fixed limits.
  const manifest = JSON.parse(readText('../../../envs/sandbox-dev.json')) as {
    apiUrl: string;
    near: { demoGuestbook: string; demoStamps: string; relay: { receivers: string[]; maxGasTgas: number; perSenderPerDay: number; perAppPerDay: number; relaysPerDay: number; relaysPerMinute: number; activationsPerAppPerDay: number; activationsPerDay: number; appDailyBudgetNear: number; dailyBudgetNear: number } };
  };
  const relayConfig = readText('../../../apps/api/src/near/relay-config.ts');
  /** A fixed limit of the API's NEAR_RELAY_LIMITS. */
  const fixed = (name: string): number => {
    const m = new RegExp(`\\n  ${name}: ([\\d_]+),`, 'u').exec(relayConfig.slice(relayConfig.indexOf('NEAR_RELAY_LIMITS = {')));
    if (!m?.[1]) throw new Error(`NEAR_RELAY_LIMITS.${name} not found`);
    return Number(m[1].replaceAll('_', ''));
  };
  const n = (v: number): string => v.toLocaleString('en-US');

  it("the quick start's guestbook is sandbox-dev's demo guestbook, on its relay's allowlist, within its gas cap", () => {
    const { demoGuestbook, demoStamps, relay } = manifest.near;
    expect(relay.receivers).toEqual([demoGuestbook, demoStamps]);
    expect(s8).toContain(`const GUESTBOOK = '${demoGuestbook}';`);
    expect(s8).toContain(`it holds only Journear's two demo contracts, the guestbook \`${demoGuestbook}\` and the passport stamps\n  \`${demoStamps}\``);
    expect(s8).toContain(`its calls attach at most **${relay.maxGasTgas} Tgas** together on sandbox-dev`);
    expect(s8).toContain(`gas: ${n(relay.maxGasTgas * 1e12).replaceAll(',', '_')}n, deposit: 0n }`);
    // The quick start's expiry fits the relay's (and so the vault's) bound.
    expect(s8).toContain('maxBlockHeight: blockHeight + 600n,');
    expect(600).toBeLessThanOrEqual(fixed('maxBlocksAhead'));
    expect(s8).toContain(`at most **${n(fixed('maxBlocksAhead'))} blocks** ahead`);
  });

  it("the limits table is sandbox-dev's", () => {
    const r = manifest.near.relay;
    for (const row of [
      `| Per NEAR account | ${fixed('perSenderPerMinute')} a minute, ${n(r.perSenderPerDay)} a day | ${fixed('activateReadsPerAccountPerMinute')} requests a minute |`,
      `| Per user (all their NEAR accounts) | ${n(fixed('perUserPerDay'))} a day | ${fixed('activationsPerUserPerDay')} a day |`,
      `| Per app | ${fixed('perAppPerMinute')} a minute, ${n(r.perAppPerDay)} a day | ${fixed('activateReadsPerAppPerMinute')} requests a minute, ${n(r.activationsPerAppPerDay)} a day |`,
      `| Per IP address, across every app | ${fixed('perIpPerMinute')} a minute | ${fixed('activationsPerIpPerMinute')} a minute |`,
      `| Across the environment | ${n(r.relaysPerMinute)} a minute, ${n(r.relaysPerDay)} a day | ${fixed('activateReadsPerMinute')} requests a minute, ${n(r.activationsPerDay)} a day |`,
      `| NEAR spent per day | ${r.appDailyBudgetNear} NEAR per app (\`rate_limited\`, \`data.reason: 'app_budget_exhausted'\`), ${r.dailyBudgetNear} NEAR across the environment`,
    ]) {
      expect(s8).toContain(row);
    }
  });

  it("every code Hana's relay answers has a row in the NEAR error table", () => {
    const table = s8.slice(s8.indexOf('<a id="near-errors"></a>'), s8.indexOf('<a id="near-not-yet"></a>'));
    const relay = readText('../../../apps/api/src/near/relay.ts');
    // Codes that are logged, never answered.
    const logOnly = new Set(['near_relay_budget_high', 'not_enough_balance']);
    const answered = [...relay.matchAll(/(?:reject\(ctx, [\w.]+, |code: )'([a-z_]+)'/gu)].map((m) => m[1]!).filter((c) => !logOnly.has(c));
    expect(answered.length).toBeGreaterThan(20);
    // The relayer key object's answers on the NEAR path, the app gate's, and the copy refusal.
    const others = ['relayer_busy', 'relayer_unavailable', 'relayer_unconfigured', 'near_unavailable', 'near_rejected', 'near_error', 'timeout', 'contract_rejected', 'already_relayed', 'missing_key', 'unknown_app', 'scope_conflict', 'origin_not_allowed', 'app_suspended'];
    for (const code of new Set([...answered, ...others])) expect(table, code).toContain(`\`${code}\``);
  });

  it("names sandbox-dev's API origin for the CSP that relay and activate need", () => {
    const s5 = guide.slice(guide.indexOf('## 5. Your page'), guide.indexOf('## 6. Google client'));
    for (const part of [s5, s8]) expect(part).toContain(`\`${manifest.apiUrl}\``);
  });
});
