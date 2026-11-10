// Zone -> waiter assignment management (PRD v1.7 §3 F10, ORD-07; bead
// legend-xlzl). The assignment decides whose phone a table's waiter call, bill
// request or complaint reaches. Outlet managers (`service_request.zone.manage`)
// list, assign and remove; the routing itself reads the same rows.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  uuidIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { floorZoneIdSchema } from "./schemas.ts";

export const zoneWaiterAssignmentIdSchema =
  uuidIdSchema<"ZoneWaiterAssignmentId">();

export const zoneWaiterAssignmentSchema = z.strictObject({
  id: zoneWaiterAssignmentIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  zoneId: floorZoneIdSchema,
  userId: userIdSchema,
  note: z.string().max(200).nullable(),
  createdAt: isoDateTimeSchema,
});
export type ZoneWaiterAssignment = z.infer<typeof zoneWaiterAssignmentSchema>;

export const assignZoneWaiterInputSchema = clientInputSchema({
  userId: userIdSchema,
  note: z.string().trim().max(200).optional(),
});

const outletParams = z.strictObject({ outletId: outletIdSchema });

/** Assignments of one outlet, optionally one zone. */
export const listZoneWaiters = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/zone-waiters",
  params: outletParams,
  query: z.strictObject({ zoneId: floorZoneIdSchema.optional() }),
  response: dataResponseSchema(z.array(zoneWaiterAssignmentSchema)),
});

/**
 * 201 when created, 200 when the user is already assigned to the zone. The
 * user must be an active member of the tenant who can work this outlet's
 * floor; anyone else is refused with 400 VALIDATION_ERROR.
 */
export const assignZoneWaiter = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/zones/:zoneId/waiters",
  params: z.strictObject({
    outletId: outletIdSchema,
    zoneId: floorZoneIdSchema,
  }),
  body: assignZoneWaiterInputSchema,
  response: dataResponseSchema(zoneWaiterAssignmentSchema),
});

/** 204; removing an assignment that is already gone is 404. */
export const removeZoneWaiter = defineEndpoint({
  method: "DELETE",
  path: "/api/outlets/:outletId/zone-waiters/:assignmentId",
  params: z.strictObject({
    outletId: outletIdSchema,
    assignmentId: zoneWaiterAssignmentIdSchema,
  }),
});
