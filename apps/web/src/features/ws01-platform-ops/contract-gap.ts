// CONTRACT GAP (bead legend-y6s): the platform contract has no cross-tenant
// audit list endpoint. This local endpoint reuses the shared audit event
// schema so the screen and its mock are typed, and it is the shape a follow-up
// contract bead should move into @starter/shared/platform. Platform health has
// no contract at all, so the health screen derives its tiles from the existing
// tenant + usage endpoints and invents nothing (see health-page.tsx).
import { defineEndpoint } from "@starter/shared/api";
import { auditActorTypeSchema, auditEventSchema } from "@starter/shared/audit";
import {
  cursorPageQuerySchema,
  cursorPageSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  z,
} from "@starter/shared/core";

export const listAuditEventsQuerySchema = cursorPageQuerySchema.extend({
  tenantId: tenantIdSchema.optional(),
  actorType: auditActorTypeSchema.optional(),
  /** Matches the action name or the start of it, e.g. `tenant.` or `role.updated`. */
  action: z.string().trim().max(150).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;

export const listPlatformAuditEvents = defineEndpoint({
  method: "GET",
  path: "/api/platform/audit-events",
  query: listAuditEventsQuerySchema,
  response: cursorPageSchema(auditEventSchema),
});
