// A tiny, isomorphic typed event emitter. RoomClient extends this instead of
// Node's `EventEmitter` so the client bundles unchanged on React Native and the
// browser (Metro doesn't resolve `node:events`). It's the small subset the
// client and its consumers actually use — on / once / off / emit /
// listenerCount — typed against an events map so listeners and payloads match.
//
// Deliberately simpler than Node's emitter in one way: emitting "error" with no
// listener does NOT throw. The client already guards error emits behind
// `listenerCount("error")`, and a transient socket error must never crash the
// process — the reconnect loop is the recovery path.

/** An events map: event name -> the listener signature for that event. Written
 *  as a self-referential constraint (rather than `Record<string, …>`) so a plain
 *  interface of named events satisfies it without needing an index signature. */
export type EventMap<E> = { [K in keyof E]: (...args: any[]) => void };

export class Emitter<E extends EventMap<E>> {
  private listeners: { [K in keyof E]?: Set<E[K]> } = {};

  on<K extends keyof E>(event: K, fn: E[K]): this {
    (this.listeners[event] ??= new Set()).add(fn);
    return this;
  }

  once<K extends keyof E>(event: K, fn: E[K]): this {
    const wrap = ((...args: Parameters<E[K]>) => {
      this.off(event, wrap);
      fn(...args);
    }) as E[K];
    return this.on(event, wrap);
  }

  off<K extends keyof E>(event: K, fn: E[K]): this {
    this.listeners[event]?.delete(fn);
    return this;
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): boolean {
    const set = this.listeners[event];
    if (!set || set.size === 0) return false;
    // Snapshot so a listener that removes itself (or others) can't disturb the
    // in-flight dispatch.
    for (const fn of [...set]) fn(...args);
    return true;
  }

  listenerCount<K extends keyof E>(event: K): number {
    return this.listeners[event]?.size ?? 0;
  }

  removeAllListeners(): this {
    this.listeners = {};
    return this;
  }
}
