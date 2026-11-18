// Two-person withdrawal of an open return claim (legend-snwnn). One finance
// person proposes with a written reason, a different one approves; both re-ask
// the account password like the other payout steps.
import { z } from "zod";

const stepUpPasswordSchema = z.string().min(1).max(128).optional();

export const payoutReturnClaimBatchParamsSchema = z.strictObject({
  id: z.uuid(),
});

export const payoutReturnClaimParamsSchema = z.strictObject({
  claimId: z.uuid(),
});

export const payoutReturnWithdrawalParamsSchema = z.strictObject({
  withdrawalId: z.uuid(),
});

export const proposePayoutReturnWithdrawInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
  reason: z.string().trim().min(10).max(500),
});

export const approvePayoutReturnWithdrawInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
});

export type ProposePayoutReturnWithdrawInput = z.infer<
  typeof proposePayoutReturnWithdrawInputSchema
>;
export type ApprovePayoutReturnWithdrawInput = z.infer<
  typeof approvePayoutReturnWithdrawInputSchema
>;
