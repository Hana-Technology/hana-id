// Test helpers: the real hana.stellar and hana.ethereum (HanaStellarSigner, HanaEthereumProvider from @hana-id/web)
// over a scripted vault port, and a fake network (Soroban RPC, Horizon, EVM RPCs) behind one fetch, routed by URL.
import { Keypair } from '@stellar/stellar-base';
import { vi } from 'vitest';
import { HanaError, HanaEthereumProvider, HanaStellarSigner, type EvmConfig, type HanaAddresses } from '@hana-id/web';
import type { SodaxEvmHana, SodaxStellarHana } from '../src/index.ts';

type StellarHost = ConstructorParameters<typeof HanaStellarSigner>[0];
type EthereumHost = ConstructorParameters<typeof HanaEthereumProvider>[0];

export const STELLAR_KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
export const STELLAR = STELLAR_KEY.publicKey();
export const OTHER_STELLAR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
export const EVM = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
export const OTHER_EVM = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
export const PUBLIC = 'Public Global Stellar Network ; September 2015';
export const HORIZON = 'https://horizon.test';
export const SOROBAN = 'https://soroban.test';

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

// ---- the vault's port ----

export interface PortCall {
  method: string;
  params: unknown;
}

/** What the vault answers per method: a result, or a function of the params (throw a HanaError to refuse). */
export type PortHandlers = Record<string, (params: unknown) => unknown>;

export class FakePort {
  readonly calls: PortCall[] = [];
  constructor(public handlers: PortHandlers = {}) {}

  request = async (method: string, params?: unknown): Promise<unknown> => {
    this.calls.push({ method, params });
    const h = this.handlers[method];
    if (!h) throw new HanaError(4200, `No handler for ${method}`);
    return h(params);
  };

  seen(method: string): PortCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

/** A logged-in (or not) user, as the client tracks it. */
export class Session {
  addresses: HanaAddresses | null = { stellar: STELLAR, evm: EVM };
  readonly login = vi.fn(async () => {
    this.addresses = { stellar: STELLAR, evm: EVM };
    return { ...this.addresses };
  });
}

export function stellarHana(port: FakePort, session = new Session(), networkPassphrase = PUBLIC): SodaxStellarHana & { session: Session } {
  const host: StellarHost = {
    stellarAddress: () => session.addresses?.stellar ?? null,
    login: () => session.login(),
    request: port.request as StellarHost['request'],
  };
  return { stellar: new HanaStellarSigner(host, { networkPassphrase }), session };
}

export function evmHana(port: FakePort, net: FakeNetwork, evm: EvmConfig | undefined, session = new Session()): SodaxEvmHana & { session: Session } {
  const host: EthereumHost = {
    evmAddress: () => session.addresses?.evm ?? null,
    login: () => session.login(),
    request: port.request as EthereumHost['request'],
    fetch: net.fetch,
  };
  const ethereum = new HanaEthereumProvider(host, evm);
  return {
    ethereum,
    get addresses() {
      return session.addresses === null ? null : { ...session.addresses };
    },
    session,
  };
}

// ---- the network ----

export interface NetCall {
  url: string;
  method: string;
  /** JSON-RPC method, or the HTTP method for a plain GET. */
  rpc: string | null;
  params: unknown;
  at: number;
}

type RpcAnswer = unknown | ((params: unknown) => unknown);
export type GetAnswer = { status: number; json?: unknown } | Error;

/**
 * JSON-RPC endpoints (url → method → result, or a function of params that may throw `{code, message}` as an RPC error)
 * and GET endpoints (url → a function returning the response for each call).
 */
export class FakeNetwork {
  readonly calls: NetCall[] = [];
  readonly rpc = new Map<string, Record<string, RpcAnswer>>();
  readonly get = new Map<string, (n: number) => GetAnswer>();

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = String(input);
    if ((init.method ?? 'GET') === 'GET') {
      const n = this.calls.filter((c) => c.url === url).length;
      this.calls.push({ url, method: 'GET', rpc: null, params: null, at: Date.now() });
      const h = this.get.get(url);
      if (!h) return new Response('not found', { status: 404 });
      const a = h(n);
      if (a instanceof Error) throw a;
      return new Response(a.json === undefined ? '' : JSON.stringify(a.json), { status: a.status });
    }
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown };
    this.calls.push({ url, method: 'POST', rpc: body.method, params: body.params, at: Date.now() });
    const answers = this.rpc.get(url) ?? {};
    if (!Object.hasOwn(answers, body.method)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
    }
    const a = answers[body.method];
    try {
      const result = typeof a === 'function' ? (a as (p: unknown) => unknown)(body.params) : a;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: e }));
    }
  };

  rpcCalls(url: string, method?: string): NetCall[] {
    return this.calls.filter((c) => c.url === url && c.rpc !== null && (method === undefined || c.rpc === method));
  }
}

/** The rejection of `p` (fails the test if it resolves). */
export async function rejection(p: Promise<unknown>): Promise<{ code?: unknown; message: string; data?: unknown }> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (e === null) throw new Error('Expected a rejection');
  return e as { code?: unknown; message: string; data?: unknown };
}

