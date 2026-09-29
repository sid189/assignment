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
