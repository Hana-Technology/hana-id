'use client';
// <HanaProvider config={…}>: one Hana client (createHana from @hana-id/web) for the subtree, destroyed on unmount
// (docs/batch-b-spec.md, React).
//
// The client is created in an effect, not during render: render may run more than once per mount (strict mode,
// discarded concurrent renders) and never on the client during SSR, and every client mounts a vault iframe. Strict
// mode's simulated unmount and remount (cleanup then setup, synchronously, on the same component) must not make a
// second client either, so the cleanup only marks the client released and destroys it on the next microtask; a setup
// that runs before then takes it back. A real unmount destroys it a microtask later.
//
// A remount with a new `key` runs the old provider's cleanup and then the new one's setup, in one go: so before a
// provider creates a client, it destroys every client a cleanup released and no setup took back (D936). The old
// client is then gone before the new one exists, and the new one takes over the page's EIP-6963 entry (same uuid),
// as wallet lists such as wagmi's need. Only a setup that creates flushes: a strict-mode or `<Activity>` setup that
// takes its own client back never does, so a client it still owns is never destroyed early.
//
// `config` is read once, at mount. To switch app or environment, remount the provider (for example with a `key`).
// A config that createHana refuses (unknown environment, malformed publishable key, bad evm/stellar config) is a
// programming error: it is thrown from the provider's render, to the nearest error boundary.
import { type HanaClient, type HanaConfig, createHana } from '@hana-id/web';
import { type ReactNode, createContext, useEffect, useRef, useState } from 'react';
import { EMPTY_STORE, type HanaStore, createStore } from './store.ts';

export interface HanaContextValue {
  /** null until the provider's mount effect has run (first render, server render). */
  readonly client: HanaClient | null;
  readonly store: HanaStore;
}

/** null outside a HanaProvider. */
export const HanaContext = createContext<HanaContextValue | null>(null);
HanaContext.displayName = 'HanaContext';

const NO_CLIENT: HanaContextValue = Object.freeze({ client: null, store: EMPTY_STORE });

export interface HanaProviderProps {
  /** createHana's config. Read once, at mount. */
  config: HanaConfig;
  children?: ReactNode;
}

interface Mounted {
  readonly client: HanaClient;
  readonly value: HanaContextValue;
  released: boolean;
}

/** Each released client's destroy, until its microtask runs it or a provider about to create a client runs it first. */
const pendingDestroys = new Set<() => void>();

// The return type is inferred (JSX.Element under every @types/react): a `ReactNode` annotation isn't accepted as a JSX
// component by older @types/react 18 releases, and `JSX.Element` has no import that works under both 18 and 19.
export function HanaProvider({ config, children }: HanaProviderProps) {
  const initialConfig = useRef(config);
  const mounted = useRef<Mounted | null>(null);
  const [value, setValue] = useState<HanaContextValue>(NO_CLIENT);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    let m = mounted.current;
    if (m) {
      m.released = false;
    } else {
      // A remount's old client goes first (see the header).
      for (const destroy of [...pendingDestroys]) destroy();
      let client: HanaClient;
      try {
        client = createHana(initialConfig.current);
      } catch (error) {
        setFailure({ error });
        return;
      }
      m = { client, value: Object.freeze({ client, store: createStore(client) }), released: false };
      mounted.current = m;
    }
    setValue(m.value);
    const owned = m;
    return () => {
      owned.released = true;
      const destroy = () => {
        // Runs once: from a provider about to create a client, or from its microtask, whichever comes first.
        if (!pendingDestroys.delete(destroy)) return;
        if (!owned.released) return;
        if (mounted.current === owned) mounted.current = null;
        owned.client.destroy();
      };
      pendingDestroys.add(destroy);
      queueMicrotask(destroy);
    };
  }, []);

  if (failure) throw failure.error;
  return <HanaContext.Provider value={value}>{children}</HanaContext.Provider>;
}
