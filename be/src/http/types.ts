import type { ProductService } from "../services/productService.js";
import type { CartService } from "../services/cartService.js";
import type { CheckoutService } from "../services/checkoutService.js";
import type { CouponService } from "../services/couponService.js";
import type { OrderService } from "../services/orderService.js";
import type { ReportService } from "../services/reportService.js";

export interface AppServices {
  products: ProductService;
  carts: CartService;
  checkout: CheckoutService;
  coupons: CouponService;
  orders: OrderService;
  report: ReportService;
}
