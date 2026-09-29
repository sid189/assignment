import { randomUUID } from "node:crypto";
import type { Database, Tables } from "../store/Database.js";
import type { AsyncLock } from "../store/AsyncLock.js";
import type { Order, OrderItem } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import { clone } from "../store/clone.js";
import type { PaymentGateway } from "./paymentGateway.js";

export interface CheckoutRequest {
  cartId: string;
  couponCode?: string | null;
  idempotencyKey: string | undefined;
}

interface InventoryDelta {
  productId: string;
  quantity: number;
}

interface Reservation {
  customerId: string;
  items: OrderItem[];
  subtotalCents: number;
  couponCode: string | null;
  discountCents: number;
  totalCents: number;
  inventoryDeltas: InventoryDelta[];
}

/**
 * Checkout is a reserve -> pay -> finalize flow:
 *
 *   1. (sync, atomic) Validate the cart/coupon and DECREMENT inventory
 *      immediately — this is the authoritative oversell check, and it
 *      protects against every OTHER cart racing for the same stock, not
 *      just retries of this one.
 *   2. (async) Call the payment gateway, holding the per-cart AsyncLock so
 *      a retry of THIS cart queues behind us instead of double-charging.
 *   3a. Payment fails -> roll back the inventory reservation (sync,
 *       atomic), record the failure against the idempotency key, throw.
 *   3b. Payment succeeds -> finalize (sync, atomic): create the order,
 *       redeem the coupon, advance the reward counter, close the cart.
 *
 * The one residual race this accepts: if a coupon is redeemed by a
 * DIFFERENT cart of the same customer during our payment await, finalize
 * throws and we roll back — meaning the (fake) payment "succeeded" for a
 * checkout that ultimately failed. With a real payment provider this would
 * need a refund call; deferred here since no real money moves. See
 * DECISIONS.md.
 */
export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly lock: AsyncLock,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async checkout(req: CheckoutRequest): Promise<Order> {
    const { cartId } = req;
    const idempotencyKey = req.idempotencyKey?.trim();
    if (!idempotencyKey) {
      throw AppError.badRequest("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required for checkout");
    }
    const couponCode = req.couponCode?.trim() || null;

    return this.lock.withLock(`cart:${cartId}`, async () => {
      const existing = this.db.exec((t) => t.idempotencyKeys.get(idempotencyKey));
      if (existing) {
        if (existing.cartId !== cartId) {
          throw AppError.conflict(
            "IDEMPOTENCY_KEY_CONFLICT",
            "This Idempotency-Key was already used for a different cart",
          );
        }
        return this.replay(existing.key);
      }

      // Pure validation failures here are not recorded against the key —
      // nothing was mutated, so a retry just re-validates for free.
      const reservation = this.db.exec((t) => this.reserve(t, cartId, couponCode));

      const paymentResult = await this.paymentGateway.charge(reservation.totalCents, {
        cartId,
        customerId: reservation.customerId,
      });

      if (!paymentResult.success) {
        this.db.exec((t) => this.rollbackReservation(t, reservation));
        const error = AppError.paymentRequired(
          "PAYMENT_DECLINED",
          paymentResult.reason ?? "Payment was declined",
        );
        this.recordFailure(idempotencyKey, cartId, error);
        throw error;
      }

      try {
        const orderId = this.db.exec((t) => this.finalize(t, cartId, reservation));
        this.db.exec((t) =>
          t.idempotencyKeys.set(idempotencyKey, { key: idempotencyKey, cartId, outcome: "success", orderId }),
        );
        return this.db.exec((t) => clone(t.orders.get(orderId)!));
      } catch (err) {
        this.db.exec((t) => this.rollbackReservation(t, reservation));
        const error =
          err instanceof AppError ? err : AppError.conflict("CHECKOUT_FAILED", "Checkout could not be completed");
        this.recordFailure(idempotencyKey, cartId, error);
        throw error;
      }
    });
  }

  private recordFailure(idempotencyKey: string, cartId: string, error: AppError): void {
    this.db.exec((t) =>
      t.idempotencyKeys.set(idempotencyKey, {
        key: idempotencyKey,
        cartId,
        outcome: "failure",
        errorCode: error.code,
        httpStatus: error.httpStatus,
        message: error.message,
      }),
    );
  }

  private replay(idempotencyKey: string): Order {
    return this.db.exec((t) => {
      const record = t.idempotencyKeys.get(idempotencyKey)!;
      if (record.outcome === "success") {
        const order = t.orders.get(record.orderId);
        if (!order) {
          throw new AppError("INTERNAL_ERROR", 500, "Recorded order for idempotency key is missing");
        }
        return clone(order);
      }
      throw new AppError(record.errorCode, record.httpStatus, record.message);
    });
  }

  private reserve(tables: Tables, cartId: string, couponCode: string | null): Reservation {
    const cart = tables.carts.get(cartId);
    if (!cart) {
      throw AppError.notFound("CART_NOT_FOUND", `Cart ${cartId} not found`);
    }
    if (cart.status !== "open") {
      throw AppError.conflict("CART_ALREADY_CHECKED_OUT", `Cart ${cartId} has already been checked out`);
    }
    if (cart.items.length === 0) {
      throw AppError.badRequest("CART_EMPTY", "Cart has no items");
    }

    const items: OrderItem[] = [];
    const inventoryDeltas: InventoryDelta[] = [];

    for (const item of cart.items) {
      const product = tables.products.get(item.productId);
      if (!product) {
        throw AppError.notFound("PRODUCT_NOT_FOUND", `Product ${item.productId} no longer exists`);
      }
      if (product.availableInventory < item.quantity) {
        throw AppError.conflict(
          "INSUFFICIENT_INVENTORY",
          `Only ${product.availableInventory} units of '${product.name}' are available`,
          { productId: product.id, requested: item.quantity, available: product.availableInventory },
        );
      }
      tables.products.set(product.id, {
        ...product,
        availableInventory: product.availableInventory - item.quantity,
      });
      inventoryDeltas.push({ productId: product.id, quantity: item.quantity });
      items.push({
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.unitPriceCents,
        quantity: item.quantity,
        lineTotalCents: product.unitPriceCents * item.quantity,
      });
    }

    const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);

    let discountCents = 0;
    if (couponCode) {
      const coupon = tables.coupons.get(couponCode);
      if (!coupon || coupon.customerId !== cart.customerId) {
        throw AppError.badRequest("COUPON_INVALID", "Coupon does not exist or does not belong to this customer");
      }
      if (coupon.status !== "available") {
        throw AppError.conflict("COUPON_ALREADY_REDEEMED", "Coupon has already been redeemed");
      }
      discountCents = Math.floor((subtotalCents * coupon.discountPercent) / 100);
    }

    const totalCents = Math.max(0, subtotalCents - discountCents);

    return { customerId: cart.customerId, items, subtotalCents, couponCode, discountCents, totalCents, inventoryDeltas };
  }

  private rollbackReservation(tables: Tables, reservation: Reservation): void {
    for (const delta of reservation.inventoryDeltas) {
      const product = tables.products.get(delta.productId);
      if (product) {
        tables.products.set(delta.productId, {
          ...product,
          availableInventory: product.availableInventory + delta.quantity,
        });
      }
    }
  }

  private finalize(tables: Tables, cartId: string, reservation: Reservation): string {
    const cart = tables.carts.get(cartId)!;

    if (reservation.couponCode) {
      const coupon = tables.coupons.get(reservation.couponCode);
      if (!coupon || coupon.status !== "available") {
        throw AppError.conflict("COUPON_ALREADY_REDEEMED", "Coupon was redeemed by a concurrent checkout");
      }
    }

    const counter = tables.rewardCounters.get(cart.customerId) ?? {
      customerId: cart.customerId,
      successfulOrderCount: 0,
      lastRewardedMilestone: 0,
    };
    const customerOrderSequence = counter.successfulOrderCount + 1;

    const order: Order = {
      id: randomUUID(),
      cartId,
      customerId: cart.customerId,
      customerOrderSequence,
      status: "placed",
      items: reservation.items,
      subtotalCents: reservation.subtotalCents,
      discountCents: reservation.discountCents,
      totalCents: reservation.totalCents,
      couponCode: reservation.couponCode,
      createdAt: new Date().toISOString(),
    };

    tables.orders.set(order.id, order);
    tables.rewardCounters.set(cart.customerId, { ...counter, successfulOrderCount: customerOrderSequence });
    tables.carts.set(cartId, { ...cart, status: "checked_out" });

    if (reservation.couponCode) {
      const coupon = tables.coupons.get(reservation.couponCode)!;
      tables.coupons.set(coupon.code, { ...coupon, status: "redeemed", redeemedByOrderId: order.id });
    }

    return order.id;
  }
}
