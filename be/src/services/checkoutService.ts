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
 *   1. (sync, atomic) Validate the cart/coupon and RESERVE both inventory
 *      and the coupon (available -> reserved) in the same pass — this is
 *      the authoritative oversell/double-redemption check, and it
 *      protects against every OTHER cart racing for the same stock or the
 *      same coupon, not just retries of this one. Validation and mutation
 *      are two separate passes over the cart's items: nothing is mutated
 *      until every item (and the coupon) has been checked, so a failure
 *      on item N never leaves items 1..N-1 partially decremented.
 *   2. (async) Call the payment gateway, holding the per-cart AsyncLock so
 *      a retry of THIS cart queues behind us instead of double-charging.
 *   3a. Payment fails -> roll back the reservation (sync, atomic: restores
 *       inventory and the coupon to "available"), record the failure
 *       against the idempotency key, throw.
 *   3b. Payment succeeds -> finalize (sync, atomic): create the order,
 *       flip the coupon reserved -> redeemed, advance the reward counter,
 *       close the cart.
 *
 * Reserving the coupon atomically alongside inventory (rather than only
 * validating it at reserve-time and redeeming it at finalize-time) closes
 * what was previously a documented race: two different carts for the same
 * customer could both pass an optimistic coupon check and both pay, with
 * only one winning at finalize — meaning the loser's (fake) payment had
 * "succeeded" for a checkout that ultimately failed. With reservation, the
 * loser is rejected at the synchronous reserve() step, before ever calling
 * payment. See DECISIONS.md, Decision 5.
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

  /**
   * Two passes on purpose: the first only reads and validates (cart,
   * every item, the coupon); nothing is mutated until every check has
   * passed. If any check throws, the store is left exactly as it was —
   * no product has had inventory decremented for an item that came
   * before the one that failed. Only the second pass mutates, and by
   * then every mutation it performs is known to be valid.
   */
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

    // Pass 1: validate everything, mutate nothing.
    const items: OrderItem[] = [];
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

    // Pass 2: every check above passed — now it's safe to mutate. This is
    // also what makes the reservation exclusive: a concurrent reserve()
    // for a different cart racing on the same product or the same coupon
    // will see the decremented inventory / "reserved" status here (exec()
    // guarantees no other reserve() call can interleave with this one).
    const inventoryDeltas: InventoryDelta[] = [];
    for (const item of cart.items) {
      const product = tables.products.get(item.productId)!;
      tables.products.set(product.id, {
        ...product,
        availableInventory: product.availableInventory - item.quantity,
      });
      inventoryDeltas.push({ productId: product.id, quantity: item.quantity });
    }
    if (couponCode) {
      const coupon = tables.coupons.get(couponCode)!;
      tables.coupons.set(couponCode, { ...coupon, status: "reserved" });
    }

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
    if (reservation.couponCode) {
      const coupon = tables.coupons.get(reservation.couponCode);
      if (coupon && coupon.status === "reserved") {
        tables.coupons.set(reservation.couponCode, { ...coupon, status: "available" });
      }
    }
  }

  private finalize(tables: Tables, cartId: string, reservation: Reservation): string {
    const cart = tables.carts.get(cartId)!;

    // reserve() already claimed the coupon exclusively (available ->
    // reserved) before payment was ever called, so no other checkout could
    // have touched it since. This is a defensive assertion, not a business
    // race check — it should be unreachable in normal operation.
    if (reservation.couponCode) {
      const coupon = tables.coupons.get(reservation.couponCode);
      if (!coupon || coupon.status !== "reserved") {
        throw new AppError(
          "INTERNAL_ERROR",
          500,
          `Coupon ${reservation.couponCode} was not in the expected reserved state at finalize`,
        );
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
