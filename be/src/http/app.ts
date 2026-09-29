import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";
import type { AppServices } from "./types.js";
import { productsRouter } from "./routes/products.js";
import { cartsRouter } from "./routes/carts.js";
import { ordersRouter } from "./routes/orders.js";
import { adminRouter } from "./routes/admin.js";
import { errorHandler, notFoundHandler } from "./errorHandler.js";
import { openApiDocument } from "./openApiDocument.js";

// public/ sits at the package root, alongside openapi.yaml — see the same
// resolution note in openApiDocument.ts.
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

export function buildApp(services: AppServices): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  app.get("/openapi.json", (_req, res) => res.status(200).json(openApiDocument));

  // Small demo UI over the real API (no mocking) — kept intentionally
  // separate from "/", which stays a JSON index for API-focused clients.
  app.use("/demo", express.static(publicDir));

  app.get("/", (_req, res) => {
    res.status(200).json({
      service: "checkout-rewards-service",
      docs: "/docs (interactive Swagger UI) — raw spec also at /openapi.json or openapi.yaml in the repo.",
      demo: "/demo — a small browser UI exercising this same API, including a live concurrency-oversell demo.",
      endpoints: [
        "GET  /health",
        "GET  /products",
        "POST /carts",
        "GET  /carts/:cartId",
        "POST /carts/:cartId/items",
        "PATCH /carts/:cartId/items/:productId",
        "DELETE /carts/:cartId/items/:productId",
        "POST /carts/:cartId/checkout (requires Idempotency-Key header)",
        "GET  /orders/:orderId",
        "POST /admin/coupons/generate",
        "GET  /admin/reports/summary",
      ],
    });
  });

  app.use(productsRouter(services));
  app.use(cartsRouter(services));
  app.use(ordersRouter(services));
  app.use(adminRouter(services));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
