// An owner's confirmation of web addresses end to end (D931; docs/partner-platform-spec.md piece P10's e2e run) in each
// browser's admin lane: the staff portal (apps/admin's real Worker and SPA) and the partner console (apps/console's real
// Worker and SPA, src/server/lane-console.ts) over one copy of the API, with the lane standing in for the network's
// backend and the email provider (src/server/lane-platform.ts), as tests/platform-screens.spec.ts sets them up.
//
// The run: a network's key registered by staff and accepted by the owner (as P5's run); the network's backend creates
// an app with two web addresses; the admin Worker's real notice step sends the request's email to the owner too, with
// the "or sooner if an owner … confirms" line and the Check and confirm link; the owner opens that link in the console,
// ticks one of the two, presses Confirm and confirms with a fresh Google sign-in; that web address passes the API's own
// gate at once (the other still waits); the notice step sends the confirmation's notice with its removal link; the
// link's page removes it (opening it alone changes nothing) and it stops at once. A viewer of the organisation sees the
// same page with no tick box and no Confirm.
//
// With HANA_SHOTS_DIR=<dir> (Chromium only) the run saves screenshots at 390 and 1280 px, light.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { CONSOLE_LANES } from '../src/stack.ts';
import { expect, signIn, test } from './admin-fixtures.ts';

test.describe.configure({ mode: 'default' });

const SHOTS = process.env.HANA_SHOTS_DIR;
const consoleOf = (info: TestInfo): string => (CONSOLE_LANES as Record<string, { origin: string }>)[info.project.name]!.origin;
/** The lane org's owner's console address (src/server/lane-console.ts `LANE_CONSOLE_EMAIL`). */
const OWNER_EMAIL = 'owner@stamp-rally.e2e.invalid';

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
interface Proposal {
  id: string;
  origin: string;
  status: string;
  notified: boolean;
  activeFrom: number | null;
}

async function platform<T>(lane: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${lane}/__e2e/lane/platform`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  expect(res.status, `platform ${String(body.action)}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  if (!SHOTS || info.project.name !== 'chromium') return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'phone']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: join(SHOTS, `e2e-${name}-${tag}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('a platform request’s email, an owner’s confirmation with a fresh sign-in, at once; its notice and the removal link; a viewer can’t confirm', async ({ page, lane }, info) => {
  test.setTimeout(180_000);
  const origin = consoleOf(info);
  const net = await platform<{ orgId: string; scopeId: string; publicKey: string }>(lane, { action: 'reset' });
  await platform(lane, { action: 'notices' }); // anything the lane left waiting goes out first

  // The owner signs in to the console once (the lane makes them the org's owner then: a recipient of its emails).
  await page.goto(`${origin}/__e2e/console/sign-in?to=${encodeURIComponent(`/orgs/${net.orgId}/platform-keys`)}`);
  await expect(page.getByRole('heading', { name: 'Platform keys', level: 1 })).toBeVisible();

  // The network's key, as P5's run: registered by staff, accepted by the owner, announced, the switch on.
  await signIn(page, lane, 'staff', `/orgs/${net.orgId}`);
  const keys = page.locator('#platform');
  await keys.getByLabel('Label', { exact: true }).fill('Coffee network backend');
  await keys.getByLabel('Scopes (one or two)').fill(net.scopeId);
  await keys.getByLabel('Public key (PEM or JWK)').fill(net.publicKey);
  await keys.getByLabel('How you checked it with the network').last().fill('Fingerprint read back by phone with the network’s CTO');
  await keys.getByRole('button', { name: 'Register the key' }).click();
  await expect(page.getByText(/Key registered: it waits for an owner of each scope to accept it/u)).toBeVisible();
  await page.goto(`${origin}/orgs/${net.orgId}/platform-keys`);
  await page.getByRole('link', { name: 'Coffee network backend' }).click();
  await page.getByRole('button', { name: 'Accept with Google' }).click();
  await page.getByRole('button', { name: 'Confirm with Google' }).click();
  await expect(page.getByText(/^Done\./u)).toBeVisible();
  await platform(lane, { action: 'notices' });
  await platform(lane, { action: 'switch' });

  // The network's backend creates an app with two web addresses (one request). Names of its own: the lane's Platform
  // queue lists every org's, and platform-screens.spec.ts looks for its own Coffee Club addresses there.
  const created = await platform<{ status: number; body: { app: { id: string }; publishableKey: string; changes: { changeId: string; origin: string }[] } }>(lane, {
    action: 'create',
    name: 'Tea House',
    origins: ['https://order.teahouse.example', 'https://shop.teahouse.example'],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const appId = created.body.app.id;
  const key = created.body.publishableKey;
  const [a, b] = created.body.changes;
  const gate = (o: string) => platform<{ status: number; code: string | null }>(lane, { action: 'gate', key, origin: o });
  const proposal = async (id: string): Promise<Proposal> => (await platform<{ proposals: Proposal[] }>(lane, { action: 'state' })).proposals.find((p) => p.id === id)!;
  expect(await gate(a!.origin)).toEqual({ status: 403, code: 'origin_not_allowed' });

  // The request's email: the owner among its recipients, the "or sooner" line and the Check and confirm link.
  const { sent } = await platform<{ sent: Mail[] }>(lane, { action: 'notices' });
  const mails = sent.filter((m) => m.text.includes(a!.changeId) || m.text.includes(b!.changeId));
  expect(mails.map((m) => m.to)).toContain(OWNER_EMAIL);
  const toOwner = mails.find((m) => m.to === OWNER_EMAIL)!;
  for (const m of mails) {
    expect(m.subject).toContain('New web addresses requested by your platform key for Tea House');
    expect(m.text).toContain('or sooner if an owner of your organisation confirms them');
    expect(m.text).toContain('Check and confirm in the partner portal');
  }
  const confirmId = /https:\/\/[^\s/]+\/confirm\/(gc_[A-Za-z0-9]+)\b/u.exec(toOwner.text)?.[1];
  expect([a!.changeId, b!.changeId], 'the Confirm link names one change of the request').toContain(confirmId);
  expect(toOwner.html).toContain(`/confirm/${confirmId}`);

  // The owner opens the Confirm link in the console: the request's page, both web addresses, none ticked.
  await page.goto(`${origin}/confirm/${confirmId}`);
  await expect(page).toHaveURL(`${origin}/orgs/${net.orgId}/apps/${appId}/confirm/${confirmId}`);
  await expect(page.getByRole('heading', { name: 'Confirm web addresses', level: 1 })).toBeVisible();
  await expect(page.getByText('Your backend (platform key “Coffee network backend”)')).toBeVisible();
  const boxA = page.getByRole('checkbox', { name: a!.origin });
  const boxB = page.getByRole('checkbox', { name: b!.origin });
  await expect(boxA).not.toBeChecked();
  await expect(boxB).not.toBeChecked();
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  await expect(confirm).toBeDisabled();
  // Reading the page confirms nothing.
  expect((await proposal(a!.changeId)).activeFrom).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  await boxA.check();
  await shot(page, info, 'console-confirm-page');
  await confirm.click();

  // The fresh Google sign-in: the review of exactly the ticked web address, then Google.
  await expect(page.getByRole('heading', { name: 'Confirm web addresses', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/actions\/act_/u);
  await expect(page.getByText(`Confirm ${a!.origin}`)).toBeVisible();
  await expect(page.getByText(`Confirm ${b!.origin}`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm with Google' }).click();
  await expect(page.getByText('Done: 1 web address works for Tea House now.')).toBeVisible();
  await shot(page, info, 'console-confirm-done');

  // It works at once, by the API's own gate; the other still waits.
  expect(await gate(a!.origin)).toEqual({ status: 200, code: null });
  expect(await gate(b!.origin)).toEqual({ status: 403, code: 'origin_not_allowed' });
  expect((await proposal(b!.changeId)).activeFrom).toBeGreaterThan(Date.now() + 23 * 3_600_000);

  // The Web addresses tab shows who confirmed it.
  await page.goto(`${origin}/orgs/${net.orgId}/apps/${appId}/origins`);
  await expect(page.getByText(/Confirmed on .* by an owner/u).first()).toBeVisible();

  // The confirmation's notice: who confirmed it, and its removal link (7 days).
  const notice = await platform<{ sent: Mail[] }>(lane, { action: 'notices' });
  const confirmed = notice.sent.filter((m) => m.subject.includes('Web address confirmed for Tea House'));
  expect(confirmed.map((m) => m.to)).toContain(OWNER_EMAIL);
  const n = confirmed.find((m) => m.to === OWNER_EMAIL)!;
  expect(n.text).toContain(`${OWNER_EMAIL} confirmed ${a!.origin} for Tea House.`);
  expect(n.text).toContain('The link works for 7 days.');
  expect(n.text).not.toContain(b!.origin);
  const token = new RegExp(`/remove/${a!.changeId}#t=([A-Za-z0-9_-]{43})`, 'u').exec(n.text)?.[1];
  expect(token, 'the removal link').toBeTruthy();

  // The removal link's page: opening it changes nothing; Remove stops it at once.
  await page.goto(`${origin}/remove/${a!.changeId}#t=${token}`);
  await expect(page.getByRole('heading', { name: 'Remove a web address' })).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove this web address' });
  await expect(remove).toBeVisible();
  expect(await gate(a!.origin)).toEqual({ status: 200, code: null });
  await remove.click();
  await expect(page.getByText('Removed. It stopped working straight away.')).toBeVisible();
  await shot(page, info, 'console-remove-done');
  expect(await gate(a!.origin)).toEqual({ status: 403, code: 'origin_not_allowed' });

  // A viewer of the organisation opens the same page: no tick box, no Confirm, and why.
  await page.goto(`${origin}/__e2e/console/sign-in?as=viewer&to=${encodeURIComponent(`/orgs/${net.orgId}/apps/${appId}/confirm/${b!.changeId}`)}`);
  await expect(page.getByRole('heading', { name: 'Confirm web addresses', level: 1 })).toBeVisible();
  await expect(page.getByText(b!.origin).first()).toBeVisible();
  await expect(page.getByText(/Only an owner/u)).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  await shot(page, info, 'console-confirm-viewer');
  expect((await proposal(b!.changeId)).activeFrom).toBeGreaterThan(Date.now() + 23 * 3_600_000);
});
