// POS member points at the cashier (936, legend-hpgyw part B). The path has no
// outlet, like setOrderCustomer: the API resolves the order's outlet itself.
// The client sends points only; the server prices them (1 point = the
// program's `pointValueIdr`, rounded down), caps them at the bill's remaining
// balance and the member's balance, and returns the numbers to show.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import { posOrderDetailSchema } from "./schemas.ts";

const pointsAmountSchema = z.number().int().positive().max(1_000_000);
const orderPointsParams = z.strictObject({ orderId: orderIdSchema });

export const posPointsAccountSchema = z.strictObject({
  memberId: uuidSchema,
  memberName: z.string(),
  balancePoints: z.number().int().nonnegative(),
  minRedeemPoints: z.number().int().positive(),
  /** min(balance, points worth at most the remaining bill); 0 = cannot redeem. */
  maxRedeemPoints: z.number().int().nonnegative(),
});
export type PosPointsAccount = z.infer<typeof posPointsAccountSchema>;

export const posPointsQuoteSchema = z.strictObject({
  points: pointsAmountSchema,
  valueIdr: z.number().int().positive(),
});
export type PosPointsQuote = z.infer<typeof posPointsQuoteSchema>;

export const getPosOrderPoints = defineEndpoint({
  method: "GET",
  path: "/api/pos/orders/:orderId/points",
  params: orderPointsParams,
  response: dataResponseSchema(
    z.strictObject({ account: posPointsAccountSchema.nullable() }),
  ),
});

export const quotePosOrderPoints = defineEndpoint({
  method: "POST",
  path: "/api/pos/orders/:orderId/points/quote",
  params: orderPointsParams,
  body: clientInputSchema({ points: pointsAmountSchema }),
  response: dataResponseSchema(posPointsQuoteSchema),
});

export const redeemPosOrderPoints = defineEndpoint({
  method: "POST",
  path: "/api/pos/orders/:orderId/points/redeem",
  params: orderPointsParams,
  body: clientInputSchema({
    points: pointsAmountSchema,
    idempotencyKey: idempotencyKeySchema,
    /** The member's QR token for this order and amount (weexf). */
    memberToken: z.string().min(1).max(512).optional(),
  }),
  response: dataResponseSchema(posOrderDetailSchema),
});
