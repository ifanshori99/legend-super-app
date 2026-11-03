// Mock for the revoke endpoint only. listEdgeDevices and setDeviceTrainingMode
// are owned by ws02-edge/mock.ts (the registry throws on a second
// registration), so this panel reads them through that mock. Revoke cannot
// write into ws02-edge's private device store, so revocation state lives here
// and the panel overlays it (hooks.ts useRevokedOverlay).
import {
  deviceFixtures,
  deviceSchema,
  transitionDevice,
  type Device,
} from "@starter/shared/edge";
import { CoreError } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { revokeEdgeDevice } from "./endpoints.ts";

const revoked = createMockStore(() => new Map<string, string>());
/** Idempotency replay: key → the first answer for that key. */
const replies = createMockStore(() => new Map<string, { data: Device }>());

registerMock(revokeEdgeDevice, ({ params, body }) => {
  const replay = replies.get().get(body.idempotencyKey);
  if (replay) return replay;
  const base = deviceFixtures.find((d) => d.id === params.deviceId);
  if (!base) throw new ApiError(404, "NOT_FOUND", "Perangkat tidak ditemukan.");
  const seen = revoked.get();
  const status: "active" | "revoked" = seen.has(base.id)
    ? "revoked"
    : (base.status as "active" | "revoked");
  try {
    transitionDevice(status, "revoke");
  } catch (error) {
    if (error instanceof CoreError)
      throw new ApiError(409, error.code, error.message);
    throw error;
  }
  const revokedAt = new Date().toISOString();
  seen.set(base.id, body.reason);
  const reply: { data: Device } = {
    data: deviceSchema.parse({
      ...base,
      lastSeenAt: new Date(Date.now() - 5_000).toISOString(),
      status: "revoked",
      revokedAt,
    }),
  };
  replies.get().set(body.idempotencyKey, reply);
  return reply;
});
