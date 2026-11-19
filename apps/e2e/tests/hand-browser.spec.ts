// The hand-test browser (D880, src/hand-test.ts) driven headless through the steps docs/operations.md "Trying sign-ins
// and NEAR actions by hand" gives a person, by the labels a person reads: the same context setup, start page, test
// accounts and helpers as `pnpm --filter @hana-id/e2e hand-browser`, on the running stack. Each test opens its own hand
// session (a context of the test's browser) with accounts of its own tag. Chromium only: the hand browser is Chromium.
import type { Browser, Page } from '@playwright/test';
import { type HandAccount, type HandAccountId, type HandSession, HAND_START_URL, chooserLabel, latestCode, openHandSession } from '../src/hand-test.ts';
import { AUTH_ORIGIN, DEMO_ORIGIN, STAMPS_ORIGIN } from '../src/stack.ts';
import { approve, expect, test } from './fixtures.ts';

test.skip(({ browserName }) => browserName !== 'chromium', 'the hand browser is Chromium');

interface Hand extends HandSession {
  lines: string[];
  who(id: HandAccountId): HandAccount;
}

async function openHand(browser: Browser): Promise<Hand> {
  const lines: string[] = [];
  const s = await openHandSession(browser, { viewport: { width: 1280, height: 860 }, log: (l) => lines.push(l) });
  return { ...s, lines, who: (id) => s.accounts.find((a) => a.id === id)! };
}

/** A popup the click opens. */
async function popupOf(page: Page, click: () => Promise<void>): Promise<Page> {
  const p = page.waitForEvent('popup');
  await click();
  return p;
}

/** In the pretend Google's "Choose an account": the account, as a person picks it. */
async function choose(popup: Page, a: HandAccount): Promise<void> {
  await expect(popup.getByRole('heading', { name: 'Choose an account' })).toBeVisible();
  await popup.getByRole('link', { name: chooserLabel(a) }).click();
}

/** When the newest code mail to `address` was sent (0: none yet). */
const lastSent = async (address: string): Promise<number> => (await latestCode(address))?.atMs ?? 0;

/**
 * Once a code newer than `since` was mailed to `a`: the start page's "Show the latest code", read as a person reads it.
 * (The issuer may mail the same code again while it is valid, so "newer" is by the time sent.)
 */
async function codeFromStart(h: Hand, a: HandAccount, since: number): Promise<string> {
  await expect.poll(() => lastSent(a.email), { timeout: 15_000 }).toBeGreaterThan(since);
  const row = h.start.locator(`tr[data-account="${a.id}"]`);
  await row.getByRole('button', { name: 'Show the latest code' }).click();
  await expect(row.getByRole('status')).toHaveText(new RegExp(`^Latest code for ${a.email.replace(/[.]/gu, '\\.')}: \\d{6} \\(sent `, 'u'));
  return /: (\d{6}) \(sent/u.exec((await row.getByRole('status').textContent()) ?? '')![1]!;
}

/** The email step in a window: the address, Send code, the code from the start page, Continue. */
async function emailCode(h: Hand, page: Page, a: HandAccount): Promise<void> {
  await page.getByLabel('Email address').fill(a.email);
  const since = await lastSent(a.email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('Code')).toBeVisible();
  await page.getByLabel('Code').fill(await codeFromStart(h, a, since));
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** A second code on a window already past the email step (Cancel this link, Remove it): sent by `click`. */
async function nextCode(h: Hand, popup: Page, a: HandAccount, click: () => Promise<void>): Promise<void> {
  const since = await lastSent(a.email);
  await click();
  await expect(popup.getByLabel('Code')).toBeVisible();
  await popup.getByLabel('Code').fill(await codeFromStart(h, a, since));
  await popup.getByRole('button', { name: 'Continue' }).click();
}

async function openDemo(h: Hand): Promise<Page> {
  const demo = await h.context.newPage();
  await demo.goto(`${DEMO_ORIGIN}/`);
  await expect(demo.locator('#status')).toHaveText('Signed out.');
  return demo;
}

async function demoGoogle(demo: Page, a: HandAccount): Promise<Page> {
  const popup = await popupOf(demo, () => demo.getByRole('button', { name: 'Sign in with Google' }).click());
  await choose(popup, a);
  return popup;
}

async function signOut(demo: Page): Promise<void> {
  await demo.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(demo.locator('#status')).toHaveText('Signed out.');
}

const closes = (p: Page) => (p.isClosed() ? Promise.resolve() : p.waitForEvent('close', { timeout: 20_000 }).then(() => undefined));

/**
 * Case B, waiting: a Google sign-in on the demo (the Google wallet), Sign out, Sign in with email with the same
 * address, Link and continue, the same account again, Done. Ends signed in to the Google wallet.
 */
async function waitingLink(h: Hand, demo: Page, a: HandAccount): Promise<void> {
  const first = await demoGoogle(demo, a);
  await closes(first);
  await expect(demo.locator('#status')).toContainText('Signed in');
  await signOut(demo);
  const popup = await popupOf(demo, () => demo.getByRole('button', { name: 'Sign in with email' }).click());
  await emailCode(h, popup, a);
  await expect(popup.getByText('This email belongs to a wallet you created by signing in with Google.')).toBeVisible();
  await popup.getByRole('button', { name: 'Link and continue' }).click();
  await choose(popup, a);
  await expect(popup.locator('#link-banners')).toContainText('will be able to open this wallet from');
  await expect(popup.getByRole('button', { name: 'Cancel this link' })).toBeVisible();
  const closed = closes(popup);
  await popup.getByRole('button', { name: 'Done' }).click();
  await closed;
  await expect(demo.locator('#status')).toContainText('Signed in');
}

/** Passport Home, signed in with `a`'s Google account (or its address, by email), on the demo's "Ways to sign in". */
async function homeList(h: Hand, a: HandAccount, by: 'google' | 'email' = 'google'): Promise<Page> {
  const home = await h.context.newPage();
  await home.goto(`${AUTH_ORIGIN}/home`);
  if (by === 'google') {
    const child = await popupOf(home, () => home.getByRole('button', { name: 'Continue with Google' }).click());
    await choose(child, a);
  } else {
    await home.getByRole('button', { name: 'Continue with email' }).click();
    await emailCode(h, home, a);
  }
  await home.getByRole('button', { name: 'View Journear demo' }).click();
  await expect(home.getByRole('heading', { name: 'Ways to sign in' })).toBeVisible();
  await home.getByRole('button', { name: 'Show ways to sign in' }).click();
  return home;
}

const rows = (home: Page) => home.locator('#home-sign-ins-list > li');

async function showAgain(home: Page): Promise<void> {
  await home.bringToFront();
  await home.getByRole('button', { name: 'Show again' }).click();
}

test('the start page, a Google sign-in with a named account, and a guestbook write; closing every window ends the session', async ({ browser }) => {
  test.setTimeout(120_000);
  const h = await openHand(browser);
  expect(h.start.url()).toBe(HAND_START_URL);
  await expect(h.start.getByRole('heading', { name: 'Journear hand test' })).toBeVisible();
  for (const a of h.accounts) await expect(h.start.locator(`tr[data-account="${a.id}"]`)).toContainText(a.email);
  // The hosted demo from its link on the start page (a new tab).
  const demoP = h.context.waitForEvent('page');
  await h.start.getByRole('link', { name: `${DEMO_ORIGIN}/` }).click();
  const demo = await demoP;
  await expect(demo.locator('#status')).toHaveText('Signed out.');
  const finn = h.who('finn');
  const popup = await demoGoogle(demo, finn);
  await closes(popup);
  await expect(demo.locator('#status')).toContainText('Signed in');
  const text = `gm from the hand browser ${h.tag}`;
  await demo.getByLabel('Your message').fill(text);
  await expect(demo.locator('#near-balance')).toHaveText('Balance: 0 NEAR. The guestbook write needs none.');
  const approval = await popupOf(demo, () => demo.getByRole('button', { name: 'Write to the guestbook (no NEAR needed)' }).click());
  await approve(approval);
  await expect(demo.locator('#near-done-text')).toHaveText('Written to the guestbook on NEAR testnet. Your NEAR account was created for it. You paid no gas.');
  await expect(demo.locator('#near-messages li', { hasText: text }).locator('.you')).toHaveText('you');
  expect(h.relay.guestbook).toEqual([text]);
  expect(h.relay.problems).toEqual([]);
  expect(h.lines.some((l) => l.startsWith('NEAR relay (demo): guestbook: '))).toBe(true);
  expect(h.lines.filter((l) => l.includes('CSP violation') || l.startsWith('page error'))).toEqual([]);
  // Closing every window ends it, as the person's closing the browser does.
  for (const p of h.context.pages()) await p.close();
  expect(await h.closed).toBe('windows-closed');
});

test('the stamps site: Google sign-in and Arrival through the relay', async ({ browser }) => {
  test.setTimeout(120_000);
  const h = await openHand(browser);
  const stamps = await h.context.newPage();
  await stamps.goto(`${STAMPS_ORIGIN}/`);
  const popup = await popupOf(stamps, () => stamps.getByRole('button', { name: 'Sign in', exact: true }).click());
  await popup.getByRole('button', { name: 'Continue with Google' }).click();
  await choose(popup, h.who('finn'));
  await expect(stamps.locator('[data-mode="mine"]')).toBeVisible();
  const approval = await popupOf(stamps, () => stamps.locator('[data-stamp="arrival"]').getByRole('button', { name: 'Collect' }).click());
  await approve(approval);
  await expect(stamps.locator('[data-stamp="arrival"]')).toHaveAttribute('data-status', 'collected', { timeout: 30_000 });
  await expect(stamps.locator('[data-role="notice"]')).toContainText('Arrival stamped on NEAR’s test network.');
  expect(h.relay.stamps).toEqual([{ stamp: 'arrival' }]);
  expect(h.relay.problems).toEqual([]);
  await h.context.close();
});

test('case B waiting, cancelled from a Google sign-in (D864), with Passport Home’s list at each stage (D874)', async ({ browser }) => {
  test.setTimeout(180_000);
  const h = await openHand(browser);
  const ben = h.who('ben');
  const demo = await openDemo(h);
  const first = await demoGoogle(demo, ben);
  await closes(first);
  await expect(demo.locator('#status')).toContainText('Signed in');
  const home = await homeList(h, ben);
  await expect(rows(home)).toHaveCount(1);
  await expect(rows(home).first()).toContainText('You’re signed in with this now');

  await demo.bringToFront();
  await signOut(demo);
  const popup = await popupOf(demo, () => demo.getByRole('button', { name: 'Sign in with email' }).click());
  await emailCode(h, popup, ben);
  await expect(popup.getByText('This email belongs to a wallet you created by signing in with Google.')).toBeVisible();
  await popup.getByRole('button', { name: 'Link and continue' }).click();
  await choose(popup, ben);
  await expect(popup.locator('#link-banners')).toContainText('will be able to open this wallet from');
  const done = closes(popup);
  await popup.getByRole('button', { name: 'Done' }).click();
  await done;

  await showAgain(home);
  await expect(rows(home)).toHaveCount(2);
  await expect(rows(home).nth(1)).toContainText('Another email address');
  await expect(rows(home).nth(1)).toContainText('Waiting');
  await expect(rows(home).nth(1)).toContainText('choose Cancel this link');

  await demo.bringToFront();
  await signOut(demo);
  const again = await demoGoogle(demo, ben);
  await expect(again.getByRole('button', { name: 'Cancel this link' })).toBeVisible();
  const cancelled = closes(again);
  await again.getByRole('button', { name: 'Cancel this link' }).click();
  await cancelled;
  await expect(demo.locator('#status')).toContainText('Signed in');

  await showAgain(home);
  await expect(rows(home)).toHaveCount(1);
  await h.context.close();
});

test('case B waiting, cancelled from the email’s own sign-in (D864)', async ({ browser }) => {
  test.setTimeout(180_000);
  const h = await openHand(browser);
  const cleo = h.who('cleo');
  const demo = await openDemo(h);
  await waitingLink(h, demo, cleo);
  await signOut(demo);
  const popup = await popupOf(demo, () => demo.getByRole('button', { name: 'Sign in with email' }).click());
  await emailCode(h, popup, cleo);
  await expect(popup.getByRole('heading', { name: 'A Google account is being linked to this email' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Keep the link' })).toBeVisible();
  await expect(popup.locator('#link-waiting-what')).toContainText('The link starts working on');
  await nextCode(h, popup, cleo, () => popup.getByRole('button', { name: 'Cancel this link' }).click());
  await expect(popup.getByRole('heading', { name: 'Link cancelled' })).toBeVisible();
  const closed = closes(popup);
  await popup.getByRole('button', { name: 'Close' }).click();
  await closed;
  const home = await homeList(h, cleo);
  await expect(rows(home)).toHaveCount(1);
  await h.context.close();
});

test('a waiting link made to take effect, the shared-wallet question and Remove (D865), Passport Home before and after', async ({ browser }) => {
  test.setTimeout(180_000);
  const h = await openHand(browser);
  const dev = h.who('dev');
  const demo = await openDemo(h);
  await waitingLink(h, demo, dev);
  const row = h.start.locator('tr[data-account="dev"]');
  await row.getByRole('button', { name: 'Make its waiting link take effect' }).click();
  await expect(row.getByRole('status')).toHaveText('Done: Dev’s waiting link works now.');
  const home = await homeList(h, dev);
  await expect(rows(home)).toHaveCount(2);
  await expect(rows(home).nth(1)).toContainText('Opens this wallet since');

  await demo.bringToFront();
  await signOut(demo);
  const popup = await popupOf(demo, () => demo.getByRole('button', { name: 'Sign in with email' }).click());
  await emailCode(h, popup, dev);
  await expect(popup.getByRole('heading', { name: 'This email now also opens another wallet' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Not now' })).toBeVisible();
  await popup.getByRole('button', { name: 'Remove this email' }).click();
  await expect(popup.getByRole('heading', { name: 'Remove this email from that wallet?' })).toBeVisible();
  await nextCode(h, popup, dev, () => popup.getByRole('button', { name: 'Remove it' }).click());
  await expect(popup.getByRole('heading', { name: 'This email was removed' })).toBeVisible();
  const closed = closes(popup);
  await popup.getByRole('button', { name: 'Close' }).click();
  await closed;
  await expect(demo.getByRole('alert')).toHaveText('Sign-in cancelled.');
  await showAgain(home);
  await expect(rows(home)).toHaveCount(1);
  await h.context.close();
});

test('the automatic same-address link (case A)', async ({ browser }) => {
  test.setTimeout(150_000);
  const h = await openHand(browser);
  const ada = h.who('ada');
  const demo = await openDemo(h);
  const popup = await popupOf(demo, () => demo.getByRole('button', { name: 'Sign in with email' }).click());
  const closed = closes(popup);
  await emailCode(h, popup, ada);
  await closed;
  await expect(demo.locator('#status')).toContainText('Signed in');
  const evm = await demo.locator('#evm-address').textContent();
  await signOut(demo);
  const google = await demoGoogle(demo, ada);
  await expect(google.locator('#link-banners')).toContainText('Your Google sign-in now opens this wallet too');
  const done = closes(google);
  await google.getByRole('button', { name: 'Done' }).click();
  await done;
  await expect(demo.locator('#status')).toContainText('Signed in');
  await expect(demo.locator('#evm-address')).toHaveText(evm ?? '');
  const home = await homeList(h, ada, 'email');
  await expect(rows(home)).toHaveCount(2);
  await expect(rows(home).nth(1)).toContainText('Added automatically at a sign-in, because this Google account uses the same email address as this wallet.');
  await h.context.close();
});

test('an added sign-in 8 days old: Home’s line, the quiet line with Done, not shown again, then after Forget, Remove (D875)', async ({ browser }) => {
  test.setTimeout(200_000);
  const h = await openHand(browser);
  const eve = h.who('eve');
  const demo = await openDemo(h);
  await waitingLink(h, demo, eve);
  const row = h.start.locator('tr[data-account="eve"]');
  await row.getByRole('button', { name: 'Make its link 8 days old' }).click();
  await expect(row.getByRole('status')).toHaveText('Done: the sign-in added to Eve’s wallet now opens it since 8 days ago.');
  const home = await homeList(h, eve);
  await expect(rows(home)).toHaveCount(2);
  await expect(rows(home).nth(1)).toContainText('Once you press Done in the sign-in window, that browser stops offering Remove.');

  await demo.bringToFront();
  await signOut(demo);
  const first = await demoGoogle(demo, eve);
  await expect(first.locator('#link-older')).toContainText('An email address also opens this wallet, since');
  await expect(first.getByRole('button', { name: 'Remove' })).toBeVisible();
  const done = closes(first);
  await first.getByRole('button', { name: 'Done' }).click();
  await done;
  await expect(demo.locator('#status')).toContainText('Signed in');
  await signOut(demo);
  // Not shown again in this browser: the window closes by itself.
  const second = await demoGoogle(demo, eve);
  await closes(second);
  await expect(demo.locator('#status')).toContainText('Signed in');
  await signOut(demo);

  await h.start.bringToFront();
  await h.start.getByRole('button', { name: 'Forget “Done” in this browser' }).click();
  await expect(h.start.locator('#forget-result')).toHaveText('Done: this browser has forgotten it. The next sign-in shows the line again.');
  const third = await demoGoogle(demo, eve);
  const removed = closes(third);
  await third.getByRole('button', { name: 'Remove' }).click();
  await removed;
  await showAgain(home);
  await expect(rows(home)).toHaveCount(1);
  await h.context.close();
});
