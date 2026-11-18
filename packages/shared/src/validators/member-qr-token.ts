// Optional body of POST /api/member/qr-token (weexf): bind the token to one
// order and one amount of points so the cashier can redeem with it. Both or
// neither; the POS verifies the order, the mint does not.
import { z } from "zod";

export const memberQrTokenMintInputSchema = z
  .strictObject({
    orderId: z.string().min(1).max(64).optional(),
    points: z.number().int().positive().max(1_000_000).optional(),
  })
  .refine(
    (value) => (value.orderId === undefined) === (value.points === undefined),
    { message: "Send orderId and points together, or neither." },
  );
export type MemberQrTokenMintInput = z.infer<
  typeof memberQrTokenMintInputSchema
>;
