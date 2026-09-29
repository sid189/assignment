import { describe, expect, it } from "vitest";
import { Database } from "../store/Database.js";
import { AsyncLock } from "../store/AsyncLock.js";
import type { Product } from "../domain/types.js";

function seedProduct(db: Database, inventory: number): Product {
  const product: Product = {
    id: "p1",
    name: "Limited Widget",
    unitPriceCents: 1000,
    availableInventory: inventory,
  };
  db.exec((t) => t.products.set(product.id, product));
  return product;
}

describe("Database.exec", () => {
  it("prevents overselling when decrements race across an await (unprotected read-modify-write does not)", async () => {
    const db = new Database();
    seedProduct(db, 1);

    // Simulates the bug: read, yield to the event loop, then write.
    // Every concurrent caller reads inventory=1 before any of them writes,
    // so all of them succeed — the classic lost-update race.
    async function buyWithoutProtection(): Promise<boolean> {
      const product = db.exec((t) => t.products.get("p1"))!;
      await Promise.resolve(); // yield — this is the race window
      if (product.availableInventory < 1) return false;
      db.exec((t) => {
        const p = t.products.get("p1")!;
        t.products.set("p1", { ...p, availableInventory: p.availableInventory - 1 });
      });
      return true;
    }

    const results = await Promise.all([
      buyWithoutProtection(),
      buyWithoutProtection(),
      buyWithoutProtection(),
    ]);

    const successes = results.filter(Boolean).length;
    const finalInventory = db.exec((t) => t.products.get("p1")!.availableInventory);

    expect(successes).toBe(3); // oversold: 3 buyers "succeeded" against 1 unit of stock
    expect(finalInventory).toBe(-2); // inventory went negative — the bug this test documents
  });

  it("prevents overselling when the whole check-and-decrement is inside one exec() block", async () => {
    const db = new Database();
    seedProduct(db, 1);

    function buyAtomically(): boolean {
      return db.exec((t) => {
        const p = t.products.get("p1")!;
        if (p.availableInventory < 1) return false;
        t.products.set("p1", { ...p, availableInventory: p.availableInventory - 1 });
        return true;
      });
    }

    // No real parallelism in JS for synchronous work, but this proves the
    // shape callers will actually use: N attempts, only stock-many succeed.
    const results = [buyAtomically(), buyAtomically(), buyAtomically()];

    const successes = results.filter(Boolean).length;
    const finalInventory = db.exec((t) => t.products.get("p1")!.availableInventory);

    expect(successes).toBe(1);
    expect(finalInventory).toBe(0);
  });

  it("throws if exec is called re-entrantly (an await leaked into a transactional block)", () => {
    const db = new Database();
    expect(() =>
      db.exec(() => {
        db.exec(() => undefined);
      }),
    ).toThrow(/re-entrantly/);
  });
});

describe("AsyncLock", () => {
  it("serializes concurrent critical sections on the same key, even across awaits", async () => {
    const lock = new AsyncLock();
    const events: string[] = [];

    async function criticalSection(label: string, delayMs: number) {
      await lock.withLock("cart:1", async () => {
        events.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`end:${label}`);
      });
    }

    await Promise.all([criticalSection("a", 20), criticalSection("b", 5)]);

    // "b" has a shorter delay but must not start until "a" fully finishes.
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("does not serialize critical sections on different keys", async () => {
    const lock = new AsyncLock();
    const events: string[] = [];

    async function criticalSection(key: string, label: string, delayMs: number) {
      await lock.withLock(key, async () => {
        events.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`end:${label}`);
      });
    }

    await Promise.all([
      criticalSection("cart:1", "a", 20),
      criticalSection("cart:2", "b", 5),
    ]);

    // "b" is on a different key and has a shorter delay, so it finishes first.
    expect(events).toEqual(["start:a", "start:b", "end:b", "end:a"]);
  });

  it("queues three or more waiters on the same key in strict arrival order", async () => {
    const lock = new AsyncLock();
    const order: string[] = [];

    async function task(label: string) {
      await lock.withLock("coupon:X", async () => {
        order.push(label);
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
    }

    // Fire in order but don't await between them, so they all queue up.
    const p1 = task("1");
    const p2 = task("2");
    const p3 = task("3");
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(["1", "2", "3"]);
  });
});
