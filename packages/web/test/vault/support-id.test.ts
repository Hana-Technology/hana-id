// The user's Support ID in the vault (batch C15; D276 as amended by D346): taken from the API's session answer
// (/v1/login, /v1/sessions in the split flow), never derived here; kept in the record so a reload has it; reported in
// hana_status, hana_login and `ready` only to an SDK that takes the field (its hello names SUPPORT_ID_SDK_MIN or later);
// shown on the approval popup's account line; gone with the session.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SUPPORT_ID_SDK_MIN } from '@hana-id/core';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { APP_ID, Browser, ENV, type Google, HOUR, SCOPE, type Tab, answer, google, login, openApproval, readyTab, sleepReal } from './harness.ts';

const CODE = 'HANA-2750-G5HM';
const NEW_SDK = SUPPORT_ID_SDK_MIN;
const OLD_SDK = '0.1.0';
const KEY = recordKey(ENV.signer, APP_ID, SCOPE, 0);

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

async function tab(browser: Browser, o: Parameters<typeof readyTab>[1] = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, sdk: NEW_SDK, ...o });
  tabs.push(t);
  return t;
}

async function stored(browser: Browser): Promise<Record<string, unknown> | undefined> {
  return (await (await openRecordStore(browser.idb)).get(KEY)) as Record<string, unknown> | undefined;
}

const status = async (t: Tab) => (await t.request('hana_status')).result as Record<string, unknown>;

/** `NONE`: the API sends no supportId at all. */
const NONE = Symbol('none');

async function loggedIn(supportId: unknown = CODE, o: Parameters<typeof readyTab>[1] = {}) {
  const browser = new Browser();
  browser.backend.supportId = supportId === NONE ? undefined : supportId;
  const first = await tab(browser, o);
  const { reply } = await login(first, g);
  return { browser, first, result: reply.result as Record<string, unknown> };
}

describe('Support ID from the API, for an SDK that takes it', () => {
  it('the login result and hana_status carry the code the API sent', async () => {
    const { first, result } = await loggedIn();
    expect(result.supportId).toBe(CODE);
    expect(await status(first)).toMatchObject({ status: 'logged_in', supportId: CODE });
  });

  it('the split flow takes it from /v1/sessions', async () => {
    const { first, result } = await loggedIn(CODE, { loginFlow: 'split' });
    expect(first.browser.backend.count('/v1/sessions')).toBe(1);
    expect(result.supportId).toBe(CODE);
    expect((await status(first)).supportId).toBe(CODE);
  });

  it('is kept in the record, so a reload reports it in `ready` and hana_status', async () => {
    const { browser } = await loggedIn();
    expect((await stored(browser))!.supportId).toBe(CODE);
    const second = await tab(browser);
    expect(await second.ready()).toMatchObject({ status: 'logged_in', supportId: CODE });
    expect((await status(second)).supportId).toBe(CODE);
  });

  it('stays while the session is dormant (PRK zeroed for idleness)', async () => {
    const { browser, first } = await loggedIn();
    browser.timers.advance(2 * HOUR);
    expect((first.vault as unknown as { session: unknown }).session).toBeNull();
    expect(await status(first)).toMatchObject({ status: 'logged_in', supportId: CODE });
  });

  it('goes with the session: logged out, hana_status has none and the record is gone', async () => {
    const { browser, first } = await loggedIn();
    expect((await first.request('hana_logout')).result).toBeNull();
    const s = await status(first);
    expect(s.status).toBe('logged_out');
    expect('supportId' in s).toBe(false);
    expect(await stored(browser)).toBeUndefined();
  });

  it('an API that sends none: no supportId anywhere (the vault never makes one up)', async () => {
    const { browser, first, result } = await loggedIn(NONE);
    expect('supportId' in result).toBe(false);
    expect('supportId' in (await status(first))).toBe(false);
    expect('supportId' in (await stored(browser))!).toBe(false);
  });

  for (const bad of ['hana-2750-g5hm', 'HANA-2750-G5HU', 'HANA-2750G5HM', 'HANA-2750-G5HM ', 42, null, { code: CODE }]) {
    it(`a malformed value from the API (${JSON.stringify(bad)}) is dropped; the login still succeeds`, async () => {
      const { browser, first, result } = await loggedIn(bad);
      expect(result.addresses).toBeDefined();
      expect('supportId' in result).toBe(false);
      expect('supportId' in (await status(first))).toBe(false);
      expect('supportId' in (await stored(browser))!).toBe(false);
    });
  }

  it('a record from before C15 (no supportId) unlocks and reports none', async () => {
    const { browser } = await loggedIn(NONE);
    const second = await tab(browser);
    const ready = await second.ready();
    expect(ready.status).toBe('logged_in');
    expect('supportId' in ready).toBe(false);
  });

  it('a stored value that is not a Support ID is dropped on read; the record still unlocks', async () => {
    const { browser } = await loggedIn();
    const store = await openRecordStore(browser.idb);
    await store.put(KEY, { ...(await stored(browser))!, supportId: 'not-a-code' } as never);
    const second = await tab(browser);
    const ready = await second.ready();
    expect(ready.status).toBe('logged_in');
    expect('supportId' in ready).toBe(false);
    expect(await stored(browser)).toBeDefined();
  });
});

describe('an SDK before the field', () => {
  for (const sdk of [OLD_SDK, '0.0.0', '0.2.0-rc.1', 'dev']) {
    it(`sdk ${sdk}: hana_login, hana_status and ready keep exactly their old keys`, async () => {
      const { browser, first, result } = await loggedIn(CODE, { sdk });
      // pk_test_ apps also get `timings`.
      expect(Object.keys(result).sort()).toEqual(['addresses', 'expiresAtMs', 'persistence', 'timings']);
      expect(Object.keys(await status(first)).sort()).toEqual(['addresses', 'expiresAtMs', 'persistence', 'status']);
      // The vault still keeps it (a newer SDK on the next load gets it).
      expect((await stored(browser))!.supportId).toBe(CODE);
      const second = await tab(browser, { sdk });
      const ready = await second.ready();
      expect('supportId' in ready).toBe(false);
      const newer = await tab(browser, { sdk: '1.0.0' });
      expect((await newer.ready()).supportId).toBe(CODE);
    });
  }
});

describe('the approval popup', () => {
  async function approvalRequest(t: Tab): Promise<Record<string, unknown>> {
    const reply = t.request('stellar_signMessage', { message: 'hello' });
    await t.waitUntil(() => t.launcher.label === 'Review in Hana', 'the launcher');
    const popup = openApproval(t);
    const m = await popup.next('hana:approve-request');
    answer(t, popup, m, true);
    await reply;
    popup.closed = true;
    await sleepReal(0);
    return m;
  }

  it('gets the session’s Support ID on the request (whatever the partner’s SDK version)', async () => {
    const { first } = await loggedIn(CODE, { sdk: OLD_SDK });
    expect((await approvalRequest(first)).supportId).toBe(CODE);
  });

  it('gets no supportId key when the session has none', async () => {
    const { first } = await loggedIn(NONE);
    expect('supportId' in (await approvalRequest(first))).toBe(false);
  });
});
