// The partner console's linking view (D925; docs/partner-platform-spec.md piece P7, B6) on the local stack: apps/console's
// real Worker and SPA in the browser project's admin lane (src/server/lane-console.ts, the Users screen on), over the
// lane's own API (ConsoleRpc.linkUser), signed in as the lane labels org's owner. The lane seeds one person on a scope
// marked as shared (/__e2e/lane/linking): an app of before, which gives them the scope's IDs, and one made after the
// mark, which gives them its own.
//
// Covered, in Chromium, Firefox and WebKit: the Users screen labels the person's IDs as theirs for all the org's apps;
// the owner finds them by the newer app's own Support ID (as the person reads it out), sees which code it was, each
// app's IDs and the sharing rule beside them; opens the person and "This person on your apps"; both look-ups are in the
// org's Audit.
//
// With HANA_SHOTS_DIR=<dir> (Chromium only) the last test saves the Tech Lead's screenshots there, at 390 and 1280 px,
// light and dark.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { CONSOLE_LANES } from '../src/stack.ts';
import { expect, test } from './admin-fixtures.ts';

test.describe.configure({ mode: 'default' });

const SHOTS = process.env.HANA_SHOTS_DIR;
const DESKTOP = { width: 1280, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
const RULE = 'Never give one partner another partner’s ID for the same person. Each partner should only see its own.';

interface Seeded {
  orgId: string;
  scopeId: string;
  apps: { before: { id: string; name: string }; own: { id: string; name: string } };
  person: { userId: string; supportId: string; ownUserId: string; ownSupportId: string };
}

const consoleOf = (info: TestInfo): string => (CONSOLE_LANES as Record<string, { origin: string }>)[info.project.name]!.origin;

async function lanePost<T>(lane: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${lane}/__e2e/lane/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  expect(res.status, `${path}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}

/** A fresh labels org (its owner is the console member the lane signs in) and a shared wallet's person in it. */
async function seed(lane: string): Promise<Seeded> {
  await lanePost(lane, 'labels', { action: 'reset' });
  return lanePost<Seeded>(lane, 'linking', {});
}

async function openUsers(page: Page, origin: string, s: Seeded): Promise<void> {
  await page.goto(`${origin}/__e2e/console/sign-in?to=${encodeURIComponent(`/orgs/${s.orgId}/users`)}`);
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: `Open ${s.person.userId}` })).toBeVisible();
}

async function findByOwnCode(page: Page, s: Seeded): Promise<void> {
  // As a person reads it out: lower case, spaces for the dashes.
  await page.getByLabel('User ID or Support ID from one of your apps').fill(s.person.ownSupportId.toLowerCase().replaceAll('-', ' '));
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText(`This is the Support ID ${s.apps.own.name} has for this person.`)).toBeVisible();
}

test('an owner finds a person by one app’s own Support ID, sees each app’s IDs with the sharing rule, and opens them', async ({ page, lane }, info) => {
  const origin = consoleOf(info);
  const s = await seed(lane);
  await openUsers(page, origin, s);
  // The list labels the shared wallet's IDs as the person's for all the org's apps.
  await expect(page.getByText('all your apps').first()).toBeVisible();
  await findByOwnCode(page, s);
  const result = page.locator('.find-result');
  await expect(result.getByText(s.person.ownUserId)).toBeVisible();
  await expect(result.getByText(s.person.ownSupportId)).toBeVisible();
  await expect(result.getByRole('cell', { name: s.apps.before.name, exact: true })).toBeVisible();
  await expect(result.getByText(RULE)).toBeVisible();
  await result.getByRole('button', { name: 'Open this person' }).click();
  const detail = page.locator('section.jp-card', { has: page.getByRole('heading', { name: 'User', exact: true }) });
  await expect(detail.getByText('User ID (all your apps)')).toBeVisible();
  // "This person on your apps" asks the server only when the owner presses for it.
  await page.getByRole('button', { name: 'Show their ID on each app' }).click();
  const panel = page.locator('section.person-apps');
  await expect(panel.getByText(s.person.ownUserId)).toBeVisible();
  await expect(panel.getByText(RULE)).toBeVisible();
  await expect(panel.getByText('Only owners can see this. Each look-up is recorded in your Audit.')).toBeVisible();
  // Both look-ups are in the org's Audit, under the person's scope-level User ID.
  await page.goto(`${origin}/orgs/${s.orgId}/audit`);
  await expect(page.getByText('Person looked up across your apps')).toHaveCount(2);
});

test('a code the org’s people don’t hold reads “not found”, in plain words', async ({ page, lane, watch }, info) => {
  const origin = consoleOf(info);
  // The refused look-up's own 404 line in the browser's console.
  watch.allow(/^console: Failed to load resource: the server responded with a status of 404/u);
  const s = await seed(lane);
  await openUsers(page, origin, s);
  await page.getByLabel('User ID or Support ID from one of your apps').fill('HANA-ZZZZ-ZZZZ');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText('Not found, or you aren’t a member of it.')).toBeVisible();
});

/** The whole page at `size`'s width, as tall as the page. */
async function whole(page: Page, size: { width: number; height: number }, path: string): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path}: the page is wider than the screen`).toBeLessThanOrEqual(size.width);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) });
  await page.screenshot({ path, animations: 'disabled' });
  await page.setViewportSize(size);
}

test('the Tech Lead’s screenshots (HANA_SHOTS_DIR, Chromium)', async ({ page, lane }, info) => {
  test.skip(!SHOTS || info.project.name !== 'chromium', 'screenshots only with HANA_SHOTS_DIR, in Chromium');
  test.setTimeout(240_000);
  mkdirSync(SHOTS!, { recursive: true });
  const origin = consoleOf(info);
  const s = await seed(lane);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of [DESKTOP, PHONE]) {
      await page.setViewportSize(size);
      await openUsers(page, origin, s);
      await whole(page, size, join(SHOTS!, `after-console-users-${size.width}-${scheme}.png`));
      await findByOwnCode(page, s);
      await whole(page, size, join(SHOTS!, `after-console-search-${size.width}-${scheme}.png`));
      await page.getByRole('button', { name: 'Open this person' }).click();
      await page.getByRole('button', { name: 'Show their ID on each app' }).click();
      await expect(page.locator('section.person-apps').getByText(s.person.ownUserId)).toBeVisible();
      await page.locator('section.person-apps').scrollIntoViewIfNeeded();
      await whole(page, size, join(SHOTS!, `after-console-panel-${size.width}-${scheme}.png`));
    }
  }
});
