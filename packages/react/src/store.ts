// The client's observable state as a `useSyncExternalStore` source. The snapshot is read from the client's own getters
// on every call and keeps its identity while nothing changed by value, so React re-renders only on a real change and
// never loops (the client's `addresses` getter returns a fresh object each time). Change notifications come from the
// client's events and from `ready` settling; reading the getters directly also catches a field that changed without
// an event of its own (`error` and `persistence` are set just before the `statusChanged` that announces them).
import type { HanaAddresses, HanaClient, HanaError, HanaStatus } from '@hana-id/web';

export type HanaPersistence = NonNullable<HanaClient['persistence']>;

/** What `useHana()` reports about the client (docs/batch-b-spec.md, React). Public values only, no key material. */
export interface HanaState {
  readonly status: HanaStatus;
  /** `{stellar, evm}` while logged in, else null. */
  readonly addresses: Readonly<HanaAddresses> | null;
  /** The app's persistence mode as the vault runs it ('none' after a storage fallback); null until the handshake. */
  readonly persistence: HanaPersistence | null;
  /** The last failure (vault_unavailable, a failed login, a lost vault); cleared by a successful login. */
  readonly error: HanaError | null;
}

/** The state before a client exists (first render, server render): the client's own initial values. */
export const INITIAL_STATE: HanaState = Object.freeze({ status: 'unlocking', addresses: null, persistence: null, error: null });

export interface HanaStore {
  subscribe(onChange: () => void): () => void;
  getSnapshot(): HanaState;
}

/** A store with no client: always INITIAL_STATE. */
export const EMPTY_STORE: HanaStore = Object.freeze({
  subscribe: () => () => {},
  getSnapshot: () => INITIAL_STATE,
});

/** The client events after which a getter may read differently. */
const EVENTS = ['statusChanged', 'accountsChanged', 'sessionExpired', 'disconnect'] as const;

export function createStore(client: HanaClient): HanaStore {
  const subscribers = new Set<() => void>();
  let snapshot = INITIAL_STATE;
  const notify = () => {
    for (const cb of [...subscribers]) cb();
  };
  // Attached once for the client's lifetime; HanaClient.destroy() removes them with every other listener.
  for (const event of EVENTS) client.on(event, notify);
  client.ready.then(notify, notify);

  return {
    subscribe(onChange) {
      subscribers.add(onChange);
      return () => {
        subscribers.delete(onChange);
      };
    },
    getSnapshot() {
      const status = client.status;
      const addresses = client.addresses;
      const persistence = client.persistence;
      const error = client.error;
      if (
        snapshot.status !== status ||
        !sameAddresses(snapshot.addresses, addresses) ||
        snapshot.persistence !== persistence ||
        snapshot.error !== error
      ) {
        snapshot = Object.freeze({ status, addresses: addresses && Object.freeze(addresses), persistence, error });
      }
      return snapshot;
    },
  };
}

function sameAddresses(a: HanaAddresses | null, b: HanaAddresses | null): boolean {
  if (a === null || b === null) return a === b;
  return a.stellar === b.stellar && a.evm === b.evm;
}
