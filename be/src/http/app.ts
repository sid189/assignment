import express, { type Express } from "express";
import type { AppServices } from "./types.js";
import { productsRouter } from "./routes/products.js";
import { cartsRouter } from "./routes/carts.js";
import { ordersRouter } from "./routes/orders.js";
import { adminRouter } from "./routes/admin.js";
import { errorHandler, notFoundHandler } from "./errorHandler.js";

export function buildApp(services: AppServices): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.use(productsRouter(services));
  app.use(cartsRouter(services));
  app.use(ordersRouter(services));
  app.use(adminRouter(services));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
