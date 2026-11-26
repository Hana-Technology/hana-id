// A small typed event emitter with the Node EventEmitter method names EIP-1193 consumers use (`on`, `once`,
// `removeListener`, `off`, `addListener`, `removeAllListeners`, `listenerCount`). A listener that throws doesn't stop
// the others or the client: its error is rethrown on a fresh task, where it reaches the page's error reporting.

type Listener = (...args: unknown[]) => void;

export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  readonly #listeners = new Map<keyof Events, Listener[]>();

  on<E extends keyof Events>(event: E, listener: (...args: Events[E]) => void): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener as unknown as Listener);
    this.#listeners.set(event, list);
    return this;
  }

  addListener<E extends keyof Events>(event: E, listener: (...args: Events[E]) => void): this {
    return this.on(event, listener);
  }

  once<E extends keyof Events>(event: E, listener: (...args: Events[E]) => void): this {
    const wrapped = (...args: Events[E]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    Object.defineProperty(wrapped, 'listener', { value: listener });
    return this.on(event, wrapped);
  }

  /** Removes the most recently added registration of `listener` (as Node does), including one added with `once`. */
  removeListener<E extends keyof Events>(event: E, listener: (...args: Events[E]) => void): this {
    const list = this.#listeners.get(event);
    if (!list) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i] as Listener & { listener?: Listener };
      if (l === (listener as unknown) || l.listener === (listener as unknown)) {
        list.splice(i, 1);
        break;
      }
    }
    if (list.length === 0) this.#listeners.delete(event);
    return this;
  }

  off<E extends keyof Events>(event: E, listener: (...args: Events[E]) => void): this {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event?: keyof Events): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  listenerCount(event: keyof Events): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  /** Calls every listener of `event` in order, on a snapshot of the list. Returns whether there was any. */
  emit<E extends keyof Events>(event: E, ...args: Events[E]): boolean {
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const l of [...list]) {
      try {
        (l as unknown as (...a: Events[E]) => void)(...args);
      } catch (e) {
        setTimeout(() => {
          throw e;
        }, 0);
      }
    }
    return true;
  }
}
