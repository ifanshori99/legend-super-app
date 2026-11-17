// Two-person clearance of a false payout reconciliation flag (legend-xbagc).
// One finance person proposes with a written reason, a different one approves;
// both re-ask the account password like the other payout steps.
import { z } from "zod";

const stepUpPasswordSchema = z.string().min(1).max(128).optional();

export const payoutReconFlagParamsSchema = z.strictObject({
  flagId: z.uuid(),
});

export const payoutReconClearanceParamsSchema = z.strictObject({
  clearanceId: z.uuid(),
});

export const proposePayoutReconClearanceInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
  reason: z.string().trim().min(10).max(500),
});

export const approvePayoutReconClearanceInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
});

export type ProposePayoutReconClearanceInput = z.infer<
  typeof proposePayoutReconClearanceInputSchema
>;
export type ApprovePayoutReconClearanceInput = z.infer<
  typeof approvePayoutReconClearanceInputSchema
>;
