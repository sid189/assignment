import { Router } from "express";
import type { AppServices } from "../types.js";
import { asyncHandler } from "../asyncHandler.js";

export function productsRouter(services: AppServices): Router {
  const router = Router();

  router.get(
    "/products",
    asyncHandler(async (_req, res) => {
      res.status(200).json(services.products.list());
    }),
  );

  return router;
}
