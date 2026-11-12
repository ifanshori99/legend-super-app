// Equipment registry, maintenance schedules/tickets and shift-handover routes
// (PRD v1.7 §3 F41 "Peralatan & Perawatan", F45 "Operasional Harian"; bead
// legend-i57s, WS-14). Paths, params, bodies and queries come from the WS-14
// contract (`@starter/shared/operations` defineEndpoint objects), so the API,
// the web client and mock mode cannot drift. Mount at `/api/operations`.
//
// The tenant comes from the server-minted context, never the request (TEN-02).
// Equipment, schedules and tickets need `ops.equipment.maintain`; handovers
// need `ops.handover.record`. The middleware runs PER ROUTE, not on the
// router, because the checklist router shares this mount prefix; every service
// re-checks the permission on the concrete outlet inside the tenant
// transaction (TEN-03).
import { Router } from "express";
import {
  completeMaintenanceSchedule as completeMaintenanceScheduleEndpoint,
  createEquipment as createEquipmentEndpoint,
  createMaintenanceSchedule as createMaintenanceScheduleEndpoint,
  createMaintenanceTicket as createMaintenanceTicketEndpoint,
  createShiftHandover as createShiftHandoverEndpoint,
  getEquipment as getEquipmentEndpoint,
  getMaintenanceTicket as getMaintenanceTicketEndpoint,
  getShiftHandover as getShiftHandoverEndpoint,
  listEquipment as listEquipmentEndpoint,
  listMaintenanceSchedules as listMaintenanceSchedulesEndpoint,
  listMaintenanceTickets as listMaintenanceTicketsEndpoint,
  listShiftHandovers as listShiftHandoversEndpoint,
  postEquipmentTransition as postEquipmentTransitionEndpoint,
  postMaintenanceTicketTransition as postMaintenanceTicketTransitionEndpoint,
  postShiftHandoverAcknowledgement as postShiftHandoverAcknowledgementEndpoint,
  postShiftHandoverClose as postShiftHandoverCloseEndpoint,
  updateEquipment as updateEquipmentEndpoint,
} from "@starter/shared/operations";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as service from "../services/operations-equipment.service.ts";

export const operationsEquipmentRouter = Router();

const common = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
] as const;
const maintain = requireMenuPermission("ops.equipment.maintain");
const record = requireMenuPermission("ops.handover.record");

// -------------------------------------------------------------- equipment

operationsEquipmentRouter.get(
  "/equipment",
  ...common,
  maintain,
  async (req, res) => {
    const query = listEquipmentEndpoint.query.parse(req.query);
    res.json(
      await service.listEquipment(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

operationsEquipmentRouter.post(
  "/equipment",
  ...common,
  maintain,
  jsonBody,
  async (req, res) => {
    const input = createEquipmentEndpoint.body.parse(req.body);
    const created = await service.createEquipment(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/operations/equipment/${created.id}`)
      .json({ data: created });
  },
);

operationsEquipmentRouter.get(
  "/equipment/:equipmentId",
  ...common,
  maintain,
  async (req, res) => {
    const { equipmentId } = getEquipmentEndpoint.params.parse(req.params);
    res.json({
      data: await service.getEquipment(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        equipmentId,
      ),
    });
  },
);

operationsEquipmentRouter.patch(
  "/equipment/:equipmentId",
  ...common,
  maintain,
  jsonBody,
  async (req, res) => {
    const { equipmentId } = updateEquipmentEndpoint.params.parse(req.params);
    const input = updateEquipmentEndpoint.body.parse(req.body);
    res.json({
      data: await service.updateEquipment(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        equipmentId,
        input,
      ),
    });
  },
);

// OPS-04: report_breakdown disables the mapped menu items, complete_maintenance
// restores exactly the ones this equipment disabled.
operationsEquipmentRouter.post(
  "/equipment/:equipmentId/transition",
  ...common,
  maintain,
  jsonBody,
  async (req, res) => {
    const { equipmentId } = postEquipmentTransitionEndpoint.params.parse(
      req.params,
    );
    const input = postEquipmentTransitionEndpoint.body.parse(req.body);
    res.json({
      data: await service.postEquipmentTransition(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        equipmentId,
        input,
      ),
    });
  },
);

// --------------------------------------------------- maintenance schedules

operationsEquipmentRouter.get(
  "/maintenance-schedules",
  ...common,
  maintain,
  async (req, res) => {
    const query = listMaintenanceSchedulesEndpoint.query.parse(req.query);
    res.json(
      await service.listMaintenanceSchedules(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

operationsEquipmentRouter.post(
  "/maintenance-schedules",
  ...common,
  maintain,
  jsonBody,
  async (req, res) => {
    const input = createMaintenanceScheduleEndpoint.body.parse(req.body);
    const created = await service.createMaintenanceSchedule(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/operations/maintenance-schedules/${created.id}`)
      .json({ data: created });
  },
);

// WS-14: a finished service advances next_due_at by the interval.
operationsEquipmentRouter.post(
  "/maintenance-schedules/:scheduleId/complete",
  ...common,
  maintain,
  jsonBody,
  async (req, res) => {
    const { scheduleId } = completeMaintenanceScheduleEndpoint.params.parse(
      req.params,
    );
    const input = completeMaintenanceScheduleEndpoint.body.parse(req.body);
    res.json({
      data: await service.completeMaintenanceSchedule(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        scheduleId,
        input,
      ),
    });
  },
);

// ----------------------------------------------------- maintenance tickets

operationsEquipmentRouter.get(
  "/maintenance-tickets",
  ...common,
  maintain,
  async (req, res) => {
    const query = listMaintenanceTicketsEndpoint.query.parse(req.query);
    res.json(
      await service.listMaintenanceTickets(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

operationsEquipmentRouter.post(
  "/maintenance-tickets",
  ...common,
  maintain,
  jsonBody,
  async (req, res) => {
    const input = createMaintenanceTicketEndpoint.body.parse(req.body);
    const created = await service.createMaintenanceTicket(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/operations/maintenance-tickets/${created.id}`)
      .json({ data: created });
  },
);

operationsEquipmentRouter.get(
  "/maintenance-tickets/:ticketId",
  ...common,
  maintain,
  async (req, res) => {
    const { ticketId } = getMaintenanceTicketEndpoint.params.parse(req.params);
    res.json({
      data: await service.getMaintenanceTicket(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        ticketId,
      ),
    });
  },
);

operationsEquipmentRouter.post(
  "/maintenance-tickets/:ticketId/transition",
  ...common,
  maintain,
  jsonBody,
  async (req, res) => {
    const { ticketId } = postMaintenanceTicketTransitionEndpoint.params.parse(
      req.params,
    );
    const input = postMaintenanceTicketTransitionEndpoint.body.parse(req.body);
    res.json({
      data: await service.postMaintenanceTicketTransition(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        ticketId,
        input,
      ),
    });
  },
);

// --------------------------------------------------------- shift handovers

operationsEquipmentRouter.get(
  "/shift-handovers",
  ...common,
  record,
  async (req, res) => {
    const query = listShiftHandoversEndpoint.query.parse(req.query);
    res.json(
      await service.listShiftHandovers(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

operationsEquipmentRouter.post(
  "/shift-handovers",
  ...common,
  record,
  jsonBody,
  async (req, res) => {
    const input = createShiftHandoverEndpoint.body.parse(req.body);
    const created = await service.createShiftHandover(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/operations/shift-handovers/${created.id}`)
      .json({ data: created });
  },
);

operationsEquipmentRouter.get(
  "/shift-handovers/:handoverId",
  ...common,
  record,
  async (req, res) => {
    const { handoverId } = getShiftHandoverEndpoint.params.parse(req.params);
    res.json({
      data: await service.getShiftHandover(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        handoverId,
      ),
    });
  },
);

// OPS-05: the receiving shift confirms; the submitting shift cannot.
operationsEquipmentRouter.post(
  "/shift-handovers/:handoverId/acknowledge",
  ...common,
  record,
  jsonBody,
  async (req, res) => {
    const { handoverId } =
      postShiftHandoverAcknowledgementEndpoint.params.parse(req.params);
    const input = postShiftHandoverAcknowledgementEndpoint.body.parse(req.body);
    res.json({
      data: await service.postShiftHandoverAcknowledgement(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        handoverId,
        input,
      ),
    });
  },
);

operationsEquipmentRouter.post(
  "/shift-handovers/:handoverId/close",
  ...common,
  record,
  jsonBody,
  async (req, res) => {
    const { handoverId } = postShiftHandoverCloseEndpoint.params.parse(
      req.params,
    );
    const input = postShiftHandoverCloseEndpoint.body.parse(req.body);
    res.json({
      data: await service.postShiftHandoverClose(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        handoverId,
        input,
      ),
    });
  },
);
