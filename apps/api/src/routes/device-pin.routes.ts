// Device pin + POS supervisor override API (bead legend-dxb; PRD v1.7 §3 F6,
// §6 B staff_pins, AUTH-06). Thin routes; every rule is in the services.
//
// staffPinRouter (mount at /api/staff-pins):
//   POST /verify              registered outlet device (X-Device-Token), no
//                             session: switch user with tile + 6-digit pin.
//                             Contract `verifyStaffPinForUser`. Optional
//                             `purpose: "attendance_clock"` adds a single-use
//                             `proof` (staff-pin-proof.service.ts); every call
//                             is device-throttled (429 + Retry-After).
//   PUT  /:outletId/:userId   signed-in, trusted origin, back-office surface
//                             (AUTH-05): self, or device.registry.manage on
//                             the outlet. Contract identity `setStaffPin`.
// posOverrideRouter (mount at /api/pos-overrides):
//   POST /                    signed-in requester; Idempotency-Key header
//                             bound to the body. 201 new, 200 replay.
//   GET  /:overrideId         requester/approver polls (settles a phone
//                             approval once its chain ends).
// Tenant always from the domain or device token (TEN-02); outlet from the
// device (verify), the path (set, checked against membership/permission) or
// the requester's membership (override).

import { Router, type Request } from "express";
import {
  createPosOverrideSchema,
  posOverrideParamsSchema,
  verifyStaffPinForUserSchema,
} from "@starter/shared/access/override";
import { CoreError, idempotencyKeySchema } from "@starter/shared/core";
import {
  setStaffPinSchema,
  staffPinParamsSchema,
} from "@starter/shared/identity";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { verifyDeviceToken } from "../lib/device-token";
import { HttpError } from "../lib/http-error";
import { actorOf, resolveActingStaff } from "../middleware/acting-staff";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireBackOfficeSurface } from "../middleware/identity-surface";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { setStaffPin } from "../services/device-pin.service";
import {
  PinDeviceThrottledError,
  verifyStaffPinWithProof,
} from "../services/staff-pin-proof.service";
import {
  createPosOverride,
  getPosOverride,
} from "../services/staff-override.service";
import { optionalDeviceIdOf } from "./optional-device-id";

function idempotencyKeyOf(req: Request): string | null {
  const raw = req.get("Idempotency-Key");
  return raw === undefined ? null : idempotencyKeySchema.parse(raw);
}

/** The signed device id, only when the token names the resolved tenant. */
function deviceIdOf(req: Request): string {
  const tenant = getTenantContext(req);
  const raw = req.get(DEVICE_TOKEN_HEADER);
  const payload = raw ? verifyDeviceToken(raw) : null;
  if (
    tenant.source !== "device" ||
    payload === null ||
    payload.tenantId.toLowerCase() !== tenant.tenantId.toLowerCase()
  )
    throw new CoreError(
      "UNAUTHORIZED",
      "Hanya perangkat outlet terdaftar yang dapat memakai PIN.",
    );
  return payload.deviceId;
}

export const staffPinRouter = Router();

staffPinRouter.post(
  "/verify",
  requireTenantContext,
  jsonBody,
  async (req, res) => {
    const deviceId = deviceIdOf(req);
    const input = verifyStaffPinForUserSchema.parse(req.body);
    res.setHeader("Cache-Control", "private, no-store");
    try {
      res.json({
        data: await verifyStaffPinWithProof(getTenantContext(req), {
          deviceId,
          userId: input.userId,
          pin: input.pin,
          purpose: input.purpose,
        }),
      });
    } catch (error) {
      // 429 tells the device when its window ends (bead legend-u7g9w).
      if (error instanceof PinDeviceThrottledError)
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
  },
);

staffPinRouter.put(
  "/:outletId/:userId",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
  jsonBody,
  async (req, res) => {
    const params = staffPinParamsSchema.parse(req.params);
    const input = setStaffPinSchema.parse(req.body);
    await setStaffPin(
      getTenantContext(req),
      getAuth(req).user.id,
      params,
      input,
    );
    res.status(204).end();
  },
);

export const posOverrideRouter = Router();

posOverrideRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
);

posOverrideRouter.post("/", jsonBody, async (req, res) => {
  const input = createPosOverrideSchema.parse(req.body);
  // The route has no :outletId, so resolveActingStaff could not compare the
  // token's outlet: do it against the body.
  if (
    req.actingStaff &&
    req.actingStaff.outletId.toLowerCase() !== input.outletId.toLowerCase()
  )
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
      "Kasir aktif bukan untuk outlet ini.",
    );
  let result: Awaited<ReturnType<typeof createPosOverride>>;
  try {
    result = await createPosOverride(
      getTenantContext(req),
      actorOf(req),
      input,
      {
        idempotencyKey: idempotencyKeyOf(req),
        deviceId: optionalDeviceIdOf(req),
      },
    );
  } catch (error) {
    // 429 tells the device when its PIN window ends (bead legend-vfj7z).
    if (error instanceof PinDeviceThrottledError)
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    throw error;
  }
  const { override, replayed } = result;
  res.setHeader("Cache-Control", "private, no-store");
  res.status(replayed ? 200 : 201).json({ data: override });
});

posOverrideRouter.get("/:overrideId", async (req, res) => {
  const { overrideId } = posOverrideParamsSchema.parse(req.params);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await getPosOverride(
      getTenantContext(req),
      actorOf(req),
      overrideId,
      // An acting cashier only sees overrides of the token's outlet.
      req.actingStaff?.outletId ?? null,
    ),
  });
});
