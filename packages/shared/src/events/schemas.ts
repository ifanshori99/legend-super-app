import {
  z,
  uuidSchema,
  ulidSchema,
  tenantIdSchema,
  outletIdSchema,
  isoDateTimeSchema,
} from "../core/index.ts";

const identifierSchema = z.union([uuidSchema, ulidSchema]);
const namePart = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const eventNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
export const aggregateTypeSchema = z.string().regex(namePart);

/** Same actor kinds as the audit contract (`mcp_client`, not `mcp`), so an
 * event and its audit row describe one actor the same way. Every actor id is a
 * UUID; `system` has none. */
export const eventActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: uuidSchema }).strict(),
  z.object({ type: z.literal("ai"), id: uuidSchema }).strict(),
  z.object({ type: z.literal("mcp_client"), id: uuidSchema }).strict(),
  z.object({ type: z.literal("device"), id: uuidSchema }).strict(),
  z.object({ type: z.literal("system") }).strict(),
]);

/** The payload is stored in JSONB and crosses the edge/cloud link as JSON, so
 * only JSON values are accepted (no Date, bigint, NaN, undefined, functions). */
export const eventPayloadSchema = z.record(z.string(), z.json());

/** Event name and schema reference are derived, never free-form:
 * `payloadSchemaRef` is `<name>.v<version>`. */
export function payloadSchemaRefOf(name: string, version: number): string {
  return `${name}.v${version}`;
}

/** Unrefined envelope shape. Domain code extends this (see
 * `defineDomainEvent`); validate with `eventEnvelopeSchema`, which adds the
 * cross-field rules. */
export const eventEnvelopeBaseSchema = z
  .object({
    id: ulidSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    name: eventNameSchema,
    version: z.number().int().positive().safe(),
    aggregateType: aggregateTypeSchema,
    aggregateId: identifierSchema,
    /** Position within one tenant + aggregate; starts at 1, no gaps. */
    sequence: z.number().int().positive().safe(),
    occurredAt: isoDateTimeSchema,
    actor: eventActorSchema,
    /** Originating device (PRD `order_events.device_id`); null for cloud work. */
    deviceId: uuidSchema.nullable().default(null),
    /** VARCHAR(100), unique per tenant (PRD §6). */
    idempotencyKey: z.string().min(1).max(100),
    payloadSchemaRef: z.string().min(1).max(255),
    payload: eventPayloadSchema,
  })
  .strict();

type EnvelopeRules = {
  name: string;
  aggregateType: string;
  version: number;
  payloadSchemaRef: string;
};
/** Cross-field rules shared by the envelope and every typed domain envelope. */
export function checkEnvelopeRules(
  event: EnvelopeRules,
  ctx: z.RefinementCtx,
): void {
  if (event.name.split(".")[0] !== event.aggregateType)
    ctx.addIssue({
      code: "custom",
      message: "Event name must match aggregate type",
      path: ["name"],
    });
  if (event.payloadSchemaRef !== payloadSchemaRefOf(event.name, event.version))
    ctx.addIssue({
      code: "custom",
      message: "payloadSchemaRef must be <name>.v<version>",
      path: ["payloadSchemaRef"],
    });
}
export const eventEnvelopeSchema =
  eventEnvelopeBaseSchema.superRefine(checkEnvelopeRules);

export const syncDirectionSchema = z.enum(["edge_to_cloud", "cloud_to_edge"]);
/** Cursors belong to a tenant, edge peer and direction, not to the global stream. */
export const syncCheckpointSchema = z
  .object({
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    peerId: uuidSchema,
    direction: syncDirectionSchema,
    cursor: z.string().min(1).max(1024).nullable(),
    lastEventId: ulidSchema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

/** A domain mutation and all its outbox rows MUST commit in the same database
 * transaction. Rows are immutable as to event and destination. A worker leases
 * rows (`attempts` counts leases), retries after lease expiry, and marks
 * delivery only after acknowledgement. After the worker's attempt limit the row
 * becomes `failed` (terminal, with `lastError`) for operator follow-up (PRD
 * "retry terbatas"). Delivery is at least once: consumers must deduplicate
 * (`eventDedupeKey`) and apply sequence order per tenant/aggregate
 * (`classifyEventSequence`); never infer ordering from arrival time or ULID
 * alone. Edge transactions are append-only; cloud wins master data conflicts.
 * Checkpoints advance only after durable, idempotent application. Recheck job
 * permissions. */
export const outboxRowSchema = z
  .object({
    id: ulidSchema,
    event: eventEnvelopeSchema,
    direction: syncDirectionSchema.nullable(),
    peerId: uuidSchema.nullable(),
    destination: z.string().min(1).max(255),
    status: z.enum(["pending", "processing", "delivered", "failed"]),
    attempts: z.number().int().nonnegative().safe(),
    availableAt: isoDateTimeSchema,
    leaseOwner: z.string().min(1).max(255).nullable(),
    leaseUntil: isoDateTimeSchema.nullable(),
    deliveredAt: isoDateTimeSchema.nullable(),
    /** Last delivery error (no secrets or payload); null until one happens. */
    lastError: z.string().max(1000).nullable().default(null),
    createdAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.direction === null) !== (row.peerId === null)) {
      ctx.addIssue({
        code: "custom",
        message: "Sync direction and peer must be specified together",
      });
    }
    const leased = row.leaseOwner !== null && row.leaseUntil !== null;
    const unleased = row.leaseOwner === null && row.leaseUntil === null;
    if (
      (row.status === "processing" ? !leased : !unleased) ||
      (row.status === "delivered") !== (row.deliveredAt !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Outbox status, lease and delivery time disagree",
      });
    }
    if (
      (row.status === "processing" || row.status === "delivered") &&
      row.attempts < 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "A leased or delivered row has at least one attempt",
      });
    }
  });
export type EventActor = z.infer<typeof eventActorSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type SyncDirection = z.infer<typeof syncDirectionSchema>;
export type SyncCheckpoint = z.infer<typeof syncCheckpointSchema>;
export type OutboxRow = z.infer<typeof outboxRowSchema>;

/** Idempotency is unique per tenant (PRD §6): the key a consumer dedupes on. */
export function eventDedupeKey(
  event: Pick<EventEnvelope, "tenantId" | "idempotencyKey">,
): string {
  return JSON.stringify([event.tenantId, event.idempotencyKey]);
}

export type SequenceDecision =
  | { action: "apply" }
  | { action: "duplicate" }
  | { action: "gap"; missingFrom: number; missingTo: number };

/** Consumer-side ordering rule for one tenant + aggregate. `lastApplied` is the
 * highest sequence already applied (0 for a new aggregate). Apply only the next
 * sequence; skip anything already applied; on a gap hold the event and request
 * the missing range. */
export function classifyEventSequence(
  lastApplied: number,
  event: Pick<EventEnvelope, "sequence">,
): SequenceDecision {
  if (!Number.isSafeInteger(lastApplied) || lastApplied < 0)
    throw new RangeError("lastApplied must be a non-negative safe integer");
  if (event.sequence <= lastApplied) return { action: "duplicate" };
  if (event.sequence === lastApplied + 1) return { action: "apply" };
  return {
    action: "gap",
    missingFrom: lastApplied + 1,
    missingTo: event.sequence - 1,
  };
}

/** True when a worker may lease the row now: a due pending row, or a
 * processing row whose lease has expired. Failed and delivered rows never. */
export function isOutboxRowClaimable(
  row: Pick<OutboxRow, "status" | "availableAt" | "leaseUntil">,
  now: Date,
): boolean {
  const time = now.getTime();
  if (row.status === "pending") return Date.parse(row.availableAt) <= time;
  if (row.status === "processing")
    return row.leaseUntil !== null && Date.parse(row.leaseUntil) <= time;
  return false;
}
