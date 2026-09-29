import { describe, expect, it } from "vitest";
import { buildTestHarness, expectAppErrorCode } from "./testHarness.js";

describe("CartService", () => {
  it("creates a cart and adds items, merging quantity for a repeated product", () => {
    const { carts } = buildTestHarness();
    const cart = carts.createCart("cust1");

    carts.addItem(cart.id, "p-mug", 2);
    carts.addItem(cart.id, "p-mug", 3);

    const view = carts.getCartView(cart.id);
    expect(view.items).toEqual([{ productId: "p-mug", quantity: 5, unitPriceCents: 1299, lineTotalCents: 6495 }]);
    expect(view.subtotalCents).toBe(6495);
  });

  it("rejects a quantity that exceeds available inventory", () => {
    const { carts } = buildTestHarness();
    const cart = carts.createCart("cust1");
    expectAppErrorCode(() => carts.addItem(cart.id, "p-poster", 4), "INSUFFICIENT_INVENTORY");
  });

  it("rejects a non-positive or non-integer quantity", () => {
    const { carts } = buildTestHarness();
    const cart = carts.createCart("cust1");
    expectAppErrorCode(() => carts.addItem(cart.id, "p-mug", 0), "VALIDATION_ERROR");
    expectAppErrorCode(() => carts.addItem(cart.id, "p-mug", 1.5), "VALIDATION_ERROR");
  });

  it("404s on an unknown product or cart", () => {
    const { carts } = buildTestHarness();
    const cart = carts.createCart("cust1");
    expectAppErrorCode(() => carts.addItem(cart.id, "does-not-exist", 1), "PRODUCT_NOT_FOUND");
    expectAppErrorCode(() => carts.addItem("no-such-cart", "p-mug", 1), "CART_NOT_FOUND");
  });

  it("updates and removes items, 404ing on an item that was never added", () => {
    const { carts } = buildTestHarness();
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 2);

    carts.updateItemQuantity(cart.id, "p-mug", 5);
    expect(carts.getCartView(cart.id).items[0]?.quantity).toBe(5);

    expectAppErrorCode(() => carts.updateItemQuantity(cart.id, "p-pen", 1), "ITEM_NOT_IN_CART");

    carts.removeItem(cart.id, "p-mug");
    expect(carts.getCartView(cart.id).items).toEqual([]);

    expectAppErrorCode(() => carts.removeItem(cart.id, "p-mug"), "ITEM_NOT_IN_CART");
  });

  it("rejects item mutation on a cart that is no longer open", () => {
    const { carts, db } = buildTestHarness();
    const cart = carts.createCart("cust1");
    carts.addItem(cart.id, "p-mug", 1);

    // Simulate a completed checkout without going through CheckoutService,
    // to keep this a pure CartService unit test.
    db.exec((t) => t.carts.set(cart.id, { ...t.carts.get(cart.id)!, status: "checked_out" }));

    expectAppErrorCode(() => carts.addItem(cart.id, "p-pen", 1), "CART_ALREADY_CHECKED_OUT");
    expectAppErrorCode(() => carts.updateItemQuantity(cart.id, "p-mug", 2), "CART_ALREADY_CHECKED_OUT");
    expectAppErrorCode(() => carts.removeItem(cart.id, "p-mug"), "CART_ALREADY_CHECKED_OUT");
  });
});
