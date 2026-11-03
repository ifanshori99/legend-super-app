// HTTP contract of the audit log viewer (PRD v1.7 §3 F36 "Audit Log Viewer";
// defineEndpoint pattern). The tenant comes from the trusted context (TEN-02);
// the server checks `audit.log.view` and returns rows whose `maskedChanges`
// already went through maskAuditChanges (the event schema rejects any row that
// did not).
//
// Browser- and Node-safe: relative `.ts` imports only.
import {
  z,
  businessDateSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  outletIdSchema,
  timeZoneSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  auditActionSchema,
  auditActorTypeSchema,
  auditEventSchema,
  auditObjectTypeSchema,
} from "./schemas.ts";

/**
 * Filters of the list. `from`/`to` are business dates (inclusive) in the
 * outlet time zone, like every other report period (D-CORE time rules).
 */
export const auditEventListQuerySchema = cursorPageQuerySchema
  .extend({
    actorType: auditActorTypeSchema.optional(),
    actorId: uuidSchema.optional(),
    objectType: auditObjectTypeSchema.optional(),
    action: auditActionSchema.optional(),
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
  outletTimeZone: timeZoneSchema.nullable(),
  deviceName: z.string().max(200).nullable(),
});
export type AuditEventView = z.infer<typeof auditEventViewSchema>;

/** Newest first, cursor-paged (`{ data, meta: { limit, nextCursor } }`). */
export const listAuditEventsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/audit/events",
  query: auditEventListQuerySchema,
  response: cursorPageSchema(auditEventViewSchema),
});
