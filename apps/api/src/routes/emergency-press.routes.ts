// Emergency button: press, acknowledge and POS fallback (bead legend-bod.4;
// design docs/design/edge-emergency.md D-05, D-06, D-07, Q94). Thin routes; the
// rules are in services/panic-relay.service.ts. Mount at /api/emergency.
// Receiver sessions live in emergency.routes.ts (/api/emergency/sessions).
//
//   POST /press                  panic button, device token only. 201 a new
//                                alert, 200 a replay or a folded press.
//                                429 past 30 requests per minute per device.
//   POST /alerts/:alertId/ack    receiver session cookie + trusted Origin;
//                                body {}. 200, again by the same staff 200,
//                                by another 409, no session 401, 404.
//   GET  /fallback               POS device token: the alarms nobody confirmed
//                                within 15 s, room and time only (Q94).
//
// The edge allowlist (edge/mode.ts) serves exactly these methods and paths. The
// tenant and the outlet come from the device token or the session, never from
// the request.
import { Router } from "express";
import {
  panicAckBodySchema,
  panicAlertIdSchema,
  panicFallbackResponseSchema,
  panicPressBodySchema,
} from "@starter/shared/facility";
import { HttpError } from "../lib/http-error.ts";
import { jsonBody } from "../middleware/body.ts";
import { noStore } from "../middleware/no-store.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  acknowledgePanicAlert,
  ingestPanicPress,
  readPanicFallback,
  takePanicPressSlot,
} from "../services/panic-relay.service.ts";
import { authenticateReceiverSession } from "../services/panic-receiver-session.ts";
import { listOpenPanicAlerts } from "../services/panic-open-alerts.service.ts";
import { registeredDeviceIdOf } from "./device-id.ts";

const unregistered = () =>
  new HttpError(401, "DEVICE_NOT_REGISTERED", "Perangkat tidak terdaftar.");

/** The tenant and device of a registered device token; 401 for anything else, no hint. */
async function deviceOf(req: Parameters<typeof registeredDeviceIdOf>[0]) {
  // No token, a forged or revoked one, or a device of another outlet resolves
  // no tenant (deviceTenantCredential), so all of them are the same 401.
  const tenant = findTenantContext(req);
  if (tenant === undefined) throw unregistered();
  const deviceId = await registeredDeviceIdOf(req);
  if (deviceId === null) throw unregistered();
  return { tenant, deviceId };
}

export const emergencyPressRouter = Router();
emergencyPressRouter.use(noStore);

emergencyPressRouter.post(
  "/press",
  // Device and rate limit first: a stranger or a flood never reaches the body.
  async (req, res, next) => {
    const device = await deviceOf(req);
    takePanicPressSlot(device.tenant.tenantId, device.deviceId);
    res.locals.device = device;
    next();
  },
  jsonBody,
  async (req, res) => {
    const { tenant, deviceId } = res.locals.device as Awaited<
      ReturnType<typeof deviceOf>
    >;
    const body = panicPressBodySchema.parse(req.body);
    const result = await ingestPanicPress(tenant, { deviceId, body });
    res
      .status(result.replayed || result.folded ? 200 : 201)
      .json({ data: result });
  },
);

emergencyPressRouter.post(
  "/alerts/:alertId/ack",
  requireTrustedOrigin,
  jsonBody,
  async (req, res) => {
    const session = await authenticateReceiverSession(req.get("cookie"));
    if (session === null)
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Sesi darurat tidak berlaku. Masuk lagi dengan PIN.",
      );
    panicAckBodySchema.parse(req.body ?? {});
    const alertId = panicAlertIdSchema.safeParse(req.params.alertId);
    if (!alertId.success)
      throw new HttpError(404, "NOT_FOUND", "Peringatan tidak ditemukan.");
    res.json({ data: await acknowledgePanicAlert(session, alertId.data) });
  },
);

emergencyPressRouter.get("/fallback", async (req, res) => {
  const { tenant, deviceId } = await deviceOf(req);
  const alerts = await readPanicFallback(tenant, deviceId);
  res.json({ data: panicFallbackResponseSchema.parse({ alerts }) });
});

emergencyPressRouter.get("/open-alerts", async (req, res) => {
  const session = await authenticateReceiverSession(req.get("cookie"));
  if (session === null)
    throw new HttpError(
      401,
      "UNAUTHORIZED",
      "Sesi darurat tidak berlaku. Masuk lagi dengan PIN.",
    );
  res.json({ data: { alerts: await listOpenPanicAlerts(session) } });
});
