import { Router } from "express";
import type { AppServices } from "../types.js";
import { asyncHandler } from "../asyncHandler.js";
import { headerString, optionalString, requireNumber, requireString } from "../validation.js";

export function cartsRouter(services: AppServices): Router {
  const router = Router();

  router.post(
    "/carts",
    asyncHandler(async (req, res) => {
      const customerId = requireString(req.body?.customerId, "customerId");
      const cart = services.carts.createCart(customerId);
      res.status(201).json(cart);
    }),
  );

  router.get(
    "/carts/:cartId",
    asyncHandler(async (req, res) => {
      const view = services.carts.getCartView(req.params.cartId!);
      res.status(200).json(view);
    }),
  );

  router.post(
    "/carts/:cartId/items",
    asyncHandler(async (req, res) => {
      const productId = requireString(req.body?.productId, "productId");
      const quantity = requireNumber(req.body?.quantity, "quantity");
      const cart = services.carts.addItem(req.params.cartId!, productId, quantity);
      res.status(201).json(cart);
    }),
  );

  router.patch(
    "/carts/:cartId/items/:productId",
    asyncHandler(async (req, res) => {
      const quantity = requireNumber(req.body?.quantity, "quantity");
      const cart = services.carts.updateItemQuantity(req.params.cartId!, req.params.productId!, quantity);
      res.status(200).json(cart);
    }),
  );

  router.delete(
    "/carts/:cartId/items/:productId",
    asyncHandler(async (req, res) => {
      const cart = services.carts.removeItem(req.params.cartId!, req.params.productId!);
      res.status(200).json(cart);
    }),
  );

  router.post(
    "/carts/:cartId/checkout",
    asyncHandler(async (req, res) => {
      const idempotencyKey = headerString(req.headers["idempotency-key"]);
      const couponCode = optionalString(req.body?.couponCode) ?? null;
      const order = await services.checkout.checkout({
        cartId: req.params.cartId!,
        couponCode,
        idempotencyKey,
      });
      res.status(201).json(order);
    }),
  );

  return router;
}
