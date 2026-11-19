// Member points redemption at the till (legend-0ne0z, flow A). The member sees
// the open bill the cashier attached, picks how many points to spend, and shows
// a QR the cashier scans. The QR carries the opaque token minted by the
// existing `issueMemberQrToken` (body { orderId, points }); the server checks
// that the token matches the order and points. These endpoints only read the
// bill, quote the allowed range and report the outcome. Money stays in whole
// rupiah; the server owns every figure shown here.

import { z, dataResponseSchema, isoDateTimeSchema } from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";

export const memberOpenBillSchema = z.strictObject({
  orderId: z.string(),
  outletName: z.string(),
  outletArea: z.string().nullable(),
  billNumber: z.string(),
  tableLabel: z.string().nullable(),
  totalIdr: z.number().int().nonnegative(),
  paidIdr: z.number().int().nonnegative(),
  remainingIdr: z.number().int().nonnegative(),
  attachedVia: z.enum(["member_qr", "pwa_session"]),
  attachedAt: isoDateTimeSchema,
  pointsRedeemed: z
    .strictObject({
      points: z.number().int().positive(),
      discountIdr: z.number().int().nonnegative(),
      redeemedAt: isoDateTimeSchema,
    })
    .nullable(),
});
export type MemberOpenBill = z.infer<typeof memberOpenBillSchema>;

export const listMemberOpenBills = defineEndpoint({
  method: "GET",
  path: "/api/member/open-bills",
  response: dataResponseSchema(z.array(memberOpenBillSchema)),
});

export const memberPointsRefusalSchema = z.enum([
  "program_inactive",
  "membership_inactive",
  "bill_settled",
  "order_not_eligible",
  "outlet_offline",
]);
export type MemberPointsRefusal = z.infer<typeof memberPointsRefusalSchema>;

export const memberPointsQuoteSchema = z.strictObject({
  orderId: z.string(),
  balancePoints: z.number().int().nonnegative(),
  pointValueIdr: z.number().int().positive(),
  minPoints: z.number().int().positive(),
  /** min(balance, floor(remainingIdr / pointValueIdr)); 0 when not eligible. */
  maxPoints: z.number().int().nonnegative(),
  remainingIdr: z.number().int().nonnegative(),
  refusal: memberPointsRefusalSchema.nullable(),
  quotedAt: isoDateTimeSchema,
});
export type MemberPointsQuote = z.infer<typeof memberPointsQuoteSchema>;

export const getMemberPointsQuote = defineEndpoint({
  method: "GET",
  path: "/api/member/open-bills/:orderId/points-quote",
  params: z.strictObject({ orderId: z.string().min(1).max(64) }),
  response: dataResponseSchema(memberPointsQuoteSchema),
});

export const memberPointsRedeemStatusInputSchema = z.strictObject({
  orderId: z.string().min(1).max(64),
  token: z.string().min(1).max(512),
});
export type MemberPointsRedeemStatusInput = z.infer<
  typeof memberPointsRedeemStatusInputSchema
>;

export const memberPointsRedeemStatusSchema = z.strictObject({
  orderId: z.string(),
  state: z.enum(["pending", "consumed", "expired", "invalid"]),
  points: z.number().int().positive().nullable(),
  discountIdr: z.number().int().nonnegative().nullable(),
  remainingIdr: z.number().int().nonnegative(),
  balancePoints: z.number().int().nonnegative(),
  checkedAt: isoDateTimeSchema,
});
export type MemberPointsRedeemStatus = z.infer<
  typeof memberPointsRedeemStatusSchema
>;

/** POST (not GET) so the token never lands in a URL or an access log. */
export const getMemberPointsRedeemStatus = defineEndpoint({
  method: "POST",
  path: "/api/member/points-redeem/status",
  body: memberPointsRedeemStatusInputSchema,
  response: dataResponseSchema(memberPointsRedeemStatusSchema),
});
