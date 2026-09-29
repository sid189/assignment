export interface RewardConfig {
  /** n — every nth successful order for a customer earns a coupon. */
  milestoneEvery: number;
  /** x — the discount percentage the earned coupon carries. */
  discountPercent: number;
}

export const rewardConfig: RewardConfig = {
  milestoneEvery: Number(process.env.COUPON_MILESTONE_N ?? 5),
  discountPercent: Number(process.env.COUPON_DISCOUNT_X ?? 10),
};
