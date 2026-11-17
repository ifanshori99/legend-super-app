// Cloud device registry API (bead legend-165; PRD v1.7 §3 F5 "Registri
// Perangkat" and "Mode Latihan", EDG-03). Mount at /api/devices.
//
//   GET   /                        device.registry.manage on query.outletId
//   POST  /                        device.registry.manage on body.outletId; 201
//                                  with the token, shown ONCE
//   POST  /heartbeat               the device itself (X-Device-Token), no session
//   POST  /:deviceId/token         device.registry.manage on the device's outlet;
//                                  reissue, older tokens stop working
//   POST  /:deviceId/revoke        device.registry.revoke on the device's outlet;
//                                  terminal
//   PATCH /:deviceId/training-mode device.registry.manage on the device's outlet
//
// Staff routes: signed-in, trusted origin, tenant from the domain (TEN-02),
// back-office surface (AUTH-05). Inputs are strict; tenant ids are never
// accepted. A device id is looked up under tenant-wide RLS first, then the
// permission is checked on its outlet; an unknown device, another tenant's
// device and a device in an outlet the caller cannot reach all answer the same
// 404.
//
// `deviceHeartbeatHandler` is shared with the edge router
// (/api/edge/devices/heartbeat). The device id comes only from the verified
// token; the body cannot name one. The handler reads the token itself (a
// brand-pinned domain makes the resolved tenant source "domain", not
// "device"); a resolved tenant must agree with the token or the answer is 403.
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { AccessError } from "@starter/shared/access";
import { CoreError, outletIdSchema } from "@starter/shared/core";
import {
  deviceParams,
  enrollDevice as enrollDeviceEndpoint,
  issueDeviceToken as issueDeviceTokenEndpoint,
  listOutletDevices as listOutletDevicesEndpoint,
  revokeDevice as revokeDeviceEndpoint,
  setOutletDeviceSharedMode as setSharedModeEndpoint,
  setOutletDeviceTrainingMode as setTrainingModeEndpoint,
} from "@starter/shared/edge";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import { currentDeviceIdOf } from "./device-id.ts";
import {
  assertNotOwnSharedDevice,
  enrollDevice,
  findDeviceOutletId,
  issueDeviceToken,
  deviceHeartbeatHandler,
  listOutletDevices,
  revokeDevice,
  setDeviceSharedMode,
  setDeviceTrainingMode,
} from "../services/device.service.ts";

const notFound = () => new CoreError("NOT_FOUND", "Perangkat tidak ditemukan.");

export { deviceHeartbeatHandler };

export const deviceHeartbeatMiddleware: RequestHandler[] = [
  requireTenantContext,
  jsonBody,
  deviceHeartbeatHandler,
];

const backOffice: RequestHandler[] = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
];

/** Reads the outlet for the permission check; Zod rejects bad input (422). */
const bodyOutlet = (req: { body?: unknown }) =>
  outletIdSchema.parse(
    (req.body as { outletId?: unknown } | undefined)?.outletId,
  );

const deviceOutlets = new WeakMap<Request, string>();

/**
 * Permission on the outlet of the device named in the path. Everything that
 * is not "you may act on this device" is the same 404.
 */
function requireDevicePermission(
  permission: "device.registry.manage" | "device.registry.revoke",
): RequestHandler {
  const check = requireOutletPermission(permission, (req) => {
    const outletId = deviceOutlets.get(req);
    if (!outletId) throw notFound();
    return outletId;
  });
  return async (req: Request, res: Response, next: NextFunction) => {
    const { deviceId } = deviceParams.parse(req.params);
    const outletId = await findDeviceOutletId(getTenantContext(req), deviceId);
    if (!outletId) throw notFound();
    deviceOutlets.set(req, outletId);
    try {
      await check(req, res, () => undefined);
    } catch (error) {
      if (error instanceof AccessError && error.code === "PERMISSION_DENIED")
        throw notFound();
      throw error;
    }
    next();
  };
}

export const deviceRouter = Router();

// The device itself, no session: declared before the `/:deviceId` routes.
deviceRouter.post("/heartbeat", ...deviceHeartbeatMiddleware);

deviceRouter.get(
  "/",
  ...backOffice,
  requireOutletPermission(
    "device.registry.manage",
    (req) => listOutletDevicesEndpoint.query.parse(req.query).outletId,
  ),
  async (req, res) => {
    const query = listOutletDevicesEndpoint.query.parse(req.query);
    res.json(await listOutletDevices(getScopedTenantContext(req), query));
  },
);

deviceRouter.post(
  "/",
  ...backOffice,
  jsonBody,
  requireOutletPermission("device.registry.manage", bodyOutlet),
  async (req, res) => {
    const input = enrollDeviceEndpoint.body.parse(req.body);
    const result = await enrollDevice(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res
      .status(201)
      .location(`/api/devices/${encodeURIComponent(result.device.id)}`)
      .json({ data: result });
  },
);

deviceRouter.post(
  "/:deviceId/token",
  ...backOffice,
  jsonBody,
  requireDevicePermission("device.registry.manage"),
  async (req, res) => {
    const { deviceId } = deviceParams.parse(req.params);
    issueDeviceTokenEndpoint.body.parse(req.body);
    const result = await issueDeviceToken(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      { deviceId },
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ data: result });
  },
);

deviceRouter.post(
  "/:deviceId/revoke",
  ...backOffice,
  jsonBody,
  requireDevicePermission("device.registry.revoke"),
  async (req, res) => {
    const { deviceId } = deviceParams.parse(req.params);
    const input = revokeDeviceEndpoint.body.parse(req.body);
    assertNotOwnSharedDevice(
      deviceId,
      getAuth(req).session.sharedDeviceId,
      await currentDeviceIdOf(req),
    );
    res.json({
      data: await revokeDevice(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { deviceId, reason: input.reason },
      ),
    });
  },
);

deviceRouter.patch(
  "/:deviceId/shared-mode",
  ...backOffice,
  jsonBody,
  requireDevicePermission("device.registry.manage"),
  async (req, res) => {
    const { deviceId } = deviceParams.parse(req.params);
    const input = setSharedModeEndpoint.body.parse(req.body);
    if (!input.sharedMode)
      assertNotOwnSharedDevice(
        deviceId,
        getAuth(req).session.sharedDeviceId,
        await currentDeviceIdOf(req),
      );
    res.json({
      data: await setDeviceSharedMode(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { deviceId, sharedMode: input.sharedMode },
      ),
    });
  },
);

deviceRouter.patch(
  "/:deviceId/training-mode",
  ...backOffice,
  jsonBody,
  requireDevicePermission("device.registry.manage"),
  async (req, res) => {
    const { deviceId } = deviceParams.parse(req.params);
    const input = setTrainingModeEndpoint.body.parse(req.body);
    res.json({
      data: await setDeviceTrainingMode(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { deviceId, trainingMode: input.trainingMode },
      ),
    });
  },
);
