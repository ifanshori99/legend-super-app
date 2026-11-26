// Paid WFC admin routes (brief 1270 cards W1 and W1b): seats, hourly quota,
// product split and switch, business settings proposals. Configuration only;
// nothing here sells a seat or takes money.
// Mounted under `facilityRouter` at `/wfc` (after its requireAuth /
// requireTrustedOrigin / requireTenantContext), so the paths here are relative
// to /api/facility/wfc.
//
// Gates: seat list `facility.booth.operate`; seats, quota and product split
// `facility.config.manage`; settings and product switch `wfc.policy.manage`.
// `requireMenuPermission` checks reach; every service re-checks the permission
// on the row's own outlet (TEN-03). Bodies are parsed by the services with the
// strict shared schemas (an unknown field is a 400). A settings version is
// never written here directly: a second person approves the proposal in the
// approval inbox, then the consumer or `apply` writes it.
import { Router } from "express";
import { getAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import * as seats from "../services/wfc-seat.service.ts";
import * as settings from "../services/wfc-settings.service.ts";

const operate = requireMenuPermission("facility.booth.operate");
const manage = requireMenuPermission("facility.config.manage");
const policy = requireMenuPermission("wfc.policy.manage");

export const wfcAdminRouter = Router();

/** A query value as the service sees it; a missing one fails its schema (400). */
const queryValue = (value: unknown): string =>
  typeof value === "string" ? value : "";

// ------------------------------------------------------------------- seats

wfcAdminRouter.get("/seats", operate, async (req, res) => {
  const zoneId =
    typeof req.query.zoneId === "string" ? req.query.zoneId : undefined;
  res.json({
    data: await seats.listWfcSeats(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      zoneId === undefined ? {} : { zoneId },
    ),
  });
});

wfcAdminRouter.post("/seats", manage, jsonBody, async (req, res) => {
  res.status(201).json({
    data: await seats.createWfcSeat(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      req.body,
    ),
  });
});

wfcAdminRouter.patch(
  "/seats/:seatId/status",
  manage,
  jsonBody,
  async (req, res) => {
    res.json({
      data: await seats.setWfcSeatStatus(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { ...req.body, seatId: req.params.seatId },
      ),
    });
  },
);

// ------------------------------------------------------------------- quota

wfcAdminRouter.get("/quotas", manage, async (req, res) => {
  res.json({
    data: await seats.listWfcHourlyQuotas(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      { outletId: queryValue(req.query.outletId) },
    ),
  });
});

wfcAdminRouter.put("/quotas", manage, jsonBody, async (req, res) => {
  res.json({
    data: await seats.putWfcHourlyQuotas(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      req.body,
    ),
  });
});

// ----------------------------------------------------------------- product

wfcAdminRouter.put(
  "/products/:productId/split",
  manage,
  jsonBody,
  async (req, res) => {
    res.json({
      data: await seats.setWfcProduct(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { ...req.body, productId: req.params.productId },
      ),
    });
  },
);

wfcAdminRouter.put(
  "/products/:productId/active",
  policy,
  jsonBody,
  async (req, res) => {
    res.json({
      data: await settings.setWfcProductActive(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { ...req.body, productId: req.params.productId },
      ),
    });
  },
);

// ---------------------------------------------------------------- settings

wfcAdminRouter.get("/settings", policy, async (req, res) => {
  res.json({
    data: await settings.listWfcSettings(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      { outletId: queryValue(req.query.outletId) },
    ),
  });
});

wfcAdminRouter.post(
  "/settings/proposals",
  policy,
  jsonBody,
  async (req, res) => {
    res.status(201).json({
      data: await settings.proposeWfcSettings(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        req.body,
      ),
    });
  },
);

wfcAdminRouter.post(
  "/settings/proposals/:chainId/apply",
  policy,
  async (req, res) => {
    res.json({
      data: await settings.applyWfcSettings(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { chainId: String(req.params.chainId) },
      ),
    });
  },
);
