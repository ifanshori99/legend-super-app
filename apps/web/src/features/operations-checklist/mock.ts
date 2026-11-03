// Mock mode for the WS-14 checklist screens (PRD v1.7 §3 F41, OPS-01).
// Handlers behave like the API will: input is parsed by the runtime, the
// contract guards run (`transitionChecklistRun`, `checklistCompletionStatus`,
// `checklistItemResultIssues`), and refusals use the contract error codes the
// screens map to catalog text. State lives in `createMockStore`, so every run
// re-seeds and "?mock=empty" empties the lists through `paginateFixture`.
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { paginateFixture } from "@/lib/mock/paginate";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  OperationsError,
  cafeLegendOperationsFixtures,
  checklistCompletionStatus,
  checklistItemResultIssues,
  checklistItemResultSchema,
  checklistRunSchema,
  checklistTemplateSchema,
  createChecklistRun as createChecklistRunEndpoint,
  createChecklistTemplate as createChecklistTemplateEndpoint,
  getChecklistRun as getChecklistRunEndpoint,
  getChecklistTemplate as getChecklistTemplateEndpoint,
  listChecklistRuns as listChecklistRunsEndpoint,
  listChecklistTemplates as listChecklistTemplatesEndpoint,
  postChecklistRunTransition as postChecklistRunTransitionEndpoint,
  recordChecklistItemResult as recordChecklistItemResultEndpoint,
  snapshotChecklistTemplate,
  transitionChecklistRun,
  updateChecklistTemplate as updateChecklistTemplateEndpoint,
  type ChecklistRun,
  type ChecklistTemplate,
} from "@starter/shared/operations";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Item fields that decide the template version (ids excluded). */
function comparableItems(
  items: readonly {
    label: string;
    instruction: string | null;
    requiredEvidence: readonly string[];
  }[],
): string {
  return JSON.stringify(
    items.map(({ label, instruction, requiredEvidence }) => ({
      label,
      instruction,
      requiredEvidence,
    })),
  );
}

type ChecklistState = {
  templates: ChecklistTemplate[];
  runs: ChecklistRun[];
  /** Idempotency keys already committed to a run/template id. */
  runByKey: Map<string, string>;
  templateByKey: Map<string, string>;
};

const store = createMockStore<ChecklistState>(() => ({
  templates: clone(cafeLegendOperationsFixtures.checklistTemplates),
  runs: clone(cafeLegendOperationsFixtures.checklistRuns),
  runByKey: new Map(),
  templateByKey: new Map(),
}));

const now = () => new Date().toISOString();

/**
 * The server derives `dueAt` from the template's outlet-local `dueTime` and
 * the run's business date (D-CORE-6). The Cafe Legend fixture outlet is
 * Asia/Jakarta, which has no daylight saving, so the fixed +07:00 offset is
 * exact for the mock.
 */
const OUTLET_UTC_OFFSET = "+07:00";

function dueAtOf(shiftDate: string, dueTime: string): string {
  return new Date(
    `${shiftDate}T${dueTime}:00${OUTLET_UTC_OFFSET}`,
  ).toISOString();
}

function findRun(id: string): ChecklistRun {
  const run = store.get().runs.find((row) => row.id === id);
  if (!run) throw new ApiError(404, "NOT_FOUND", "Checklist tidak ditemukan.");
  return run;
}

function findTemplate(id: string): ChecklistTemplate {
  const template = store.get().templates.find((row) => row.id === id);
  if (!template)
    throw new ApiError(404, "NOT_FOUND", "Template checklist tidak ditemukan.");
  return template;
}

// ---- Runs ----------------------------------------------------------------

registerMock(listChecklistRunsEndpoint, ({ query, scenario }) => {
  const rows = store.get().runs.filter((run) => {
    if (run.outletId !== query.outletId) return false;
    if (query.status !== undefined && run.status !== query.status) return false;
    if (query.shiftDate !== undefined && run.shiftDate !== query.shiftDate)
      return false;
    if (query.assignedTo !== undefined && run.assignedTo !== query.assignedTo)
      return false;
    return true;
  });
  return paginateFixture(rows, query, (run) => run.id, scenario);
});

registerMock(getChecklistRunEndpoint, ({ params, scenario }) => {
  if (scenario === "empty")
    throw new ApiError(404, "NOT_FOUND", "Checklist tidak ditemukan.");
  return { data: clone(findRun(params.runId)) };
});

registerMock(createChecklistRunEndpoint, ({ body }) => {
  const state = store.get();
  const seenId = state.runByKey.get(body.idempotencyKey);
  if (seenId !== undefined) {
    const existing = state.runs.find((run) => run.id === seenId);
    if (existing) return { data: clone(existing) };
  }

  const template = findTemplate(body.templateId);
  // Owner decision: a run copies the template items at creation
  // (`snapshotChecklistTemplate`), so later template edits never rewrite it.
  const snapshot = snapshotChecklistTemplate(template);
  const run = checklistRunSchema.parse({
    id: newIdempotencyKey(),
    tenantId: template.tenantId,
    outletId: body.outletId,
    ...snapshot,
    shiftDate: body.shiftDate,
    shiftTemplateId:
      body.shiftTemplateId ?? template.schedule.shiftTemplateId ?? null,
    assignedTo: body.assignedTo,
    dueAt: dueAtOf(body.shiftDate, template.schedule.dueTime),
    completedAt: null,
    status: "pending",
    missedAt: null,
    alertedAt: null,
    results: snapshot.items.map((item) => ({
      itemId: item.id,
      status: "pending" as const,
      numberValue: null,
      note: null,
      photoMediaIds: [],
      signatureMediaId: null,
      completedAt: null,
      completedBy: null,
    })),
  });

  state.runs.unshift(run);
  state.runByKey.set(body.idempotencyKey, run.id);
  return { data: clone(run) };
});

registerMock(recordChecklistItemResultEndpoint, ({ params, body }) => {
  const state = store.get();
  const runIndex = state.runs.findIndex((row) => row.id === params.runId);
  if (runIndex === -1)
    throw new ApiError(404, "NOT_FOUND", "Checklist tidak ditemukan.");
  const run = state.runs[runIndex];

  // A result only belongs to a run in progress: pending runs must be started
  // through the machine first (machines.ts `start`).
  if (run.status !== "in_progress")
    throw new OperationsError("CHECKLIST_TRANSITION_INVALID");

  const item = run.items.find((row) => row.id === params.itemId);
  if (!item) throw new OperationsError("CHECKLIST_ITEM_NOT_IN_RUN");

  const finished = body.status !== "pending";
  const result = checklistItemResultSchema.parse({
    itemId: params.itemId,
    status: body.status,
    numberValue: body.numberValue ?? null,
    note: body.note ?? null,
    photoMediaIds: body.photoMediaIds ?? [],
    signatureMediaId: body.signatureMediaId ?? null,
    completedAt: finished ? now() : null,
    completedBy: finished ? run.assignedTo : null,
  });

  // PRD §3 F45: a done/failed answer carries the evidence its item requires.
  if (checklistItemResultIssues(item, result).length > 0)
    throw new OperationsError("CHECKLIST_ITEM_INCOMPLETE");

  const resultIndex = run.results.findIndex(
    (row) => row.itemId === params.itemId,
  );
  const results =
    resultIndex === -1
      ? [...run.results, result]
      : run.results.map((row, index) => (index === resultIndex ? result : row));
  const next = checklistRunSchema.parse({ ...run, results });
  state.runs[runIndex] = next;
  return { data: clone(next) };
});

registerMock(postChecklistRunTransitionEndpoint, ({ params, body }) => {
  const state = store.get();
  const runIndex = state.runs.findIndex((row) => row.id === params.runId);
  if (runIndex === -1)
    throw new ApiError(404, "NOT_FOUND", "Checklist tidak ditemukan.");
  const run = state.runs[runIndex];

  const nextStatus = transitionChecklistRun(run.status, body.action);

  if (body.action === "complete" || body.action === "fail") {
    // `complete`/`fail` must match the outcome the answers produce; an
    // unfinished or failed run refuses (machines.ts `checklistCompletionStatus`).
    const outcome = checklistCompletionStatus(run.items, run.results);
    if (outcome !== nextStatus)
      throw new OperationsError("CHECKLIST_TRANSITION_INVALID");
    const next = checklistRunSchema.parse({
      ...run,
      status: outcome,
      completedAt: now(),
      missedAt: null,
      alertedAt: null,
    });
    state.runs[runIndex] = next;
    return { data: clone(next) };
  }

  const next = checklistRunSchema.parse({
    ...run,
    status: nextStatus,
    completedAt: null,
    // OPS-01: a missed run carries the server miss time; any other transition
    // clears it.
    missedAt: nextStatus === "missed" ? now() : null,
    alertedAt: null,
  });
  state.runs[runIndex] = next;
  return { data: clone(next) };
});

// ---- Templates -----------------------------------------------------------

registerMock(listChecklistTemplatesEndpoint, ({ query, scenario }) => {
  const rows = store.get().templates.filter((template) => {
    if (template.outletId !== query.outletId) return false;
    if (query.type !== undefined && template.type !== query.type) return false;
    return true;
  });
  return paginateFixture(rows, query, (template) => template.id, scenario);
});

registerMock(getChecklistTemplateEndpoint, ({ params, scenario }) => {
  if (scenario === "empty")
    throw new ApiError(404, "NOT_FOUND", "Template checklist tidak ditemukan.");
  return { data: clone(findTemplate(params.templateId)) };
});

registerMock(createChecklistTemplateEndpoint, ({ body }) => {
  const state = store.get();
  const seenId = state.templateByKey.get(body.idempotencyKey);
  if (seenId !== undefined) {
    const existing = state.templates.find((row) => row.id === seenId);
    if (existing) return { data: clone(existing) };
  }

  const template = checklistTemplateSchema.parse({
    id: newIdempotencyKey(),
    tenantId: cafeLegendFixtures.tenant.id,
    outletId: body.outletId,
    name: body.name,
    type: body.type,
    items: body.items.map((item) => ({
      id: newIdempotencyKey(),
      label: item.label,
      instruction: item.instruction ?? null,
      requiredEvidence: item.requiredEvidence ?? [],
    })),
    schedule: body.schedule,
    roleId: body.roleId ?? null,
    version: 1,
    updatedAt: now(),
  });

  state.templates.unshift(template);
  state.templateByKey.set(body.idempotencyKey, template.id);
  return { data: clone(template) };
});

registerMock(updateChecklistTemplateEndpoint, ({ params, body }) => {
  const state = store.get();
  const templateIndex = state.templates.findIndex(
    (row) => row.id === params.templateId,
  );
  if (templateIndex === -1)
    throw new ApiError(404, "NOT_FOUND", "Template checklist tidak ditemukan.");
  const template = state.templates[templateIndex];

  // Optimistic concurrency: the client sends the version stamp it edited
  // (CORE PRECONDITION_FAILED on a stale value).
  if (template.updatedAt !== body.expectedUpdatedAt)
    throw new ApiError(
      412,
      "PRECONDITION_FAILED",
      "Template sudah berubah. Muat ulang lalu coba lagi.",
    );

  const nextItems =
    body.items === undefined
      ? template.items
      : body.items.map((item) => ({
          id: item.id ?? newIdempotencyKey(),
          label: item.label,
          instruction: item.instruction ?? null,
          requiredEvidence: item.requiredEvidence ?? [],
        }));
  // "Bumped by the server whenever `items` change" (checklistTemplateSchema).
  const itemsChanged =
    body.items !== undefined &&
    comparableItems(nextItems) !== comparableItems(template.items);

  const next = checklistTemplateSchema.parse({
    ...template,
    name: body.name ?? template.name,
    items: nextItems,
    schedule: body.schedule ?? template.schedule,
    roleId: body.roleId === undefined ? template.roleId : body.roleId,
    version: itemsChanged ? template.version + 1 : template.version,
    updatedAt: now(),
  });

  state.templates[templateIndex] = next;
  return { data: clone(next) };
});
