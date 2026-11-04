// The wallet directory end to end (D310, D317): after a login the vault reports the wallet's two addresses to the real
// Worker's POST /v1/wallets/record in the background; the hot DB then holds the user with both wallets and its root
// identity (`/__e2e/wallets`). The login itself never waits for it.
import { API_URL } from '../src/stack.ts';
import { expect, login, newApp, okValue, openPartner, runAction, test, walletDirectory } from './fixtures.ts';

test('after a login the wallet directory lists the user with both addresses and its Google identity', async ({ page, requests }) => {
  const app = await newApp();
  await openPartner(page, app);
  const addresses = await login(page);
  await expect.poll(async () => (await walletDirectory(addresses.stellar)).length, { timeout: 15_000 }).toBe(1);
  const [user] = await walletDirectory(addresses.evm);
  expect(user!.userId).toMatch(/^hu_[0-9a-hjkmnp-tv-z]{26}$/u);
  expect(user!.wallets).toEqual([
    { chain: 'stellar', address: addresses.stellar },
    { chain: 'evm', address: addresses.evm },
  ]);
  expect(user!.identities).toEqual([expect.objectContaining({ provider: 'google', role: 'root', status: 'active' })]);
  expect(requests.count(`${API_URL}/v1/wallets/record`)).toBe(1);

  // The same account in a second login (after a logout): the same user, no new row.
  await runAction(page, 'logout', 'logout');
  await okValue(page, 'logout');
  const again = await login(page, { name: 'again' });
  expect(again).toEqual(addresses);
  await expect.poll(() => requests.count(`${API_URL}/v1/wallets/record`), { timeout: 15_000 }).toBe(2);
  expect((await walletDirectory(addresses.stellar)).map((u) => u.userId)).toEqual([user!.userId]);
});
