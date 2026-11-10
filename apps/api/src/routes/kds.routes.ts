// KDS routes (bead legend-4d5; PRD v1.7 §3 F12; contract @starter/shared/kitchen
// endpoints.ts + realtime.ts): station snapshot and feed, ticket detail, ticket
// actions (start, bump, recall, void), priority and per item status. Board,
// pacing, all-day, expo and pickup belong to their own beads.
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId/kitchen",
// kdsRouter)`. The router merges params, so every contract path
// `/api/outlets/:outletId/kitchen/...` is served here.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext; the tenant
//   comes from the server-minted context (TEN-02), never the body.
// - Station-path routes mount requireStationPermission; ticket and item routes
//   learn the station from the row, so the service asserts it (legend-fsb7).
// - Bodies, params and queries are parsed with the strict contract schemas.
// - The device id stays null until WS-02 device registration (legend-165)
//   supplies a verified one: a client-claimed device is never trusted.

import { Router, type Request } from "express";
import { userIdSchema } from "@starter/shared/core";
import {
  bumpKitchenTicket,
  deleteMenuLoad,
  getKitchenStationFeed,
  getKitchenStationSummary,
  getKitchenTicket,
  getPacing,
  getStationCapacityRules,
  listCapacityRules,
  listChannelPauses,
  listMenuLoads,
  listKitchenStationLabels,
  listKitchenStationTickets,
  recallKitchenTicket,
  releaseManualChannelPause,
  setKitchenTicketPriority,
  setManualChannelPause,
  setMenuLoads,
  startKitchenTicket,
  updateCapacityRules,
  updateKitchenTicketItem,
  voidKitchenTicket,
} from "@starter/shared/kitchen";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  getStationScope,
  requireOutletPermission,
  requireStationScopePermission,
  requireStationPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as capacity from "../services/kds-capacity.service.ts";
import * as cookReads from "../services/kds-cook-reads.service.ts";
import * as pacing from "../services/kds-pacing.service.ts";
import * as kds from "../services/kds.service.ts";
import type { KdsActor } from "../services/kds.service.ts";

export const kdsRouter = Router({ mergeParams: true });

kdsRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

const stationOf = (req: Request) => {
  const id = req.params.stationId;
  return typeof id === "string" ? id : undefined;
};

// Station routes authorize the station itself, so a station-scoped cook
// reaches only their own station; an unknown station fails closed
// (legend-fsb7, TEN-03). The service re-asserts the station and the path
// outlet on every query.
const processStation = [
  requireStationPermission("kds.ticket.process", stationOf),
];
// Ticket and item routes cannot name the station before the row is read: the
// guard admits outlet- and station-scoped grants, and the service asserts
// `kds.ticket.process` on the ticket's own station (assertStationPermission).
const processTicket = requireStationScopePermission("kds.ticket.process");
const ticketContext = (req: Request) => getStationScope(req).context;

function actor(req: Request): KdsActor {
  return { userId: userIdSchema.parse(getAuth(req).user.id), deviceId: null };
}

// ---- Station reads ---------------------------------------------------------

kdsRouter.get(
  "/stations/:stationId/tickets",
  ...processStation,
  async (req, res) => {
    const { outletId, stationId } = listKitchenStationTickets.params.parse(
      req.params,
    );
    res.json({
      data: await kds.listStationTickets(
        getScopedTenantContext(req),
        actor(req),
        outletId,
        stationId,
        new Date(),
      ),
    });
  },
);

kdsRouter.get(
  "/stations/:stationId/feed",
  ...processStation,
  async (req, res) => {
    const { outletId, stationId } = getKitchenStationFeed.params.parse(
      req.params,
    );
    const { after } = getKitchenStationFeed.query.parse(req.query);
    res.json({
      data: await kds.readStationFeed(
        getScopedTenantContext(req),
        actor(req),
        outletId,
        stationId,
        after,
        new Date(),
      ),
    });
  },
);

// One light read for the station switch: open-ticket count per station. The
// caller may hold the permission on an outlet or on stations only, so the
// service narrows to `permittedStationIds`.
kdsRouter.get("/station-summary", processTicket, async (req, res) => {
  const { outletId } = getKitchenStationSummary.params.parse(req.params);
  res.json({
    data: await kds.getStationSummary(
      ticketContext(req),
      actor(req),
      outletId,
      new Date(),
    ),
  });
});

// Cook reads (legend-gt7f): the label and the capacity rules a station-scoped
// cook needs, under `kds.ticket.process` only. Slim views; the capacity config
// read (`/capacity-rules`, kds.station.manage) and PUT keep their guard.
kdsRouter.get("/station-labels", processTicket, async (req, res) => {
  const { outletId } = listKitchenStationLabels.params.parse(req.params);
  res.json({
    data: await cookReads.listStationLabels(
      ticketContext(req),
      actor(req),
      outletId,
      new Date(),
    ),
  });
});

kdsRouter.get(
  "/stations/:stationId/capacity-rules",
  ...processStation,
  async (req, res) => {
    const { outletId, stationId } = getStationCapacityRules.params.parse(
      req.params,
    );
    res.json({
      data: await cookReads.listStationCapacityRules(
        getScopedTenantContext(req),
        actor(req),
        outletId,
        stationId,
        new Date(),
      ),
    });
  },
);

// KDS-05: capacity per station for the current window. Evaluating on read
// keeps the level (and the auto-pause behind it) fresh without a scheduler.
// A station-scoped cook reads it too; the service keeps only the stations the
// caller may process.
kdsRouter.get("/pacing", processTicket, async (req, res) => {
  const { outletId } = getPacing.params.parse(req.params);
  res.json({
    data: await pacing.getPacingSnapshot(
      ticketContext(req),
      outletId,
      new Date(),
      actor(req),
    ),
  });
});

// ---- Tickets ---------------------------------------------------------------

kdsRouter.get("/tickets/:ticketId", processTicket, async (req, res) => {
  const { outletId, ticketId } = getKitchenTicket.params.parse(req.params);
  res.json({
    data: await kds.getKitchenTicketDetail(
      ticketContext(req),
      actor(req),
      outletId,
      ticketId,
      new Date(),
    ),
  });
});

kdsRouter.post("/tickets/:ticketId/start", processTicket, async (req, res) => {
  const { outletId, ticketId } = startKitchenTicket.params.parse(req.params);
  res.json({
    data: await kds.applyKitchenTicketAction(
      ticketContext(req),
      actor(req),
      outletId,
      ticketId,
      "start",
      {},
      new Date(),
    ),
  });
});

kdsRouter.post("/tickets/:ticketId/bump", processTicket, async (req, res) => {
  const { outletId, ticketId } = bumpKitchenTicket.params.parse(req.params);
  res.json({
    data: await kds.applyKitchenTicketAction(
      ticketContext(req),
      actor(req),
      outletId,
      ticketId,
      "bump",
      {},
      new Date(),
    ),
  });
});

kdsRouter.post(
  "/tickets/:ticketId/recall",
  processTicket,
  jsonBody,
  async (req, res) => {
    const { outletId, ticketId } = recallKitchenTicket.params.parse(req.params);
    const body = recallKitchenTicket.body.parse(req.body);
    res.json({
      data: await kds.applyKitchenTicketAction(
        ticketContext(req),
        actor(req),
        outletId,
        ticketId,
        "recall",
        { reason: body.reason },
        new Date(),
      ),
    });
  },
);

kdsRouter.post(
  "/tickets/:ticketId/void",
  processTicket,
  jsonBody,
  async (req, res) => {
    const { outletId, ticketId } = voidKitchenTicket.params.parse(req.params);
    const body = voidKitchenTicket.body.parse(req.body);
    res.json({
      data: await kds.applyKitchenTicketAction(
        ticketContext(req),
        actor(req),
        outletId,
        ticketId,
        "void",
        { reason: body.reason },
        new Date(),
      ),
    });
  },
);

kdsRouter.patch(
  "/tickets/:ticketId/priority",
  processTicket,
  jsonBody,
  async (req, res) => {
    const { outletId, ticketId } = setKitchenTicketPriority.params.parse(
      req.params,
    );
    const body = setKitchenTicketPriority.body.parse(req.body);
    res.json({
      data: await kds.setKitchenTicketPriority(
        ticketContext(req),
        actor(req),
        outletId,
        ticketId,
        body.priority,
        new Date(),
      ),
    });
  },
);

// ---- Items -----------------------------------------------------------------

kdsRouter.post(
  "/ticket-items/:itemId/status",
  processTicket,
  jsonBody,
  async (req, res) => {
    const { outletId, itemId } = updateKitchenTicketItem.params.parse(
      req.params,
    );
    const body = updateKitchenTicketItem.body.parse(req.body);
    res.json({
      data: await kds.applyKitchenItemAction(
        ticketContext(req),
        actor(req),
        outletId,
        itemId,
        body.action,
        new Date(),
      ),
    });
  },
);

// ---- Capacity rules (legend-w4nq4, legend-44jm) ----------------------------
// The kitchen config screen reads and replaces a station's capacity windows.
// `kds.station.manage` on the outlet (tenant or outlet scope) is the guard:
// the same permission that owns station configuration; a station-only or
// `kds.ticket.process` grant is refused. The service re-asserts that the
// station belongs to the path outlet (TEN-03).

const manageStations = requireOutletPermission("kds.station.manage", (req) =>
  String(req.params.outletId),
);

// legend-44jm: GET answers `listCapacityRules` (contract rows), ordered by
// station, then window_minutes, then id, so two reads of an unchanged config
// are identical. Only this tenant's and this path outlet's stations appear.
kdsRouter.get("/capacity-rules", manageStations, async (req, res) => {
  const { outletId } = listCapacityRules.params.parse(req.params);
  res.json({
    data: await capacity.listCapacityRules(
      getScopedTenantContext(req),
      outletId,
    ),
  });
});

kdsRouter.put(
  "/stations/:stationId/capacity-rules",
  manageStations,
  jsonBody,
  async (req, res) => {
    const { outletId, stationId } = updateCapacityRules.params.parse(
      req.params,
    );
    const body = updateCapacityRules.body.parse(req.body);
    res.json({
      data: await capacity.replaceCapacityRules(
        getScopedTenantContext(req),
        outletId,
        stationId,
        body.rules,
        new Date(),
      ),
    });
  },
);

// legend-7svpq: menu load admin and manual channel pauses, same guard.
kdsRouter.get("/menu-loads", manageStations, async (req, res) => {
  const { outletId } = listMenuLoads.params.parse(req.params);
  res.json({
    data: await pacing.listMenuLoads(getScopedTenantContext(req), outletId),
  });
});

kdsRouter.put("/menu-loads", manageStations, jsonBody, async (req, res) => {
  const { outletId } = setMenuLoads.params.parse(req.params);
  const body = setMenuLoads.body.parse(req.body);
  res.json({
    data: await pacing.setMenuLoads(
      getScopedTenantContext(req),
      outletId,
      body.loads,
      new Date(),
      actor(req),
    ),
  });
});

kdsRouter.delete("/menu-loads/:loadId", manageStations, async (req, res) => {
  const { outletId, loadId } = deleteMenuLoad.params.parse(req.params);
  res.json({
    data: await pacing.deleteMenuLoad(
      getScopedTenantContext(req),
      actor(req),
      outletId,
      loadId,
      new Date(),
    ),
  });
});

kdsRouter.get("/channel-pauses", manageStations, async (req, res) => {
  const { outletId } = listChannelPauses.params.parse(req.params);
  res.json({
    data: await pacing.listChannelPauses(
      getScopedTenantContext(req),
      outletId,
      new Date(),
    ),
  });
});

kdsRouter.put("/channel-pauses", manageStations, jsonBody, async (req, res) => {
  const { outletId } = setManualChannelPause.params.parse(req.params);
  const body = setManualChannelPause.body.parse(req.body);
  res.json({
    data: await pacing.setManualChannelPause(
      getScopedTenantContext(req),
      actor(req),
      outletId,
      body,
      new Date(),
    ),
  });
});

kdsRouter.delete(
  "/channel-pauses/:pauseId",
  manageStations,
  async (req, res) => {
    const { outletId, pauseId } = releaseManualChannelPause.params.parse(
      req.params,
    );
    res.json({
      data: await pacing.releaseManualChannelPause(
        getScopedTenantContext(req),
        actor(req),
        outletId,
        pauseId,
        new Date(),
      ),
    });
  },
);
