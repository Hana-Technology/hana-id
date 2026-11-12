// The auto-approve consent screen's contract names in a real popup (docs/decisions.md D44): a contract on Hana's
// verified list shows "✓ {verified name}", any other "{name} · named by {app}", flagged when the name imitates a
// verified one; each with its short address and a link to the chain's explorer, none for an unknown chain.
import { expect, login, newApp, okValue, openPartner, approve, clickLauncher, runAction, test } from './fixtures.ts';

const SODAX_BASE_ASSET_MANAGER = '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3';
const OTHER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const IMPOSTOR = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const DEPOSIT = [{ selector: '0xb6b55f25', signature: 'deposit(uint256)', addressArgs: 'self-or-listed' }];
const chain = (chainId: number, contracts: { address: string; name: string }[]) => ({
  chainId,
  maxValueWei: '1000',
  maxValueWeiPerDay: '3000',
  maxFeeWei: '1000',
  contracts: contracts.map((c) => ({ ...c, selectors: DEPOSIT })),
});

const POLICY = {
  v: 1,
  label: 'Deposits',
  maxConsentMs: 3_600_000,
  limits: { perDayCount: 3 },
  evm: {
    chains: [
      chain(8453, [
        { address: SODAX_BASE_ASSET_MANAGER, name: 'Whatever the partner says' },
        { address: OTHER, name: 'Example vault' },
        { address: IMPOSTOR, name: 'Sodax Asset Manager' },
      ]),
      chain(999_999, [{ address: OTHER, name: 'Example vault' }]),
    ],
  },
};

test('consent shows verified names, partner names labelled and flagged, short addresses and explorer links', async ({ page }) => {
  await openPartner(page, await newApp({ settings: { autoApprovePolicy: POLICY } }));
  await login(page);
  await runAction(page, 'consent', 'requestAutoApprove');
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.getByRole('heading', { name: 'Allow automatic signing?' })).toBeVisible();

  const lines = popup.locator('.contracts p.contract');
  await expect(lines).toHaveCount(4);

  const verified = lines.nth(0);
  await expect(verified.locator('.verified')).toHaveText('✓ Sodax Asset Manager');
  await expect(verified).not.toContainText('Whatever the partner says');
  await expect(verified.locator('code')).toHaveText('0x348B…7Bc3');
  await expect(verified.locator('code')).toHaveAttribute('title', SODAX_BASE_ASSET_MANAGER);
  const link = verified.getByRole('link', { name: 'View on Basescan' });
  await expect(link).toHaveAttribute('href', `https://basescan.org/address/${SODAX_BASE_ASSET_MANAGER}`);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  await expect(lines.nth(1)).toContainText('Example vault · named by E2E Partner');
  await expect(lines.nth(1).locator('.name-warning')).toHaveCount(0);
  await expect(lines.nth(1).getByRole('link')).toHaveAttribute('href', `https://basescan.org/address/${OTHER}`);

  await expect(lines.nth(2)).toContainText('Sodax Asset Manager · named by E2E Partner — not the verified Sodax Asset Manager');
  await expect(lines.nth(2).locator('.verified')).toHaveCount(0);
  await expect(popup.getByText('E2E Partner gave some contracts below names that look like verified ones')).toBeVisible();

  // An unknown chain: the short address, no link.
  await expect(lines.nth(3)).toContainText('Example vault · named by E2E Partner');
  await expect(lines.nth(3).locator('code')).toHaveText('0x3fC9…7FAD');
  await expect(lines.nth(3).getByRole('link')).toHaveCount(0);

  await approve(popup, 'Allow');
  expect(await okValue(page, 'consent')).toMatchObject({ granted: true });
});
