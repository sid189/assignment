import { describe, expect, it } from "vitest";
import { buildTestHarness, expectAppErrorCode, expectAsyncAppErrorCode } from "./testHarness.js";
import type { PaymentContext, PaymentGateway, PaymentResult } from "../services/paymentGateway.js";

class CountingPaymentGateway implements PaymentGateway {
  calls = 0;
  constructor(private readonly result: PaymentResult, private readonly delayMs = 5) {}
  async charge(_amountCents: number, _context: PaymentContext): Promise<PaymentResult> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.result;
  }
}

describe("CheckoutService — happy path and money", () => {
  it("creates an order with the expected totals and decrements inventory", async () => {
    const { carts, checkout, products } = buildTestHarness();
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 2); // 1299 * 2 = 2598

    const order = await checkout.checkout({ cartId: cart.id, idempotencyKey: "k1" });

    expect(order.status).toBe("placed");
    expect(order.subtotalCents).toBe(2598);
    expect(order.discountCents).toBe(0);
    expect(order.totalCents).toBe(2598);
    expect(order.items).toEqual([
      { productId: "p-mug", productName: "Ceramic Mug", unitPriceCents: 1299, quantity: 2, lineTotalCents: 2598 },
    ]);
    expect(products.get("p-mug").availableInventory).toBe(98);
  });

  it("truncates the discount instead of rounding, and never lets the total go negative", async () => {
    const { carts, checkout, coupons } = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 33 } });

    const firstCart = carts.createCart("cust1");
    carts.addItem(firstCart.id, "p-notebook", 1); // 899 cents
    await checkout.checkout({ cartId: firstCart.id, idempotencyKey: "seed-order" });

    const coupon = coupons.generateForCustomer("cust1"); // 33% off, milestone 1

    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-notebook", 1); // 899 cents * 33% = 296.67 -> floor 296
    const order = await checkout.checkout({ cartId: cart.id, couponCode: coupon.code, idempotencyKey: "k2" });

    expect(order.subtotalCents).toBe(899);
    expect(order.discountCents).toBe(296);
    expect(order.totalCents).toBe(603);
    expect(order.totalCents).toBeGreaterThanOrEqual(0);
  });
});

describe("CheckoutService — validation", () => {
  it("rejects checkout without an Idempotency-Key", async () => {
    const { carts, checkout } = buildTestHarness();
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);
    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cart.id, idempotencyKey: undefined }),
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });

  it("rejects checkout of an empty cart", async () => {
    const { carts, checkout } = buildTestHarness();
    const cart = carts.createCart("cust1");
    await expectAsyncAppErrorCode(() => checkout.checkout({ cartId: cart.id, idempotencyKey: "k1" }), "CART_EMPTY");
  });

  it("rejects checking out the same cart twice with different idempotency keys", async () => {
    const { carts, checkout } = buildTestHarness();
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);
    await checkout.checkout({ cartId: cart.id, idempotencyKey: "k1" });
    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cart.id, idempotencyKey: "k2" }),
      "CART_ALREADY_CHECKED_OUT",
    );
  });
});

describe("CheckoutService — idempotency", () => {
  it("replays the same order on a retry with the same key, without charging or decrementing twice", async () => {
    const gateway = new CountingPaymentGateway({ success: true });
    const { carts, checkout, products } = buildTestHarness({ paymentGateway: gateway });
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);

    const first = await checkout.checkout({ cartId: cart.id, idempotencyKey: "same-key" });
    const second = await checkout.checkout({ cartId: cart.id, idempotencyKey: "same-key" });

    expect(second.id).toBe(first.id);
    expect(gateway.calls).toBe(1);
    expect(products.get("p-mug").availableInventory).toBe(99);
  });

  it("rejects reusing an idempotency key against a different cart", async () => {
    const { carts, checkout } = buildTestHarness();
    const cartA = carts.createCart("cust1");
    carts.addItem(cartA.id, "p-mug", 1);
    const cartB = carts.createCart("cust1");
    carts.addItem(cartB.id, "p-pen", 1);

    await checkout.checkout({ cartId: cartA.id, idempotencyKey: "shared-key" });
    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cartB.id, idempotencyKey: "shared-key" }),
      "IDEMPOTENCY_KEY_CONFLICT",
    );
  });

  it("two truly concurrent retries of the same cart+key only pay once and produce one order", async () => {
    const gateway = new CountingPaymentGateway({ success: true }, 20);
    const { carts, checkout } = buildTestHarness({ paymentGateway: gateway });
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);

    const [a, b] = await Promise.all([
      checkout.checkout({ cartId: cart.id, idempotencyKey: "race-key" }),
      checkout.checkout({ cartId: cart.id, idempotencyKey: "race-key" }),
    ]);

    expect(a.id).toBe(b.id);
    expect(gateway.calls).toBe(1);
  });

  it("rolls back inventory and coupon on a declined payment, and replays the same failure on retry", async () => {
    const gateway = new CountingPaymentGateway({ success: false, reason: "insufficient funds" });
    const { carts, checkout, products } = buildTestHarness({ paymentGateway: gateway });
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 2);

    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cart.id, idempotencyKey: "declined-key" }),
      "PAYMENT_DECLINED",
    );
    expect(products.get("p-mug").availableInventory).toBe(100); // rolled back
    expect(carts.getCartView(cart.id).status).toBe("open"); // cart can still be retried

    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cart.id, idempotencyKey: "declined-key" }),
      "PAYMENT_DECLINED",
    );
    expect(gateway.calls).toBe(1); // second call was served from the recorded failure
  });

  it("allows a genuinely new attempt (new key) on the same cart to succeed after a prior decline", async () => {
    // A gateway that declines once, then accepts — models a customer fixing
    // a payment issue and retrying with a fresh Idempotency-Key. This also
    // proves the per-cart AsyncLock is actually released after a failed
    // attempt: if it weren't, this second call would hang rather than fail
    // or succeed (see the direct AsyncLock proof in store.test.ts).
    let callCount = 0;
    const flakyGateway: PaymentGateway = {
      async charge() {
        callCount += 1;
        return callCount === 1 ? { success: false, reason: "temporary" } : { success: true };
      },
    };
    const { carts, checkout } = buildTestHarness({ paymentGateway: flakyGateway });
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);

    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cart.id, idempotencyKey: "attempt-1" }),
      "PAYMENT_DECLINED",
    );

    const order = await checkout.checkout({ cartId: cart.id, idempotencyKey: "attempt-2" });
    expect(order.status).toBe("placed");
    expect(callCount).toBe(2);
  });
});

describe("CheckoutService — concurrency across different carts", () => {
  it("does not oversell limited inventory when different carts race for the same product", async () => {
    const { carts, checkout, products } = buildTestHarness();

    const buyers = Array.from({ length: 5 }, (_, i) => `cust-${i}`);
    const cartIds = buyers.map((customerId) => {
      const cart = carts.createCart(customerId);
      carts.addItem(cart.id, "p-poster", 1); // stock is 3
      return cart.id;
    });

    const results = await Promise.allSettled(
      cartIds.map((cartId, i) => checkout.checkout({ cartId, idempotencyKey: `key-${i}` })),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(2);
    expect(products.get("p-poster").availableInventory).toBe(0);
  });

  it("keeps two independently-scarce products from cross-contaminating under concurrent carts", async () => {
    const { carts, checkout, products } = buildTestHarness();

    // Every cart wants 1 of BOTH scarce products in the same checkout:
    // p-poster (stock 3) and p-scarf (stock 2). If reservation logic ever
    // leaked state between products (e.g. reusing a shared counter instead
    // of per-product inventory), this would show up as the wrong success
    // count on one or both.
    const cartIds = Array.from({ length: 5 }, (_, i) => {
      const cart = carts.createCart(`cust-${i}`);
      carts.addItem(cart.id, "p-poster", 1);
      carts.addItem(cart.id, "p-scarf", 1);
      return cart.id;
    });

    const results = await Promise.allSettled(
      cartIds.map((cartId, i) => checkout.checkout({ cartId, idempotencyKey: `dual-${i}` })),
    );

    // Every checkout needs BOTH items, and p-scarf (stock 2) is the
    // tighter constraint, so exactly 2 succeed — not "at most 2": carts
    // attempt reserve() in creation order (each checkout's synchronous
    // prefix runs to completion before the next resumes, since reserve()
    // itself never awaits), so this is deterministic, not probabilistic.
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded).toHaveLength(2);
    expect(products.get("p-poster").availableInventory).toBe(1); // 3 - 2
    expect(products.get("p-scarf").availableInventory).toBe(0); // 2 - 2
  });

  it("rejects adding an already-sold-out product immediately, not just at checkout", () => {
    const { carts } = buildTestHarness();
    const cart = carts.createCart("cust1");
    expectAppErrorCode(() => carts.addItem(cart.id, "p-typewriter", 1), "INSUFFICIENT_INVENTORY");
  });

  it("only one of two concurrent checkouts (different carts, same customer) can redeem the same coupon", async () => {
    const { carts, checkout, coupons } = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 10 } });

    const seedCart = carts.createCart("cust1");
    carts.addItem(seedCart.id, "p-notebook", 1);
    await checkout.checkout({ cartId: seedCart.id, idempotencyKey: "seed" });
    const coupon = coupons.generateForCustomer("cust1");

    const cartA = carts.createCart("cust1");
    carts.addItem(cartA.id, "p-mug", 1);
    const cartB = carts.createCart("cust1");
    carts.addItem(cartB.id, "p-pen", 1);

    const results = await Promise.allSettled([
      checkout.checkout({ cartId: cartA.id, couponCode: coupon.code, idempotencyKey: "coupon-a" }),
      checkout.checkout({ cartId: cartB.id, couponCode: coupon.code, idempotencyKey: "coupon-b" }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded).toHaveLength(1);
  });
});

describe("CheckoutService — coupon rules", () => {
  it("rejects a coupon that belongs to a different customer", async () => {
    const { carts, checkout, coupons } = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 10 } });
    const seedCart = carts.createCart("cust1");
    carts.addItem(seedCart.id, "p-notebook", 1);
    await checkout.checkout({ cartId: seedCart.id, idempotencyKey: "seed" });
    const coupon = coupons.generateForCustomer("cust1");

    const otherCart = carts.createCart("cust2");
    carts.addItem(otherCart.id, "p-mug", 1);
    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: otherCart.id, couponCode: coupon.code, idempotencyKey: "k" }),
      "COUPON_INVALID",
    );
  });

  it("rejects an already-redeemed coupon", async () => {
    const { carts, checkout, coupons } = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 10 } });
    const seedCart = carts.createCart("cust1");
    carts.addItem(seedCart.id, "p-notebook", 1);
    await checkout.checkout({ cartId: seedCart.id, idempotencyKey: "seed" });
    const coupon = coupons.generateForCustomer("cust1");

    const cartA = carts.createCart("cust1");
    carts.addItem(cartA.id, "p-mug", 1);
    await checkout.checkout({ cartId: cartA.id, couponCode: coupon.code, idempotencyKey: "first-use" });

    const cartB = carts.createCart("cust1");
    carts.addItem(cartB.id, "p-pen", 1);
    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cartB.id, couponCode: coupon.code, idempotencyKey: "second-use" }),
      "COUPON_ALREADY_REDEEMED",
    );
  });
});

describe("CheckoutService — reservation atomicity", () => {
  it("never partially decrements inventory when a later item in the same cart fails validation", async () => {
    const { carts, checkout, products } = buildTestHarness();

    // Cart holds 1 p-mug (item 1) and all 3 p-poster (item 2) — both pass
    // CartService's add-time check (3 <= 3 available at add-time).
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);
    carts.addItem(cart.id, "p-poster", 3);

    // A different cart buys 1 of the 3 p-posters in the meantime, so by the
    // time our cart checks out, item 2 (p-poster) is no longer satisfiable
    // — but item 1 (p-mug) still is. This is what actually exercises the
    // "later item fails" path, since add-time checks alone can't produce it.
    const otherCart = carts.createCart("cust2");
    carts.addItem(otherCart.id, "p-poster", 1);
    await checkout.checkout({ cartId: otherCart.id, idempotencyKey: "drain-stock" });
    expect(products.get("p-poster").availableInventory).toBe(2);

    await expectAsyncAppErrorCode(
      () => checkout.checkout({ cartId: cart.id, idempotencyKey: "partial-fail" }),
      "INSUFFICIENT_INVENTORY",
    );

    // The cart failed as a whole: p-mug (item 1, validated fine) must be
    // untouched, not decremented-then-orphaned because item 2 in the same
    // reserve() pass failed after it.
    expect(products.get("p-mug").availableInventory).toBe(100);
    expect(products.get("p-poster").availableInventory).toBe(2);
  });

  it("rejects a losing concurrent checkout for a shared coupon before it ever calls payment", async () => {
    const gateway = new CountingPaymentGateway({ success: true }, 20);
    const { carts, checkout, coupons } = buildTestHarness({
      paymentGateway: gateway,
      reward: { milestoneEvery: 1, discountPercent: 10 },
    });

    const seedCart = carts.createCart("cust1");
    carts.addItem(seedCart.id, "p-notebook", 1);
    await checkout.checkout({ cartId: seedCart.id, idempotencyKey: "seed" });
    const coupon = coupons.generateForCustomer("cust1");
    gateway.calls = 0; // ignore the seed order's payment call

    const cartA = carts.createCart("cust1");
    carts.addItem(cartA.id, "p-mug", 1);
    const cartB = carts.createCart("cust1");
    carts.addItem(cartB.id, "p-pen", 1);

    const results = await Promise.allSettled([
      checkout.checkout({ cartId: cartA.id, couponCode: coupon.code, idempotencyKey: "race-a" }),
      checkout.checkout({ cartId: cartB.id, couponCode: coupon.code, idempotencyKey: "race-b" }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded).toHaveLength(1);
    // The old (pre-fix) behavior let both checkouts pay and only rejected
    // the loser at finalize, after payment — this asserts the loser is now
    // rejected at reserve(), before payment is ever attempted.
    expect(gateway.calls).toBe(1);
  });
});
