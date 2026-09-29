import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../http/app.js";
import { buildTestHarness } from "./testHarness.js";

describe("HTTP layer", () => {
  it("serves a landing response at / listing the available endpoints", async () => {
    const app = buildApp(buildTestHarness());
    const res = await request(app).get("/").expect(200);
    expect(res.body.service).toBe("checkout-rewards-service");
    expect(res.body.endpoints).toEqual(expect.arrayContaining([expect.stringContaining("/products")]));
  });

  it("serves the raw OpenAPI spec and an interactive Swagger UI", async () => {
    const app = buildApp(buildTestHarness());

    const spec = await request(app).get("/openapi.json").expect(200);
    expect(spec.body.openapi).toBe("3.0.3");
    expect(spec.body.paths).toHaveProperty("/carts/{cartId}/checkout");

    const docsPage = await request(app).get("/docs/").expect(200);
    expect(docsPage.text).toContain("swagger-ui");
  });

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

  it("rejects a non-string customerId (type, not just presence)", async () => {
    const app = buildApp(buildTestHarness());
    const res = await request(app).post("/carts").send({ customerId: 12345 }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-number quantity, distinctly from a missing one", async () => {
    const app = buildApp(buildTestHarness());
    const cart = await request(app).post("/carts").send({ customerId: "cust1" });

    const stringQty = await request(app)
      .post(`/carts/${cart.body.id}/items`)
      .send({ productId: "p-mug", quantity: "2" })
      .expect(400);
    expect(stringQty.body.error.code).toBe("VALIDATION_ERROR");

    const nanQty = await request(app)
      .post(`/carts/${cart.body.id}/items`)
      .send({ productId: "p-mug", quantity: null })
      .expect(400);
    expect(nanQty.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing productId as VALIDATION_ERROR, distinctly from an unknown one", async () => {
    const app = buildApp(buildTestHarness());
    const cart = await request(app).post("/carts").send({ customerId: "cust1" });

    const missing = await request(app)
      .post(`/carts/${cart.body.id}/items`)
      .send({ quantity: 1 })
      .expect(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");

    const unknown = await request(app)
      .post(`/carts/${cart.body.id}/items`)
      .send({ productId: "does-not-exist", quantity: 1 })
      .expect(404);
    expect(unknown.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("naturally rejects an absurdly large quantity via the inventory check, not silently", async () => {
    const app = buildApp(buildTestHarness());
    const cart = await request(app).post("/carts").send({ customerId: "cust1" });
    const res = await request(app)
      .post(`/carts/${cart.body.id}/items`)
      .send({ productId: "p-mug", quantity: 1e15 })
      .expect(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_INVENTORY");
  });

  it("rejects a missing customerId on admin coupon generation", async () => {
    const app = buildApp(buildTestHarness());
    const res = await request(app).post("/admin/coupons/generate").send({}).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
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

  it("generates exactly one coupon when the admin endpoint is hit concurrently at the same milestone", async () => {
    const app = buildApp(buildTestHarness({ reward: { milestoneEvery: 1, discountPercent: 15 } }));

    const cart = await request(app).post("/carts").send({ customerId: "cust1" });
    await request(app).post(`/carts/${cart.body.id}/items`).send({ productId: "p-notebook", quantity: 1 });
    await request(app).post(`/carts/${cart.body.id}/checkout`).set("Idempotency-Key", "k").send({}).expect(201);

    // Five genuinely concurrent HTTP requests, not a sequential loop —
    // exercises Database.exec()'s atomicity through the real Express stack.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post("/admin/coupons/generate").send({ customerId: "cust1" })),
    );

    const succeeded = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    rejected.forEach((r) => expect(r.body.error.code).toBe("MILESTONE_NOT_REACHED"));
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

  it("413s a request body over the size limit instead of a generic 500", async () => {
    const app = buildApp(buildTestHarness());
    // express.json()'s default limit is 100kb; comfortably exceed it.
    const oversized = { customerId: "x".repeat(200_000) };
    const res = await request(app).post("/carts").send(oversized).expect(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
