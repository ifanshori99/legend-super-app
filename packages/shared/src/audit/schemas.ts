import {
  z,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { auditChangesAreMasked } from "./masking.ts";

// Audit rows are immutable records; storage must enforce append-only writes.
export const auditActorTypeSchema = z.enum([
  "user",
  "ai",
  "mcp_client",
  "system",
  "device",
]);
const MAX_CHANGES_LENGTH = 65_536;
const maskedValueSchema = z
  .json()
  .nullable()
  .refine((value) => auditChangesAreMasked(value), {
    message: "Sensitive fields must be masked with maskAuditChanges",
  });
// Dotted lowercase names like events: `role.updated`; object types are one word.
export const auditActionSchema = z
  .string()
  .max(150)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
export const auditObjectTypeSchema = z
  .string()
  .max(150)
  .regex(/^[a-z][a-z0-9_]*$/);

export const auditEventSchema = z
  .strictObject({
    id: ulidIdSchema<"AuditEventId">(),
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    actorType: auditActorTypeSchema,
    actorId: uuidSchema.nullable(),
    deviceId: uuidSchema.nullable(),
    action: auditActionSchema,
    objectType: auditObjectTypeSchema,
    // Targets may be UUID or operational ULID; service validates the target type.
    objectId: z.union([uuidSchema, ulidIdSchema<"AuditTargetId">()]).nullable(),
    reason: z.string().max(1000).nullable(),
    maskedChanges: z
      .strictObject({ before: maskedValueSchema, after: maskedValueSchema })
      .refine(
        (changes) => JSON.stringify(changes).length <= MAX_CHANGES_LENGTH,
        { message: "maskedChanges is too large" },
      ),
    ipHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    sensitiveAccess: z.boolean(),
    retentionClass: z.literal("audit_2y"),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((event, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (event.actorType === "system" && event.actorId !== null)
      fail("actorId", "A system actor has no actor id");
    if (
      (event.actorType === "user" ||
        event.actorType === "ai" ||
        event.actorType === "mcp_client") &&
      event.actorId === null
    )
      fail("actorId", "This actor kind needs an actor id");
    // A device acts as itself: actorId and deviceId name the same device.
    if (
      event.actorType === "device" &&
      (event.deviceId === null || event.actorId !== event.deviceId)
    )
      fail("deviceId", "A device actor needs deviceId equal to actorId");
    // PRD support access: sensitive data is opened only with a reason.
    if (event.sensitiveAccess && (event.reason ?? "").trim() === "")
      fail("reason", "Sensitive access requires a reason");
  });
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditEvent = Readonly<z.infer<typeof auditEventSchema>>;
