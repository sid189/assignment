import { describe, expect, it } from "vitest";
import { buildTestHarness, expectAppErrorCode } from "./testHarness.js";

async function completeOrder(harness: ReturnType<typeof buildTestHarness>, customerId: string, key: string) {
  const cart = harness.carts.createCart(customerId);
  harness.carts.addItem(cart.id, "p-mug", 1);
  return harness.checkout.checkout({ cartId: cart.id, idempotencyKey: key });
}

describe("CouponService", () => {
  it("refuses to generate before the milestone is reached", () => {
    const { coupons } = buildTestHarness({ reward: { milestoneEvery: 5, discountPercent: 10 } });
    expectAppErrorCode(() => coupons.generateForCustomer("cust1"), "MILESTONE_NOT_REACHED");
  });

  it("generates a coupon scoped to the customer once the milestone is reached", async () => {
    const harness = buildTestHarness({ reward: { milestoneEvery: 2, discountPercent: 15 } });
    await completeOrder(harness, "cust1", "o1");
    expectAppErrorCode(() => harness.coupons.generateForCustomer("cust1"), "MILESTONE_NOT_REACHED");

    await completeOrder(harness, "cust1", "o2");
    const coupon = harness.coupons.generateForCustomer("cust1");

    expect(coupon.customerId).toBe("cust1");
    expect(coupon.discountPercent).toBe(15);
    expect(coupon.milestoneOrderNumber).toBe(2);
    expect(coupon.status).toBe("available");
  });

  it("does not generate a second coupon for the same milestone", async () => {
    const harness = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 10 } });
    await completeOrder(harness, "cust1", "o1");

    harness.coupons.generateForCustomer("cust1"); // consumes milestone 1
    expectAppErrorCode(() => harness.coupons.generateForCustomer("cust1"), "MILESTONE_NOT_REACHED");
  });

  it("tracks each customer's milestones independently", async () => {
    const harness = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 10 } });
    await completeOrder(harness, "cust1", "o1");

    const coupon = harness.coupons.generateForCustomer("cust1");
    expect(coupon.customerId).toBe("cust1");
    expectAppErrorCode(() => harness.coupons.generateForCustomer("cust2"), "MILESTONE_NOT_REACHED");
  });

  it("only produces one coupon even when generation is requested many times back-to-back at the milestone", async () => {
    const harness = buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 10 } });
    await completeOrder(harness, "cust1", "o1");

    // generateForCustomer is synchronous end-to-end (no await inside), so
    // Database.exec's atomicity — proven generically in store.test.ts —
    // guarantees exactly one of these can ever succeed for milestone 1.
    const attempts = Array.from({ length: 5 }, () => {
      try {
        return harness.coupons.generateForCustomer("cust1");
      } catch {
        return null;
      }
    });

    const successes = attempts.filter((c) => c !== null);
    expect(successes).toHaveLength(1);
  });
});
