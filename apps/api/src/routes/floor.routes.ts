// Floor editor + live table routes (PRD v1.7 §3 F9 "Denah & Meja", F10
// "Keamanan Sesi"/"Kontrol Open Bill"; contracts `@starter/shared/qr-order`
// endpoints getCurrentFloor, create/update/delete zone and table,
// saveFloorLayout, issueTableQr, rotateTableQr, updateTableStatus,
// getFloorBoard).
//
// Tenant comes from the domain/token (TEN-02), never from the body. The floor
// editor routes carry no outlet id: the caller's outlet is resolved from the
// stored role assignments (routes/floor-access.ts). Layout editing needs
// floor.table.manage; live table operations need floor.table.operate.

import { Router } from "express";
import type { Request } from "express";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import { requireAuthAllowSharedDevice } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { loadRequestAccess } from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createFloorZoneInputSchema,
  createTableInputSchema,
  floorZoneIdSchema,
  getFloorBoard as floorBoardEndpoint,
  saveFloorLayoutInputSchema,
  tableIdSchema,
  updateFloorZoneInputSchema,
  updateTableInputSchema,
  updateTableStatusInputSchema,
} from "@starter/shared/qr-order";
import { z } from "@starter/shared/core";
import {
  createFloorZone,
  createTable,
  deleteFloorZone,
  deleteTable,
  issueTableQr,
  listFloorBoard,
  rotateTableQr,
  saveFloorLayout,
  updateFloorZone,
  updateTable,
} from "../services/floor.service";
import { updateTableStatus } from "../services/table-session.service";
import { resolveFloorContext, resolveOutletContext } from "./floor-access";

const zoneParams = z.strictObject({ zoneId: floorZoneIdSchema });
const tableParams = z.strictObject({ tableId: tableIdSchema });

function actorUserId(req: Request): string {
  return actorOf(req);
}

/** Resolve visibility on the server for every route exposing the board. */
async function floorBoardFilters(
  req: Request,
  outletId: string,
  query: { zoneId?: string; assignedToMe?: boolean },
) {
  const snapshot = await loadRequestAccess(req);
  const managesFloor = snapshot.contextFor("floor.table.manage", {
    type: "outlet",
    id: outletId,
  });
  return {
    zoneId: query.zoneId,
    assignedWaiterId:
      query.assignedToMe || !managesFloor ? actorUserId(req) : undefined,
  };
}

export const floorRouter = Router();
floorRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

/** Zones, tables and live sessions of the caller's outlet (editor read model). */
floorRouter.get("/", async (req, res) => {
  const query = floorBoardEndpoint.query.parse(req.query);
  const { context, outletId } = await resolveFloorContext(
    req,
    "floor.table.view",
  );
  res.json({
    data: await listFloorBoard(
      context,
      outletId,
      await floorBoardFilters(req, outletId, query),
    ),
  });
});

floorRouter.post("/zones", jsonBody, async (req, res) => {
  const input = createFloorZoneInputSchema.parse(req.body);
  const { context, outletId } = await resolveFloorContext(
    req,
    "floor.table.manage",
  );
  const zone = await createFloorZone(
    context,
    outletId,
    input,
    actorUserId(req),
  );
  res.status(201).location(`/api/floor/zones/${zone.id}`).json({ data: zone });
});

floorRouter.patch("/zones/:zoneId", jsonBody, async (req, res) => {
  const { zoneId } = zoneParams.parse(req.params);
  const input = updateFloorZoneInputSchema.parse(req.body);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  res.json({
    data: await updateFloorZone(context, zoneId, input, actorUserId(req)),
  });
});

floorRouter.delete("/zones/:zoneId", async (req, res) => {
  const { zoneId } = zoneParams.parse(req.params);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  await deleteFloorZone(context, zoneId, actorUserId(req));
  res.status(204).end();
});

floorRouter.post("/tables", jsonBody, async (req, res) => {
  const input = createTableInputSchema.parse(req.body);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  const table = await createTable(context, input, actorUserId(req));
  res.status(201).location(`/api/floor/tables/${table.id}`).json({
    data: table,
  });
});

floorRouter.patch("/tables/:tableId", jsonBody, async (req, res) => {
  const { tableId } = tableParams.parse(req.params);
  const input = updateTableInputSchema.parse(req.body);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  res.json({
    data: await updateTable(context, tableId, input, actorUserId(req)),
  });
});

floorRouter.delete("/tables/:tableId", async (req, res) => {
  const { tableId } = tableParams.parse(req.params);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  await deleteTable(context, tableId, actorUserId(req));
  res.status(204).end();
});

/** One request saves every moved table, so a drag never persists half a plan. */
floorRouter.put("/layout", jsonBody, async (req, res) => {
  const input = saveFloorLayoutInputSchema.parse(req.body);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  res.json({ data: await saveFloorLayout(context, input, actorUserId(req)) });
});

// ---- Tables: signed QR and live status ------------------------------------

export const tablesRouter = Router();
tablesRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

/** The table's current signed QR; never rotates (contract issueTableQr). */
tablesRouter.post("/:tableId/qr", async (req, res) => {
  const { tableId } = tableParams.parse(req.params);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  res.json({ data: await issueTableQr(context, tableId, actorUserId(req)) });
});

/** "Ganti QR": the only rotation, audited; the old sticker stops working. */
tablesRouter.post("/:tableId/qr/rotate", async (req, res) => {
  const { tableId } = tableParams.parse(req.params);
  const { context } = await resolveFloorContext(req, "floor.table.manage");
  res.json({ data: await rotateTableQr(context, tableId, actorUserId(req)) });
});

/** PRD "Papan Status" transitions with the ORD-10 cannot-mark-empty guard. */
tablesRouter.post("/:tableId/status", jsonBody, async (req, res) => {
  const { tableId } = tableParams.parse(req.params);
  const input = updateTableStatusInputSchema.parse(req.body);
  const { context } = await resolveFloorContext(req, "floor.table.operate");
  res.json({
    data: await updateTableStatus(context, tableId, input, actorUserId(req)),
  });
});

// ---- Live floor board for one explicit outlet -----------------------------

export const outletFloorRouter = Router();
outletFloorRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
);

// legend-42gqp: same shared-device guard as floorRouter; without it an owner
// cookie (or a cashier token) on a shared device read another outlet's board.
// Mounted on the route, not with `.use`: this router shares the /outlets prefix
// with other routers, and a router-level guard would also run (with no
// :outletId to bind the cashier token to) for every request that falls through.
outletFloorRouter.get(
  "/:outletId/floor",
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  async (req, res) => {
    const { outletId } = floorBoardEndpoint.params.parse(req.params);
    const query = floorBoardEndpoint.query.parse(req.query);
    const context = await resolveOutletContext(
      req,
      "floor.table.view",
      outletId,
    );
    res.json({
      data: await listFloorBoard(
        context,
        outletId,
        await floorBoardFilters(req, outletId, query),
      ),
    });
  },
);
