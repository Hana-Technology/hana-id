// @vitest-environment happy-dom
// useMainnetDemo: on, off and "not known yet" are three different answers, and a change of prices re-renders.
import { createHana } from '@hana-id/web';
import { act, cleanup, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaProvider, type UseMainnetDemoResult, useMainnetDemo } from '../src/index.ts';
import { CONFIG, LOGGED_OUT, attachVault, settle, stubBrowser } from './harness.tsx';

vi.mock('@hana-id/web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@hana-id/web')>();
  return { ...real, createHana: vi.fn(real.createHana) };
});

const STATE = { evmChains: [8453], stellarNetworkPassphrase: 'Public Global Stellar Network ; September 2015', txCapUsdMicros: '9990000', pricesReviewedAt: '2026-11-06', pricesValidUntilMs: Date.UTC(2026, 11, 21) };
const BOOK = { atMs: 1_800_000_000_000, assets: { ETH: { usdMicros: '2251798500', source: 'live' }, XLM: { usdMicros: '155400', source: 'live' }, USDC: { usdMicros: '1048950', source: 'live' }, EURC: { usdMicros: '1165500', source: 'live' } } };

const seen: UseMainnetDemoResult[] = [];
function Probe() {
  seen.push(useMainnetDemo());
  return null;
}
const last = () => seen.at(-1) as UseMainnetDemoResult;

beforeEach(() => {
  seen.length = 0;
  stubBrowser();
  vi.mocked(createHana).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useMainnetDemo', () => {
  it('is "not known yet" before the client is ready, then off', async () => {
    render(
      <HanaProvider config={CONFIG}>
        <Probe />
      </HanaProvider>,
    );
    expect(last()).toEqual({ demo: null, known: false });
    await settle();
    const vault = attachVault();
    await act(async () => {
      vault.connect(LOGGED_OUT);
      await Promise.resolve();
    });
    await settle();
    expect(last()).toEqual({ demo: null, known: true });
  });

  it('reports the demo with its prices, and re-renders when the prices change', async () => {
    render(
      <HanaProvider config={CONFIG}>
        <Probe />
      </HanaProvider>,
    );
    await settle();
    const vault = attachVault();
    await act(async () => {
      vault.connect(LOGGED_OUT);
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      vault.emit('mainnetDemoPrices', BOOK);
      vault.emit('mainnetDemo', STATE);
      await Promise.resolve();
    });
    await settle();
    expect(last().known).toBe(true);
    expect(last().demo?.txCapUsd).toBe('9.99');
    expect(last().demo?.prices?.source).toBe('live');
    expect(last().demo?.prices?.assets.ETH.usd).toBe('2251.7985');
    await act(async () => {
      vault.emit('mainnetDemoPrices', { ...BOOK, assets: { ...BOOK.assets, XLM: { usdMicros: '160000', source: 'live' } } });
      await Promise.resolve();
    });
    await settle();
    expect(last().demo?.prices?.assets.XLM.usd).toBe('0.16');
  });

  it('renders on the server as "not known yet", without touching a client', () => {
    expect(renderToString(<HanaProvider config={CONFIG}><Probe /></HanaProvider>)).toBe('');
    expect(seen.at(-1)).toEqual({ demo: null, known: false });
    expect(createHana).not.toHaveBeenCalled();
  });

  it('throws outside the provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderToString(<Probe />)).toThrow(/useMainnetDemo must be used inside/u);
    quiet.mockRestore();
  });
});
