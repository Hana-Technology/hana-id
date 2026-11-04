// The app's logo, vault side (batch C11): the vault passes GET /v1/app's `logoUrl` to the login popup (auth-params),
// the approval popup (approve-request, consent-request) and the export window (export-context), only when it is this
// app's logo on the build's files origin, and sends no field otherwise (the messages older pages take).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HanaEnv } from '../../src/hana-env.ts';
import { APP_ID, Browser, ENV, type Google, type Tab, answer, google, login, openApproval, readyTab, waitLauncher } from './harness.ts';

const FILES = 'https://files.test';
const LOGO = `${FILES}/logos/${APP_ID}/${'5a'.repeat(32)}.png`;
const FILES_ENV: HanaEnv = { ...ENV, filesOrigin: FILES };

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function session(logoUrl: unknown, env: HanaEnv = FILES_ENV) {
  const browser = new Browser();
  browser.backend.app = { ...browser.backend.app, ...(logoUrl === undefined ? {} : { logoUrl }) };
  const t = await readyTab(browser, { googleJwk: g.jwk, env });
  tabs.push(t);
  const { run } = await login(t, g);
  return { t, params: run.params };
}

/** What the vault sends the approval popup and the export window for this session. */
async function windows(t: Tab): Promise<{ approve: Record<string, unknown>; exportContext: Record<string, unknown> }> {
  const reply = t.request('stellar_signMessage', { message: 'hi' });
  await waitLauncher(t, 'Review in Hana');
  const popup = openApproval(t);
  const approve = await popup.next('hana:approve-request');
  answer(t, popup, approve, false);
  await reply;
  const exporting = t.request('hana_export', { chain: 'stellar' });
  await waitLauncher(t, 'Export key in Hana');
  t.launcher.click();
  const w = t.opened.at(-1)!;
  t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, source: w });
  const exportContext = await w.next('hana:export-context');
  await exporting;
  return { approve, exportContext };
}

describe('the app’s logo (vault side, batch C11)', () => {
  it('passes GET /v1/app’s logo on the files origin to the login, approval and export windows', async () => {
    const { t, params } = await session(LOGO);
    expect(params.logoUrl).toBe(LOGO);
    const { approve, exportContext } = await windows(t);
    expect(approve.logoUrl).toBe(LOGO);
    expect(exportContext.logoUrl).toBe(LOGO);
  });

  it.each([
    ['no logo (null)', null, FILES_ENV],
    ['an older API (no field)', undefined, FILES_ENV],
    ['another origin', `https://cdn.partner.example/logos/${APP_ID}/${'5a'.repeat(32)}.png`, FILES_ENV],
    ['another app’s logo', `${FILES}/logos/app_other/${'5a'.repeat(32)}.png`, FILES_ENV],
    ['not a logo URL', `${LOGO}?v=2`, FILES_ENV],
    ['a build without a files origin', LOGO, ENV],
  ])('sends no logoUrl for %s, and the login still works', async (_, logoUrl, env) => {
    const { t, params } = await session(logoUrl, env);
    expect(params).not.toHaveProperty('logoUrl');
    const { approve, exportContext } = await windows(t);
    expect(approve).not.toHaveProperty('logoUrl');
    expect(exportContext).not.toHaveProperty('logoUrl');
  });
});
