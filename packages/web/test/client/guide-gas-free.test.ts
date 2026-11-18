// docs/integration.md, the partner guide's SDK 0.5.0 parts, held to the code partners install: the gas-free actions'
// error table lists every sponsored-action reason with the very sentence `userMessage` gives for it, and the sign-in
// table names the `login_cancelled` reasons the vault sends. (The guide's `ts` samples are type-checked against the
// packed tarballs by the pack check: scripts/pack-check.ts, GUIDE_PARTS.)
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPONSOR_REASONS, userMessageFor } from '../../src/client/user-messages.ts';
import { HanaSponsorError, NOT_OFFERED } from '../../src/client/evm-sponsor.ts';
import { CALLS_VERSION, EIP5792 } from '../../src/client/ethereum.ts';

const guide = readFileSync(new URL('../../../../docs/integration.md', import.meta.url), 'utf8');

/** The guide's text from the line `start` to the line `end`. */
function part(start: string, end: string): string {
  const from = guide.indexOf(`\n${start}\n`);
  const to = guide.indexOf(`\n${end}\n`, from + 1);
  if (from < 0 || to < 0) throw new Error(`No part from ${start} to ${end}`);
  return guide.slice(from, to);
}

const gasFree = part('### Gas-free actions (not live)', '### NEAR');

/** The rows of the table that follows `marker`: each row's cells, without the header and the rule. */
function tableAfter(text: string, marker: string): string[][] {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`No ${marker}`);
  const lines = text.slice(at).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.slice(1, -1).split(' | ').map((c) => c.trim()));
  }
  return rows;
}

/** The backticked codes in a cell. */
const codesIn = (cell: string): string[] => [...cell.matchAll(/`([a-z0-9_]+)`/gu)].map((m) => m[1]!);

describe('docs/integration.md "Gas-free actions"', () => {
  const rows = tableAfter(gasFree, '<a id="gas-free-errors"></a>');

  it('lists every sponsored-action reason once, with the sentence userMessage gives for it', () => {
    const listed: string[] = [];
    for (const [reasons, , sentence] of rows) {
      for (const reason of codesIn(reasons!)) {
        listed.push(reason);
        expect((SPONSOR_REASONS as Record<string, string>)[reason], reason).toBe(sentence);
        // What a partner shows: the getter on the error it gets, for each code such an error comes with.
        expect(new HanaSponsorError(4100, 'x', { reason }).userMessage, reason).toBe(sentence);
        expect(userMessageFor('api_unavailable', { reason }), reason).toBe(sentence);
      }
    }
    expect([...listed].sort()).toEqual(Object.keys(SPONSOR_REASONS).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("quotes the SDK's own refusal for a chain it doesn't sponsor, and the EIP-5792 codes and version", () => {
    expect(SPONSOR_REASONS.chain_not_sponsored).toBe(NOT_OFFERED);
    expect(gasFree).toContain('`sendSponsored()` refuses with `4100` (`chain_not_sponsored`) before any window');
    expect(gasFree).toContain("`sponsorship()` answers `{ available: false, reason: 'chain_not_enabled' }`");
    expect(gasFree).toContain(`Version \`${CALLS_VERSION}\` only`);
    for (const [name, code] of Object.entries({ duplicateId: '5720', unknownBundle: '5730', unsupportedCapability: '5700', unsupportedChain: '5710', bundleTooLarge: '5740' })) {
      expect(String(EIP5792[name as keyof typeof EIP5792])).toBe(code);
      expect(gasFree).toContain(`\`${code}\``);
    }
  });
});

describe('docs/integration.md "When sign-in doesn\'t finish"', () => {
  const s4 = part("### When sign-in doesn't finish", '## 5. Your page: origins, CSP, popups');
  const vault = readFileSync(new URL('../../src/vault/login.ts', import.meta.url), 'utf8');

  it("names the login_cancelled reasons the vault sends, and link_remove's sentence is the SDK's", () => {
    for (const reason of ['popup_closed', 'link_remove', 'email_consent_declined', 'google_account_mismatch']) {
      expect(s4).toContain(`\`${reason}\``);
      expect(vault).toMatch(new RegExp(`'login_cancelled'[^\\n]*(?:reason: '${reason}'|\\{ reason \\})`, 'u'));
    }
    expect(vault).toContain("const reason = problem === 'declined' ? 'email_consent_declined' : 'google_account_mismatch';");
    expect(userMessageFor('login_cancelled', { reason: 'link_remove' })).toMatch(/^You chose to remove this sign-in from that wallet\./u);
  });
});
