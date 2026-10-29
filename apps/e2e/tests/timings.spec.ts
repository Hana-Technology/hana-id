// pk_test_ timings in real browsers (packages/core/src/timings.ts, apps/smoke/README.md "Timings"): a login carries the
// popup's navigation-timing stages and the API's own times, a reload carries the vault document's load and the unlock;
// only stage names and durations.
import { LOGIN_TIMING_DETAILS, LOGIN_TIMING_STAGES, UNLOCK_TIMING_DETAILS, UNLOCK_TIMING_STAGES } from '@hana-id/core';
import { expect, login, newApp, openPartner, test, waitReady } from './fixtures.ts';

type Timings = Record<string, number> | null | undefined;

function expectOnly(timings: Timings, names: readonly string[]): Record<string, number> {
  expect(timings).toBeTruthy();
  for (const [k, ms] of Object.entries(timings!)) {
    expect(names, k).toContain(k);
    expect(Number.isFinite(ms) && ms >= 0, k).toBe(true);
  }
  return timings!;
}

test('a login and a reload report their stages, measured in the browser and by the API', async ({ page }) => {
  const app = await newApp();
  await openPartner(page, app);
  await login(page);
  const loginTimings = expectOnly(
    await page.evaluate(() => (window as any).e2e.hana.lastLogin?.timings as Timings),
    [...LOGIN_TIMING_STAGES, ...LOGIN_TIMING_DETAILS],
  );
  // The client's, the popup's (from the callback's navigation timing), the relay's and the API's parts are all there.
  for (const k of ['open', 'port', 'app', 'keygen', 'popup', 'authCheck', 'google', 'callbackFetch', 'callbackBoot', 'callbackPrep', 'relayHeld', 'chain', 'decrypt', 'finish', 'vault', 'loginRtt', 'loginServer'])
    expect(loginTimings, k).toHaveProperty(k);
  // The share and record come after the reply (D79): nothing of theirs is in the login's timings.
  for (const k of Object.keys(loginTimings)) expect(k).not.toMatch(/^(persist|share)/u);
  expect(loginTimings.loginServer!).toBeLessThanOrEqual(loginTimings.loginRtt!);

  await page.reload();
  expect(await waitReady(page)).toBe('ok');
  const ready = expectOnly(await page.evaluate(() => (window as any).e2e.hana.readyTimings as Timings), [...UNLOCK_TIMING_STAGES, ...UNLOCK_TIMING_DETAILS]);
  for (const k of ['mount', 'frameStart', 'vaultFetch', 'vaultScript', 'vaultConfig', 'vaultLoad', 'store', 'record', 'unlock', 'counter', 'unwrap', 'addresses', 'port', 'unlockRtt', 'unlockServer'])
    expect(ready, k).toHaveProperty(k);
  expect(ready.unlockServer!).toBeLessThanOrEqual(ready.unlockRtt!);
});
