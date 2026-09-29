import { randomBytes } from "node:crypto";
import type { Database } from "../store/Database.js";
import type { Coupon } from "../domain/types.js";
import { AppError } from "../errors/AppError.js";
import { clone } from "../store/clone.js";
import { rewardConfig, type RewardConfig } from "../config.js";

function generateCouponCode(discountPercent: number): string {
  return `SAVE${discountPercent}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export class CouponService {
  constructor(
    private readonly db: Database,
    private readonly config: RewardConfig = rewardConfig,
  ) {}

  /**
   * Generates a coupon for `customerId` if their successful-order count has
   * crossed an unrewarded multiple of `config.milestoneEvery`. The whole
   * read-check-write happens inside one exec() block, so two concurrent
   * calls for the same customer can never both succeed for the same
   * milestone — the second sees `lastRewardedMilestone` already advanced
   * and falls back into "not yet eligible for the next one". That also
   * means "already generated for this milestone" is not a distinct,
   * separately reachable state from "milestone not reached" under this
   * design — see DECISIONS.md.
   */
  generateForCustomer(customerId: string): Coupon {
    if (!customerId || !customerId.trim()) {
      throw AppError.badRequest("VALIDATION_ERROR", "customerId is required");
    }
    return this.db.exec((t) => {
      const counter = t.rewardCounters.get(customerId) ?? {
        customerId,
        successfulOrderCount: 0,
        lastRewardedMilestone: 0,
      };
      const nextMilestone = counter.lastRewardedMilestone + this.config.milestoneEvery;
      if (counter.successfulOrderCount < nextMilestone) {
        throw AppError.conflict(
          "MILESTONE_NOT_REACHED",
          `Customer ${customerId} has ${counter.successfulOrderCount} successful orders; ` +
            `the next reward unlocks at ${nextMilestone}`,
          { successfulOrderCount: counter.successfulOrderCount, nextMilestone },
        );
      }

      t.rewardCounters.set(customerId, { ...counter, lastRewardedMilestone: nextMilestone });

      const coupon: Coupon = {
        code: generateCouponCode(this.config.discountPercent),
        customerId,
        discountPercent: this.config.discountPercent,
        milestoneOrderNumber: nextMilestone,
        status: "available",
        redeemedByOrderId: null,
        createdAt: new Date().toISOString(),
      };
      t.coupons.set(coupon.code, coupon);
      return clone(coupon);
    });
  }
}
