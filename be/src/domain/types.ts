export interface Product {
  id: string;
  name: string;
  unitPriceCents: number;
  availableInventory: number;
}

export type CartStatus = "open" | "checked_out";

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  id: string;
  customerId: string;
  status: CartStatus;
  items: CartItem[];
  createdAt: string;
}

export type OrderStatus = "placed";

export interface OrderItem {
  productId: string;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  cartId: string;
  customerId: string;
  customerOrderSequence: number;
  status: OrderStatus;
  items: OrderItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode: string | null;
  createdAt: string;
}

/**
 * "reserved" is an internal, transitional state: a checkout has claimed
 * this coupon (atomically, at inventory-reservation time) and is awaiting
 * payment. It is never returned by any API response today — there is no
 * coupon-lookup endpoint — but it's a real state, not a display nuance,
 * so it's modeled explicitly rather than folded into "available"/"redeemed".
 */
export type CouponStatus = "available" | "reserved" | "redeemed";

export interface Coupon {
  code: string;
  customerId: string;
  discountPercent: number;
  milestoneOrderNumber: number;
  status: CouponStatus;
  redeemedByOrderId: string | null;
  createdAt: string;
}

export interface RewardCounter {
  customerId: string;
  successfulOrderCount: number;
  lastRewardedMilestone: number;
}

export type IdempotencyRecord =
  | { key: string; cartId: string; outcome: "success"; orderId: string }
  | {
      key: string;
      cartId: string;
      outcome: "failure";
      errorCode: string;
      httpStatus: number;
      message: string;
    };
