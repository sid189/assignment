export interface PaymentContext {
  cartId: string;
  customerId: string;
}

export interface PaymentResult {
  success: boolean;
  reason?: string;
}

export interface PaymentGateway {
  charge(amountCents: number, context: PaymentContext): Promise<PaymentResult>;
}

export interface FakePaymentGatewayOptions {
  /** Simulated network latency — also what actually exercises the async lock. */
  delayMs?: number;
  /** Injection point for tests: return true to simulate a declined payment. */
  shouldDecline?: (context: PaymentContext, amountCents: number) => boolean;
}

/**
 * No real payment integration is implemented (out of scope). This fake
 * still models the two things that matter for this assignment's
 * invariants: it is asynchronous (so checkout must hold something across
 * an await), and it can fail (so "a coupon/inventory must not be lost by
 * a checkout that ultimately fails" is an actual code path, not just an
 * assumption). See DECISIONS.md for the alternative considered (treating
 * checkout as always-succeeds).
 */
export class FakePaymentGateway implements PaymentGateway {
  constructor(private readonly options: FakePaymentGatewayOptions = {}) {}

  async charge(amountCents: number, context: PaymentContext): Promise<PaymentResult> {
    await new Promise((resolve) => setTimeout(resolve, this.options.delayMs ?? 15));
    if (this.options.shouldDecline?.(context, amountCents)) {
      return { success: false, reason: "Simulated decline" };
    }
    return { success: true };
  }
}
