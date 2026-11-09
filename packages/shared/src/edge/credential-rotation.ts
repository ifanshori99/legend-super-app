// Edge node credential rotation (bead legend-x3lv; brief 90 WS-02 Section A;
// PRD v1.7 §3 F5 "Server Lokal", EDG-03). The cloud mints a new link
// credential for an active edge node and shows it ONCE. The previous
// credential keeps working for a grace period (EDGE_CREDENTIAL_ROTATION_GRACE_
// HOURS, default 24) so the operator can update the mini PC without an
// outage; after `previousCredentialExpiresAt` the cloud refuses it and closes
// any link still using it (4403). Rotating again replaces the previous one.
//
// Permission `device.registry.revoke` on the node's own outlet (resolved from
// the node, like the device routes); `outletId` is optional and, when given,
// must be that outlet. The tenant comes from the domain (TEN-02).
//
// `graceHours` (0..EDGE_CREDENTIAL_ROTATION_GRACE_HOURS, default that env
// value; 0 = cut the old credential off at once, e.g. a suspected leak). A
// rotation while the previous credential's grace is still open is refused
// (409) unless `force: true`, so a retried request cannot silently kill the
// credential the edge has just installed.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  uuidSchema,
  outletIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { edgeNodeSchema } from "./schemas.ts";

/** `edg1.<tenantId>.<outletId>.<edgeNodeId>.<secret>`; never logged. */
export const edgeNodeCredentialSchema = z
  .string()
  .max(300)
  .regex(/^edg1\.[^.]+\.[^.]+\.[^.]+\.[A-Za-z0-9_-]{43}$/);

/** The back-office view of a registered edge node. */
export const edgeNodeAdminViewSchema = edgeNodeSchema.extend({
  label: z.string().min(1).max(255),
  status: z.enum(["active", "revoked"]),
  revokedAt: isoDateTimeSchema.nullable(),
});
export type EdgeNodeAdminViewContract = z.infer<typeof edgeNodeAdminViewSchema>;

export const rotateEdgeNodeCredentialResultSchema = z.strictObject({
  edgeNode: edgeNodeAdminViewSchema,
  /** The new credential, shown ONCE (`Cache-Control: no-store`). */
  credential: edgeNodeCredentialSchema,
  /** Until when the replaced credential is accepted; null = cut off now. */
  previousCredentialExpiresAt: isoDateTimeSchema.nullable(),
});
export type RotateEdgeNodeCredentialResult = z.infer<
  typeof rotateEdgeNodeCredentialResultSchema
>;

export const rotateEdgeNodeCredential = defineEndpoint({
  method: "POST",
  path: "/api/edge-nodes/:edgeNodeId/rotate-credential",
  params: z.strictObject({ edgeNodeId: uuidSchema }),
  body: clientInputSchema({
    outletId: outletIdSchema.optional(),
    graceHours: z.number().int().min(0).max(720).optional(),
    force: z.boolean().optional(),
  }),
  response: dataResponseSchema(rotateEdgeNodeCredentialResultSchema),
});
