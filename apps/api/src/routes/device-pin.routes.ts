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
//   GET  /approvers?outletId&action
//                             card 1268 B3: who can approve this action in
//                             the outlet (permission + usable PIN, requester
//                             excluded). Needs the acting cashier on a shared
//                             device and outlet membership; declared before
//                             /:overrideId.
//   GET  /:overrideId         requester/approver polls (settles a phone
//                             approval once its chain ends).
//   GET  /approvals/:requestId
//                             POS phone-approval poll (sub-brief E3): the
//                             acting cashier reads their own pos_override
//                             request at the device's outlet (same guards and
//                             scope as the cancel below); else 404.
//   POST /approvals/:requestId/cancel
//                             POS "Berhenti menunggu" (sub-brief E3): the
//                             acting cashier (signed device + X-Acting-Staff
//                             required) withdraws their own pending phone
//                             override (:requestId = its approvalRequestId)
//                             at the device's outlet. No back-office MFA
//                             gate; any other request is 404.
// Tenant always from the domain or device token (TEN-02); outlet from the
// device (verify), the path (set, checked against membership/permission) or
// the requester's membership (override).

import { Router, type Request } from "express";
import {
  createPosOverrideSchema,
  posOverrideApproversQuerySchema,
  posOverrideParamsSchema,
  verifyStaffPinForUserSchema,
} from "@starter/shared/access/override";
import { CoreError, idempotencyKeySchema } from "@starter/shared/core";
import {
  approvalRequestParamsSchema,
  setStaffPinSchema,
  staffPinParamsSchema,
} from "@starter/shared/identity";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { HttpError } from "../lib/http-error";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import {
  getAuth,
  requireAuth,
  requireAuthAllowSharedDevice,
} from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireBackOfficeSurface } from "../middleware/identity-surface";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { setStaffPin } from "../services/device-pin.service";
import { listPosOverrideApprovers } from "../services/pos-override-approvers.service";
import {
  PinDeviceThrottledError,
  verifyStaffPinWithProof,
} from "../services/staff-pin-proof.service";
import {
  cancelOwnPosOverrideApproval,
  createPosOverride,
  getOwnPosOverrideApproval,
  getPosOverride,
} from "../services/staff-override.service";
import { currentDeviceIdOf, registeredDeviceIdOf } from "./device-id.ts";

function idempotencyKeyOf(req: Request): string | null {
  const raw = req.get("Idempotency-Key");
  return raw === undefined ? null : idempotencyKeySchema.parse(raw);
}

/**
 * The signed device id, only when the token names the resolved tenant and the
 * registry still accepts it (not revoked, not rotated out).
 */
async function deviceIdOf(req: Request): Promise<string> {
  if (getTenantContext(req).source !== "device")
    throw new CoreError(
      "UNAUTHORIZED",
      "Hanya perangkat outlet terdaftar yang dapat memakai PIN.",
    );
  const deviceId = await registeredDeviceIdOf(req);
  if (deviceId === null)
    throw new CoreError(
      "UNAUTHORIZED",
      "Token perangkat ini tidak berlaku lagi. Daftarkan ulang perangkat.",
    );
  return deviceId;
}

export const staffPinRouter = Router();

staffPinRouter.post(
  "/verify",
  requireTenantContext,
  jsonBody,
  async (req, res) => {
    const deviceId = await deviceIdOf(req);
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
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
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
  const deviceId = await currentDeviceIdOf(req);
  let result: Awaited<ReturnType<typeof createPosOverride>>;
  try {
    result = await createPosOverride(
      getTenantContext(req),
      actorOf(req),
      input,
      {
        idempotencyKey: idempotencyKeyOf(req),
        deviceId,
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

// Before /:overrideId, which would take "approvers" for an id.
posOverrideRouter.get("/approvers", async (req, res) => {
  const query = posOverrideApproversQuerySchema.parse(req.query);
  // The route has no :outletId, so resolveActingStaff could not compare the
  // token's outlet: do it against the query.
  if (
    req.actingStaff &&
    req.actingStaff.outletId.toLowerCase() !== query.outletId.toLowerCase()
  )
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH,
      "Kasir aktif bukan untuk outlet ini.",
    );
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await listPosOverrideApprovers(
      getTenantContext(req),
      actorOf(req),
      query,
    ),
  });
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

/**
 * The device's acting cashier, required by the MFA-free approval paths:
 * resolveActingStaff has verified the device signature, the session, the
 * device's outlet and the staff member's active membership. Without it the
 * session owner would be the actor, which these paths must never allow.
 */
function requiredActingStaff(req: Request) {
  const acting = req.actingStaff;
  if (!acting)
    throw new HttpError(
      401,
      ACTING_STAFF_ERROR_CODES.INVALID,
      "Masukkan PIN kasir aktif dulu untuk melihat atau membatalkan permintaan ini.",
    );
  return acting;
}

// Two segments deep: no clash with GET /:overrideId.
posOverrideRouter.get("/approvals/:requestId", async (req, res) => {
  const { requestId } = approvalRequestParamsSchema.parse(req.params);
  const acting = requiredActingStaff(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await getOwnPosOverrideApproval(
      getTenantContext(req),
      acting.staffUserId,
      requestId,
      acting.outletId,
    ),
  });
});

// No jsonBody: the browser sends this POST with no body and no content-type.
posOverrideRouter.post("/approvals/:requestId/cancel", async (req, res) => {
  const { requestId } = approvalRequestParamsSchema.parse(req.params);
  idempotencyKeyOf(req);
  const acting = requiredActingStaff(req);
  const deviceId = await currentDeviceIdOf(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await cancelOwnPosOverrideApproval(
      getTenantContext(req),
      acting.staffUserId,
      requestId,
      acting.outletId,
      { deviceId },
    ),
  });
});
