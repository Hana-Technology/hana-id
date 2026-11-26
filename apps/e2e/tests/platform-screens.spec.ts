// The partner platform's screens end to end (D930; docs/partner-platform-spec.md piece P5's e2e run) in each browser's
// admin lane: the staff portal (apps/admin's real Worker and SPA) and the partner console (apps/console's real Worker
// and SPA, src/server/lane-console.ts) over one copy of the API, with the lane standing in for the network's backend and
// the email provider (src/server/lane-platform.ts).
//
// The run: staff register the network's key in the admin portal; the network's owner accepts it in the partner
// console with a fresh sign-in; the admin Worker's real notice step announces it (in force at once: the acceptance
// counts as its confirmation); the platform switch goes on; the network's backend creates an app with two web
// addresses; the notice step sends ONE email per recipient for that request, both addresses with their own cancel
// links, the real 24 hours and no waiver; staff see both in the Platform queue; the console shows the app as made by
// the backend with the addresses it asked for; one is cancelled from its emailed link; the queue then shows the other.
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

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
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

test('a key registered by staff, accepted by the owner; the backend’s app and its web addresses: one email, the queue, cancel from the link', async ({ page, lane }, info) => {
  test.setTimeout(150_000);
  const origin = consoleOf(info);
  const net = await platform<{ orgId: string; scopeId: string; publicKey: string }>(lane, { action: 'reset' });
  await platform(lane, { action: 'notices' }); // anything the lane left waiting goes out first

  // The owner signs in to the console once (the lane makes them the org's owner then).
  await page.goto(`${origin}/__e2e/console/sign-in?to=${encodeURIComponent(`/orgs/${net.orgId}/platform-keys`)}`);
  await expect(page.getByRole('heading', { name: 'Platform keys', level: 1 })).toBeVisible();

  // Staff register the key in the admin portal (after checking its fingerprint with the network).
  await signIn(page, lane, 'staff', `/orgs/${net.orgId}`);
  const keys = page.locator('#platform');
  await keys.getByLabel('Label', { exact: true }).fill('Coffee network backend');
  await keys.getByLabel('Scopes (one or two)').fill(net.scopeId);
  await keys.getByLabel('Public key (PEM or JWK)').fill(net.publicKey);
  await keys.getByLabel('How you checked it with the network').last().fill('Fingerprint read back by phone with the network’s CTO');
  await keys.getByRole('button', { name: 'Register the key' }).click();
  await expect(page.getByText(/Key registered: it waits for an owner of each scope to accept it/u)).toBeVisible();

  // The owner accepts it in the console with a fresh sign-in.
  await page.goto(`${origin}/orgs/${net.orgId}/platform-keys`);
  await page.getByRole('link', { name: 'Coffee network backend' }).click();
  await expect(page.getByText('Waiting for your acceptance')).toBeVisible();
  await page.getByRole('button', { name: 'Accept with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Accept a platform key' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm with Google' }).click();
  await expect(page.getByText(/^Done\./u)).toBeVisible();

  // Announced by the real notice step: working at once (the acceptance is its confirmation).
  const announced = await platform<{ sent: Mail[] }>(lane, { action: 'notices' });
  expect(announced.sent.some((m) => m.subject.includes('New platform key registered'))).toBe(true);
  await platform(lane, { action: 'switch' });

  // The network's backend creates a partner's app with two web addresses (one request).
  const created = await platform<{ status: number; body: { app: { id: string }; changes: { changeId: string; origin: string }[] } }>(lane, {
    action: 'create',
    name: 'Coffee Club',
    origins: ['https://order.coffeeclub.example', 'https://shop.coffeeclub.example'],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const appId = created.body.app.id;
  const [a, b] = created.body.changes;

  // One email per recipient for the request: both addresses, each with its own cancel link; the real wait; no waiver.
  const { sent } = await platform<{ sent: Mail[] }>(lane, { action: 'notices' });
  const mails = sent.filter((m) => m.text.includes(a!.changeId) || m.text.includes(b!.changeId));
  expect(mails.length).toBeGreaterThanOrEqual(2);
  expect(new Set(mails.map((m) => m.to)).size).toBe(mails.length);
  for (const m of mails) {
    expect(m.subject).toContain('New web addresses requested by your platform key for Coffee Club');
    expect(m.text).toContain(`/cancel/${a!.changeId}#t=`);
    expect(m.text).toContain(`/cancel/${b!.changeId}#t=`);
    expect(m.text).toContain('24 hours after this email');
    expect(m.text).not.toMatch(/waiver/iu);
  }
  const token = new RegExp(`/cancel/${a!.changeId}#t=([A-Za-z0-9_-]{43})`, 'u').exec(mails[0]!.text)![1]!;
  expect((await platform<{ proposals: { status: string; notified: boolean }[] }>(lane, { action: 'state' })).proposals).toEqual([
    expect.objectContaining({ status: 'pending', notified: true }),
    expect.objectContaining({ status: 'pending', notified: true }),
  ]);

  // Staff see both in the Platform queue.
  await signIn(page, lane, 'staff', '/platform-queue');
  await expect(page.getByRole('heading', { name: 'Platform queue', level: 1 })).toBeVisible();
  await expect(page.getByText(a!.origin)).toBeVisible();
  await expect(page.getByText(b!.origin)).toBeVisible();
  await shot(page, info, 'admin-platform-queue');

  // The console shows the app as made by the backend, and the addresses it asked for.
  await page.goto(`${origin}/orgs/${net.orgId}/apps/${appId}`);
  await expect(page.getByRole('heading', { name: 'Made by your backend' })).toBeVisible();
  await expect(page.getByText('your platform key “Coffee network backend”').first()).toBeVisible();
  await page.getByRole('link', { name: /^Web addresses/u }).click();
  await expect(page.getByText('Asked for by your backend').first()).toBeVisible();
  // D931: the line says it waits for an owner, or starts working on its date.
  await expect(page.getByText(/Waiting for an owner to confirm, or starts working on/u).first()).toBeVisible();
  await shot(page, info, 'console-app-web-addresses');

  // Cancelled from the email's link (on the console's origin), with no sign-in needed; a GET alone changes nothing.
  await page.goto(`${origin}/cancel/${a!.changeId}#t=${token}`);
  await expect(page.getByRole('button', { name: 'Cancel this change' })).toBeVisible();
  expect((await platform<{ proposals: { id: string; status: string }[] }>(lane, { action: 'state' })).proposals.find((p) => p.id === a!.changeId)!.status).toBe('pending');
  await page.getByRole('button', { name: 'Cancel this change' }).click();
  await expect(page.getByText('Cancelled.')).toBeVisible();
  expect((await platform<{ proposals: { id: string; status: string }[] }>(lane, { action: 'state' })).proposals.find((p) => p.id === a!.changeId)!.status).toBe('cancelled');

  // The queue now holds the other one only; the console's activity lists the backend's create.
  await signIn(page, lane, 'staff', '/platform-queue');
  await expect(page.getByText(b!.origin)).toBeVisible();
  await expect(page.getByText(a!.origin)).toHaveCount(0);
  await page.goto(`${origin}/orgs/${net.orgId}/platform-activity`);
  await expect(page.getByRole('cell', { name: 'Coffee Club' })).toBeVisible();
  await expect(page.getByText('Create an app').first()).toBeVisible();
  await shot(page, info, 'console-platform-activity');
});
