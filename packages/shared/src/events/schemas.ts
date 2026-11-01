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
export const eventActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: uuidSchema }).strict(),
  z.object({ type: z.literal("ai"), id: identifierSchema }).strict(),
  z.object({ type: z.literal("mcp"), id: identifierSchema }).strict(),
  z
    .object({ type: z.literal("system"), id: identifierSchema.optional() })
    .strict(),
]);
export const eventEnvelopeSchema = z
  .object({
    id: ulidSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    name: eventNameSchema,
    version: z.number().int().positive().safe(),
    aggregateType: z.string().regex(namePart),
    aggregateId: identifierSchema,
    sequence: z.number().int().positive().safe(),
    occurredAt: isoDateTimeSchema,
    actor: eventActorSchema,
    idempotencyKey: z.string().min(1).max(100),
    payloadSchemaRef: z.string().min(1).max(255),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine((event) => event.name.split(".")[0] === event.aggregateType, {
    message: "Event name must match aggregate type",
    path: ["name"],
  });

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
 * rows, retries after lease expiry, and marks delivery only after acknowledgement.
 * Delivery is at least once: consumers must deduplicate and apply sequence order
 * per tenant/aggregate; never infer ordering from arrival time or ULID alone.
 * Edge transactions are append-only; cloud wins master data conflicts. Checkpoints
 * advance only after durable, idempotent application. Recheck job permissions. */
export const outboxRowSchema = z
  .object({
    id: ulidSchema,
    event: eventEnvelopeSchema,
    direction: syncDirectionSchema.nullable(),
    peerId: uuidSchema.nullable(),
    destination: z.string().min(1).max(255),
    status: z.enum(["pending", "processing", "delivered"]),
    attempts: z.number().int().nonnegative().safe(),
    availableAt: isoDateTimeSchema,
    leaseOwner: z.string().min(1).max(255).nullable(),
    leaseUntil: isoDateTimeSchema.nullable(),
    deliveredAt: isoDateTimeSchema.nullable(),
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
  });
export type EventActor = z.infer<typeof eventActorSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type SyncDirection = z.infer<typeof syncDirectionSchema>;
export type SyncCheckpoint = z.infer<typeof syncCheckpointSchema>;
export type OutboxRow = z.infer<typeof outboxRowSchema>;
