import { cafeLegendFixtures } from "../core/index.ts";
import { auditEventSchema } from "./schemas.ts";

const deviceId = "b23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13";
const actors = ["user", "ai", "mcp_client", "system", "device"] as const;
export const cafeLegendAuditFixtures = actors.map((actorType, index) =>
  auditEventSchema.parse({
    id: `01JBQ7Z8K3M4N5P6Q7R8S9T0V${index}`,
    tenantId: cafeLegendFixtures.tenant.id,
    outletId: cafeLegendFixtures.outlets[0].id,
    actorType,
    actorId:
      actorType === "system"
        ? null
        : actorType === "device"
          ? deviceId
          : "a23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
    deviceId,
    action: "settings.updated",
    objectType: "outlet",
    objectId: cafeLegendFixtures.outlets[0].id,
    reason: null,
    maskedChanges: {
      before: { status: "preopening" },
      after: { status: "active" },
    },
    ipHash: null,
    sensitiveAccess: false,
    retentionClass: "audit_2y",
    createdAt: "2026-11-01T05:12:00.000Z",
  }),
);
