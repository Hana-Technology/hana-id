// Partner labels in the staff admin portal on the local stack (D894): apps/admin's real Worker and SPA in the browser
// project's lane (src/server/admin-lane.ts), over apps/api's real AdminRpc, with a partner org whose on-chain owner
// proposes through apps/api's real ConsoleRpc and a step-up the API verifies (src/server/lane-labels.ts). The notice's
// ack, the hourly job and time are the lane's controls (`POST /__e2e/lane/labels`, `POST /__e2e/lane/clock`): nothing
// waits on a wall clock. Each test starts from the lane's labels reset (a new org; the last one's labels removed by its
// owner and the switches turned back).
//
// Covered: a proposed and announced change in the staff feed (its state and time, what users would see) → its page →
// Block with a note → the blocked state on the page, and `GET /v1/app` as the vault reads it no longer serving it; and a
// change not served a millisecond before its time and served at it (the text's sha256 the delivered one), "Live" on its
// page.
//
// With HANA_SHOTS_DIR=<dir> (Chromium only) the last test saves the Tech Lead's screenshots there, light theme, full
// page, 1366 and 390 px wide: the feed and a change's Block confirmation, the blocked change, a change waiting for Allow
// (required review), and System status's Partner labels tile with every partner label switched off.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, nowPanel, signIn, test, tool } from './admin-fixtures.ts';

test.describe.configure({ mode: 'default' });

const SHOTS = process.env.HANA_SHOTS_DIR;
const DESKTOP = { width: 1366, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
const DAY = 24 * 3_600_000;

test.use({ viewport: DESKTOP, colorScheme: 'light' });

/** A note of this run (the lane's audit log lives as long as the stack). */
const RUN = crypto.randomUUID().slice(0, 6);
const NOTE = `The words say collect a stamp but hide the fare (run ${RUN})`;
/** What users would see, as the preview writes the lane's document (lane-labels.ts laneLabelDocument). */
const PREVIEW_LINE = 'Stamp Rally says: collect the stamp “Arrival”';

interface Version {
  changeId: string;
  labelId: string;
  state: string;
  sha256: string;
  activeFrom: number | null;
  served: boolean;
  off: string | null;
  blockNote: string | null;
}
interface LabelsState {
  orgId: string;
  versions: Version[];
  nowMs: number;
}
interface Delivered {
  changeId: string;
  sha256: string;
  text: string;
  effectiveSince: number;
}

async function control<T>(lane: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${lane}/__e2e/lane/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  expect(res.status, `${path} ${JSON.stringify(body)}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}
/** A labels action (src/server/admin-lane-worker.ts labelsControl): its answer and the lane org's state. */
const labels = <T = Record<string, unknown>>(lane: string, body: Record<string, unknown>) => control<T & { state: LabelsState }>(lane, 'labels', body);
/** `GET /v1/app` as the vault reads it for the lane's labels app. */
async function served(lane: string): Promise<Delivered[] | null> {
  const r = await control<{ status: number; partnerLabels: Delivered[] | null }>(lane, 'labels', { action: 'app' });
  expect(r.status).toBe(200);
  return r.partnerLabels;
}
const clock = (lane: string, body: { advanceMs?: number; freeze?: boolean }) => control(lane, 'clock', body);

/**
 * The browser reads the lane's time: the pages' "in 24 h" and "Live" are worked out against the reader's clock, and
 * the lane's runs ahead of real time (Date.now fixed there; the page's timers keep running).
 */
const laneTime = (page: Page, s: LabelsState): Promise<void> => page.clock.setFixedTime(s.nowMs);

const feedItem = (page: Page, changeId: string): Locator => page.locator(`.label-item[data-change="${changeId}"]`);
const itemState = (item: Locator): Locator => item.locator('.label-item-head .jp-badge').first();

/** Fills a staff tool's note and presses its button: the confirmation strip shows, with `confirm`. */
async function openConfirm(form: Locator, button: string, note: string, confirm: string): Promise<Locator> {
  await form.locator('[name="note"]').fill(note);
  await form.getByRole('button', { name: button, exact: true }).click();
  const strip = form.getByRole('group', { name: `Confirm: ${button}` });
  await expect(strip).toContainText(confirm);
  return strip;
}

test('a proposed change is in the staff feed with what users would see; Block with a note stops it, on the page and in GET /v1/app', async ({ page, lane }) => {
  await labels(lane, { action: 'reset' });
  const p = await labels<{ proposed: { changeId: string } }>(lane, { action: 'propose' });
  const a = await labels<{ announced: { activeFrom: number }[] }>(lane, { action: 'announce' });
  const id = p.proposed.changeId;
  await laneTime(page, a.state);
  await signIn(page, lane, 'staff', '/labels');
  await expect(page.getByRole('heading', { name: 'Partner labels', level: 1 })).toBeVisible();
  const waiting = page.locator('.panel', { has: page.getByRole('heading', { name: 'Waiting', exact: true }) });
  const item = waiting.locator(`.label-item[data-change="${id}"]`);
  await expect(itemState(item)).toHaveText(/^Goes live \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(in (?:2[34] h( \d+ min)?|1 d 0 h)\)$/u);
  await expect(item.locator('.label-line')).toHaveText([PREVIEW_LINE]);
  await expect(item).toContainText('Stamp Rally');

  await item.getByRole('link', { name: `Open ${id}`, exact: true }).click();
  await expect(page).toHaveURL(`${lane}/labels/${id}`);
  await expect(page.getByRole('heading', { name: 'Partner label change', level: 1 })).toBeVisible();
  await expect(nowPanel(page)).toContainText('Shown to users nowNo');
  const strip = await openConfirm(tool(page, 'Block this change'), 'Block this change', NOTE, 'Block this change? Users will never see it, and the partner is told Journear blocked it.');
  await strip.getByRole('button', { name: 'Block this change', exact: true }).click();

  await expect(page.locator('.act-result')).toBeVisible();
  await expect(nowPanel(page).locator('.jp-badge').first()).toHaveText('Blocked by staff');
  await expect(nowPanel(page)).toContainText(`“${NOTE}”`);
  await expect(tool(page, 'Block this change')).toHaveCount(0);
  const s = await labels(lane, { action: 'state' });
  expect(s.state.versions).toEqual([expect.objectContaining({ changeId: id, state: 'blocked', blockNote: NOTE, served: false })]);
  // Its time comes, and it still isn't served.
  await clock(lane, { advanceMs: DAY });
  await labels(lane, { action: 'cron' });
  expect(await served(lane)).toEqual([]);
  // The feed lists it under what was decided (signed in again: the stand-in's token ends 24 h after the lane's clock).
  await signIn(page, lane, 'staff', '/labels');
  const decided = page.locator('.panel', { has: page.getByRole('heading', { name: 'Decided in the last 14 days', exact: true }) });
  await expect(itemState(decided.locator(`.label-item[data-change="${id}"]`))).toHaveText('Blocked by staff');
});

test('not served a millisecond before its time, served at it (the text’s sha256 the delivered one), and Live on its page', async ({ page, lane }) => {
  await labels(lane, { action: 'reset' });
  await clock(lane, { freeze: true });
  try {
    const p = await labels<{ proposed: { changeId: string; sha256: string } }>(lane, { action: 'propose' });
    const a = await labels<{ announced: { activeFrom: number }[] }>(lane, { action: 'announce' });
    const at = a.announced[0]!.activeFrom;
    expect(at).toBe(a.state.nowMs + DAY);
    await clock(lane, { advanceMs: DAY - 1 });
    expect(await served(lane)).toEqual([]);
    const before = await labels(lane, { action: 'state' });
    expect(before.state.nowMs).toBe(at - 1);
    await laneTime(page, before.state);
    await signIn(page, lane, 'staff', `/labels/${p.proposed.changeId}`);
    await expect(nowPanel(page).locator('.jp-badge').first()).toHaveText(/^Goes live /u);

    await clock(lane, { advanceMs: 1 });
    const s = await served(lane);
    expect(s).toEqual([expect.objectContaining({ changeId: p.proposed.changeId, sha256: p.proposed.sha256, effectiveSince: at })]);
    expect(createHash('sha256').update(s![0]!.text, 'utf8').digest('hex')).toBe(p.proposed.sha256);
    const now = await labels(lane, { action: 'state' });
    await laneTime(page, now.state);
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(nowPanel(page).locator('.jp-badge').first()).toHaveText('Live');
    await expect(nowPanel(page)).toContainText('Shown to users nowYes');
  } finally {
    await clock(lane, { freeze: false });
  }
});

/**
 * The whole page at `size`'s width: the viewport made as tall as the page first (a full-page capture would leave the
 * sticky sidebar where the first screen had it), then back.
 */
async function wholePage(page: Page, size: { width: number; height: number }, path: string): Promise<void> {
  // Nothing wider than the screen (no sideways scrolling of the page itself; a table may scroll in its own box).
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path}: the page is wider than the screen`).toBeLessThanOrEqual(size.width);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) });
  await page.screenshot({ path, animations: 'disabled' });
  await page.setViewportSize(size);
}

/** One whole-page screenshot per width, named `<name>-<width>.png`. */
async function shots(page: Page, name: string, open: () => Promise<void>): Promise<void> {
  for (const size of [DESKTOP, PHONE]) {
    await page.setViewportSize(size);
    await open();
    await wholePage(page, size, join(SHOTS!, `${name}-${size.width}.png`));
  }
}

test('the Tech Lead’s screenshots (HANA_SHOTS_DIR, Chromium)', async ({ page, lane }, info: TestInfo) => {
  test.skip(!SHOTS || info.project.name !== 'chromium', 'screenshots only with HANA_SHOTS_DIR, in Chromium');
  mkdirSync(SHOTS!, { recursive: true });
  try {
    // 1. The feed, and a change's Block confirmation.
    const w = await labels(lane, { action: 'scenario', name: 'labels-waiting' });
    const id = w.state.versions[0]!.changeId;
    await laneTime(page, w.state);
    await signIn(page, lane, 'staff', '/labels');
    await shots(page, '01-feed', async () => {
      await page.goto(`${lane}/labels`);
      await expect(feedItem(page, id).locator('.label-line')).toHaveText([PREVIEW_LINE]);
    });
    await shots(page, '01-change-block', async () => {
      await page.goto(`${lane}/labels/${id}`);
      await openConfirm(tool(page, 'Block this change'), 'Block this change', NOTE, 'Block this change?');
    });
    // 2. Blocked.
    await page.setViewportSize(DESKTOP);
    await page.goto(`${lane}/labels/${id}`);
    const strip = await openConfirm(tool(page, 'Block this change'), 'Block this change', NOTE, 'Block this change?');
    await strip.getByRole('button', { name: 'Block this change', exact: true }).click();
    await expect(nowPanel(page).locator('.jp-badge').first()).toHaveText('Blocked by staff');
    await wholePage(page, DESKTOP, join(SHOTS!, '02-blocked-answer-1366.png'));
    // The browser's clock at the lane's again (the block came a moment after the last reading).
    await laneTime(page, (await labels(lane, { action: 'state' })).state);
    await shots(page, '02-blocked', async () => {
      await page.goto(`${lane}/labels/${id}`);
      await expect(nowPanel(page).locator('.jp-badge').first()).toHaveText('Blocked by staff');
    });
    // 3. Required review: its time passed, waiting for Allow.
    const r = await labels(lane, { action: 'scenario', name: 'labels-review' });
    const rid = r.state.versions[0]!.changeId;
    await laneTime(page, r.state);
    // Signed in again after each state that moved the lane's clock a day on (the stand-in's token ends 24 h after it).
    await page.setViewportSize(DESKTOP);
    await signIn(page, lane, 'staff', '/labels');
    await shots(page, '03-review-allow', async () => {
      await page.goto(`${lane}/labels/${rid}`);
      await expect(tool(page, 'Allow')).toBeVisible();
    });
    await shots(page, '03-review-feed', async () => {
      await page.goto(`${lane}/labels`);
      await expect(itemState(feedItem(page, rid))).toHaveText(/^Waiting for a staff Allow/u);
    });
    // 4. Every partner label switched off: System status's tile (the status page's 30 s reading emptied).
    const o = await labels(lane, { action: 'scenario', name: 'labels-off' });
    await clock(lane, { advanceMs: 0 });
    await laneTime(page, o.state);
    await page.setViewportSize(DESKTOP);
    await signIn(page, lane, 'staff', '/status');
    const tile = page.locator('li.tile').filter({ has: page.getByRole('heading', { name: 'Partner labels', exact: true }) });
    await shots(page, '04-status', async () => {
      await page.goto(`${lane}/status`);
      await expect(tile.locator('.tile-lines')).toContainText('Every partner label');
    });
    for (const size of [DESKTOP, PHONE]) {
      await page.setViewportSize(size);
      await page.goto(`${lane}/status`);
      await expect(tile.locator('.tile-lines')).toContainText('Every partner label');
      await tile.screenshot({ path: join(SHOTS!, `04-status-tile-${size.width}.png`), animations: 'disabled' });
    }
  } finally {
    // The switch back on, for the lane's next test.
    await labels(lane, { action: 'reset' });
  }
});
