// Mock handlers for the staff facility endpoints (VITE_API_MOCK=true). They
// serve @starter/shared/facility fixtures and run the contract's own state
// machines — the unit machine (FAC-06 bookable rule), the cleaning cycle and the
// incident response (FAC-08) — instead of inventing transitions, so the screens
// behave like they will against the real API (docs/frontend.md, "Typed
// endpoints and mock mode").
//
// Clock: the demo lives in the facility's morning. `staffAnchor` is opening time
// + 30 minutes of the outlet's current business date (Asia/Jakarta, no DST),
// fixed per calendar day so the SSR render and the browser hydration show the
// same session times, ages and elapsed seconds.
import {
  CLEANING_CHECKLIST_KEYS,
  FacilityError,
  cafeLegendFacilityFixtures as fx,
  cleaningTaskSchema,
  completeCleaningCycle,
  completeCleaningTask,
  createCleaningTask,
  facilityIncidentSchema,
  facilityUnitBoardRowSchema,
  facilityUnitSchema,
  getFacilityUnitBoard,
  listFacilityIncidents,
  raiseFacilityIncident,
  respondFacilityIncident,
  respondToFacilityIncident,
  startCleaningCycle,
  startCleaningTask,
  transitionUnit,
  updateFacilityUnit,
  type CleaningTask,
  type FacilityIncident,
  type FacilityUnit,
} from "@starter/shared/facility";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { businessDateInOutletZone } from "../facility/flow.ts";
import {
  closeMockOpenAlert,
  listMockOpenAlerts,
  readPanicMockScenario,
} from "./panic-mock-socket.ts";
// The facility feature owns GET /api/facility/config for every screen; import
// its registration instead of registering the same endpoint twice.
import "../facility/mock.ts";
// The facility-admin feature owns GET /api/facility/facilities (its config
// index lists them); importing it registers that one handler for the staff
// screens too.
import "../facility-admin/mock.ts";

const MINUTE = 60_000;
const SHOWER_FACILITY_ID = fx.ids.showerFacilityId;
const STAFF_ID = fx.ids.staffUserId;

/** Opening 06:00 + 30 minutes, in the outlet's fixed +07:00 offset. */
function staffAnchor(): string {
  const date = businessDateInOutletZone(new Date());
  return `${date}T06:30:00+07:00`;
}

function emptyChecklist() {
  return CLEANING_CHECKLIST_KEYS.map((key) => ({
    key,
    done: false,
    note: null,
  }));
}

/** Seed one world; every store reseeds on resetMocks(). */
function seedWorld() {
  const anchorMs = Date.parse(staffAnchor());
  const at = (offsetSeconds: number) =>
    new Date(anchorMs + offsetSeconds * 1_000).toISOString();

  // PRD §3 F22 + the booth fixtures: P1 available, P2 in use, W1 needs
  // cleaning, W2 under maintenance; the WFC units are seeded too so the screens
  // stay honest when a tenant opens another facility.
  const units: FacilityUnit[] = fx.units.map((unit) =>
    facilityUnitSchema.parse(unit),
  );

  const cleaningTemplate = fx.cleaningTasks[0];
  const tasks: CleaningTask[] = [
    cleaningTaskSchema.parse({
      ...cleaningTemplate,
      // The checklist starts empty: the screen shows all four keys and the
      // staff marks each one done (PRD §3 F22 Siklus Kebersihan).
      checklist: emptyChecklist(),
      mediaIds: [],
      assignedTo: null,
      startedAt: null,
      completedAt: null,
      createdAt: at(-10 * 60),
    }),
  ];

  const [panicTemplate, damageTemplate] = fx.incidents;
  const incidents: FacilityIncident[] = [
    facilityIncidentSchema.parse({
      ...panicTemplate,
      triggeredAt: at(-120),
      // Four seconds: inside the FAC-08 five-second target.
      respondedAt: at(-116),
      offline: false,
      respondedBy: STAFF_ID,
      resolution: "Tamu dibantu dari luar, kondisi aman.",
    }),
    facilityIncidentSchema.parse({
      ...damageTemplate,
      triggeredAt: at(-30),
      respondedBy: null,
      respondedAt: null,
      resolution: null,
      offline: true,
    }),
  ];

  return { units, tasks, incidents };
}

const world = createMockStore(seedWorld);

function wrapped<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    // The mock runtime maps ApiError and CoreError to the error envelope; the
    // facility contract's errors are mapped the way the API maps them.
    if (error instanceof FacilityError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

function unitById(unitId: string): FacilityUnit {
  const unit = world.get().units.find((item) => item.id === unitId);
  if (!unit) throw new ApiError(404, "NOT_FOUND", "Bilik tidak ditemukan.");
  return unit;
}

function taskById(taskId: string): CleaningTask {
  const task = world.get().tasks.find((item) => item.id === taskId);
  if (!task)
    throw new ApiError(404, "NOT_FOUND", "Tugas kebersihan tidak ditemukan.");
  return task;
}

function incidentById(incidentId: string): FacilityIncident {
  const incident = world.get().incidents.find((item) => item.id === incidentId);
  if (!incident)
    throw new ApiError(404, "NOT_FOUND", "Insiden tidak ditemukan.");
  return incident;
}

function replaceUnit(unit: FacilityUnit) {
  const state = world.get();
  world.set({
    ...state,
    units: state.units.map((item) => (item.id === unit.id ? unit : item)),
  });
}

function replaceTask(task: CleaningTask) {
  const state = world.get();
  world.set({
    ...state,
    tasks: state.tasks.map((item) => (item.id === task.id ? task : item)),
  });
}

function replaceIncident(incident: FacilityIncident) {
  const state = world.get();
  world.set({
    ...state,
    incidents: state.incidents.map((item) =>
      item.id === incident.id ? incident : item,
    ),
  });
}

// ---- Board ------------------------------------------------------------------

/** The current session of an in-use unit; only P2 runs one in the demo. */
function currentSession(unitId: string) {
  if (unitId !== fx.ids.unitP2) return null;
  const anchorMs = Date.parse(staffAnchor());
  return {
    ticketId: fx.ids.ticketB,
    startedAt: new Date(anchorMs - 4 * MINUTE).toISOString(),
    scheduledEndsAt: new Date(anchorMs + 16 * MINUTE).toISOString(),
  };
}

registerMock(getFacilityUnitBoard, ({ query, scenario }) => {
  const serverTime = staffAnchor();
  if (scenario === "empty") return { data: { rows: [], serverTime } };
  const state = world.get();
  const rows = state.units
    .filter((unit) => unit.facilityId === query.facilityId)
    .filter((unit) => !query.status || unit.status === query.status)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((unit) =>
      facilityUnitBoardRowSchema.parse({
        unit,
        currentTicket: currentSession(unit.id),
        cleaningTask:
          state.tasks.find(
            (task) => task.unitId === unit.id && task.completedAt === null,
          ) ?? null,
      }),
    );
  return { data: { rows, serverTime } };
});

// ---- Cleaning ---------------------------------------------------------------

registerMock(createCleaningTask, ({ body }) => {
  const unit = unitById(body.unitId);
  const state = world.get();
  const open = state.tasks.find(
    (task) => task.unitId === unit.id && task.completedAt === null,
  );
  if (open)
    throw new ApiError(
      409,
      "CONFLICT",
      "Bilik ini sudah punya tugas kebersihan aktif.",
    );
  // A guest is still inside: cleaning waits for the session to end.
  if (unit.status === "in_use")
    throw new ApiError(
      409,
      "CONFLICT",
      "Selesaikan sesi tamu sebelum membersihkan bilik.",
    );
  if (unit.status === "maintenance")
    throw new ApiError(
      409,
      "UNIT_NOT_BOOKABLE",
      "Bilik sedang dalam perawatan.",
    );
  const task = cleaningTaskSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fx.tenant.id,
    outletId: fx.outlet.id,
    facilityId: unit.facilityId,
    unitId: unit.id,
    accessTicketId: body.accessTicketId ?? null,
    checklist: emptyChecklist(),
    mediaIds: [],
    assignedTo: null,
    startedAt: null,
    completedAt: null,
    createdAt: staffAnchor(),
  });
  world.set({
    ...state,
    tasks: [...state.tasks, task],
    units: state.units.map((item) =>
      item.id === unit.id
        ? facilityUnitSchema.parse({ ...item, status: "needs_cleaning" })
        : item,
    ),
  });
  return { data: task };
});

registerMock(startCleaningTask, ({ params, body }) => {
  const task = taskById(params.taskId);
  const unit = unitById(task.unitId);
  // The contract's unit machine owns the transition; a maintenance unit throws
  // UNIT_NOT_BOOKABLE here instead of inventing a shortcut.
  const nextStatus = wrapped(() =>
    transitionUnit(unit.status, "start_cleaning"),
  );
  const started = wrapped(() =>
    startCleaningCycle(task, staffAnchor(), body.assignedTo ?? null),
  );
  replaceTask(started);
  replaceUnit(facilityUnitSchema.parse({ ...unit, status: nextStatus }));
  return { data: started };
});

registerMock(completeCleaningTask, ({ params, body }) => {
  const task = taskById(params.taskId);
  const unit = unitById(task.unitId);
  // FAC-06: the unit returns to available only through the cleaning cycle, and
  // only after every checklist item is done (PRD §3 F22 Siklus Kebersihan).
  const completed = wrapped(() =>
    completeCleaningCycle(task, staffAnchor(), {
      checklist: body.checklist,
      mediaIds: body.mediaIds,
    }),
  );
  const nextStatus = wrapped(() =>
    transitionUnit(unit.status, "complete_cleaning"),
  );
  const updatedUnit = facilityUnitSchema.parse({
    ...unit,
    status: nextStatus,
  });
  replaceTask(completed);
  replaceUnit(updatedUnit);
  return { data: { task: completed, unit: updatedUnit } };
});

registerMock(updateFacilityUnit, ({ params, body }) => {
  const unit = unitById(params.unitId);
  // FAC-06: release_maintenance lands on needs_cleaning, never straight back to
  // available — the unit must be cleaned before it can be booked again.
  const nextStatus = wrapped(() => transitionUnit(unit.status, body.action));
  const updated = facilityUnitSchema.parse({ ...unit, status: nextStatus });
  replaceUnit(updated);
  return { data: updated };
});

// ---- Incidents --------------------------------------------------------------

registerMock(raiseFacilityIncident, ({ body }) => {
  const unit = body.unitId ? unitById(body.unitId) : null;
  const incident = facilityIncidentSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fx.tenant.id,
    outletId: fx.outlet.id,
    facilityId: unit?.facilityId ?? SHOWER_FACILITY_ID,
    unitId: unit?.id ?? null,
    accessTicketId: body.accessTicketId ?? null,
    type: body.type,
    triggeredAt: staffAnchor(),
    offline: false,
    respondedBy: null,
    respondedAt: null,
    resolution: null,
  });
  const state = world.get();
  world.set({ ...state, incidents: [...state.incidents, incident] });
  return { data: incident };
});

registerMock(respondFacilityIncident, ({ params, body }) => {
  const incident = incidentById(params.incidentId);
  const responded = wrapped(() =>
    respondToFacilityIncident(incident, {
      respondedBy: STAFF_ID,
      respondedAt: staffAnchor(),
      resolution: body.resolution,
    }),
  );
  replaceIncident(responded);
  return { data: responded };
});

registerMock(listFacilityIncidents, ({ query, scenario }) => {
  const incidents = world
    .get()
    .incidents.filter((incident) => incident.facilityId === query.facilityId)
    .sort((a, b) => Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt));
  return paginateFixture(incidents, query, (incident) => incident.id, scenario);
});

// ---- Panic alerts (WS-02) ---------------------------------------------------

/**
 * Stand-in for POST /api/emergency/alerts/:id/ack (not a contract endpoint, so
 * the realtime client calls it through `apiFetch`). The "acknowledged" panic
 * scenario answers 409 like a colleague who was faster; any other scenario
 * accepts, and a repeat ack by the same staff is accepted too.
 */
export async function mockPanicAck(path: string): Promise<void> {
  const match = /^\/api\/emergency\/alerts\/([^/]+)\/ack$/.exec(path);
  if (!match) throw new ApiError(404, "NOT_FOUND", "Alert tidak ditemukan.");
  // Long enough to see the "Mengirim…" state.
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (readPanicMockScenario() === "acknowledged") {
    closeMockOpenAlert(decodeURIComponent(match[1]));
    throw new ApiError(
      409,
      "PANIC_ALREADY_ACKNOWLEDGED",
      "Alert sudah ditangani rekan lain.",
      undefined,
      {
        acknowledgedBy: { displayName: "Rina" },
        acknowledgedAt: new Date().toISOString(),
      },
    );
  }
  closeMockOpenAlert(decodeURIComponent(match[1]));
}

/** Stand-in for GET /api/emergency/open-alerts (the hook's mock `apiGet`). */
export async function mockPanicOpenAlerts(): Promise<{
  data: { alerts: ReturnType<typeof listMockOpenAlerts> };
}> {
  return { data: { alerts: listMockOpenAlerts() } };
}
