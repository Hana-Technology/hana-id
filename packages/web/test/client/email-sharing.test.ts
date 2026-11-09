// @vitest-environment happy-dom
// HanaClient.requestEmailSharing (D411): the sheet's popup opened in the click, before the request; the vault's
// launcher when the browser blocks it; the answer; errors close the popup; `emailSharingChanged` passed on. The hello
// names a version the vault sends the event to (EMAIL_SHARING_SDK_MIN, D393's gate).
import { EMAIL_SHARING_SDK_MIN, sdkAtLeast } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '../../src/version.ts';
import { LOGGED_IN, LOGGED_OUT, ORIGINS, type Setup, flush, setup } from './harness.ts';

let s: Setup;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  s?.client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('HanaClient.requestEmailSharing', () => {
  it('this SDK takes emailSharingChanged', () => {
    expect(sdkAtLeast(VERSION, EMAIL_SHARING_SDK_MIN)).toBe(true);
  });

  it('opens /share-email?from=partner&v=<vault frame> synchronously, then asks the vault; resolves its state', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_requestEmailSharing', () => ({ result: { state: 'granted' } }));
    const p = s.client.requestEmailSharing();
    expect(s.open).toHaveBeenCalledOnce();
    const [url, name, features] = s.open.mock.calls[0]! as [string, string, string];
    expect(url).toBe(`${ORIGINS.authOrigin}/share-email?from=partner&v=${encodeURIComponent(s.frame.name)}`);
    expect(name).toMatch(/^hana-share-[0-9a-f]{32}$/u);
    expect(features).toBe('popup,width=420,height=680');
    expect(await p).toBe('granted');
    expect(s.vault.last('hana_requestEmailSharing').params).toBeUndefined();
  });

  it('a blocked popup asks the vault with popupBlocked (its launcher opens the sheet)', async () => {
    s = setup({ popup: 'blocked' });
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_requestEmailSharing', () => ({ result: { state: 'dismissed' } }));
    expect(await s.client.requestEmailSharing()).toBe('dismissed');
    expect(s.vault.last('hana_requestEmailSharing').params).toEqual({ popupBlocked: true });
  });

  it('logged out: 4100 and no popup; a refusal closes the popup it opened', async () => {
    s = setup();
    await s.vault.connect(LOGGED_OUT);
    await expect(s.client.requestEmailSharing()).rejects.toMatchObject({ code: 4100 });
    expect(s.open).not.toHaveBeenCalled();
    s.client.destroy();
    document.body.replaceChildren();
    s = setup();
    await s.vault.connect(LOGGED_IN);
    s.vault.handle('hana_requestEmailSharing', () => ({ error: { code: 'email_sharing_unavailable', message: 'off', data: { reason: 'off' } } }));
    await expect(s.client.requestEmailSharing()).rejects.toMatchObject({ code: 'email_sharing_unavailable', data: { reason: 'off' } });
    expect(s.popups[0]!.close).toHaveBeenCalled();
  });

  it('passes emailSharingChanged on', async () => {
    s = setup();
    await s.vault.connect(LOGGED_IN);
    const seen: string[] = [];
    s.client.on('emailSharingChanged', (state) => seen.push(state));
    s.vault.emit('emailSharingChanged', { state: 'declined' });
    await flush();
    expect(seen).toEqual(['declined']);
  });
});
