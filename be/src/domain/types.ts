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

export type CouponStatus = "available" | "redeemed";

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
