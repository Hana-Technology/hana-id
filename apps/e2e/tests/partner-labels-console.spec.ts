// The partner console's Request labels tab on the local stack (D899): apps/console's real Worker and SPA in the browser
// project's admin lane (src/server/lane-console.ts), over the lane's own API (the ConsoleRpc the staff portal and
// lane-labels.ts reach), signed in as the lane labels org's owner (an on-chain owner of its scope). The fresh sign-in is
// the console's own (its /start, /callback and code exchange; the Google step answered by the lane's stand-in), and the
// API verifies the token itself. The notice's ack and staff's Block are the lane's controls (lane-labels.ts).
//
// Covered, in Chromium, Firefox and WebKit: the form filled (no JSON typed), the approval window's own preview (the
// partner's box; the amber and red lines), Review → the confirmation page's diff → Confirm with Google → proposed, the
// change waiting with its go-live time once announced, Cancel; and a change Journear blocked, with its note.
//
// With HANA_SHOTS_DIR=<dir> (Chromium only) the last test saves the founder's screenshots there, at 390 and 1280 px,
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
/** The lane org's till: an example Stellar account (no one's real account). */
const TILL = 'GBBQI276ICJLH2KJSTVNUFO4YIGYVKQHWZMP2OKU5OHA564L3SS55TZP';
const RUN = crypto.randomUUID().slice(0, 6);
const NOTE = `The words would mislead users about the fare (run ${RUN})`;

test.use({ viewport: DESKTOP, colorScheme: 'light' });

interface LabelsState {
  orgId: string;
  appId: string;
  versions: { changeId: string; state: string; blockNote: string | null }[];
  nowMs: number;
}

const consoleOf = (info: TestInfo): string => (CONSOLE_LANES as Record<string, { origin: string }>)[info.project.name]!.origin;

async function labels<T = Record<string, unknown>>(lane: string, body: Record<string, unknown>): Promise<T & { state: LabelsState }> {
  const res = await fetch(`${lane}/__e2e/lane/labels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  expect(res.status, `${JSON.stringify(body)}: ${text}`).toBe(200);
  return JSON.parse(text) as T & { state: LabelsState };
}

/** Signs in to the lane's console as the labels org's owner, then opens the app's Request labels tab. */
async function openTab(page: Page, origin: string, s: LabelsState, rest = ''): Promise<void> {
  await page.clock.setFixedTime(s.nowMs);
  await page.goto(`${origin}/__e2e/console/sign-in?to=${encodeURIComponent(`/orgs/${s.orgId}/apps/${s.appId}/labels${rest}`)}`);
  await expect(page.getByRole('navigation', { name: 'App sections' }).getByRole('link', { name: 'Request labels', exact: true })).toBeVisible();
}

/** Fills the payment form as a partner would: an account and its name, the phrase, a text memo, the suggested fee. */
async function fillPayment(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add an account' }).click();
  await page.getByLabel('Account 1', { exact: true }).fill(TILL);
  await page.getByLabel(/Its name for users/u).fill('Stamp Rally till');
  await page.getByLabel(/Your phrase/u).fill('order');
  await page.getByLabel(/^The memo/u).selectOption('text');
  await page.getByLabel('Joining word').selectOption('for');
  await page.getByRole('button', { name: 'Add the word' }).click();
  await page.getByRole('button', { name: 'Move “for” earlier' }).click();
  await page.getByRole('button', { name: 'Move “for” earlier' }).click();
  await page.getByRole('button', { name: 'Use 0.01 XLM' }).click();
  await expect(page.getByRole('status').filter({ hasText: /problem|ready/u })).toHaveText('No problems: ready to review.');
}

const box = (page: Page) => page.locator('.window-preview div.partner-label');

test('fills the form, sees the preview, proposes with a fresh sign-in, sees it waiting, cancels', async ({ page, lane }, info) => {
  const origin = consoleOf(info);
  const r = await labels(lane, { action: 'reset' });
  await openTab(page, origin, r.state);
  await expect(page.getByText(/Request labels are your own words for your app’s requests/u)).toBeVisible();
  await page.getByRole('link', { name: 'New request labels' }).click();
  await expect(page.getByRole('heading', { name: 'New request labels' })).toBeVisible();
  await fillPayment(page);
  // The approval window's own box, with the example memo.
  await expect(box(page).locator('p.partner-says')).toHaveText('Stamp Rally says: pay for order 1042');
  await expect(box(page)).toHaveAttribute('aria-label', 'What Stamp Rally says');
  await page.getByLabel('A payment that doesn’t match').check();
  await expect(page.locator('.window-preview .partner-mismatch')).toContainText('Stamp Rally describes this kind of request, but this one doesn’t match');
  await expect(box(page)).toHaveCount(0);
  await page.getByLabel('A payment to an account not in your list').check();
  await expect(page.locator('.window-preview .partner-not-listed')).toContainText('This isn’t one of the accounts Stamp Rally has listed for payments.');
  // A claim word: core's refusal beside the phrase, Review off; fixed again.
  await page.getByLabel(/Your phrase/u).fill('free order');
  await expect(page.getByLabel(/Your phrase/u)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Review the change' })).toBeDisabled();
  await page.getByLabel(/Your phrase/u).fill('order');
  await expect(page.getByRole('button', { name: 'Review the change' })).toBeEnabled();

  await page.getByRole('button', { name: 'Review the change' }).click();
  await expect(page.getByRole('heading', { name: 'Propose request labels' })).toBeVisible();
  await expect(page.locator('.labels-diff [data-change="added"]')).toHaveCount(2);
  await expect(page.getByText(/goes live 24 hours after the email unless someone cancels it; Journear may block it if it would mislead users/u)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm with Google' }).click();
  await expect(page.getByText(/^Done\./u)).toBeVisible();
  await expect(page.getByText(/Proposed\. Journear emails your security contacts/u)).toBeVisible();
  const proposed = (await labels(lane, { action: 'state' })).state.versions;
  expect(proposed).toEqual([expect.objectContaining({ state: 'proposed' })]);

  // Announced by the lane's notice step: waiting, with its time.
  const a = await labels(lane, { action: 'announce' });
  await page.clock.setFixedTime(a.state.nowMs);
  await page.getByRole('link', { name: 'Back to Request labels' }).first().click();
  const waiting = page.locator(`.labels-waiting[data-change="${proposed[0]!.changeId}"]`);
  await expect(waiting).toContainText('Stamp Rally says: pay for order “1042”');
  await expect(waiting).toContainText(/It goes live in (?:23 h|1 d 0 h|24 h)/u);
  await expect(page.locator('.labels-entry .jp-badge').filter({ hasText: /^Goes live / })).toBeVisible();
  await waiting.getByRole('button', { name: 'Cancel this change' }).click();
  await waiting.getByRole('button', { name: 'Cancel it now' }).click();
  await expect(page.getByText('Cancelled. It won’t go live.').first()).toBeVisible();
  await expect(page.locator('.labels-recent')).toContainText('Cancelled on');
  expect((await labels(lane, { action: 'state' })).state.versions).toEqual([expect.objectContaining({ changeId: proposed[0]!.changeId, state: 'cancelled' })]);
});

test('a change Journear blocked is listed with Journear’s note', async ({ page, lane }, info) => {
  const origin = consoleOf(info);
  await labels(lane, { action: 'reset' });
  await labels(lane, { action: 'propose' });
  await labels(lane, { action: 'announce' });
  const b = await labels(lane, { action: 'block', note: NOTE });
  await openTab(page, origin, b.state);
  const recent = page.locator('.labels-recent');
  await expect(recent.locator('.jp-badge')).toHaveText('Blocked by Journear');
  await expect(recent).toContainText(`Journear’s note: “${NOTE}”`);
  await expect(recent).toContainText('Your users don’t see it.');
});

/** The whole page at `size`'s width, as tall as the page. */
async function whole(page: Page, size: { width: number; height: number }, path: string): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path}: the page is wider than the screen`).toBeLessThanOrEqual(size.width);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) });
  await page.screenshot({ path, animations: 'disabled' });
  await page.setViewportSize(size);
}

test('the founder’s screenshots (HANA_SHOTS_DIR, Chromium)', async ({ page, lane }, info) => {
  test.skip(!SHOTS || info.project.name !== 'chromium', 'screenshots only with HANA_SHOTS_DIR, in Chromium');
  test.setTimeout(240_000);
  mkdirSync(SHOTS!, { recursive: true });
  const origin = consoleOf(info);
  const shoot = async (name: string, open: (scheme: 'light' | 'dark') => Promise<void>) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const size of [DESKTOP, PHONE]) {
        await page.setViewportSize(size);
        await open(scheme);
        await whole(page, size, join(SHOTS!, `${name}-${size.width}-${scheme}.png`));
      }
    }
  };
  // 1. The editor with the preview: a match, a mismatch, a payment to an unlisted account; the window dark too.
  const r = await labels(lane, { action: 'reset' });
  for (const [example, label] of [
    ['match', null],
    ['mismatch', 'A payment that doesn’t match'],
    ['not-listed', 'A payment to an account not in your list'],
  ] as const) {
    await shoot(`01-editor-${example}`, async (scheme) => {
      await openTab(page, origin, r.state, '/new');
      await fillPayment(page);
      if (label) await page.getByLabel(label).check();
      await page.getByLabel(scheme === 'dark' ? 'Dark' : 'Light', { exact: true }).check();
      await expect(page.locator('.window-preview > *').first()).toBeVisible();
    });
  }
  // 2. A problem beside its field.
  await shoot('02-editor-problem', async () => {
    await openTab(page, origin, r.state, '/new');
    await fillPayment(page);
    await page.getByLabel(/Your phrase/u).fill('free order');
    await expect(page.getByLabel(/Your phrase/u)).toHaveAttribute('aria-invalid', 'true');
  });
  // 3. The review before the fresh sign-in.
  await shoot('03-review', async () => {
    await openTab(page, origin, r.state, '/new');
    await fillPayment(page);
    await page.getByRole('button', { name: 'Review the change' }).click();
    await expect(page.getByRole('heading', { name: 'Propose request labels' })).toBeVisible();
  });
  // 4. The list: live, a change waiting, and one Journear blocked.
  await labels(lane, { action: 'scenario', name: 'labels-update' });
  const s = await labels(lane, { action: 'state' });
  await shoot('04-list', async () => {
    await openTab(page, origin, s.state);
    await expect(page.locator('.labels-entry').first()).toBeVisible();
  });
  await labels(lane, { action: 'block', note: NOTE });
  const blocked = await labels(lane, { action: 'state' });
  await shoot('05-list-blocked', async () => {
    await openTab(page, origin, blocked.state);
    await expect(page.locator('.labels-recent').first()).toBeVisible();
  });
  // 6. A NEAR program's form: not shown to users yet.
  await shoot('06-editor-near', async () => {
    await openTab(page, origin, blocked.state, '/new');
    await page.getByLabel(/A NEAR program/u).check();
    await expect(page.getByText('Not shown to users yet').first()).toBeVisible();
  });
});
