// POS cashier shift, cash movement and end-of-day routes (bead legend-6c0;
// contract @starter/shared/pos endpoints.ts "Cashier shift" and "End of day").
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/pos",
// posShiftRouter)` next to posOrderRouter; the router merges params.
//
// - requireAuthAllowSharedDevice + requireTrustedOrigin + requireTenantContext, then
//   requireOutletPermission on the path's outlet (TEN-03). The services check
//   the same permissions again and fail closed.
// - Bodies, params and queries are parsed with the strict contract schemas.
//   A blind-count body never carries expected/counted/variance: the server
//   computes them (POS-03).
// - The device id is only ever the signed X-Device-Token's, and only when it
//   names the request's tenant. Anything else is null: a client-claimed
//   device is never trusted.

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import { userIdSchema } from "@starter/shared/core";
import {
  closePosDay,
  closePosShift,
  decidePosCashMovement,
  forceClosePosShift,
  listPosShiftCounts,
  submitPosShiftCount,
  getEndOfDayRecap,
  getPosShift,
  listPosCashMovements,
  listPosShifts,
  openPosShift,
  recordPosCashMovement,
} from "@starter/shared/pos";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as day from "../services/pos-day.service.ts";
import * as cashApproval from "../services/pos-shift-cash-approval.service.ts";
import * as shifts from "../services/pos-shift.service.ts";
import { currentDeviceIdOf } from "./device-id.ts";

export const posShiftRouter = Router({ mergeParams: true });

posShiftRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const can = (permission: PermissionCode) =>
  requireOutletPermission(permission, outletOf);

/** Passes when the caller holds at least one of the permissions on the outlet. */
function canAny(...permissions: PermissionCode[]): RequestHandler {
  const guards = permissions.map(can);
  return async (req: Request, res: Response, next: NextFunction) => {
    let denied: unknown = null;
    for (const guard of guards) {
      let outcome: unknown;
      let passed = false;
      try {
        await guard(req, res, (error?: unknown) => {
          if (error === undefined) passed = true;
          else outcome = error;
        });
      } catch (error) {
        outcome = error;
      }
      if (passed) {
        next();
        return;
      }
      if (!(outcome instanceof AccessError)) {
        next(outcome);
        return;
      }
      denied ??= outcome;
    }
    next(denied);
  };
}

const operate = can("shift.cash.operate");
const approveClose = can("shift.cash.approve_close");
const decideHeldCash = can(cashApproval.HELD_CASH_MOVEMENT_APPROVE_PERMISSION);
// The cashier counts; a supervisor submits a forced count (the service decides).
const operateOrApproveClose = canAny(
  "shift.cash.operate",
  "shift.cash.approve_close",
);
const readShift = canAny(
  "shift.cash.operate",
  "shift.cash.view_all",
  "shift.cash.approve_close",
);
// Founder Q9: the outlet manager closes the day; supervisors may only read it.
const readDay = canAny(
  "pos.day.close",
  "shift.cash.view_all",
  "shift.cash.approve_close",
);
const closeDay = can("pos.day.close");

async function caller(req: Request): Promise<shifts.ShiftCaller> {
  return {
    userId: userIdSchema.parse(actorOf(req)),
    deviceId: await currentDeviceIdOf(req),
  };
}

// ---- Shifts -------------------------------------------------------------------

posShiftRouter.post("/shifts", operate, jsonBody, async (req, res) => {
  const { outletId } = openPosShift.params.parse(req.params);
  const body = openPosShift.body.parse(req.body);
  const shift = await shifts.openPosShift(
    getScopedTenantContext(req),
    await caller(req),
    outletId,
    body,
  );
  res.location(
    `/api/outlets/${encodeURIComponent(outletId)}/pos/shifts/${encodeURIComponent(shift.id)}`,
  );
  res.status(201).json({ data: shift });
});

posShiftRouter.get("/shifts", readShift, async (req, res) => {
  const { outletId } = listPosShifts.params.parse(req.params);
  const query = listPosShifts.query.parse(req.query);
  res.json(
    await shifts.listPosShifts(
      getScopedTenantContext(req),
      await caller(req),
      outletId,
      query,
    ),
  );
});

posShiftRouter.get("/shifts/:shiftId", readShift, async (req, res) => {
  const { outletId, shiftId } = getPosShift.params.parse(req.params);
  res.json({
    data: await shifts.getPosShiftReport(
      getScopedTenantContext(req),
      await caller(req),
      outletId,
      shiftId,
    ),
  });
});

// Blind count submissions (legend-6c0 round 2): the cashier submits, the
// supervisor reads the trail with expected and variance.
posShiftRouter.post(
  "/shifts/:shiftId/counts",
  operateOrApproveClose,
  jsonBody,
  async (req, res) => {
    const { outletId, shiftId } = submitPosShiftCount.params.parse(req.params);
    const body = submitPosShiftCount.body.parse(req.body);
    res.status(201).json({
      data: await shifts.submitPosShiftCount(
        getScopedTenantContext(req),
        await caller(req),
        outletId,
        shiftId,
        body,
      ),
    });
  },
);

posShiftRouter.get("/shifts/:shiftId/counts", readShift, async (req, res) => {
  const { outletId, shiftId } = listPosShiftCounts.params.parse(req.params);
  res.json({
    data: await shifts.listPosShiftCounts(
      getScopedTenantContext(req),
      await caller(req),
      outletId,
      shiftId,
    ),
  });
});

posShiftRouter.post(
  "/shifts/:shiftId/close",
  operate,
  jsonBody,
  async (req, res) => {
    const { outletId, shiftId } = closePosShift.params.parse(req.params);
    const body = closePosShift.body.parse(req.body);
    res.json({
      data: await shifts.closePosShift(
        getScopedTenantContext(req),
        await caller(req),
        outletId,
        shiftId,
        body,
      ),
    });
  },
);

posShiftRouter.post(
  "/shifts/:shiftId/force-close",
  approveClose,
  jsonBody,
  async (req, res) => {
    const { outletId, shiftId } = forceClosePosShift.params.parse(req.params);
    const body = forceClosePosShift.body.parse(req.body);
    res.json({
      data: await shifts.forceClosePosShift(
        getScopedTenantContext(req),
        await caller(req),
        outletId,
        shiftId,
        body,
      ),
    });
  },
);

// ---- Cash movements -----------------------------------------------------------

posShiftRouter.post(
  "/shifts/:shiftId/cash-movements",
  operate,
  jsonBody,
  async (req, res) => {
    const { outletId, shiftId } = recordPosCashMovement.params.parse(
      req.params,
    );
    const body = recordPosCashMovement.body.parse(req.body);
    res.status(201).json({
      data: await shifts.recordCashMovement(
        getScopedTenantContext(req),
        await caller(req),
        outletId,
        shiftId,
        body,
      ),
    });
  },
);

posShiftRouter.get(
  "/shifts/:shiftId/cash-movements",
  readShift,
  async (req, res) => {
    const { outletId, shiftId } = listPosCashMovements.params.parse(req.params);
    const query = listPosCashMovements.query.parse(req.query);
    res.json(
      await shifts.listCashMovements(
        getScopedTenantContext(req),
        await caller(req),
        outletId,
        shiftId,
        query,
      ),
    );
  },
);

posShiftRouter.post(
  "/shifts/:shiftId/cash-movements/:movementId/decision",
  decideHeldCash,
  jsonBody,
  async (req, res) => {
    const { outletId, shiftId, movementId } =
      decidePosCashMovement.params.parse(req.params);
    const body = decidePosCashMovement.body.parse(req.body);
    res.json({
      data: await cashApproval.decideHeldCashMovement(
        getScopedTenantContext(req),
        await caller(req),
        outletId,
        shiftId,
        movementId,
        body,
      ),
    });
  },
);

// ---- End of day ---------------------------------------------------------------

posShiftRouter.get("/day", readDay, async (req, res) => {
  const { outletId } = getEndOfDayRecap.params.parse(req.params);
  const { businessDate } = getEndOfDayRecap.query.parse(req.query);
  res.json({
    data: await day.getEndOfDayRecap(
      getScopedTenantContext(req),
      { userId: userIdSchema.parse(actorOf(req)) },
      outletId,
      businessDate,
    ),
  });
});

posShiftRouter.post("/day/close", closeDay, jsonBody, async (req, res) => {
  const { outletId } = closePosDay.params.parse(req.params);
  const body = closePosDay.body.parse(req.body);
  res.json({
    data: await day.closePosDay(
      getScopedTenantContext(req),
      { userId: userIdSchema.parse(actorOf(req)) },
      outletId,
      body,
    ),
  });
});
