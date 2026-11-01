import {
  z,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidIdSchema,
  uuidSchema,
} from "../core/index.ts";

// Audit rows are immutable records; storage must enforce append-only writes.
export const auditActorTypeSchema = z.enum([
  "user",
  "ai",
  "mcp_client",
  "system",
  "device",
]);
export const auditEventSchema = z.strictObject({
  id: ulidIdSchema<"AuditEventId">(),
  tenantId: tenantIdSchema,
  outletId: outletIdSchema.nullable(),
  actorType: auditActorTypeSchema,
  actorId: uuidSchema.nullable(),
  deviceId: uuidSchema.nullable(),
  action: z.string().min(1).max(150),
  objectType: z.string().min(1).max(150),
  // Targets may be UUID or operational ULID; service validates the target type.
  objectId: z.union([uuidSchema, ulidIdSchema<"AuditTargetId">()]).nullable(),
  reason: z.string().max(1000).nullable(),
  maskedChanges: z.strictObject({
    before: z.json().nullable(),
    after: z.json().nullable(),
  }),
  ipHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sensitiveAccess: z.boolean(),
  retentionClass: z.literal("audit_2y"),
  createdAt: isoDateTimeSchema,
});
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditEvent = Readonly<z.infer<typeof auditEventSchema>>;
