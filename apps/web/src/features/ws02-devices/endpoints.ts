// Revoke endpoint for the device registry (bead legend-q2c; PRD v1.7 §3 F5).
// CONTRACT GAP: packages/shared/src/edge/endpoints.ts has listEdgeDevices and
// setDeviceTrainingMode but no revoke call (identity `revokeSession` revokes a
// user session, not a registry device). This local definition reuses the
// shared deviceSchema and `transitionDevice(…, "revoke")`; the contract bead
// should move it into @starter/shared/edge. Requires `device.registry.revoke`.
import { z, clientInputSchema, dataResponseSchema } from "@starter/shared/core";
import { defineEndpoint } from "@starter/shared/api";
import { deviceParams, deviceSchema } from "@starter/shared/edge";

export const revokeEdgeDevice = defineEndpoint({
  method: "POST",
  path: "/api/edge/devices/:deviceId/revoke",
  params: deviceParams,
  body: clientInputSchema({ reason: z.string().trim().min(3).max(500) }),
  response: dataResponseSchema(deviceSchema),
});
