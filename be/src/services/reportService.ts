import type { Database } from "../store/Database.js";

export interface ReportSummary {
  purchasedQuantityByProduct: Record<string, number>;
  grossRevenueCents: number;
  totalDiscountCents: number;
  netRevenueCents: number;
  coupons: { generated: number; available: number; redeemed: number };
  totalSuccessfulOrders: number;
}

/**
 * Everything here is derived live from `orders`/`coupons` on every call —
 * no separately maintained running totals. That's what makes the report
 * reconcile by construction and keeps repeated calls side-effect free.
 */
export class ReportService {
  constructor(private readonly db: Database) {}

  getSummary(): ReportSummary {
    return this.db.exec((t) => {
      const purchasedQuantityByProduct: Record<string, number> = {};
      let grossRevenueCents = 0;
      let totalDiscountCents = 0;
      let totalSuccessfulOrders = 0;

      for (const order of t.orders.values()) {
        totalSuccessfulOrders += 1;
        grossRevenueCents += order.subtotalCents;
        totalDiscountCents += order.discountCents;
        for (const item of order.items) {
          purchasedQuantityByProduct[item.productId] =
            (purchasedQuantityByProduct[item.productId] ?? 0) + item.quantity;
        }
      }

      let generated = 0;
      let available = 0;
      let redeemed = 0;
      for (const coupon of t.coupons.values()) {
        generated += 1;
        // "reserved" (claimed by an in-flight checkout, not yet paid) is
        // bucketed with "available" rather than "redeemed": it isn't a
        // completed redemption, and it will almost certainly return to
        // "available" (payment failure/rollback) or become "redeemed"
        // (payment success) within the same request.
        if (coupon.status === "redeemed") redeemed += 1;
        else available += 1;
      }

      return {
        purchasedQuantityByProduct,
        grossRevenueCents,
        totalDiscountCents,
        netRevenueCents: grossRevenueCents - totalDiscountCents,
        coupons: { generated, available, redeemed },
        totalSuccessfulOrders,
      };
    });
  }
}
