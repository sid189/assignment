import { describe, expect, it } from "vitest";
import { buildTestHarness } from "./testHarness.js";

describe("ReportService", () => {
  it("reconciles with the underlying orders and coupons, and is stable across repeated reads", async () => {
    const harness = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 10 } });
    const { carts, checkout, coupons, report } = harness;

    const cart1 = carts.createCart("cust1");
    carts.addItem(cart1.id, "p-mug", 2); // 2598
    await checkout.checkout({ cartId: cart1.id, idempotencyKey: "o1" });

    const coupon = coupons.generateForCustomer("cust1");

    const cart2 = carts.createCart("cust1");
    carts.addItem(cart2.id, "p-notebook", 1); // 899, 10% off -> 89 discount
    await checkout.checkout({ cartId: cart2.id, couponCode: coupon.code, idempotencyKey: "o2" });

    const summary = report.getSummary();

    expect(summary.totalSuccessfulOrders).toBe(2);
    expect(summary.purchasedQuantityByProduct).toEqual({ "p-mug": 2, "p-notebook": 1 });
    expect(summary.grossRevenueCents).toBe(2598 + 899);
    expect(summary.totalDiscountCents).toBe(89);
    expect(summary.netRevenueCents).toBe(2598 + 899 - 89);
    expect(summary.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });

    const secondRead = report.getSummary();
    expect(secondRead).toEqual(summary);
  });

  it("excludes a checkout that failed payment from every figure", async () => {
    const { carts, checkout, report } = buildTestHarness({
      paymentGateway: { charge: async () => ({ success: false, reason: "declined" }) },
    });
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);
    await checkout.checkout({ cartId: cart.id, idempotencyKey: "k1" }).catch(() => undefined);

    const summary = report.getSummary();
    expect(summary.totalSuccessfulOrders).toBe(0);
    expect(summary.grossRevenueCents).toBe(0);
    expect(summary.purchasedQuantityByProduct).toEqual({});
  });
});
