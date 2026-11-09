// @vitest-environment happy-dom
// useEmailSharing (D411): `request` calls hana.requestEmailSharing() and keeps its answer in `state`, a failure in
// `error` (the promise marked handled), and `emailSharingChanged` from elsewhere updates `state`.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaProvider, type UseEmailSharingResult, useEmailSharing } from '../src/index.ts';
import { CONFIG, type FakeVault, LOGGED_IN, attachVault, settle, stubBrowser } from './harness.tsx';

beforeEach(() => {
  stubBrowser();
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function Probe({ out }: { out: UseEmailSharingResult[] }) {
  out.push(useEmailSharing());
  return null;
}

async function mount(): Promise<{ vault: FakeVault; out: UseEmailSharingResult[] }> {
  const out: UseEmailSharingResult[] = [];
  render(
    <HanaProvider config={CONFIG}>
      <Probe out={out} />
    </HanaProvider>,
  );
  await settle();
  const vault = attachVault();
  await act(async () => {
    await vault.connect(LOGGED_IN);
  });
  await settle();
  return { vault, out };
}

describe('useEmailSharing', () => {
  it('request → state; a refusal → error, never an unhandled rejection; emailSharingChanged updates state', async () => {
    const { vault, out } = await mount();
    expect(out.at(-1)!.state).toBeNull();
    vault.handle('hana_requestEmailSharing', () => ({ result: { state: 'granted' } }));
    await act(async () => {
      await out.at(-1)!.request();
    });
    expect(out.at(-1)!.state).toBe('granted');
    vault.handle('hana_requestEmailSharing', () => ({ error: { code: 'email_sharing_unavailable', message: 'off', data: { reason: 'off' } } }));
    await act(async () => {
      void out.at(-1)!.request().catch(() => undefined);
      await settle();
    });
    expect(out.at(-1)!.error?.code).toBe('email_sharing_unavailable');
    await act(async () => {
      vault.emit('emailSharingChanged', { state: 'declined' });
      await settle();
    });
    expect(out.at(-1)!.state).toBe('declined');
  });
});
