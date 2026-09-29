import { Router } from "express";
import type { AppServices } from "../types.js";
import { asyncHandler } from "../asyncHandler.js";
import { requireString } from "../validation.js";

/** Both routes here are the two operations this assignment treats as administrative — no auth is implemented (out of scope), but they're deliberately namespaced under /admin. */
export function adminRouter(services: AppServices): Router {
  const router = Router();

  router.post(
    "/admin/coupons/generate",
    asyncHandler(async (req, res) => {
      const customerId = requireString(req.body?.customerId, "customerId");
      const coupon = services.coupons.generateForCustomer(customerId);
      res.status(201).json(coupon);
    }),
  );

  router.get(
    "/admin/reports/summary",
    asyncHandler(async (_req, res) => {
      res.status(200).json(services.report.getSummary());
    }),
  );

  return router;
}
