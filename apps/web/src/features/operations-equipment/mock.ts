// Mock mode for the equipment registry, service schedules, breakdown tickets
// and shift handover (bead legend-cz9g). Handlers behave like the API will:
// the runtime validates input/output against the contract, transitions run
// through the same `machines.ts` state machines (OPS-04/OPS-05), and refusals
// use the contract error codes.
//
// Demo data comes from `cafeLegendOperationsFixtures`; mutations live in one
// store so both screens (and a cookie reload) see the same state. A real API
// replaces this file; the screens do not change.
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  acknowledgeShiftHandover as acknowledgeHandoverMachine,
  assertMaintenanceTicketHasPhoto,
  cafeLegendOperationsFixtures,
  createEquipment,
  createMaintenanceSchedule,
  createMaintenanceTicket,
  createShiftHandover,
  getEquipment,
  getMaintenanceTicket,
  getShiftHandover,
  listEquipment,
  listMaintenanceSchedules,
  listMaintenanceTickets,
  listShiftHandovers,
  postEquipmentTransition,
  postMaintenanceTicketTransition,
  postShiftHandoverAcknowledgement,
  OperationsError,
  transitionEquipment,
  transitionMaintenanceTicket,
  updateEquipment,
  type Equipment,
  type MaintenanceSchedule,
  type MaintenanceTicket,
  type ShiftHandover,
} from "@starter/shared/operations";

const tenantId = cafeLegendOperationsFixtures.equipment[0].tenantId;
const outletId = cafeLegendOperationsFixtures.equipment[0].outletId;
const supervisorId = cafeLegendAccessFixtures.users.supervisor.id;
// The receiving shift in the demo. A handover submitted by this same user is
// refused by the contract machine (OPS-05: the receiving shift confirms).
const receiverId = cafeLegendAccessFixtures.users.supervisor2.id;

type OpsState = {
  equipment: Equipment[];
  schedules: MaintenanceSchedule[];
  tickets: MaintenanceTicket[];
  handovers: ShiftHandover[];
};

const seed = (): OpsState => ({
  equipment: structuredClone(cafeLegendOperationsFixtures.equipment),
  schedules: structuredClone(cafeLegendOperationsFixtures.maintenanceSchedules),
  tickets: structuredClone(cafeLegendOperationsFixtures.maintenanceTickets),
  handovers: structuredClone(cafeLegendOperationsFixtures.shiftHandovers),
});

const store = createMockStore<OpsState>(seed);
/** Created document per `scope:idempotencyKey`, so a retried write replays. */
const idempotency = createMockStore(() => new Map<string, string>());

const nowIso = () => new Date().toISOString();

/** Maps the operations machine errors onto the API envelope of the mock. */
function contractError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof OperationsError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

function assertOutlet(candidate: string): void {
  if (candidate !== outletId)
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
}

function equipmentById(id: string): Equipment {
  const row = store.get().equipment.find((item) => item.id === id);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Peralatan tidak ditemukan.");
  return row;
}

function ticketById(id: string): MaintenanceTicket {
  const row = store.get().tickets.find((item) => item.id === id);
  if (!row)
    throw new ApiError(404, "NOT_FOUND", "Tiket perawatan tidak ditemukan.");
  return row;
}

function handoverById(id: string): ShiftHandover {
  const row = store.get().handovers.find((item) => item.id === id);
  if (!row)
    throw new ApiError(404, "NOT_FOUND", "Serah terima tidak ditemukan.");
  return row;
}

function idempotent<T extends { id: string }>(
  scope: string,
  key: string,
  find: (id: string) => T | undefined,
  create: () => T,
): T {
  const seen = idempotency.get().get(`${scope}:${key}`);
  if (seen) {
    const existing = find(seen);
    if (existing) return existing;
  }
  const row = create();
  idempotency.get().set(`${scope}:${key}`, row.id);
  return row;
}

// ---- Equipment ------------------------------------------------------------

registerMock(listEquipment, ({ query, scenario }) => {
  const rows = store
    .get()
    .equipment.filter(
      (row) =>
        row.outletId === query.outletId &&
        (!query.category || row.category === query.category) &&
        (!query.status || row.status === query.status),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getEquipment, ({ params, scenario }) => {
  if (scenario === "empty")
    throw new ApiError(404, "NOT_FOUND", "Peralatan tidak ditemukan.");
  return { data: equipmentById(params.equipmentId) };
});

registerMock(createEquipment, ({ body }) => {
  assertOutlet(body.outletId);
  const row = idempotent(
    "equipment",
    body.idempotencyKey,
    (id) => store.get().equipment.find((item) => item.id === id),
    (): Equipment => ({
      id: crypto.randomUUID() as Equipment["id"],
      tenantId,
      outletId: body.outletId,
      name: body.name,
      category: body.category,
      assetId: body.assetId ?? null,
      linkedMenuItemIds: body.linkedMenuItemIds ?? [],
      status: "operational",
      temperatureThreshold: body.temperatureThreshold ?? null,
      updatedAt: nowIso(),
    }),
  );
  if (!store.get().equipment.some((item) => item.id === row.id))
    store.set({ ...store.get(), equipment: [...store.get().equipment, row] });
  return { data: row };
});

registerMock(updateEquipment, ({ params, body }) => {
  const current = equipmentById(params.equipmentId);
  // The contract's optimistic concurrency: a stale `expectedUpdatedAt` means
  // another supervisor changed the row first.
  if (current.updatedAt !== body.expectedUpdatedAt)
    throw new ApiError(
      409,
      "PRECONDITION_FAILED",
      "Peralatan sudah diubah pengguna lain. Muat ulang lalu coba lagi.",
    );
  const next: Equipment = {
    ...current,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.assetId !== undefined ? { assetId: body.assetId } : {}),
    ...(body.linkedMenuItemIds !== undefined
      ? { linkedMenuItemIds: body.linkedMenuItemIds }
      : {}),
    ...(body.temperatureThreshold !== undefined
      ? { temperatureThreshold: body.temperatureThreshold }
      : {}),
    updatedAt: nowIso(),
  };
  store.set({
    ...store.get(),
    equipment: store
      .get()
      .equipment.map((item) => (item.id === next.id ? next : item)),
  });
  return { data: next };
});

registerMock(postEquipmentTransition, ({ params, body }) => {
  const current = equipmentById(params.equipmentId);
  // Throws EQUIPMENT_TRANSITION_INVALID (409) for an action the status forbids.
  const status = contractError(() =>
    transitionEquipment(current.status, body.action),
  );
  const next: Equipment = { ...current, status, updatedAt: nowIso() };
  store.set({
    ...store.get(),
    equipment: store
      .get()
      .equipment.map((item) => (item.id === next.id ? next : item)),
  });
  return { data: next };
});

// ---- Maintenance schedules ------------------------------------------------

registerMock(listMaintenanceSchedules, ({ query, scenario }) => {
  const rows = store
    .get()
    .schedules.filter(
      (row) =>
        row.outletId === query.outletId &&
        (!query.equipmentId || row.equipmentId === query.equipmentId) &&
        (!query.dueBefore || row.nextDueAt <= query.dueBefore),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(createMaintenanceSchedule, ({ body }) => {
  assertOutlet(body.outletId);
  equipmentById(body.equipmentId);
  const row = idempotent(
    "schedule",
    body.idempotencyKey,
    (id) => store.get().schedules.find((item) => item.id === id),
    (): MaintenanceSchedule => ({
      id: crypto.randomUUID() as MaintenanceSchedule["id"],
      tenantId,
      outletId: body.outletId,
      equipmentId: body.equipmentId,
      intervalDays: body.intervalDays,
      nextDueAt: body.nextDueAt,
      vendorId: body.vendorId ?? null,
      updatedAt: nowIso(),
    }),
  );
  if (!store.get().schedules.some((item) => item.id === row.id))
    store.set({ ...store.get(), schedules: [...store.get().schedules, row] });
  return { data: row };
});

// ---- Maintenance tickets --------------------------------------------------

registerMock(listMaintenanceTickets, ({ query, scenario }) => {
  const rows = store
    .get()
    .tickets.filter(
      (row) =>
        row.outletId === query.outletId &&
        (!query.equipmentId || row.equipmentId === query.equipmentId) &&
        (!query.status || row.status === query.status) &&
        (!query.urgency || row.urgency === query.urgency),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getMaintenanceTicket, ({ params, scenario }) => {
  if (scenario === "empty")
    throw new ApiError(404, "NOT_FOUND", "Tiket perawatan tidak ditemukan.");
  return { data: ticketById(params.ticketId) };
});

registerMock(createMaintenanceTicket, ({ body }) => {
  assertOutlet(body.outletId);
  const equipment = equipmentById(body.equipmentId);
  // PRD §3 F45: a breakdown ticket carries at least one photo.
  contractError(() => assertMaintenanceTicketHasPhoto(body.mediaIds));
  const row = idempotent(
    "ticket",
    body.idempotencyKey,
    (id) => store.get().tickets.find((item) => item.id === id),
    (): MaintenanceTicket => ({
      id: crypto.randomUUID() as MaintenanceTicket["id"],
      tenantId,
      outletId: body.outletId,
      equipmentId: body.equipmentId,
      reportedBy: supervisorId as MaintenanceTicket["reportedBy"],
      urgency: body.urgency,
      description: body.description,
      mediaIds: body.mediaIds,
      vendorId: body.vendorId ?? null,
      costIdr: body.costIdr ?? null,
      status: "reported",
      marksEquipmentBroken: body.marksEquipmentBroken ?? false,
      reportedAt: nowIso(),
      resolvedAt: null,
    }),
  );
  const state = store.get();
  if (!state.tickets.some((item) => item.id === row.id))
    store.set({ ...state, tickets: [...state.tickets, row] });

  // OPS-04: marking the equipment broken disables its mapped menu items.
  // `report_breakdown` is only legal from `operational`; an equipment already
  // under maintenance (or retired) keeps its state, and the ticket still
  // records the flag. See the report: the contract has no transition from
  // under_maintenance back to broken.
  if (row.marksEquipmentBroken && equipment.status === "operational") {
    const status = contractError(() =>
      transitionEquipment(equipment.status, "report_breakdown"),
    );
    const next: Equipment = { ...equipment, status, updatedAt: nowIso() };
    store.set({
      ...store.get(),
      equipment: store
        .get()
        .equipment.map((item) => (item.id === next.id ? next : item)),
    });
  }
  return { data: row };
});

registerMock(postMaintenanceTicketTransition, ({ params, body }) => {
  const current = ticketById(params.ticketId);
  // Throws MAINTENANCE_TRANSITION_INVALID (409) for a forbidden action.
  const status = contractError(() =>
    transitionMaintenanceTicket(current.status, body.action),
  );
  const next: MaintenanceTicket = {
    ...current,
    status,
    resolvedAt: status === "resolved" ? nowIso() : current.resolvedAt,
    ...(body.vendorId !== undefined ? { vendorId: body.vendorId } : {}),
    ...(body.costIdr !== undefined ? { costIdr: body.costIdr } : {}),
  };
  store.set({
    ...store.get(),
    tickets: store
      .get()
      .tickets.map((item) => (item.id === next.id ? next : item)),
  });
  return { data: next };
});

// ---- Shift handovers ------------------------------------------------------

registerMock(listShiftHandovers, ({ query, scenario }) => {
  const rows = store
    .get()
    .handovers.filter(
      (row) =>
        row.outletId === query.outletId &&
        (!query.status || row.status === query.status),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getShiftHandover, ({ params, scenario }) => {
  if (scenario === "empty")
    throw new ApiError(404, "NOT_FOUND", "Serah terima tidak ditemukan.");
  return { data: handoverById(params.handoverId) };
});

registerMock(createShiftHandover, ({ body }) => {
  assertOutlet(body.outletId);
  const row = idempotent(
    "handover",
    body.idempotencyKey,
    (id) => store.get().handovers.find((item) => item.id === id),
    (): ShiftHandover => ({
      id: crypto.randomUUID() as ShiftHandover["id"],
      tenantId,
      outletId: body.outletId,
      fromShiftTemplateId: body.fromShiftTemplateId,
      toShiftTemplateId: body.toShiftTemplateId,
      notes: body.notes,
      submittedBy: supervisorId as ShiftHandover["submittedBy"],
      submittedAt: nowIso(),
      acknowledgedBy: null,
      acknowledgedAt: null,
      status: "submitted",
    }),
  );
  if (!store.get().handovers.some((item) => item.id === row.id))
    store.set({ ...store.get(), handovers: [...store.get().handovers, row] });
  return { data: row };
});

registerMock(postShiftHandoverAcknowledgement, ({ params }) => {
  const current = handoverById(params.handoverId);
  // OPS-05: the receiving shift confirms; the machine rejects a self
  // acknowledgement (403) and a second acknowledgement (409).
  const next = contractError(() =>
    acknowledgeHandoverMachine(current, {
      acknowledgedBy: receiverId as NonNullable<
        ShiftHandover["acknowledgedBy"]
      >,
      acknowledgedAt: nowIso(),
    }),
  );
  store.set({
    ...store.get(),
    handovers: store
      .get()
      .handovers.map((item) => (item.id === next.id ? next : item)),
  });
  return { data: next };
});
