// The useSyncExternalStore source behind useHana and useWallet: snapshot identity, change detection, notifications.
import type { HanaAddresses, HanaClient, HanaError, HanaStatus } from '@hana-id/web';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_STORE, INITIAL_STATE, createStore } from '../src/store.ts';

const A: HanaAddresses = { stellar: 'GA', evm: '0xA' };

/** The client surface the store reads: getters, `on`, `ready`. */
function fakeClient() {
  const listeners = new Map<string, (() => void)[]>();
  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const state = {
    status: 'unlocking' as HanaStatus,
    addresses: null as HanaAddresses | null,
    persistence: null as 'session' | 'none' | null,
    error: null as HanaError | null,
  };
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => {});
  const client = {
    get status() {
      return state.status;
    },
    // As HanaClient does: a fresh object on every read.
    get addresses() {
      return state.addresses && { ...state.addresses };
    },
    get persistence() {
      return state.persistence;
    },
    get error() {
      return state.error;
    },
    ready,
    on(event: string, cb: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
      return client;
    },
  };
  const emit = (event: string) => {
    for (const cb of listeners.get(event) ?? []) cb();
  };
  return { client: client as unknown as HanaClient, state, emit, listeners, resolveReady, rejectReady };
}

describe('createStore', () => {
  it("starts from the client's values and keeps the snapshot's identity while nothing changed by value", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    const s1 = store.getSnapshot();
    expect(s1).toEqual(INITIAL_STATE);
    expect(store.getSnapshot()).toBe(s1);
    f.state.addresses = { ...A };
    const s2 = store.getSnapshot();
    expect(s2).not.toBe(s1);
    expect(s2.addresses).toEqual(A);
    f.state.addresses = { ...A }; // a new object with the same values
    expect(store.getSnapshot()).toBe(s2);
  });

  it('detects each reported field, including a change without an event of its own', () => {
    const f = fakeClient();
    const store = createStore(f.client);
    let prev = store.getSnapshot();
    const steps: (() => void)[] = [
      () => (f.state.status = 'logged_out'),
      () => (f.state.persistence = 'session'),
      () => (f.state.error = new Error('x') as HanaError),
      () => (f.state.addresses = { ...A }),
      () => (f.state.addresses = { ...A, evm: '0xB' }),
      () => (f.state.addresses = null),
    ];
    for (const step of steps) {
      step();
      const next = store.getSnapshot();
      expect(next).not.toBe(prev);
      prev = next;
    }
  });

  it('snapshots are frozen', () => {
    const f = fakeClient();
    f.state.addresses = { ...A };
    const s = createStore(f.client).getSnapshot();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.addresses)).toBe(true);
  });

  it('notifies subscribers on statusChanged, accountsChanged, sessionExpired and disconnect, until they unsubscribe', () => {
    const f = fakeClient();
    const store = createStore(f.client);
    expect([...f.listeners.keys()].sort()).toEqual(['accountsChanged', 'disconnect', 'sessionExpired', 'statusChanged']);
    const cb = vi.fn();
    const unsubscribe = store.subscribe(cb);
    for (const e of ['statusChanged', 'accountsChanged', 'sessionExpired', 'disconnect']) f.emit(e);
    expect(cb).toHaveBeenCalledTimes(4);
    unsubscribe();
    f.emit('statusChanged');
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it('notifies when ready resolves', async () => {
    const f = fakeClient();
    const cb = vi.fn();
    createStore(f.client).subscribe(cb);
    f.resolveReady();
    await f.client.ready;
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('notifies when ready rejects (vault_unavailable)', async () => {
    const f = fakeClient();
    const cb = vi.fn();
    createStore(f.client).subscribe(cb);
    f.rejectReady(new Error('vault_unavailable'));
    await f.client.ready.catch(() => {});
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a subscriber that unsubscribes another during a notification does not break the loop', () => {
    const f = fakeClient();
    const store = createStore(f.client);
    const second = vi.fn();
    let off2 = () => {};
    store.subscribe(() => off2());
    off2 = store.subscribe(second);
    f.emit('statusChanged');
    expect(second).toHaveBeenCalledTimes(1); // the snapshot of subscribers was taken first
    f.emit('statusChanged');
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('EMPTY_STORE', () => {
  it('is always the initial state and never notifies', () => {
    const cb = vi.fn();
    const off = EMPTY_STORE.subscribe(cb);
    expect(EMPTY_STORE.getSnapshot()).toBe(INITIAL_STATE);
    off();
    expect(cb).not.toHaveBeenCalled();
  });
});
