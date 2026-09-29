import { Database } from "./store/Database.js";
import { AsyncLock } from "./store/AsyncLock.js";
import { seedDatabase } from "./seed.js";
import { ProductService } from "./services/productService.js";
import { CartService } from "./services/cartService.js";
import { CheckoutService } from "./services/checkoutService.js";
import { CouponService } from "./services/couponService.js";
import { OrderService } from "./services/orderService.js";
import { ReportService } from "./services/reportService.js";
import { FakePaymentGateway } from "./services/paymentGateway.js";
import { rewardConfig } from "./config.js";
import type { AppServices } from "./http/types.js";

/** Composition root: the one place that wires the store + lock + gateway into the service layer. */
export function buildServices(): AppServices {
  const db = new Database();
  seedDatabase(db);
  const lock = new AsyncLock();
  const paymentGateway = new FakePaymentGateway();

  return {
    products: new ProductService(db),
    carts: new CartService(db),
    checkout: new CheckoutService(db, lock, paymentGateway),
    coupons: new CouponService(db, rewardConfig),
    orders: new OrderService(db),
    report: new ReportService(db),
  };
}
