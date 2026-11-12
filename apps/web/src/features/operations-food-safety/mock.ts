// Mock mode for the food-safety screens (VITE_API_MOCK=true): serves and
// mutates the shared Cafe Legend operations fixtures, so every screen works
// without a backend and the Playwright spec covers OPS-02 and OPS-03
// (docs/frontend.md "Mock mode").
//
// The handlers behave like the API will: the runtime validates input with the
// contract schemas, the temperature gate is the contract machine
// `assertTemperatureLogAllowed` (OPS-02), the prep list transition is
// `transitionPrepList`, and creates are idempotent per key.
//
// Fixture timestamps are rebased onto the browser's business day so "today"
// always has scheduled checks and one expired prep label, whatever the
// wall-clock date. Seeded ids and the story (one corrected excursion per
// chiller/freezer, one past-use-by label) stay intact.
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  addBusinessDays,
  businessDateOf,
  cafeLegendFixtures,
  decimal4Schema,
  type BusinessDate,
} from "@starter/shared/core";
import { cafeLegendInventoryFixtures } from "@starter/shared/inventory";
import {
  OperationsError,
  assertTemperatureLogAllowed,
  cafeLegendOperationsFixtures,
  calculatePrepUseBy,
  createPrepLabel as createPrepLabelEndpoint,
  createPrepList as createPrepListEndpoint,
  createTemperatureLog as createTemperatureLogEndpoint,
  getPrepList as getPrepListEndpoint,
  isTemperatureInRange,
  listPrepItemSettings as listPrepItemSettingsEndpoint,
  listPrepLabels as listPrepLabelsEndpoint,
  listPrepLists as listPrepListsEndpoint,
  listTemperatureLogs as listTemperatureLogsEndpoint,
  postPrepListTransition as postPrepListTransitionEndpoint,
  prepItemSettingSchema,
  prepLabelIdSchema,
  prepLabelSchema,
  prepListIdSchema,
  prepListItemIdSchema,
  prepListSchema,
  printPrepLabel as printPrepLabelEndpoint,
  putPrepItemSetting as putPrepItemSettingEndpoint,
  temperatureLogIdSchema,
  temperatureLogSchema,
  transitionPrepList,
  type PrepItemSetting,
  type PrepLabel,
  type PrepList,
  type TemperatureLog,
  type TemperatureThreshold,
} from "@starter/shared/operations";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const fixtures = cafeLegendOperationsFixtures;
const [outlet] = cafeLegendFixtures.outlets;
const inventory = cafeLegendInventoryFixtures;
// The mock session is the owner (features/ws01-auth/mock.ts); created rows
// carry the same actor so the form's "Penanggung jawab" matches the label.
const actorId = cafeLegendAccessFixtures.users.owner.id;

/** Outlet business dates and fixture timestamps are read on this clock. */
const TIME_ZONE = outlet.timeZone;
const ANCHOR_DATE: BusinessDate = "2026-11-01";
const DAY_MS = 86_400_000;

/**
 * Whole days between the fixture day and the browser's current business day.
 * Applied to every seeded instant, so 1 Nov fixture times land on today.
 */
function fixtureDayShift(): number {
  const today = businessDateOf(new Date(), {
    timeZone: TIME_ZONE,
    cutoff: outlet.businessDayCutoff,
  });
  return Math.round(
    (Date.parse(`${today}T00:00:00.000Z`) -
      Date.parse(`${ANCHOR_DATE}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

const shiftDays = fixtureDayShift();
const shiftMs = shiftDays * DAY_MS;

function shiftInstant(iso: string): string {
  return new Date(Date.parse(iso) + shiftMs).toISOString();
}

const nowIso = () => new Date().toISOString();

/** UUID v4 for a new row; the contract ids are uuid-branded, not ULIDs. */
const newId = () => newIdempotencyKey();

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function invalid(field: string, message: string): never {
  throw new ApiError(400, "VALIDATION_ERROR", message, [{ field, message }]);
}

function idempotentReplay<T>(
  seen: Map<string, { fingerprint: string; value: T }>,
  key: string,
  fingerprint: string,
): T | null {
  const record = seen.get(key);
  if (!record) return null;
  if (record.fingerprint !== fingerprint)
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
    );
  return record.value;
}

function assertOutlet(outletId: string) {
  if (outletId !== outlet.id) invalid("outletId", "Outlet tidak dikenal.");
}

/** Maps the operations machine errors onto the API envelope of the mock. */
function assertTemperatureAllowed(input: {
  readingCelsius: string;
  threshold: TemperatureThreshold;
  correctiveAction: string | null;
}): void {
  try {
    assertTemperatureLogAllowed(input);
  } catch (error) {
    if (error instanceof OperationsError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

// ---- Seeded state (rebased onto today) -----------------------------------

function seedTemperatureLogs(): TemperatureLog[] {
  return structuredClone(fixtures.temperatureLogs)
    .map((log) =>
      temperatureLogSchema.parse({
        ...log,
        recordedAt: shiftInstant(log.recordedAt),
      }),
    )
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
}

function seedPrepLabels(): PrepLabel[] {
  return structuredClone(fixtures.prepLabels)
    .map((label) =>
      prepLabelSchema.parse({
        ...label,
        producedAt: shiftInstant(label.producedAt),
        useBy: shiftInstant(label.useBy),
        printedAt: label.printedAt ? shiftInstant(label.printedAt) : null,
      }),
    )
    .sort((a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt));
}

function seedPrepLists(): PrepList[] {
  return structuredClone(fixtures.prepLists)
    .map((list) =>
      prepListSchema.parse({
        ...list,
        prepDate: addBusinessDays(list.prepDate, shiftDays),
        generatedAt: shiftInstant(list.generatedAt),
      }),
    )
    .sort((a, b) => b.prepDate.localeCompare(a.prepDate));
}

const temperatureLogs = createMockStore<TemperatureLog[]>(seedTemperatureLogs);
const prepLabels = createMockStore<PrepLabel[]>(seedPrepLabels);
// Demo settings reproduce the durations of the existing sample labels; this
// never supplies a production default for an unconfigured prep item.
const prepItemSettings = createMockStore<PrepItemSetting[]>(() => {
  const items = new Map<string, PrepItemSetting>();
  for (const label of fixtures.prepLabels) {
    const key = `${label.outletId}:${label.inventoryItemId}`;
    if (items.has(key)) continue;
    items.set(
      key,
      prepItemSettingSchema.parse({
        tenantId: label.tenantId,
        outletId: label.outletId,
        inventoryItemId: label.inventoryItemId,
        shelfLifeMinutes:
          (Date.parse(label.useBy) - Date.parse(label.producedAt)) / 60_000,
        updatedAt: shiftInstant(label.producedAt),
        updatedBy: actorId,
      }),
    );
  }
  return [...items.values()];
});
const prepSettingSaves = createMockStore(
  () => new Map<string, { fingerprint: string; value: PrepItemSetting }>(),
);
const prepLists = createMockStore<PrepList[]>(seedPrepLists);

const temperatureCreates = createMockStore(
  () => new Map<string, { fingerprint: string; value: TemperatureLog }>(),
);
const labelCreates = createMockStore(
  () => new Map<string, { fingerprint: string; value: PrepLabel }>(),
);
const printResults = createMockStore(
  () => new Map<string, { fingerprint: string; value: PrepLabel }>(),
);
const prepListCreates = createMockStore(
  () => new Map<string, { fingerprint: string; value: PrepList }>(),
);
const prepListTransitions = createMockStore(
  () => new Map<string, { fingerprint: string; value: PrepList }>(),
);

// ---- Temperature logs (OPS-02) -------------------------------------------

registerMock(listTemperatureLogsEndpoint, ({ query, scenario }) => {
  const from = query.from === undefined ? null : Date.parse(query.from);
  const to = query.to === undefined ? null : Date.parse(query.to);
  const filtered = temperatureLogs
    .get()
    .filter((log) => log.outletId === query.outletId)
    .filter(
      (log) =>
        query.equipmentId === undefined ||
        log.equipmentId === query.equipmentId,
    )
    .filter((log) => from === null || Date.parse(log.recordedAt) >= from)
    .filter((log) => to === null || Date.parse(log.recordedAt) <= to)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  return paginateFixture(filtered, query, (log) => log.id, scenario);
});

registerMock(createTemperatureLogEndpoint, ({ body }) => {
  assertOutlet(body.outletId);
  const fingerprint = JSON.stringify(body);
  const replay = idempotentReplay(
    temperatureCreates.get(),
    body.idempotencyKey,
    fingerprint,
  );
  if (replay) return { data: replay };

  const equipment = fixtures.equipment.find(
    (row) => row.id === body.equipmentId && row.outletId === outlet.id,
  );
  if (!equipment) notFound("Peralatan");
  const threshold = equipment.temperatureThreshold;
  if (!threshold)
    throw new ApiError(
      422,
      "TEMPERATURE_READING_INVALID",
      "Peralatan ini tidak memiliki ambang suhu.",
    );

  const reading = decimal4Schema.parse(body.readingCelsius);
  const correctiveAction = body.correctiveAction?.trim() || null;
  // OPS-02: the contract machine decides, exactly as the API service will.
  assertTemperatureAllowed({
    readingCelsius: reading,
    threshold,
    correctiveAction,
  });
  const inRange = isTemperatureInRange(reading, threshold);
  const log = temperatureLogSchema.parse({
    id: temperatureLogIdSchema.parse(newId()),
    tenantId: fixtures.temperatureLogs[0].tenantId,
    outletId: body.outletId,
    equipmentId: body.equipmentId,
    readingCelsius: reading,
    recordedAt: body.recordedAt ?? nowIso(),
    recordedBy: actorId,
    inRange,
    correctiveAction: inRange ? null : correctiveAction,
  });

  temperatureLogs.set(
    [log, ...temperatureLogs.get()].sort(
      (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt),
    ),
  );
  temperatureCreates
    .get()
    .set(body.idempotencyKey, { fingerprint, value: log });
  return { data: log };
});

// ---- Prep labels (OPS-03) ------------------------------------------------

registerMock(listPrepItemSettingsEndpoint, ({ query, scenario }) => {
  assertOutlet(query.outletId);
  const filtered = prepItemSettings
    .get()
    .filter(
      (setting) =>
        setting.outletId === query.outletId &&
        (query.inventoryItemId === undefined ||
          setting.inventoryItemId === query.inventoryItemId),
    );
  return paginateFixture(
    filtered,
    query,
    (setting) => setting.inventoryItemId,
    scenario,
  );
});

registerMock(putPrepItemSettingEndpoint, ({ params, body }) => {
  assertOutlet(body.outletId);
  const fingerprint = JSON.stringify({
    inventoryItemId: params.inventoryItemId,
    ...body,
  });
  const replay = idempotentReplay(
    prepSettingSaves.get(),
    body.idempotencyKey,
    fingerprint,
  );
  if (replay) return { data: replay };
  if (!inventory.items.some((item) => item.id === params.inventoryItemId))
    notFound("Bahan prep");
  const setting = prepItemSettingSchema.parse({
    tenantId: outlet.tenantId,
    outletId: body.outletId,
    inventoryItemId: params.inventoryItemId,
    shelfLifeMinutes: body.shelfLifeMinutes,
    updatedAt: nowIso(),
    updatedBy: actorId,
  });
  prepItemSettings.set([
    ...prepItemSettings
      .get()
      .filter(
        (row) =>
          row.outletId !== setting.outletId ||
          row.inventoryItemId !== setting.inventoryItemId,
      ),
    setting,
  ]);
  prepSettingSaves
    .get()
    .set(body.idempotencyKey, { fingerprint, value: setting });
  return { data: setting };
});

registerMock(listPrepLabelsEndpoint, ({ query, scenario }) => {
  const expiringBefore =
    query.expiringBefore === undefined
      ? null
      : Date.parse(query.expiringBefore);
  const filtered = prepLabels
    .get()
    .filter((label) => label.outletId === query.outletId)
    .filter(
      (label) =>
        query.inventoryItemId === undefined ||
        label.inventoryItemId === query.inventoryItemId,
    )
    .filter(
      (label) =>
        expiringBefore === null || Date.parse(label.useBy) < expiringBefore,
    )
    .sort((a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt));
  return paginateFixture(filtered, query, (label) => label.id, scenario);
});

registerMock(createPrepLabelEndpoint, ({ body }) => {
  assertOutlet(body.outletId);
  const fingerprint = JSON.stringify(body);
  const replay = idempotentReplay(
    labelCreates.get(),
    body.idempotencyKey,
    fingerprint,
  );
  if (replay) return { data: replay };

  const item = inventory.items.find((row) => row.id === body.inventoryItemId);
  if (!item) invalid("inventoryItemId", "Bahan tidak dikenal.");
  const batch = inventory.batches.find((row) => row.id === body.batchId);
  if (!batch) invalid("batchId", "Batch tidak dikenal.");
  if (batch.inventoryItemId !== item.id)
    invalid("batchId", "Batch tidak sesuai dengan bahan yang dipilih.");
  if (batch.outletId !== body.outletId)
    invalid("batchId", "Batch bukan milik outlet ini.");
  const setting = prepItemSettings
    .get()
    .find(
      (row) =>
        row.outletId === body.outletId &&
        row.inventoryItemId === body.inventoryItemId,
    );
  if (!setting)
    throw new ApiError(
      422,
      "PREP_SHELF_LIFE_REQUIRED",
      "Atur masa simpan bahan prep di outlet ini sebelum membuat label.",
    );
  const useBy = calculatePrepUseBy(body.producedAt, setting.shelfLifeMinutes);
  if (
    useBy === null ||
    (body.useBy !== undefined && Date.parse(body.useBy) !== Date.parse(useBy))
  )
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Batas pakai harus sesuai waktu produksi dan masa simpan bahan prep.",
      [
        {
          field: "useBy",
          message: "Periksa waktu produksi dan masa simpan bahan prep.",
        },
      ],
    );

  const label = prepLabelSchema.parse({
    id: prepLabelIdSchema.parse(newId()),
    tenantId: fixtures.prepLabels[0].tenantId,
    outletId: body.outletId,
    inventoryItemId: body.inventoryItemId,
    batchId: body.batchId,
    producedAt: body.producedAt,
    useBy,
    producedBy: actorId,
    printedAt: null,
  });
  prepLabels.set(
    [label, ...prepLabels.get()].sort(
      (a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt),
    ),
  );
  labelCreates.get().set(body.idempotencyKey, { fingerprint, value: label });
  return { data: label };
});

registerMock(printPrepLabelEndpoint, ({ params, body }) => {
  const fingerprint = JSON.stringify(body);
  const replay = idempotentReplay(
    printResults.get(),
    body.idempotencyKey,
    fingerprint,
  );
  if (replay) return { data: replay };

  const current = prepLabels.get().find((label) => label.id === params.labelId);
  if (!current) notFound("Label prep");
  const printed = prepLabelSchema.parse({
    ...current,
    printedAt: nowIso(),
  });
  prepLabels.set(
    prepLabels
      .get()
      .map((label) => (label.id === printed.id ? printed : label))
      .sort((a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt)),
  );
  printResults.get().set(body.idempotencyKey, { fingerprint, value: printed });
  return { data: printed };
});

// ---- Prep lists ----------------------------------------------------------

registerMock(listPrepListsEndpoint, ({ query, scenario }) => {
  const filtered = prepLists
    .get()
    .filter((list) => list.outletId === query.outletId)
    .filter(
      (list) =>
        query.prepDate === undefined || list.prepDate === query.prepDate,
    )
    .filter(
      (list) => query.status === undefined || list.status === query.status,
    )
    .sort(
      (a, b) =>
        b.prepDate.localeCompare(a.prepDate) ||
        Date.parse(b.generatedAt) - Date.parse(a.generatedAt),
    );
  return paginateFixture(filtered, query, (list) => list.id, scenario);
});

registerMock(getPrepListEndpoint, ({ params }) => {
  const list = prepLists.get().find((row) => row.id === params.prepListId);
  if (!list) notFound("Daftar prep");
  return { data: list };
});

registerMock(createPrepListEndpoint, ({ body }) => {
  assertOutlet(body.outletId);
  const fingerprint = JSON.stringify(body);
  const replay = idempotentReplay(
    prepListCreates.get(),
    body.idempotencyKey,
    fingerprint,
  );
  if (replay) return { data: replay };

  const seen = new Set<string>();
  for (const line of body.lines) {
    const item = inventory.items.find((row) => row.id === line.inventoryItemId);
    if (!item) invalid("lines", "Bahan pada daftar tidak dikenal.");
    if (seen.has(line.inventoryItemId))
      invalid("lines", "Setiap bahan hanya boleh muncul sekali.");
    seen.add(line.inventoryItemId);
  }

  const list = prepListSchema.parse({
    id: prepListIdSchema.parse(newId()),
    tenantId: fixtures.prepLists[0].tenantId,
    outletId: body.outletId,
    prepDate: body.prepDate,
    lines: body.lines.map((line) => ({
      id: prepListItemIdSchema.parse(newId()),
      inventoryItemId: line.inventoryItemId,
      plannedQuantity: line.plannedQuantity,
      productionOrderId: null,
    })),
    status: "pending",
    generatedFromForecastId: body.generatedFromForecastId ?? null,
    generatedAt: nowIso(),
  });
  prepLists.set(
    [list, ...prepLists.get()].sort(
      (a, b) =>
        b.prepDate.localeCompare(a.prepDate) ||
        Date.parse(b.generatedAt) - Date.parse(a.generatedAt),
    ),
  );
  prepListCreates.get().set(body.idempotencyKey, { fingerprint, value: list });
  return { data: list };
});

registerMock(postPrepListTransitionEndpoint, ({ params, body }) => {
  const fingerprint = JSON.stringify({ id: params.prepListId, ...body });
  const replay = idempotentReplay(
    prepListTransitions.get(),
    body.idempotencyKey,
    fingerprint,
  );
  if (replay) return { data: replay };

  const current = prepLists.get().find((row) => row.id === params.prepListId);
  if (!current) notFound("Daftar prep");
  let nextStatus: PrepList["status"];
  try {
    nextStatus = transitionPrepList(current.status, body.action);
  } catch (error) {
    if (error instanceof OperationsError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
  const updated = prepListSchema.parse({ ...current, status: nextStatus });
  prepLists.set(
    prepLists.get().map((row) => (row.id === updated.id ? updated : row)),
  );
  prepListTransitions
    .get()
    .set(body.idempotencyKey, { fingerprint, value: updated });
  return { data: updated };
});
