// Mock mode for the payroll configuration screen: serves and mutates the
// shared Cafe Legend payroll fixtures, so every tab works with
// VITE_API_MOCK=true (docs/frontend.md "Mock mode").
//
// Handlers behave like the API will: the runtime parses input with the
// contract's schemas, statutory versions move through the contract's own
// lifecycle (`publishStatutoryVersion` / `archiveStatutoryVersion`, PAYR-02),
// and idempotency keys are honored like a real endpoint: replaying one returns
// the recorded result, reusing it for another body is refused with
// IDEMPOTENCY_KEY_REUSED.
import { z, userIdSchema } from "@starter/shared/core";
import { zodIssuesToDetails } from "@starter/shared/api";
import {
  PayrollError,
  archiveStatutoryTable,
  archiveStatutoryVersion,
  cafeLegendPayrollFixtures,
  createPayComponent,
  createPayrollPolicy,
  createStatutoryTableDraft,
  createThrSchedule,
  employeePayComponentSchema,
  getStatutoryTable,
  listEmployeePayComponents,
  listPayComponents,
  listPayrollPolicies,
  listStatutoryTables,
  listThrSchedules,
  payComponentKindOf,
  payComponentSchema,
  payrollPolicySchema,
  publishStatutoryTable,
  publishStatutoryVersion,
  setEmployeePayComponent,
  statutoryTableVersionSchema,
  thrScheduleSchema,
  updatePayComponent,
  updatePayrollPolicy,
  updateStatutoryTableDraft,
  type EmployeePayComponent,
  type PayComponent,
  type PayrollPolicy,
  type StatutoryTableVersion,
  type ThrSchedule,
} from "@starter/shared/hris/payroll";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { dispatchMock } from "../../lib/mock/runtime.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { addDays, businessDateToday, sortStatutoryVersions } from "./lib.ts";

const fixtures = cafeLegendPayrollFixtures;
/** The finance user the fixture versions were published by (publishedBy). */
const ACTOR_ID = userIdSchema.parse(fixtures.userIds.financeApprover);

type PayrollConfigState = {
  statutoryTables: StatutoryTableVersion[];
  payComponents: PayComponent[];
  employeePayComponents: EmployeePayComponent[];
  payrollPolicies: PayrollPolicy[];
  thrSchedules: ThrSchedule[];
};

const seed = (): PayrollConfigState => {
  const source = structuredClone(fixtures);
  return {
    statutoryTables: [...source.statutoryTables],
    payComponents: [...source.payComponents],
    employeePayComponents: [...source.employeePayComponents],
    payrollPolicies: [...source.payrollPolicies],
    thrSchedules: [...source.thrSchedules],
  };
};

const store = createMockStore<PayrollConfigState>(seed);

// ---- Idempotency ----------------------------------------------------------

type ReplayRecord = { fingerprint: string; response: unknown };

const replays = createMockStore(() => new Map<string, ReplayRecord>());

/** The request body without its idempotency key. */
function withoutIdempotencyKey(body: object): Record<string, unknown> {
  const copy = { ...body } as Record<string, unknown>;
  delete copy.idempotencyKey;
  return copy;
}

/** The request without its idempotency key: a replay must match it exactly. */
function fingerprintOf(body: unknown): string {
  return JSON.stringify(
    withoutIdempotencyKey((body ?? {}) as Record<string, unknown>),
  );
}

function idempotent<T>(
  endpointId: string,
  key: string,
  body: unknown,
  compute: () => T,
): T {
  const records = replays.get();
  const id = `${endpointId}:${key}`;
  const seen = records.get(id);
  if (seen) {
    if (seen.fingerprint !== fingerprintOf(body))
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk permintaan lain.",
      );
    return seen.response as T;
  }
  const response = compute();
  records.set(id, { fingerprint: fingerprintOf(body), response });
  return response;
}

// ---- Shared helpers -------------------------------------------------------

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

/** A contract schema failure becomes the API's VALIDATION_ERROR, not a 500. */
function parseRow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Data tidak valid.",
      zodIssuesToDetails(result.error),
    );
  return result.data;
}

/** Contract domain errors reach the UI as ApiError, like the API's handler. */
function toApiError(error: unknown): never {
  if (error instanceof PayrollError)
    throw new ApiError(error.status, error.code, error.message);
  throw error;
}

function now(): string {
  return new Date().toISOString();
}

function tenantId(): string {
  return fixtures.tenant.id;
}

// ---- Statutory tables (PAYR-02, R20) -------------------------------------

registerMock(listStatutoryTables, ({ query, scenario }) => {
  const rows = sortStatutoryVersions(
    store
      .get()
      .statutoryTables.filter(
        (version) => query.type === undefined || version.type === query.type,
      ),
  );
  return paginateFixture(rows, query, (version) => version.id, scenario);
});

registerMock(getStatutoryTable, ({ params }) => {
  const found = store
    .get()
    .statutoryTables.find((version) => version.id === params.versionId);
  if (!found) notFound("Versi tabel tarif");
  return { data: found };
});

registerMock(createStatutoryTableDraft, ({ body }) => {
  const state = store.get();
  const versions = state.statutoryTables.filter(
    (version) => version.type === body.draft.type,
  );
  const version =
    versions.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  return idempotent(
    createStatutoryTableDraft.id,
    body.idempotencyKey,
    body,
    () => {
      const row = parseRow(statutoryTableVersionSchema, {
        id: newIdempotencyKey(),
        tenantId: tenantId(),
        type: body.draft.type,
        parameters: body.draft.parameters,
        version,
        effectiveFrom: body.effectiveFrom,
        status: "draft",
        legalBasis: body.legalBasis,
        publishedAt: null,
        publishedBy: null,
        createdAt: now(),
      });
      store.set({
        ...state,
        statutoryTables: [...state.statutoryTables, row],
      });
      return { data: row };
    },
  );
});

registerMock(updateStatutoryTableDraft, ({ params, body }) => {
  const state = store.get();
  const found = state.statutoryTables.find(
    (row) => row.id === params.versionId,
  );
  if (!found) notFound("Versi tabel tarif");
  if (found.status !== "draft")
    throw new ApiError(
      409,
      "PAYROLL_STATUTORY_TABLE_IMMUTABLE",
      "Tabel tarif yang sudah terbit tidak dapat diubah; buat versi baru.",
    );
  return idempotent(
    updateStatutoryTableDraft.id,
    body.idempotencyKey,
    body,
    () => {
      const updated = parseRow(statutoryTableVersionSchema, {
        ...found,
        type: body.draft.type,
        parameters: body.draft.parameters,
        effectiveFrom: body.effectiveFrom,
        legalBasis: body.legalBasis,
      });
      store.set({
        ...state,
        statutoryTables: state.statutoryTables.map((row) =>
          row.id === updated.id ? updated : row,
        ),
      });
      return { data: updated };
    },
  );
});

registerMock(publishStatutoryTable, ({ params, body }) =>
  idempotent(publishStatutoryTable.id, body.idempotencyKey, body, () => {
    const state = store.get();
    const found = state.statutoryTables.find(
      (row) => row.id === params.versionId,
    );
    if (!found) notFound("Versi tabel tarif");
    let published: StatutoryTableVersion;
    try {
      published = publishStatutoryVersion(found, {
        today: businessDateToday(),
        actorId: ACTOR_ID,
        at: now(),
      });
    } catch (error) {
      return toApiError(error);
    }
    store.set({
      ...state,
      statutoryTables: state.statutoryTables.map((row) =>
        row.id === published.id ? published : row,
      ),
    });
    return { data: published };
  }),
);

registerMock(archiveStatutoryTable, ({ params, body }) =>
  idempotent(archiveStatutoryTable.id, body.idempotencyKey, body, () => {
    const state = store.get();
    const found = state.statutoryTables.find(
      (row) => row.id === params.versionId,
    );
    if (!found) notFound("Versi tabel tarif");
    let archived: StatutoryTableVersion;
    try {
      archived = archiveStatutoryVersion(found);
    } catch (error) {
      return toApiError(error);
    }
    store.set({
      ...state,
      statutoryTables: state.statutoryTables.map((row) =>
        row.id === archived.id ? archived : row,
      ),
    });
    return { data: archived };
  }),
);

// ---- Policies -------------------------------------------------------------

registerMock(listPayrollPolicies, ({ query, scenario }) => {
  const rows = store
    .get()
    .payrollPolicies.filter(
      (policy) =>
        query.legalEntityId === undefined ||
        policy.legalEntityId === query.legalEntityId,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  return paginateFixture(rows, query, (policy) => policy.id, scenario);
});

registerMock(createPayrollPolicy, ({ body }) =>
  idempotent(createPayrollPolicy.id, body.idempotencyKey, body, () => {
    const state = store.get();
    const row = parseRow(payrollPolicySchema, {
      id: newIdempotencyKey(),
      tenantId: tenantId(),
      legalEntityId: body.legalEntityId,
      name: body.name,
      employeeGroup: body.employeeGroup,
      cycle: body.cycle,
      payDateAdjustment: body.payDateAdjustment,
      jkkRiskClass: body.jkkRiskClass,
      bpjsProgrammes: body.bpjsProgrammes,
      isActive: true,
      createdAt: now(),
      updatedAt: now(),
    });
    store.set({
      ...state,
      payrollPolicies: [...state.payrollPolicies, row],
    });
    return { data: row };
  }),
);

registerMock(updatePayrollPolicy, ({ params, body }) =>
  idempotent(updatePayrollPolicy.id, body.idempotencyKey, body, () => {
    const state = store.get();
    const found = state.payrollPolicies.find(
      (policy) => policy.id === params.payrollPolicyId,
    );
    if (!found) notFound("Kebijakan payroll");
    const patch = withoutIdempotencyKey(body);
    const updated = parseRow(payrollPolicySchema, {
      ...found,
      ...patch,
      updatedAt: now(),
    });
    store.set({
      ...state,
      payrollPolicies: state.payrollPolicies.map((policy) =>
        policy.id === updated.id ? updated : policy,
      ),
    });
    return { data: updated };
  }),
);

// ---- Pay components -------------------------------------------------------

registerMock(listPayComponents, ({ query, scenario }) => {
  const rows = [...store.get().payComponents].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code),
  );
  return paginateFixture(rows, query, (component) => component.id, scenario);
});

registerMock(createPayComponent, ({ body }) =>
  idempotent(createPayComponent.id, body.idempotencyKey, body, () => {
    const state = store.get();
    const row = parseRow(payComponentSchema, {
      id: newIdempotencyKey(),
      tenantId: tenantId(),
      code: body.code,
      name: body.name,
      category: body.category,
      recurrence: body.recurrence,
      taxable: body.taxable,
      taxScheme: body.taxScheme,
      bpjsBase: body.bpjsBase,
      overtimeBase: body.overtimeBase,
      thrBase: body.thrBase,
      displayOrder: body.displayOrder,
      kind: payComponentKindOf(body.category),
      isSystem: false,
      isActive: true,
      createdAt: now(),
      updatedAt: now(),
    });
    store.set({ ...state, payComponents: [...state.payComponents, row] });
    return { data: row };
  }),
);

registerMock(updatePayComponent, ({ params, body }) =>
  idempotent(updatePayComponent.id, body.idempotencyKey, body, () => {
    const state = store.get();
    const found = state.payComponents.find(
      (component) => component.id === params.componentId,
    );
    if (!found) notFound("Komponen gaji");
    const patch = withoutIdempotencyKey(body);
    const updated = parseRow(payComponentSchema, {
      ...found,
      ...patch,
      updatedAt: now(),
    });
    store.set({
      ...state,
      payComponents: state.payComponents.map((component) =>
        component.id === updated.id ? updated : component,
      ),
    });
    return { data: updated };
  }),
);

// ---- Employee pay components (HR-03) --------------------------------------

registerMock(listEmployeePayComponents, ({ params, query, scenario }) => {
  const rows = store
    .get()
    .employeePayComponents.filter((row) => row.employeeId === params.employeeId)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(setEmployeePayComponent, ({ params, body }) =>
  idempotent(setEmployeePayComponent.id, body.idempotencyKey, body, () => {
    const state = store.get();
    if (
      !state.payComponents.some(
        (component) => component.id === body.componentId,
      )
    )
      notFound("Komponen gaji");
    const effectiveFrom = body.effectiveFrom;
    // Mirror the API: a new amount closes the open row of the same component
    // the day before it starts; the same start date replaces the amount.
    const replaced = state.employeePayComponents.find(
      (row) =>
        row.employeeId === params.employeeId &&
        row.componentId === body.componentId &&
        row.effectiveFrom === effectiveFrom &&
        row.effectiveTo === null,
    );
    const rows = state.employeePayComponents.map((row) => {
      if (row.id === replaced?.id)
        return parseRow(employeePayComponentSchema, {
          ...row,
          amountIdr: body.amountIdr,
        });
      if (
        row.employeeId === params.employeeId &&
        row.componentId === body.componentId &&
        row.effectiveTo === null &&
        row.effectiveFrom < effectiveFrom
      )
        return parseRow(employeePayComponentSchema, {
          ...row,
          effectiveTo: addDays(effectiveFrom, -1),
        });
      return row;
    });
    const row = parseRow(employeePayComponentSchema, {
      id: replaced?.id ?? newIdempotencyKey(),
      tenantId: tenantId(),
      employeeId: params.employeeId,
      componentId: body.componentId,
      amountIdr: body.amountIdr,
      effectiveFrom,
      effectiveTo: null,
      createdAt: now(),
    });
    store.set({
      ...state,
      employeePayComponents: [
        ...rows.filter((existing) => existing.id !== row.id),
        row,
      ],
    });
    return { data: row };
  }),
);

// ---- THR schedules --------------------------------------------------------

registerMock(listThrSchedules, ({ query, scenario }) => {
  const rows = [...store.get().thrSchedules].sort((a, b) =>
    b.holidayDate.localeCompare(a.holidayDate),
  );
  return paginateFixture(rows, query, (schedule) => schedule.id, scenario);
});

registerMock(createThrSchedule, ({ body }) =>
  idempotent(createThrSchedule.id, body.idempotencyKey, body, () => {
    const state = store.get();
    const row = parseRow(thrScheduleSchema, {
      id: newIdempotencyKey(),
      tenantId: tenantId(),
      legalEntityId: body.legalEntityId,
      name: body.name,
      holidayName: body.holidayName,
      holidayDate: body.holidayDate,
      tenureAsOfDate: body.tenureAsOfDate,
      payDate: body.payDate,
      employeeIds: body.employeeIds,
      status: "scheduled",
      createdAt: now(),
    });
    store.set({ ...state, thrSchedules: [...state.thrSchedules, row] });
    return { data: row };
  }),
);

// ---- Dev-only replay control ----------------------------------------------
//
// The screen mints a fresh idempotency key per attempt, so a same-key replay
// is not reachable through the UI. The mock spec therefore dispatches the
// publish endpoint twice with one key through the same runtime the screen
// uses, then lists the chain to assert one row, not two (PAYR-02). Never
// present outside mock mode: the whole mock graph is compiled out of a normal
// build.
if (typeof window !== "undefined") {
  (
    window as unknown as {
      __legendPayrollConfigMock?: {
        publishStatutoryVersion: (
          versionId: string,
          idempotencyKey: string,
        ) => Promise<unknown>;
        listStatutoryTables: (type?: string) => Promise<unknown>;
      };
    }
  ).__legendPayrollConfigMock = {
    publishStatutoryVersion: (versionId, idempotencyKey) =>
      dispatchMock({
        method: "POST",
        path: `/api/hris/payroll/statutory-tables/${versionId}/publish`,
        body: { idempotencyKey },
      }),
    listStatutoryTables: (type) =>
      dispatchMock({
        method: "GET",
        path: "/api/hris/payroll/statutory-tables",
        query: { limit: 100, ...(type === undefined ? {} : { type }) },
      }),
  };
}
