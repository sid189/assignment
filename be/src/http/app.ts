import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";
import type { AppServices } from "./types.js";
import { productsRouter } from "./routes/products.js";
import { cartsRouter } from "./routes/carts.js";
import { ordersRouter } from "./routes/orders.js";
import { adminRouter } from "./routes/admin.js";
import { errorHandler, notFoundHandler } from "./errorHandler.js";
import { openApiDocument } from "./openApiDocument.js";

export function buildApp(services: AppServices): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  app.get("/openapi.json", (_req, res) => res.status(200).json(openApiDocument));

  app.get("/", (_req, res) => {
    res.status(200).json({
      service: "checkout-rewards-service",
      docs: "/docs (interactive Swagger UI) — raw spec also at /openapi.json or openapi.yaml in the repo.",
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
