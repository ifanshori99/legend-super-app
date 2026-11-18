// Customer display routes (design legend-yhia9 D-08, §6; contract
// @starter/shared/pos endpoints.ts). Mounted before the POS order router on the
// same prefix (routes/index.ts) because the display device has no staff
// session: it authenticates with its device token alone.
//
// - Display (device token, no cookie): ask for a pairing code, read its state.
//   Every refusal of the state read (unpaired, revoked, other outlet) is the
//   same 404 DISPLAY_NOT_PAIRED, so nothing tells which case it was.
// - Cashier on a terminal (staff session + terminal device token): pair,
//   select the bill, revoke. The display itself can never select a bill and no
//   route accepts an amount.
import { Router, type Request } from "express";
import { CoreError, outletIdSchema, userIdSchema } from "@starter/shared/core";
import {
  getCustomerDisplayState,
  pairCustomerDisplay,
  revokeCustomerDisplayPairing,
  selectCustomerDisplayBill,
} from "@starter/shared/pos";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireOutletPermission } from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import * as display from "../services/customer-display.service.ts";
import { HttpError } from "../lib/http-error.ts";
import { currentDeviceIdOf } from "./device-id.ts";

export const customerDisplayRouter = Router({ mergeParams: true });

const BASE = "/customer-display";
const outletOf = (req: Request) => String(req.params.outletId ?? "");
const staff = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  resolveActingStaff,
];
// Commands (pair, config, clear) also need the cashier token on a shared
// device (legend-3z0ds). The cashier preview GET stays tokenless: a second
// window of the same device has no token of its own and only reads.
const staffCommand = [...staff, requireActingStaffOnSharedDevice];
const operate = requireOutletPermission("pos.sale.create", outletOf);
const view = requireOutletPermission("order.view", outletOf);

/** The signed, registry-checked device of this request; 401 without one. */
async function requireDevice(req: Request): Promise<string> {
  const deviceId = await currentDeviceIdOf(req);
  if (deviceId === null)
    throw new CoreError(
      "UNAUTHORIZED",
      "Token perangkat diperlukan untuk layar pelanggan.",
    );
  return deviceId;
}

/** The terminal a cashier acts from: always the signed device token. */
async function requireTerminal(req: Request): Promise<string> {
  const deviceId = await currentDeviceIdOf(req);
  if (deviceId === null)
    throw new HttpError(
      400,
      "TERMINAL_DEVICE_REQUIRED",
      "Perintah ini harus dikirim dari perangkat kasir yang terdaftar.",
    );
  return deviceId;
}

// GET: the display device first (token only); anyone else falls through to the
// cashier preview (staff session + terminalDeviceId).
customerDisplayRouter.get(
  BASE,
  requireTenantContext,
  async (req, res, next) => {
    const deviceId = await currentDeviceIdOf(req);
    if (deviceId !== null) {
      const tenant = getTenantContext(req);
      const outletId = outletIdSchema.parse(outletOf(req));
      const type = await display.displayDeviceTypeOf(
        tenant,
        outletId,
        deviceId,
      );
      if (type === null) throw display.notPaired();
      if (type === "display") {
        res.setHeader("Cache-Control", "private, no-store");
        // The query is ignored on purpose: nothing a display sends changes
        // what it is shown.
        res.json({
          data: await display.readStateForDisplay(tenant, outletId, deviceId),
        });
        return;
      }
    }
    next();
  },
  ...staff,
  view,
  async (req, res) => {
    const query = getCustomerDisplayState.query.parse(req.query);
    const terminalDeviceId =
      query.terminalDeviceId ?? (await currentDeviceIdOf(req));
    if (!terminalDeviceId)
      throw new HttpError(
        400,
        "TERMINAL_DEVICE_REQUIRED",
        "Sebutkan terminalDeviceId atau kirim dari perangkat kasir.",
      );
    res.json({
      data: await display.readStateForTerminal(
        getTenantContext(req),
        outletIdSchema.parse(outletOf(req)),
        terminalDeviceId,
      ),
    });
  },
);

customerDisplayRouter.post(
  `${BASE}/pairing-codes`,
  requireTenantContext,
  requireTrustedOrigin,
  jsonBody,
  async (req, res) => {
    const deviceId = await requireDevice(req);
    res.json({
      data: await display.issuePairingCode(
        getTenantContext(req),
        outletIdSchema.parse(outletOf(req)),
        deviceId,
      ),
    });
  },
);

// The pair-code throttle runs before the permission check: every guess takes a
// slot (5 per terminal, 20 per outlet in 5 minutes, then 429), whoever sends it.
const pairSlots = new WeakMap<Request, string>();

customerDisplayRouter.post(
  `${BASE}/pair`,
  requireTenantContext,
  ...staffCommand,
  jsonBody,
  async (req, res, next) => {
    pairCustomerDisplay.body.parse(req.body);
    const terminalDeviceId = await requireTerminal(req);
    try {
      pairSlots.set(
        req,
        await display.reservePairSlot(
          getTenantContext(req),
          outletIdSchema.parse(outletOf(req)),
          terminalDeviceId,
        ),
      );
    } catch (error) {
      // 429 tells the terminal when its window ends.
      if (error instanceof display.PairThrottledError)
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
    next();
  },
  operate,
  async (req, res) => {
    const body = pairCustomerDisplay.body.parse(req.body);
    res.status(201).json({
      data: await display.pairCustomerDisplay(
        getTenantContext(req),
        outletIdSchema.parse(outletOf(req)),
        await requireTerminal(req),
        userIdSchema.parse(actorOf(req)),
        body.code,
        pairSlots.get(req)!,
      ),
    });
  },
);

customerDisplayRouter.put(
  `${BASE}/selection`,
  requireTenantContext,
  ...staffCommand,
  operate,
  jsonBody,
  async (req, res) => {
    const body = selectCustomerDisplayBill.body.parse(req.body);
    const terminalDeviceId = await requireTerminal(req);
    res.json({
      data: await display.selectCustomerDisplayBill(
        getTenantContext(req),
        outletIdSchema.parse(outletOf(req)),
        terminalDeviceId,
        body.orderId,
      ),
    });
  },
);

customerDisplayRouter.delete(
  `${BASE}/pairings/:pairingId`,
  requireTenantContext,
  ...staffCommand,
  operate,
  async (req, res) => {
    const params = revokeCustomerDisplayPairing.params.parse(req.params);
    res.json({
      data: await display.revokeCustomerDisplayPairing(
        getTenantContext(req),
        params.outletId,
        params.pairingId,
        userIdSchema.parse(actorOf(req)),
      ),
    });
  },
);
