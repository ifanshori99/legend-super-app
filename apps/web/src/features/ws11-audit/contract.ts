// Local contract of the audit log list (WS-11 FE, bead legend-max2; PRD v1.7
// §3 F36 "Audit Log Viewer"). `packages/shared/src/audit` defines the event
// row but no HTTP endpoint yet, so the list endpoint lives here until the lead
// files a contract bead and moves it to `@starter/shared/audit`.
//
// Browser- and Node-safe (loaded by the mock in Node): bare package imports and
// relative `.ts` paths only.
import { defineEndpoint } from "@starter/shared/api";
import { auditActorTypeSchema, auditEventSchema } from "@starter/shared/audit";
import {
  businessDateSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  outletIdSchema,
  uuidSchema,
  z,
} from "@starter/shared/core";

/** `role.updated`: the same dotted lowercase shape the event row validates. */
export const auditActionFilterSchema = z
  .string()
  .max(150)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);

export const auditObjectTypeFilterSchema = z
  .string()
  .max(150)
  .regex(/^[a-z][a-z0-9_]*$/);

/**
 * Filters of the list. `from`/`to` are business dates (inclusive) in the
 * outlet time zone, like every other report period (D-CORE time rules).
 */
export const auditEventListQuerySchema = cursorPageQuerySchema
  .extend({
    actorType: auditActorTypeSchema.optional(),
    actorId: uuidSchema.optional(),
    objectType: auditObjectTypeFilterSchema.optional(),
    action: auditActionFilterSchema.optional(),
    outletId: outletIdSchema.optional(),
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ["to"],
    message: "Tanggal akhir tidak boleh sebelum tanggal awal.",
  });
export type AuditEventListQuery = z.input<typeof auditEventListQuerySchema>;

/**
 * One row as the viewer needs it: the immutable event (already masked) plus the
 * display names the server resolved, so the browser never joins ids to names.
 */
export const auditEventViewSchema = z.strictObject({
  event: auditEventSchema,
  /** User, AI agent, MCP client or device name; `null` for the system actor. */
  actorName: z.string().max(200).nullable(),
  outletName: z.string().max(200).nullable(),
  /** IANA zone of the event's outlet; `null` falls back to the tenant default. */
  outletTimeZone: z.string().max(64).nullable(),
  deviceName: z.string().max(200).nullable(),
});
export type AuditEventView = z.infer<typeof auditEventViewSchema>;

export const listAuditEventsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/audit/events",
  query: auditEventListQuerySchema,
  response: cursorPageSchema(auditEventViewSchema),
});
