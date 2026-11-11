// Operator view and action for outbox sequence gaps (bead legend-jcil).
// `domain_event_gap_requests` records a destination that is missing a producer
// sequence. An operator may skip one only with a written reason; the action is
// audited as `outbox_gap.skipped` in the tenant's audit log.

import {
  clientInputSchema,
  isoDateTimeSchema,
  uuidSchema,
  z,
} from "../core/index.ts";

export const outboxGapIdSchema = uuidSchema;

export const outboxGapSchema = z.strictObject({
  id: uuidSchema,
  destination: z.string(),
  aggregateType: z.string(),
  aggregateId: uuidSchema,
  missingSequence: z.number().int().positive(),
  requestCount: z.number().int().positive(),
  firstRequestedAt: isoDateTimeSchema,
  lastRequestedAt: isoDateTimeSchema,
});
export type OutboxGap = z.infer<typeof outboxGapSchema>;

export const listOutboxGapsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const skipOutboxGapInputSchema = clientInputSchema({
  reason: z.string().trim().min(10).max(500),
});
export type SkipOutboxGapInput = z.infer<typeof skipOutboxGapInputSchema>;
