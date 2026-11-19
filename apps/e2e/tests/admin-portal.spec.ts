// The staff admin portal on the local stack (D873): apps/admin's real Worker and SPA, behind the stack's Cloudflare
// Access stand-in (the Worker's own Access check verifies every token), bound to the real AdminRpc and StaffRpc
// entrypoints, with EVM gas sponsorship's REAL relayer object on chain 31337 (src/server/admin-lane.ts). Each browser
// project has its own lane, and this file's tests run one after another in it (they share its relayer); each test
// puts the relayer in its state first, through the lane's controls (src/server/admin-lane-worker.ts SCENARIOS), so
// nothing waits on a wall clock: time passes for the relayer when a control runs it, and the lane's clock moves when a
// control moves it.
//
// Covered: sign-in as staff, and the refusals (no token, a forged one, someone not on the staff list); System status's
// "Free network fees" tile; the sponsorship page against the relayer's real state: a waiting transaction, Cancel only
// past its time limit; out of money (the steps, refill, Resume); someone else using the relayer's key three ways (the
// leak steps, no refill asked, Resume refused without the engineer's word, then Close, Set the next slot number and
// Fill a gap, each with its confirmation); a stale page and a second tab; every action in the audit log with who, when
// and the note; the sponsorship's security events with their playbooks; and the staff side of the support pages
// (unlock and unsuppress are the email issuer's staff routes, with no admin page: their audit rows here).
//
// With HANA_SHOTS_DIR=<dir> (Chromium only) it saves the founder's screenshots there (desktop, light theme).
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { ISSUER_URL } from '../src/stack.ts';
import { DETAIL, STAFF, actResult, expect, laneClock, laneRun, laneState, nowPanel, scenario, signIn, slotRow, test, tool, useTool } from './admin-fixtures.ts';

test.describe.configure({ mode: 'default' });

const SHOTS = process.env.HANA_SHOTS_DIR;
const DESKTOP = { width: 1366, height: 900 } as const;

test.use({ viewport: DESKTOP, colorScheme: 'light' });

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!SHOTS || info.project.name !== 'chromium') return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' });
}

const TITLE = 'Free network fees (local test network)';
/** A note of this run (the lane's audit log lives as long as the stack): the text and a short tag. */
const RUN = crypto.randomUUID().slice(0, 6);
const n = (text: string): string => `${text} (run ${RUN})`;

const LEAK_FIRST_STEP = 'Tell an engineer now: treat the relayer’s key as leaked. Don’t send money to the relayer wallet.';
const LEAK_LAST_STEP = 'Don’t press Resume until the engineer says the key is safe or replaced. Resume then asks you to confirm that.';

/** The page's tool answer box: its title and text. */
async function expectAnswer(page: Page, title: string, text: string | RegExp): Promise<void> {
  await expect(actResult(page).locator('b')).toHaveText(title);
  await expect(actResult(page)).toContainText(text);
}

/** The relayer's own log has exactly these entries, newest first: [tool, done, refused]. */
async function expectStaffLog(lane: string, entries: [string, boolean, string | null][]): Promise<void> {
  const s = await laneState(lane);
  expect(s.staffLog.map((e) => [e.tool, e.done, e.refused])).toEqual(entries);
  for (const e of s.staffLog) expect(e.who).toBe(STAFF);
}

/**
 * The Audit log page's console rows for one staff tool use: `evm_relay.staff_action` (before, with the note) and
 * `evm_relay.staff_result` (after, with the answer), both by the staff member, with their time.
 */
async function expectAudited(page: Page, lane: string, o: { tool: string; note: string; result: string }): Promise<void> {
  await page.goto(`${lane}/audit`);
  await expect(page.getByRole('heading', { name: 'Audit log', exact: true })).toBeVisible();
  const rows = page.locator('.panel', { has: page.getByRole('heading', { name: 'Console audit', exact: true }) }).locator('tbody tr');
  const action = rows.filter({ hasText: 'evm_relay.staff_action' }).filter({ hasText: o.note });
  await expect(action).toHaveCount(1);
  await expect(action).toContainText(STAFF);
  await expect(action).toContainText(`tool: ${o.tool}`);
  await expect(action).toContainText('chainId: 31337');
  // The row's time, as the page writes it (UTC, to the minute).
  await expect(action.locator('td').first()).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u);
  const requestId = (await action.locator('td').last().locator('.sub').textContent())!.trim();
  const result = rows.filter({ hasText: 'evm_relay.staff_result' }).filter({ hasText: requestId });
  await expect(result).toHaveCount(1);
  await expect(result).toContainText(`result: ${o.result}`);
  await expect(result).toContainText(STAFF);
}

/** A forged Access token: the right claims, signed with a key that isn't the team's. */
function forgedToken(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'e2e-access-1', typ: 'JWT' });
  const body = b64({ iss: 'https://e2e-access.invalid', aud: ['e2e'.padEnd(64, '0')], sub: '00000000-0000-4000-8000-00000000e2e1', email: STAFF, type: 'app', iat: now, exp: now + 3600 });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }))).toString('base64url')}`;
}

test.describe('signing in (Cloudflare Access, the staff list)', () => {
  test('staff sign in through Access and land on System status, named in the sidebar', async ({ page, lane }, info) => {
    await signIn(page, lane, 'staff', '/');
    await expect(page.getByRole('heading', { name: 'System status', exact: true })).toBeVisible();
    await expect(page.locator('#who')).toHaveText(`Signed in as ${STAFF}`);
    await expect(page.locator('#env')).toHaveText('local-e2e');
    await shot(page, info, 'signed-in-status');
  });

  test('refused: no Access token, a forged one, and someone Access lets in who is not on the staff list', async ({ page, context, lane, watch }) => {
    // The refused /api/me is a console error in Chromium and WebKit ("Failed to load resource"): expected here.
    watch.allow(/Failed to load resource: the server responded with a status of 40[13]/u);
    const me = async () => {
      const r = await context.request.get(`${lane}/api/me`);
      return [r.status(), ((await r.json()) as { error?: { code?: string } }).error?.code];
    };
    // No token: the page says the sign-in has expired; the Worker answers 401.
    const banner = page.getByRole('alert');
    await page.goto(`${lane}/`);
    await expect(banner).toContainText('Your sign-in has expired');
    await expect(banner.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await expect(page.locator('#who')).toHaveText('');
    expect(await me()).toEqual([401, 'unauthenticated']);

    // A forged token (right claims, wrong key) in the Access cookie: the Worker's own check refuses it.
    await context.addCookies([{ name: 'CF_Authorization', value: forgedToken(), url: lane }]);
    await page.reload();
    await expect(banner).toContainText('Your sign-in has expired');
    await expect(page.locator('#who')).toHaveText('');
    expect(await me()).toEqual([401, 'unauthenticated']);
    // A client can't hand the Worker its own header either: the edge replaces it with the cookie's token.
    const direct = await context.request.get(`${lane}/api/me`, { headers: { 'cf-access-jwt-assertion': forgedToken() } });
    expect(direct.status()).toBe(401);

    // A real Access token of someone not on the staff list: 403, and the page says so.
    await context.clearCookies();
    await signIn(page, lane, 'outsider', '/');
    await expect(page.getByText('This account isn’t on the Journear staff list', { exact: true })).toBeVisible();
    expect(await me()).toEqual([403, 'not_staff']);
    await expect(page.locator('#who')).toHaveText('');
  });
});

test.describe('every page', () => {
  test('each page in the sidebar opens with its heading and no console error, but the two sources the stack has none of', async ({ page, lane, watch }) => {
    // The stack runs no watchdog and its mocked chain has no governance views: those reads answer 503, said on the
    // pages (Security & monitoring, Pending upgrades). Any other error fails the test.
    watch.allow(/Failed to load resource: the server responded with a status of 503/u);
    await signIn(page, lane, 'staff', '/status');
    const links = await page.locator('#nav a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), (a.textContent ?? '').trim()]));
    expect(links.length).toBeGreaterThanOrEqual(15);
    for (const [href, label] of links) {
      await page.goto(`${lane}${href}`);
      if (href === '/security/upgrades') {
        await expect(page.locator('main'), label!).toContainText('NEAR didn’t answer');
        continue;
      }
      await expect(page.locator('main h1'), label!).toBeVisible();
      await expect(page.locator('main .skeleton'), label!).toHaveCount(0);
    }
  });
});

test.describe('free network fees (the relayer on chain 31337)', () => {
  test('System status: the tile is Working, with the wallet, the money, the helper program; it links to the page', async ({ page, lane }, info) => {
    await scenario(lane, 'working');
    await signIn(page, lane, 'staff', '/status');
    const tile = page.locator('li.tile').filter({ has: page.getByRole('heading', { name: TITLE, exact: true }) });
    await expect(tile.locator('.tile-head')).toContainText('Working');
    await expect(tile.locator('.tile-detail').first()).toHaveText('Sending normally · the next transaction gets slot 1');
    await expect(tile).toContainText('Money in the wallet1 test ETH · low below 0.01 test ETH');
    await expect(tile).toContainText('Account helper programThe checked version');
    await expect(tile).toContainText('Waiting to go throughNone');
    await tile.scrollIntoViewIfNeeded();
    await shot(page, info, 'status-tile-working');
    await tile.getByRole('link', { name: 'Free network fees' }).click();
    await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
    await expect(nowPanel(page)).toContainText('Working');
    await expect(page.getByText('No tool is offered now')).toHaveCount(0);
  });

  test('System status: the tile in each state the relayer can be in, as the relayer is', async ({ page, lane }, info) => {
    const tile = page.locator('li.tile').filter({ has: page.getByRole('heading', { name: TITLE, exact: true }) });
    const states: [string, string, string | RegExp][] = [
      ['ready', 'Working', 'Ready · nothing sent yet'],
      ['working', 'Working', 'Sending normally · the next transaction gets slot 1'],
      ['waiting', 'Working', 'Sending normally · the next transaction gets slot 1'],
      ['low-money', 'Low on money', '0.005 test ETH left in the relayer wallet.'],
      ['out-of-money', 'Paused: needs a person', /^Paused since \d{2}:\d{2} UTC \(\d+ s\)\. Nobody gets free network fees until a person fixes it\. Nothing is lost\.$/u],
      ['key-used-elsewhere', 'Paused: needs a person', /^Paused since /u],
    ];
    await signIn(page, lane, 'staff', '/status');
    for (const [name, chip, detail] of states) {
      await scenario(lane, name);
      await page.reload();
      await expect(tile.locator('.tile-head'), name).toContainText(chip);
      await expect(tile.locator('.tile-detail').first(), name).toHaveText(detail);
      if (name === 'waiting') await expect(tile).toContainText(/Waiting to go through1 · the oldest for \d+ s · not yet picked up by the network|Waiting to go through1 · the oldest for \d+ s/u);
      if (name === 'out-of-money') await expect(tile.locator('.explain-why')).toHaveText('The relayer’s wallet can’t send transactions: it is out of money.');
      if (name === 'key-used-elsewhere') {
        await expect(tile.locator('.explain-steps li').first()).toHaveText(LEAK_FIRST_STEP);
        await expect(tile).not.toContainText('Send at least');
      }
      if (SHOTS && info.project.name === 'chromium') {
        await tile.scrollIntoViewIfNeeded();
        await tile.screenshot({ path: join(SHOTS, `status-tile-${name}.png`), animations: 'disabled' });
      }
    }
    // The page keeps one reading for 30 s (D425): a change shows once that has passed (here, the lane's clock).
    await scenario(lane, 'refill');
    await page.reload();
    await expect(tile.locator('.tile-head')).toContainText('Paused: needs a person');
    await laneClock(lane, 31_000);
    await page.reload();
    await expect(tile.locator('.tile-head')).toContainText('Paused: needs a person');
    await expect(tile).toContainText('Money in the wallet1 test ETH · low below 0.01 test ETH');
  });

  test('a waiting transaction is listed with its app; Cancel only once its time limit has passed; Cancel sends one', async ({ page, lane }, info) => {
    await scenario(lane, 'waiting');
    await signIn(page, lane, 'staff', DETAIL);
    const row = slotRow(page, 0);
    await expect(row).toContainText('Check-in demo');
    await expect(row).toContainText('Sent, waiting to go through');
    await expect(row).toContainText('Cancel shows once its time limit has passed.');
    await expect(row.getByRole('button', { name: 'Cancel…' })).toHaveCount(0);
    await expect(nowPanel(page)).toContainText('Working');
    await shot(page, info, 'detail-waiting');

    // The lane's clock moves past the 4-minute time limit: now Cancel is offered.
    await scenario(lane, 'past-deadline');
    await page.reload();
    await expect(row.getByRole('button', { name: 'Cancel…' })).toBeVisible();
    await row.getByRole('button', { name: 'Cancel…' }).click();
    const note = n('The user’s time limit passed and it holds up the slots after it');
    await useTool(row, { button: 'Cancel slot 0', note, confirm: 'Cancel slot 0? The user’s action in this slot won’t happen, and that can’t be undone.' });
    await expectAnswer(page, 'Cancel this slot: done', 'A cancel for slot 0 was sent. The user’s action in that slot won’t happen.');
    await expect(slotRow(page, 0)).toContainText('Being cancelled: the user’s action won’t happen');
    const s = await laneState(lane);
    expect(s.records.find((r) => r.slot === 0)?.copies.at(-1)).toBe('cancel');
    await expectStaffLog(lane, [['cancel', true, null]]);
    await expectAudited(page, lane, { tool: 'cancel', note, result: 'done' });
  });

  test('out of money: the steps; Resume refused while it still can’t send; refilled, Resume works', async ({ page, lane }, info) => {
    await scenario(lane, 'out-of-money');
    await signIn(page, lane, 'staff', DETAIL);
    const now = nowPanel(page);
    await expect(now).toContainText('Paused: needs a person');
    await expect(now.locator('.explain-why')).toHaveText('The relayer’s wallet can’t send transactions: it is out of money.');
    const steps = now.locator('.explain-steps li');
    await expect(steps).toHaveCount(5);
    await expect(steps.nth(2)).toHaveText('Send at least 1.01 test ETH to the relayer wallet (its address is below) from the local node’s funded test account.');
    await expect(steps.nth(3)).toHaveText('When the balance below shows the new amount, press Resume on the Free network fees page.');
    await expect(now).toContainText('relayer_cannot_send · insufficient_funds · slot 0');
    await expect(now).toContainText('Money in the walletProblem 0.0001 test ETH · low below 0.01 test ETH');
    // Not a leak: Resume is the plain one (no engineer's confirmation).
    const resume = tool(page, 'Resume');
    await expect(resume.locator('[name="keyConfirmed"]')).toHaveCount(0);
    await shot(page, info, 'detail-paused-out-of-money');

    await useTool(resume, { button: 'Resume', note: n('Pressed before the refill to see what it says'), confirm: 'Resume free network fees? The relayer checks the network first' });
    await expectAnswer(page, 'Resume: the relayer said no. Nothing was changed.', 'The problem is still there: the relayer’s wallet can’t send transactions: it is out of money.');

    await scenario(lane, 'refill');
    await page.reload();
    await expect(nowPanel(page)).toContainText('Money in the wallet1 test ETH · low below 0.01 test ETH');
    const note = n('Sent 1.01 test ETH from the local node account; balance now 1');
    await useTool(tool(page, 'Resume'), { button: 'Resume', note, confirm: 'Resume free network fees?' });
    await expectAnswer(page, 'Resume: done', 'Free network fees are running again.');
    await expect(nowPanel(page)).toContainText('Working');
    await shot(page, info, 'detail-resumed');
    await expectStaffLog(lane, [
      ['resume', true, null],
      ['resume', false, 'relayer_cannot_send'],
    ]);
    await expectAudited(page, lane, { tool: 'resume', note, result: 'done' });
    if (SHOTS && info.project.name === 'chromium') await shot(page, info, 'audit-log');
  });

  test('a transaction nobody at Journear sent used a slot: the leak steps, no refill; Resume needs the engineer; Close, then Resume', async ({ page, lane }, info) => {
    await scenario(lane, 'key-used-elsewhere');
    await signIn(page, lane, 'staff', DETAIL);
    const now = nowPanel(page);
    await expect(now).toContainText('Paused: needs a person');
    await expect(now.locator('.explain-why')).toHaveText('Slot 0 was used up on the network by a transaction the relayer didn’t send: someone else used the relayer’s key.');
    const steps = now.locator('.explain-steps li');
    await expect(steps.first()).toHaveText(LEAK_FIRST_STEP);
    await expect(steps.last()).toHaveText(LEAK_LAST_STEP);
    await expect(page.locator('main')).not.toContainText('Send at least');
    await expect(now).toContainText('nonce_consumed_elsewhere · slot 0 · leak_seen');
    // The slot's row says what the relayer found (not "waiting to go through"), and offers no Cancel: Close is its tool.
    await expect(slotRow(page, 0)).toContainText('Used by a transaction Journear didn’t send: it won’t go through');
    await expect(slotRow(page, 0)).toContainText('No Cancel: the network shows this slot already used. Close it instead (under Advanced), once the engineer says so.');
    const resume = tool(page, 'Resume');
    await expect(resume).toContainText('Only after the engineer says so');
    await shot(page, info, 'detail-paused-leak');

    // Without the engineer's confirmation the page sends nothing; nor does the Worker act on a request without it.
    await useTool(resume, { button: 'Resume', note: n('Trying without the engineer first'), confirm: 'Resume free network fees on the engineer’s word' });
    await expect(resume.locator('.jp-alert').last()).toContainText('Confirm what the engineer said first');
    await expectStaffLog(lane, []);
    const refused = await page.evaluate(async (note) => {
      const d = await (await fetch('/api/evm-relay/31337')).json();
      const r = await fetch('/api/evm-relay/31337/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hana-admin': '1' }, body: JSON.stringify({ token: d.token, tool: 'resume', note, seen: d.seen }) });
      return [r.status, (await r.json()).result];
    }, n('Sent straight to the Worker without the box'));
    expect(refused).toEqual([200, { done: false, refused: 'key_confirmation_required' }]);
    // Refused by the API before the relayer is called: not in the relayer's own log, in the audit log with its answer.
    await expectStaffLog(lane, []);
    await expectAudited(page, lane, { tool: 'resume', note: n('Sent straight to the Worker without the box'), result: 'key_confirmation_required' });
    await page.goto(`${lane}${DETAIL}`);

    // Advanced: Close the slot (its confirmation names what it does to the books), then Resume on the engineer's word.
    await page.reload();
    await page.getByText('Advanced: rarely needed').click();
    const close = tool(page, 'Close as “used by something else”');
    await expect(close.locator('select[name="slot"]')).toHaveValue('0');
    const closeNote = n('The explorer shows slot 0 used by a transfer we did not send');
    await useTool(close, { button: 'Close the slot', note: closeNote, confirm: 'Close slot 0 as used by something else? The user’s action in it is marked as not done. The app is not charged: Journear covers it. This can’t be undone.' });
    await shot(page, info, 'tool-close-result');
    await expectAnswer(page, 'Close as “used by something else”: done', 'Slot 0 is closed as used by something else.');
    await expect(page.locator('main')).toContainText('Nothing is waiting: every transaction is on the network.');

    const resumeNote = n('Engineer replaced the key and moved the money out at 14:20 UTC');
    await useTool(tool(page, 'Resume'), { button: 'Resume', note: resumeNote, confirm: 'on the engineer’s word', fill: (f) => f.locator('[name="keyConfirmed"]').check() });
    await expectAnswer(page, 'Resume: done', 'Free network fees are running again.');
    await expect(nowPanel(page)).toContainText('Working');
    await expectStaffLog(lane, [
      ['resume', true, null],
      ['close', true, null],
    ]);
    await expectAudited(page, lane, { tool: 'close', note: closeNote, result: 'done' });
    await expectAudited(page, lane, { tool: 'resume', note: resumeNote, result: 'done' });
    await expect(page.locator('tbody tr').filter({ hasText: resumeNote })).toContainText('keyConfirmed: true');
  });

  test('more transactions on the network than the relayer sent: Set the next slot number, pre-filled from the network', async ({ page, lane }, info) => {
    await scenario(lane, 'foreign-transactions');
    await signIn(page, lane, 'staff', DETAIL);
    const now = nowPanel(page);
    await expect(now.locator('.explain-why')).toHaveText('The network shows more transactions from the relayer’s wallet than the relayer sent: someone else is using its key.');
    await expect(now.locator('.explain-steps li').first()).toHaveText(LEAK_FIRST_STEP);
    await expect(page.locator('main')).not.toContainText('Send at least');
    await page.getByText('Advanced: rarely needed').click();
    const adopt = tool(page, 'Set the next slot number');
    await expect(adopt).toContainText('The network says the next slot number is 2.');
    await expect(adopt.locator('[name="slot"]')).toHaveValue('2');
    const note = n('Engineer replaced the key; the network says the next slot is 2');
    await adopt.locator('[name="note"]').fill(note);
    await adopt.getByRole('button', { name: 'Set the number', exact: true }).click();
    await expect(adopt.getByRole('group', { name: 'Confirm: Set the number' })).toContainText('Set the relayer’s next slot number to 2? It can never go back down.');
    await shot(page, info, 'tool-set-number-confirm');
    await adopt.getByRole('group', { name: 'Confirm: Set the number' }).getByRole('button', { name: 'Set the number' }).click();
    await expectAnswer(page, 'Set the next slot number: done', 'The relayer’s next slot is now 2. Press Resume when the engineer says so.');
    await shot(page, info, 'tool-set-number-result');
    await useTool(tool(page, 'Resume'), { button: 'Resume', note: n('Engineer says the key is replaced'), confirm: 'on the engineer’s word', fill: (f) => f.locator('[name="keyConfirmed"]').check() });
    await expectAnswer(page, 'Resume: done', 'Free network fees are running again.');
    await expectStaffLog(lane, [
      ['resume', true, null],
      ['adopt_nonce', true, null],
    ]);
    expect((await laneState(lane)).nextSlot).toBe(2);
    await expectAudited(page, lane, { tool: 'adopt_nonce', note, result: 'done' });
  });

  test('an empty slot holds the rest up: Fill a gap at the slot the relayer found, then Resume', async ({ page, lane }) => {
    await scenario(lane, 'gap');
    await signIn(page, lane, 'staff', DETAIL);
    const now = nowPanel(page);
    await expect(now.locator('.explain-why')).toHaveText('Slot 0 is empty and nothing is waiting to fill it, so every transaction after it is stuck. Only someone else using the relayer’s key leaves a gap like this.');
    await expect(now.locator('.explain-steps li').first()).toHaveText(LEAK_FIRST_STEP);
    await expect(slotRow(page, 1)).toContainText('Check-in demo');
    await page.getByText('Advanced: rarely needed').click();
    const fill = tool(page, 'Fill a gap');
    await expect(fill.locator('[name="slot"]')).toHaveValue('0');
    await expect(fill).toContainText('The empty slot the relayer found: 0.');
    const note = n('Slot 0 is empty after a transaction we did not send');
    await useTool(fill, { button: 'Fill the gap', note, confirm: 'Fill slot 0 with a harmless empty transfer? It costs a small network fee from the relayer wallet.' });
    await expectAnswer(page, 'Fill a gap: done', 'A harmless empty transfer was sent for slot 0.');
    // Time passes: the filler and the check-in behind it are on the network.
    await laneRun(lane, 2);
    await page.reload();
    await expect(page.locator('main')).toContainText('Nothing is waiting: every transaction is on the network.');
    await useTool(tool(page, 'Resume'), { button: 'Resume', note: n('Gap filled; engineer checked the key'), confirm: 'on the engineer’s word', fill: (f) => f.locator('[name="keyConfirmed"]').check() });
    await expectAnswer(page, 'Resume: done', 'Free network fees are running again.');
    await expectStaffLog(lane, [
      ['resume', true, null],
      ['fill', true, null],
    ]);
    await expectAudited(page, lane, { tool: 'fill', note, result: 'done' });
  });

  test('a stale page or a second tab: the relayer changed, so nothing is done and the page reads it again', async ({ page, context, lane, watch }) => {
    watch.allow(/Failed to load resource: the server responded with a status of 409/u);
    await scenario(lane, 'out-of-money');
    await scenario(lane, 'refill');
    await signIn(page, lane, 'staff', DETAIL);
    const other = await context.newPage();
    await other.goto(`${lane}${DETAIL}`);
    await useTool(tool(other, 'Resume'), { button: 'Resume', note: n('Resumed from the second tab after the refill'), confirm: 'Resume free network fees?' });
    await expectAnswer(other, 'Resume: done', 'Free network fees are running again.');
    // The first tab still shows the pause it read: its Resume reaches the relayer, which refuses it unseen.
    await useTool(tool(page, 'Resume'), { button: 'Resume', note: n('Resumed from the first tab, which is out of date'), confirm: 'Resume free network fees?' });
    await expectAnswer(page, 'Resume: Someone changed this first', 'Reload the page to see the latest version, then try again. The page has been read again.');
    await expect(nowPanel(page)).toContainText('Working');
    await expectStaffLog(lane, [['resume', true, null]]);
    await expectAudited(page, lane, { tool: 'resume', note: n('Resumed from the first tab, which is out of date'), result: 'stale_page' });
  });

  test('Feed and notices and Security & monitoring: the sponsorship’s security events in words, each with its playbook', async ({ page, lane, watch }, info) => {
    // The stack runs no watchdog: Security & monitoring's watchdog reads answer 503 (said on the page), expected here.
    watch.allow(/Failed to load resource: the server responded with a status of 503/u);
    await scenario(lane, 'out-of-money');
    const eventsOf = (heading: string) => page.locator('.panel', { has: page.getByRole('heading', { name: heading, exact: true }) }).locator('tbody tr');
    for (const [path, heading] of [
      ['/security', 'Security events not yet emailed'],
      ['/security/monitoring', 'Security events'],
    ] as const) {
      await signIn(page, lane, 'staff', path);
      const events = eventsOf(heading);
      for (const [kind, words, playbook] of [
        ['evm_relay_stuck', 'Free network fees: paused or slow, needs a look', 'Free network fees are paused or slow'],
        ['evm_relay_balance_low', 'Free network fees: the paying account is running low', 'The free network fees wallet is running low'],
      ] as const) {
        const row = events.filter({ hasText: kind }).first();
        await expect(row, `${path} ${kind}`).toContainText(words);
        await expect(row.getByRole('link'), `${path} ${kind}`).toHaveText(playbook);
      }
      if (path === '/security/monitoring') await shot(page, info, 'security-monitoring-events');
    }
    const link = eventsOf('Security events').filter({ hasText: 'evm_relay_stuck' }).first().getByRole('link');
    const title = (await link.textContent())!.trim();
    await link.click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  });
});

test.describe('the usage ledger (PGlite, as role usage_admin)', () => {
  test('the pages that read the ledger work: the feeds’ positions, the month’s rates, the retention job', async ({ page, lane }) => {
    await signIn(page, lane, 'staff', '/security');
    await expect(page.getByRole('heading', { name: 'Feed and notices', level: 1 })).toBeVisible();
    await expect(page.getByText('The admin’s own state couldn’t be read')).toHaveCount(0);
    const feeds = page.locator('.panel', { has: page.getByRole('heading', { name: 'Feeds', exact: true }) });
    await expect(feeds.locator('tbody tr')).toHaveCount(2);
    await expect(feeds).toContainText('Caught up');
    await page.goto(`${lane}/rates`);
    await expect(page.getByRole('heading', { name: 'NEAR/USD rates', level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText('Days without a rate');
    await page.goto(`${lane}/retention`);
    await expect(page.getByRole('heading', { name: 'Retention', level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText(/No run of \d{4}-\d{2} has completed yet\./u);
    for (const [path, heading] of [
      ['/reports', 'Usage reports'],
      ['/statements', 'Monthly statements'],
    ]) {
      await page.goto(`${lane}${path}`);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.locator('main')).not.toContainText('The usage ledger isn’t available');
    }
  });
});

test.describe('the support pages, staff side (D866)', () => {
  test('a staff unlock and unsuppress through the email issuer’s staff routes are in the admin audit log, with who and the ticket', async ({ page, lane }, info) => {
    // Support calls the issuer's admin/unlock with their Access token (docs/operations.md "Staff calls"): there is no
    // admin page for it. The stack's /__e2e/staff makes that call with a stand-in token for the staff member.
    const email = `e2eadmin${info.project.name}${crypto.randomUUID().slice(0, 8)}@gmail.com`;
    const ticket = `SUP-${crypto.randomUUID().slice(0, 6)}`;
    for (const action of ['unlock', 'unsuppress']) {
      const r = await fetch(`${ISSUER_URL}/__e2e/staff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, email, ticket }) });
      expect(r.status, action).toBe(200);
    }
    await signIn(page, lane, 'staff', `/audit?dirStaff=${encodeURIComponent(STAFF)}`);
    const rows = page.locator('tbody tr').filter({ hasText: ticket });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Unsuppress' })).toContainText(STAFF);
    await expect(rows.filter({ hasText: /Unlock/u })).toContainText(STAFF);
    // The filter by action, as staff use it.
    await page.goto(`${lane}/audit?dirAction=unlock&dirStaff=${encodeURIComponent(STAFF)}`);
    await expect(page.locator('tbody tr').filter({ hasText: ticket })).toHaveCount(1);
  });
});
