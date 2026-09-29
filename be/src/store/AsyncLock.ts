/**
 * Per-key async mutex: a FIFO queue of promises, one chain per key. Unlike
 * `Database.exec`, the critical section here CAN `await` — the caller holds
 * the lock across real async work (e.g. a payment call) and everyone else
 * waiting on the same key queues behind it in arrival order.
 *
 * This is the in-process stand-in for a Redis distributed lock
 * (`SET key val NX PX ttl` + token-checked Lua unlock / Redlock). See
 * API_DESIGN.md "Store engine".
 */
export class AsyncLock {
  private tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const myTurnDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const myTail = previousTail.then(() => myTurnDone);
    this.tails.set(key, myTail);

    await previousTail;
    try {
      return await fn();
    } finally {
      release();
      // Only clear the entry if nobody has queued behind us — if someone
      // has, the map already points at their tail and must be left alone.
      if (this.tails.get(key) === myTail) {
        this.tails.delete(key);
      }
    }
  }
}
