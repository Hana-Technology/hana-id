// pk_test_ timings, vault side (packages/core/src/timings.ts; apps/smoke/README.md "Timings"): the login's and the
// unlock's stages are present, add up to the vault's own total, carry the popup's, the relay's and the API's parts
// as durations, and hold nothing but stage names and numbers. pk_live_ apps get none.
import { LOGIN_TIMING_DETAILS, LOGIN_TIMING_STAGES, UNLOCK_TIMING_DETAILS, UNLOCK_TIMING_STAGES, isTimings, stageSum, toHex } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  EMAIL_ENV,
  type EmailIssuer,
  type Google,
  SUB,
  type Tab,
  deliverEmailToken,
  emailIssuer,
  enableEmail,
  google,
  login,
  makeConfig,
  persisted,
  popupHello,
  readyTab,
} from './harness.ts';

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

async function tab(browser = new Browser(), o: Parameters<typeof readyTab>[1] = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, ...o });
  tabs.push(t);
  return t;
}

/** The partner client's own stages (it adds them around the vault's). */
const CLIENT_LOGIN_STAGES = new Set(['open', 'wait', 'port']);
const CLIENT_UNLOCK_STAGES = new Set(['mount', 'retry', 'frameStart', 'port']);
/** The login stages of the other method (and the chooser, which a preselected or Google-only login never shows). */
const EMAIL_ONLY = new Set(['choose', 'emailLoad', 'emailEntry', 'emailStart', 'emailCode', 'emailVerify', 'emailRelay']);
const GOOGLE_ONLY = new Set(['choose', 'google', 'callbackRedirect', 'callbackFetch', 'callbackBoot', 'callbackPrep']);
// Small enough to fit inside the test's own hello → token time (real values are hundreds of ms).
const POPUP = { authCheck: 0.03, callbackRedirect: 0.01, callbackFetch: 0.02, callbackBoot: 0.01, callbackPrep: 0.005 };
const SERVER = {
  totalMs: 700,
  phases: { app: 40, limits: 60, checks: 100, relay: 480, relayDispatch: 30, relayOutcome: 440, settings: 20, chain: 15, session: 300, insert: 25, share: 50, advance: 35 },
};

/** Close to `want` (the stages are consecutive marks of one clock, so only float rounding separates them). */
const near = (got: number, want: number): void => expect(Math.abs(got - want)).toBeLessThan(1e-6);

function expectNothingSensitive(timings: Record<string, number>, allowed: readonly string[], secrets: string[]): void {
  expect(isTimings(timings)).toBe(true);
  for (const k of Object.keys(timings)) expect(allowed).toContain(k);
  const text = JSON.stringify(timings);
  for (const s of secrets) expect(text).not.toContain(s);
}

describe('login timings', () => {
  it('has every vault stage, the popup, relay and API parts, and the stages add up to the vault total', async () => {
    const browser = new Browser();
    browser.backend.popupTimings = POPUP;
    browser.backend.relayHeldMs = 0.01;
    browser.backend.serverTimings = SERVER;
    const t = await tab(browser);
    const { reply, run, token } = await login(t, g);
    const timings = (reply.result as { timings: Record<string, number> }).timings;

    const vaultStages = LOGIN_TIMING_STAGES.filter((s) => !CLIENT_LOGIN_STAGES.has(s));
    for (const s of vaultStages.filter((s) => !EMAIL_ONLY.has(s))) expect(timings, s).toHaveProperty(s);
    for (const s of EMAIL_ONLY) expect(timings, s).not.toHaveProperty(s);
    // GET /v1/app: the vault's round trip of the request `app` waited for, and the API's own phases.
    expect(timings).toMatchObject({ appServer: 700, appServerGate: 100, appServerSettings: 20, appServerChain: 15 });
    expect(timings).toHaveProperty('appRtt');
    // The popup's own stages, passed as durations inside the encrypted slot, and the API's relay hold.
    expect(timings).toMatchObject({ ...POPUP, relayHeld: 0.01 });
    // Every vault stage is a lap of one clock from hana_login to the reply: they sum to `vault` exactly.
    near(stageSum(timings, vaultStages), timings.vault!);
    // The API's own time for /v1/login, next to the vault's round trip.
    expect(timings).toMatchObject({
      loginServer: 700,
      loginServerGate: 100,
      loginServerChecks: 100,
      loginServerRelay: 480,
      loginServerBroadcast: 30,
      loginServerWait: 440,
    });
    for (const d of ['chainPrep', 'loginRtt', 'scopeCheck']) expect(timings, d).toHaveProperty(d);
    expect(timings.loginRtt!).toBeLessThanOrEqual(timings.chain!);
    // The share and record are made after the reply (D79): no stage or detail of the login covers them.
    for (const k of Object.keys(timings)) expect(k).not.toMatch(/^(persist|share)/u);

    const p = run.params;
    expectNothingSensitive(timings, [...LOGIN_TIMING_STAGES, ...LOGIN_TIMING_DETAILS], [
      token,
      SUB,
      p.relayId as string,
      p.nonce as string,
      toHex(p.relayKey as Uint8Array),
      toHex(p.sessionPublicKey as Uint8Array),
    ]);
  });

  it('without the popup, relay or API parts (an older API, a pk_live_ popup) the stages still add up', async () => {
    const t = await tab();
    const { reply } = await login(t, g);
    const timings = (reply.result as { timings: Record<string, number> }).timings;
    for (const s of ['authCheck', 'callbackFetch', 'relayHeld', 'loginServer', 'shareServer']) expect(timings).not.toHaveProperty(s);
    near(
      stageSum(
        timings,
        LOGIN_TIMING_STAGES.filter((s) => !CLIENT_LOGIN_STAGES.has(s)),
      ),
      timings.vault!,
    );
  });

  it('a Google login whose popup showed the chooser has `choose`, taken out of `google`', async () => {
    const browser = new Browser();
    browser.backend.popupTimings = { ...POPUP, choose: 0.02 };
    const t = await tab(browser);
    const timings = ((await login(t, g)).reply.result as { timings: Record<string, number> }).timings;
    expect(timings.choose).toBe(0.02);
    near(stageSum(timings, LOGIN_TIMING_STAGES.filter((s) => !CLIENT_LOGIN_STAGES.has(s))), timings.vault!);
  });

  it('an email login has the email step’s stages and `emailRelay` instead of `google`, and they add up', async () => {
    const issuer: EmailIssuer = await emailIssuer();
    const browser = new Browser();
    enableEmail(browser.backend, issuer);
    const step = { authCheck: 0.01, choose: 0.01, emailLoad: 0.01, emailEntry: 0.02, emailStart: 0.01, emailCode: 0.03, emailVerify: 0.01 };
    browser.backend.popupTimings = step;
    browser.backend.relayHeldMs = 0.01;
    browser.backend.serverTimings = SERVER;
    const t = await tab(browser, { env: EMAIL_ENV });
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await deliverEmailToken(t, issuer, run);
    const reply = await pending;
    await persisted(t);
    const timings = (reply.result as { timings: Record<string, number> }).timings;
    expect(timings).toMatchObject({ ...step, relayHeld: 0.01 });
    expect(timings).not.toHaveProperty('google');
    for (const s of GOOGLE_ONLY) if (s !== 'choose') expect(timings, s).not.toHaveProperty(s);
    expect(timings).toHaveProperty('emailRelay');
    const vaultStages = LOGIN_TIMING_STAGES.filter((s) => !CLIENT_LOGIN_STAGES.has(s));
    near(stageSum(timings, vaultStages), timings.vault!);
    expectNothingSensitive(timings, [...LOGIN_TIMING_STAGES, ...LOGIN_TIMING_DETAILS], [SUB, run.params.relayId as string, run.params.nonce as string]);
  });

  it('a malformed API timings object is ignored', async () => {
    const browser = new Browser();
    browser.backend.serverTimings = { totalMs: -1, phases: { app: 1 } };
    const t = await tab(browser);
    const timings = ((await login(t, g)).reply.result as { timings: Record<string, number> }).timings;
    expect(Object.keys(timings).some((k) => k.startsWith('loginServer') || k.startsWith('shareServer'))).toBe(false);
  });

  it('pk_live_ apps get no timings, whatever the popup and the API send', async () => {
    const browser = new Browser();
    browser.backend.popupTimings = POPUP;
    browser.backend.serverTimings = SERVER;
    const t = await tab(browser, { config: makeConfig({ publishableKey: 'pk_live_1111111111111111111111' }) });
    const { reply } = await login(t, g);
    expect(reply.result).not.toHaveProperty('timings');
  });
});

describe('unlock timings', () => {
  async function reload(browser: Browser, o: Parameters<typeof readyTab>[1] = {}): Promise<Record<string, unknown>> {
    const first = await tab(browser, o);
    await login(first, g);
    const second = await tab(browser, o);
    return (await second.ready()) as Record<string, unknown>;
  }

  it('a reload reports the vault document load and each unlock stage, summing to its own total', async () => {
    const browser = new Browser();
    browser.backend.serverTimings = SERVER;
    const ready = await reload(browser, { navigation: { responseEnd: 180, loadEventEnd: 0 }, options: { boot: { scriptStart: 230 } } });
    expect(ready.status).toBe('logged_in');
    const timings = ready.timings as Record<string, number>;
    const vaultStages = UNLOCK_TIMING_STAGES.filter((s) => !CLIENT_UNLOCK_STAGES.has(s));
    for (const s of vaultStages) expect(timings, s).toHaveProperty(s);
    expect(timings).toMatchObject({ vaultFetch: 180, vaultScript: 50, unlockServer: 700, unlockServerGate: 100, unlockServerShare: 50, unlockServerAdvance: 35 });
    expect(timings.unlockRtt!).toBeLessThanOrEqual(timings.unlock!);
    // After the hello, the stages are laps of one clock up to `ready`.
    near(stageSum(timings, ['store', 'record', 'unlock', 'counter', 'unwrap', 'addresses']), timings.vault!);
    expectNothingSensitive(timings, [...UNLOCK_TIMING_STAGES, ...UNLOCK_TIMING_DETAILS], [SUB]);
  });

  it('a vault with no record reports only how far it got', async () => {
    const t = await tab();
    const ready = (await t.ready()) as { status: string; timings: Record<string, number> };
    expect(ready.status).toBe('logged_out');
    expect(Object.keys(ready.timings).sort()).toEqual(['record', 'store', 'vault']);
    near(ready.timings.store! + ready.timings.record!, ready.timings.vault!);
  });

  it('pk_live_ apps get no ready timings', async () => {
    const browser = new Browser();
    const ready = await reload(browser, { config: makeConfig({ publishableKey: 'pk_live_1111111111111111111111' }) });
    expect(ready.status).toBe('logged_in');
    expect(ready).not.toHaveProperty('timings');
  });
});
