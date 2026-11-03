// Revoke endpoint for the device registry (bead legend-q2c; PRD v1.7 §3 F5).
// CONTRACT GAP: packages/shared/src/edge/endpoints.ts has listEdgeDevices and
// setDeviceTrainingMode but no revoke call (identity `revokeSession` revokes a
// user session, not a registry device). This local definition reuses the
// shared deviceSchema and `transitionDevice(…, "revoke")`; the contract bead
// should move it into @starter/shared/edge. Requires `device.registry.revoke`.
//
// Idempotent: one key per confirmation, so a retried or double-sent request
// replays the first answer instead of a second audit entry. A revoke of an
// already-revoked device is a CONFLICT (`transitionDevice`); the panel treats
// it as "already revoked". There is no un-revoke call: a revoked device is
// re-registered as a new device (PRD v1.7 §3 F5).
import {
  z,
  clientInputSchema,
  dataResponseSchema,
  idempotencyKeySchema,
} from "@starter/shared/core";
import { defineEndpoint } from "@starter/shared/api";
import { deviceParams, deviceSchema } from "@starter/shared/edge";

export const revokeEdgeDevice = defineEndpoint({
  method: "POST",
  path: "/api/edge/devices/:deviceId/revoke",
  params: deviceParams,
  body: clientInputSchema({
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(deviceSchema),
});
