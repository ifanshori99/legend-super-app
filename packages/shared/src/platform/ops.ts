// Super Admin operations contracts (PRD v1.7 §3 F4: "melihat kesehatan sistem
// dan audit lintas tenant"; bead legend-bag1). The cross-tenant audit list needs
// `platform.audit.view`.

import {
  cursorPageQuerySchema,
  isoDateTimeSchema,
  tenantIdSchema,
  z,
} from "../core/index.ts";
import { auditActorTypeSchema } from "../audit/index.ts";

export const listPlatformAuditEventsQuerySchema = cursorPageQuerySchema.extend({
  tenantId: tenantIdSchema.optional(),
  actorType: auditActorTypeSchema.optional(),
  /** Matches the action name or the start of it, e.g. `tenant.` or `role.updated`. */
  action: z.string().trim().max(150).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type ListPlatformAuditEventsQuery = z.infer<
  typeof listPlatformAuditEventsQuerySchema
>;

export const platformComponentStatusSchema = z.enum(["ok", "unreachable"]);

/** Platform health report: database reachability, checked at request time. */
export const platformHealthSchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  checkedAt: isoDateTimeSchema,
  database: platformComponentStatusSchema,
});
export type PlatformHealth = z.infer<typeof platformHealthSchema>;
