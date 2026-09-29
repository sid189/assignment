import { Database } from "../store/Database.js";
import { AsyncLock } from "../store/AsyncLock.js";
import { seedDatabase } from "../seed.js";
import { CartService } from "../services/cartService.js";
import { CheckoutService } from "../services/checkoutService.js";
import { CouponService } from "../services/couponService.js";
import { ReportService } from "../services/reportService.js";
import { OrderService } from "../services/orderService.js";
import { ProductService } from "../services/productService.js";
import { FakePaymentGateway } from "../services/paymentGateway.js";
import type { PaymentGateway } from "../services/paymentGateway.js";
import type { RewardConfig } from "../config.js";
import { expect } from "vitest";
import { AppError } from "../errors/AppError.js";

export interface TestHarnessOptions {
  paymentGateway?: PaymentGateway;
  reward?: RewardConfig;
}

export function buildTestHarness(options: TestHarnessOptions = {}) {
  const db = new Database();
  seedDatabase(db);
  const lock = new AsyncLock();
  const paymentGateway = options.paymentGateway ?? new FakePaymentGateway({ delayMs: 5 });
  const reward: RewardConfig = options.reward ?? { milestoneEvery: 3, discountPercent: 10 };

  return {
    db,
    products: new ProductService(db),
    carts: new CartService(db),
    coupons: new CouponService(db, reward),
    checkout: new CheckoutService(db, lock, paymentGateway),
    orders: new OrderService(db),
    report: new ReportService(db),
  };
}

export function expectAppErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`Expected AppError with code ${code}, but no error was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}

export async function expectAsyncAppErrorCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected AppError with code ${code}, but no error was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}
