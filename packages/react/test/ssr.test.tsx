// Server rendering (docs/batch-b-spec.md "React": the modules are 'use client', and the provider creates its client in
// an effect). No DOM environment here: this file runs in plain Node, as a Next.js server render does, with no `window`.
// The render must show the initial state and never call createHana, which needs a browser.
import { createHana } from '@hana-id/web';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HanaProvider, INITIAL_STATE, useHana, useWallet } from '../src/index.ts';

vi.mock('@hana-id/web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@hana-id/web')>();
  return { ...real, createHana: vi.fn(real.createHana) };
});

/** As harness.tsx's CONFIG (a public test key), without importing the DOM harness. */
const PK = 'pk_test_4bd7ZqGiPcDdRx8Fk2mN9w';
const CONFIG = Object.freeze({ publishableKey: PK, environment: 'sandbox-dev' });

function Probe() {
  const hana = useHana();
  const stellar = useWallet('stellar');
  const evm = useWallet('evm');
  return (
    <pre>
      {JSON.stringify({
        status: hana.status,
        addresses: hana.addresses,
        persistence: hana.persistence,
        error: hana.error,
        supportId: hana.supportId,
        client: hana.client === null ? null : 'client',
        stellar: { address: stellar.address, signer: stellar.signer === null ? null : 'signer' },
        evm: { address: evm.address, provider: evm.provider === null ? null : 'provider' },
      })}
    </pre>
  );
}

describe('server render', () => {
  it('runs without a window', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
  });

  it('renders the initial state (unlocking, no addresses, no signer or provider) and never calls createHana', () => {
    const html = renderToString(
      <HanaProvider config={CONFIG}>
        <Probe />
      </HanaProvider>,
    );
    const json = html.replace(/^<pre>/u, '').replace(/<\/pre>$/u, '').replaceAll('&quot;', '"');
    expect(JSON.parse(json)).toEqual({
      ...INITIAL_STATE,
      client: null,
      stellar: { address: null, signer: null },
      evm: { address: null, provider: null },
    });
    expect(INITIAL_STATE.status).toBe('unlocking');
    expect(vi.mocked(createHana)).not.toHaveBeenCalled();
  });
});
