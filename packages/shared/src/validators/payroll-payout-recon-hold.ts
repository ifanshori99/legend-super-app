// Two-person release of a hold of a payout reconciliation flag that could not be
// written (legend-6o7pc). One finance person proposes with a written reason, a
// different one approves; both re-ask the account password like the other payout
// steps.
import { z } from "zod";

const stepUpPasswordSchema = z.string().min(1).max(128).optional();

export const payoutReconHoldParamsSchema = z.strictObject({
  holdId: z.uuid(),
});

export const payoutReconHoldReleaseParamsSchema = z.strictObject({
  releaseId: z.uuid(),
});

export const proposePayoutReconHoldReleaseInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
  reason: z.string().trim().min(10).max(500),
});

export const approvePayoutReconHoldReleaseInputSchema = z.strictObject({
  password: stepUpPasswordSchema,
});

export type ProposePayoutReconHoldReleaseInput = z.infer<
  typeof proposePayoutReconHoldReleaseInputSchema
>;
export type ApprovePayoutReconHoldReleaseInput = z.infer<
  typeof approvePayoutReconHoldReleaseInputSchema
>;
