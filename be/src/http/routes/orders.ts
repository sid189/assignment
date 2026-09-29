import { Router } from "express";
import type { AppServices } from "../types.js";
import { asyncHandler } from "../asyncHandler.js";

export function ordersRouter(services: AppServices): Router {
  const router = Router();

  router.get(
    "/orders/:orderId",
    asyncHandler(async (req, res) => {
      const order = services.orders.getOrder(req.params.orderId!);
      res.status(200).json(order);
    }),
  );

  return router;
}
