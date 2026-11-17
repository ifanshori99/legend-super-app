// Customer reviews contract (legend-vqicf, docs/briefs/981-reviews.md). Not the
// staff-handled `feedback` queue: a review keeps its source and a moderation
// outcome. `body` is personal data (staff list only; never in a dashboard
// queue or AI output).

import {
  z,
  clientInputSchema,
  cursorPageQuerySchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidIdSchema,
  uuidSchema,
} from "../core/index.ts";

export const customerReviewSourceSchema = z.enum([
  "qr",
  "app",
  "web",
  "google",
  "manual",
]);
export type CustomerReviewSource = z.infer<typeof customerReviewSourceSchema>;

export const customerReviewModerationStatusSchema = z.enum([
  "pending",
  "published",
  "hidden",
]);
export type CustomerReviewModerationStatus = z.infer<
  typeof customerReviewModerationStatusSchema
>;

export const customerReviewRatingSchema = z.number().int().min(1).max(5);

export const createCustomerReviewInput = clientInputSchema({
  outletId: outletIdSchema,
  rating: customerReviewRatingSchema,
  body: z.string().trim().min(1).max(2000).optional(),
  // Staff entry is always a manual review; the server stores `manual`.
  source: z.literal("manual"),
  orderId: ulidIdSchema<"OrderId">().optional(),
  reservationId: uuidSchema.optional(),
});
export type CreateCustomerReviewInput = z.output<
  typeof createCustomerReviewInput
>;

export const listCustomerReviewsQuery = cursorPageQuerySchema.extend({
  outletId: outletIdSchema.optional(),
  moderationStatus: customerReviewModerationStatusSchema.optional(),
});
export type ListCustomerReviewsQuery = z.output<
  typeof listCustomerReviewsQuery
>;

export const moderateCustomerReviewInput = clientInputSchema({
  status: customerReviewModerationStatusSchema,
  // The status the moderator saw: a changed row answers 409 (no lost update).
  expectedStatus: customerReviewModerationStatusSchema,
  note: z.string().trim().min(1).max(500).optional(),
});
export type ModerateCustomerReviewInput = z.output<
  typeof moderateCustomerReviewInput
>;

export const customerReviewIdParams = z.strictObject({ id: uuidSchema });

export const customerReviewDtoSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  orderId: ulidIdSchema<"OrderId">().nullable(),
  reservationId: uuidSchema.nullable(),
  customerProfileId: uuidSchema.nullable(),
  rating: customerReviewRatingSchema,
  body: z.string().max(2000).nullable(),
  source: customerReviewSourceSchema,
  moderationStatus: customerReviewModerationStatusSchema,
  moderatedBy: z.string().nullable(),
  moderatedAt: isoDateTimeSchema.nullable(),
  moderationNote: z.string().max(500).nullable(),
  createdAt: isoDateTimeSchema,
});
export type CustomerReviewDto = z.infer<typeof customerReviewDtoSchema>;
