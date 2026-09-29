import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../http/app.js";
import { buildTestHarness } from "./testHarness.js";

describe("HTTP layer", () => {
  it("supports the full cart -> checkout -> order flow", async () => {
    const app = buildApp(buildTestHarness());

    const createCart = await request(app).post("/carts").send({ customerId: "cust1" }).expect(201);
    const cartId = createCart.body.id as string;

    await request(app).post(`/carts/${cartId}/items`).send({ productId: "p-mug", quantity: 2 }).expect(201);

    const view = await request(app).get(`/carts/${cartId}`).expect(200);
    expect(view.body.subtotalCents).toBe(2598);

    await request(app)
      .patch(`/carts/${cartId}/items/p-mug`)
      .send({ quantity: 1 })
      .expect(200);

    const checkoutRes = await request(app)
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "http-key-1")
      .send({})
      .expect(201);
    expect(checkoutRes.body.status).toBe("placed");
    expect(checkoutRes.body.totalCents).toBe(1299);

    const orderRes = await request(app).get(`/orders/${checkoutRes.body.id}`).expect(200);
    expect(orderRes.body.id).toBe(checkoutRes.body.id);
  });

  it("returns the typed error shape for a validation failure", async () => {
    const app = buildApp(buildTestHarness());
    const res = await request(app).post("/carts").send({}).expect(400);
    expect(res.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: expect.any(String) },
    });
  });

  it("404s a missing cart with the typed error shape", async () => {
    const app = buildApp(buildTestHarness());
    const res = await request(app).get("/carts/does-not-exist").expect(404);
    expect(res.body.error.code).toBe("CART_NOT_FOUND");
  });

  it("requires Idempotency-Key on checkout", async () => {
    const app = buildApp(buildTestHarness());
    const cart = await request(app).post("/carts").send({ customerId: "cust1" });
    await request(app).post(`/carts/${cart.body.id}/items`).send({ productId: "p-mug", quantity: 1 });

    const res = await request(app).post(`/carts/${cart.body.id}/checkout`).send({}).expect(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("replays the same order body on a retried checkout request", async () => {
    const app = buildApp(buildTestHarness());
    const cart = await request(app).post("/carts").send({ customerId: "cust1" });
    await request(app).post(`/carts/${cart.body.id}/items`).send({ productId: "p-mug", quantity: 1 });

    const first = await request(app)
      .post(`/carts/${cart.body.id}/checkout`)
      .set("Idempotency-Key", "retry-key")
      .send({})
      .expect(201);
    const second = await request(app)
      .post(`/carts/${cart.body.id}/checkout`)
      .set("Idempotency-Key", "retry-key")
      .send({})
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
  });

  it("does not oversell limited inventory under concurrent HTTP checkout requests", async () => {
    const app = buildApp(buildTestHarness());

    const cartIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cart = await request(app).post("/carts").send({ customerId: `cust-${i}` });
      await request(app).post(`/carts/${cart.body.id}/items`).send({ productId: "p-poster", quantity: 1 });
      cartIds.push(cart.body.id);
    }

    const results = await Promise.all(
      cartIds.map((cartId, i) =>
        request(app).post(`/carts/${cartId}/checkout`).set("Idempotency-Key", `poster-${i}`).send({}),
      ),
    );

    const succeeded = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    expect(succeeded).toHaveLength(3);
    expect(conflicted).toHaveLength(2);

    const products = await request(app).get("/products").expect(200);
    const poster = products.body.find((p: { id: string }) => p.id === "p-poster");
    expect(poster.availableInventory).toBe(0);
  });

  it("supports the admin coupon-generation and reporting endpoints", async () => {
    const app = buildApp(buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 20 } }));

    const cart = await request(app).post("/carts").send({ customerId: "cust1" });
    await request(app).post(`/carts/${cart.body.id}/items`).send({ productId: "p-notebook", quantity: 1 });
    await request(app).post(`/carts/${cart.body.id}/checkout`).set("Idempotency-Key", "admin-key").send({}).expect(201);

    const couponRes = await request(app).post("/admin/coupons/generate").send({ customerId: "cust1" }).expect(201);
    expect(couponRes.body.status).toBe("available");
    expect(couponRes.body.discountPercent).toBe(20);

    const notEligible = await request(app)
      .post("/admin/coupons/generate")
      .send({ customerId: "cust1" })
      .expect(409);
    expect(notEligible.body.error.code).toBe("MILESTONE_NOT_REACHED");

    const report = await request(app).get("/admin/reports/summary").expect(200);
    expect(report.body.totalSuccessfulOrders).toBe(1);
    expect(report.body.coupons).toEqual({ generated: 1, available: 1, redeemed: 0 });
  });

  it("404s unknown routes and 400s malformed JSON", async () => {
    const app = buildApp(buildTestHarness());
    const notFound = await request(app).get("/does-not-exist").expect(404);
    expect(notFound.body.error.code).toBe("ROUTE_NOT_FOUND");

    const malformed = await request(app)
      .post("/carts")
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
    expect(malformed.body.error.code).toBe("VALIDATION_ERROR");
  });
});
