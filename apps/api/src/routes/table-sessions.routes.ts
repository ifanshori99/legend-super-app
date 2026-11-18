// Staff table-session lifecycle (PRD v1.7 §3 F10 "Keamanan Sesi" and "Kontrol
// Open Bill"; contracts confirmOpenBillSession and closeTableSession).
//
// Guests never reach these routes: they arrive with a staff session and need
// floor.table.operate on the table's outlet. The guest side of
// `/api/table-sessions/...` (cart, quote, bill) authenticates with the opaque
// session credential in a later WS-03 bead, so staff middleware is attached to
// each staff route instead of the router (a router-wide guard would reject
// guests before their routes ever matched).

import { Router } from "express";
import {
  closeTableSessionInputSchema,
  mergeTableSessionsInputSchema,
  moveSessionItemsInputSchema,
  moveTableSessionInputSchema,
  tableSessionIdSchema,
} from "@starter/shared/qr-order";
import { z } from "@starter/shared/core";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { requireTenantContext } from "../middleware/tenant";
import {
  closeTableSession,
  confirmOpenBillSession,
} from "../services/table-session.service";
import {
  mergeTableSessionsOperation,
  moveSessionItemsOperation,
  moveTableSessionOperation,
} from "../services/table-session-operations.service";
import { resolveFloorContext } from "./floor-access";

const sessionParams = z.strictObject({ sessionId: tableSessionIdSchema });

export const tableSessionsRouter = Router();

/** Staff session + trusted origin + resolved tenant, per staff route. */
const staffGuard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

tableSessionsRouter.post(
  "/:sessionId/confirm",
  ...staffGuard,
  async (req, res) => {
    const { sessionId } = sessionParams.parse(req.params);
    const { context } = await resolveFloorContext(req, "floor.table.operate");
    res.json({
      data: await confirmOpenBillSession(context, sessionId, actorOf(req)),
    });
  },
);

tableSessionsRouter.post(
  "/:sessionId/close",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { sessionId } = sessionParams.parse(req.params);
    const input = closeTableSessionInputSchema.parse(req.body);
    const { context } = await resolveFloorContext(req, "floor.table.operate");
    res.json({
      data: await closeTableSession(context, sessionId, input, actorOf(req)),
    });
  },
);

// Staff table operations (PRD "Operasi Meja", legend-685n): pindah meja, gabung
// meja, pindah item. Same guard and permission as confirm and close.
tableSessionsRouter.post(
  "/:sessionId/move",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { sessionId } = sessionParams.parse(req.params);
    const input = moveTableSessionInputSchema.parse(req.body);
    const { context } = await resolveFloorContext(req, "floor.table.operate");
    res.json({
      data: await moveTableSessionOperation(
        context,
        sessionId,
        input,
        actorOf(req),
      ),
    });
  },
);

tableSessionsRouter.post(
  "/:sessionId/merge",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { sessionId } = sessionParams.parse(req.params);
    const input = mergeTableSessionsInputSchema.parse(req.body);
    const { context } = await resolveFloorContext(req, "floor.table.operate");
    res.json({
      data: await mergeTableSessionsOperation(
        context,
        sessionId,
        input,
        actorOf(req),
      ),
    });
  },
);

tableSessionsRouter.post(
  "/:sessionId/move-items",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { sessionId } = sessionParams.parse(req.params);
    const input = moveSessionItemsInputSchema.parse(req.body);
    const { context } = await resolveFloorContext(req, "floor.table.operate");
    res.json({
      data: await moveSessionItemsOperation(
        context,
        sessionId,
        input,
        actorOf(req),
      ),
    });
  },
);
