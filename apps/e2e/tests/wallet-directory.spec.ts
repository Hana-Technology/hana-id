// The wallet directory end to end (D310, D317, D346): after a login the vault reports the wallet's two addresses to
// the real Worker's POST /v1/wallets/record in the background, signed by each chain key and by the session key; the
// hot DB then holds the user (its User ID the `sub` of the identity token the same page gets) with both wallets and its
// root identity (`/__e2e/wallets`). The login itself never waits for it.
import { API_URL } from '../src/stack.ts';
import { expect, login, newApp, okValue, openPartner, runAction, status, test, waitReady, walletDirectory } from './fixtures.ts';

/** The Support ID's 8 characters of a User ID: Crockford base32 of its first 5 bytes (an independent build). */
function supportCodeOf(userId: string): string {
  const bytes = Buffer.from(userId.slice(3), 'base64url').subarray(0, 5);
  const n = bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  return Array.from({ length: 8 }, (_, i) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number((n >> BigInt(35 - 5 * i)) & 31n)]).join('');
}

test('after a login the wallet directory lists the user with both addresses and its Google identity', async ({ page, requests }) => {
  const app = await newApp();
  await openPartner(page, app);
  const addresses = await login(page);
  await expect.poll(async () => (await walletDirectory(addresses.stellar)).length, { timeout: 15_000 }).toBe(1);
  const [user] = await walletDirectory(addresses.evm);
  expect(user!.userId).toMatch(/^u1_[A-Za-z0-9_-]{22}$/u);
  expect(user!.internalId).toMatch(/^hu_[0-9a-hjkmnp-tv-z]{26}$/u);
  expect(user!.supportCode).toBe(supportCodeOf(user!.userId));
  // The User ID is exactly the identity token's `sub` (what the partner's backend stores).
  await runAction(page, 'token', 'identityToken');
  const token = (await okValue<string>(page, 'token'))!;
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string };
  expect(claims.sub).toBe(user!.userId);
  expect(user!.wallets).toEqual([
    { chain: 'stellar', address: addresses.stellar },
    { chain: 'evm', address: addresses.evm },
  ]);
  expect(user!.identities).toEqual([expect.objectContaining({ provider: 'google', role: 'root', status: 'active' })]);
  expect(requests.count(`${API_URL}/v1/wallets/record`)).toBe(1);
  // The Support ID the page reads (the vault's hana_status, from the API's /v1/login answer, C15) is the one the
  // directory stores for this user, and it survives a reload (the vault's record, `ready`).
  const supportId = `HANA-${user!.supportCode.slice(0, 4)}-${user!.supportCode.slice(4)}`;
  expect(await page.evaluate(() => (window as any).e2e.supportId())).toBe(supportId);
  await page.reload();
  expect(await waitReady(page)).toBe('ok');
  expect(await status(page)).toBe('logged_in');
  expect(await page.evaluate(() => (window as any).e2e.supportId())).toBe(supportId);

  // The same account in a second login (after a logout): the same user, no new row.
  await runAction(page, 'logout', 'logout');
  await okValue(page, 'logout');
  const again = await login(page, { name: 'again' });
  expect(again).toEqual(addresses);
  await expect.poll(() => requests.count(`${API_URL}/v1/wallets/record`), { timeout: 15_000 }).toBe(2);
  expect((await walletDirectory(addresses.stellar)).map((u) => u.userId)).toEqual([user!.userId]);
});
