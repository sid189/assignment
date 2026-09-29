import type {
  Cart,
  Coupon,
  IdempotencyRecord,
  Order,
  Product,
  RewardCounter,
} from "../domain/types.js";

export interface Tables {
  products: Map<string, Product>;
  carts: Map<string, Cart>;
  orders: Map<string, Order>;
  coupons: Map<string, Coupon>;
  rewardCounters: Map<string, RewardCounter>;
  idempotencyKeys: Map<string, IdempotencyRecord>;
}

/**
 * Hand-rolled, Redis-inspired in-memory store. `exec` is the atomicity
 * primitive: `fn` must be synchronous (no `await` inside it), which lets
 * Node's run-to-completion guarantee do the work a Redis Lua script or a
 * DB transaction would otherwise do — no two `exec` calls can ever
 * interleave. See API_DESIGN.md "Store engine".
 */
export class Database {
  readonly tables: Tables = {
    products: new Map(),
    carts: new Map(),
    orders: new Map(),
    coupons: new Map(),
    rewardCounters: new Map(),
    idempotencyKeys: new Map(),
  };

  private busy = false;

  exec<T>(fn: (tables: Tables) => T): T {
    if (this.busy) {
      throw new Error(
        "Database.exec called re-entrantly — an async gap leaked into a " +
          "transactional block. Every exec() callback must be synchronous.",
      );
    }
    this.busy = true;
    try {
      return fn(this.tables);
    } finally {
      this.busy = false;
    }
  }
}
