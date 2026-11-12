// Daily-operations food safety, prep labels and the daily prep list (PRD v1.7
// §3 F41 "Log Keamanan Pangan, Label Prep, Daftar Prep Harian", §6 L; WS-14;
// bead legend-sdet). Routes: routes/operations*.routes.ts.
//
// Rules implemented here, all inside `withTenant` (RLS) and re-checked against
// the concrete outlet with `assertOutletPermission`:
// - OPS-02: `temperature_logs.in_range` is derived from the equipment
//   threshold once and stored; an out-of-range reading cannot be written
//   without a corrective action (`TEMPERATURE_CORRECTIVE_ACTION_REQUIRED`),
//   and an in-range reading never carries one. The DB CHECK
//   `temperature_logs_corrective_action_check` is the backstop. An out-of-range
//   save emits `temperature.out_of_range` through the transactional outbox.
// - OPS-03: a prep label is linked to an inventory batch of the same tenant and
//   outlet and the same inventory item; the expiry sweep alerts each expired
//   label exactly once (`prep_label.expired`, `expiry_alerted_at`).
// - The daily prep list comes from the AI-07 forecast job id
//   (`generated_from_forecast_id`); completing it hands the lines to the WS-06
//   production port (`operations-prep-production.ts`, default no-op until
//   legend-ugo wires production orders).
//
// Reads (`list*`, `get*`) have no actor argument in the agreed signatures: they
// rely on the server-minted tenant/outlet scope and RLS, and the router keeps
// the read permission. Writes re-check on the outlet inside the transaction.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  assertOutletInScope,
  businessDateSchema,
  CoreError,
  decimal4Schema,
  decodeCursor,
  encodeCursor,
  userIdSchema,
  uuidSchema,
  z,
  type CursorPage,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  calculatePrepUseBy,
  createPrepLabel as createPrepLabelEndpoint,
  createPrepList as createPrepListEndpoint,
  createTemperatureLog as createTemperatureLogEndpoint,
  isTemperatureInRange,
  listPrepItemSettings as listPrepItemSettingsEndpoint,
  listPrepLabels as listPrepLabelsEndpoint,
  listPrepLists as listPrepListsEndpoint,
  listTemperatureLogs as listTemperatureLogsEndpoint,
  OperationsError,
  operationsEvents,
  prepItemSettingSchema,
  prepLabelSchema,
  prepListLineSchema,
  prepListSchema,
  printPrepLabel as printPrepLabelEndpoint,
  postPrepListTransition as postPrepListTransitionEndpoint,
  putPrepItemSetting as putPrepItemSettingEndpoint,
  temperatureLogSchema,
  temperatureThresholdSchema,
  transitionPrepList as transitionPrepListMachine,
  type PrepItemSetting,
  type PrepLabel,
  type PrepList,
  type PrepListLine,
  type TemperatureLog,
} from "@starter/shared/operations";
import { db } from "../db/index.ts";
import { inventoryItems, stockBatches } from "../db/schema/inventory.ts";
import {
  equipment,
  prepItemSettings,
  prepLabels,
  prepListItems,
  prepLists,
  temperatureLogs,
} from "../db/schema/operations.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertOutletPermission } from "./menu-internals.ts";
import {
  operationsFingerprint,
  readIdempotentResult,
  storeIdempotentResult,
  type OperationsTx,
} from "./operations-idempotency.ts";
import { emitOperationsEvent } from "./operations-events.ts";
import { linkProductionOrdersForPrepList } from "./operations-prep-production.ts";

const TEMPERATURE_PERMISSION = "ops.food_safety.log" as const;
const PREP_PERMISSION = "ops.prep.manage" as const;

/** OPS-02 event: only emitted after the corrective action is recorded. */
const temperatureOutOfRangeEvent = operationsEvents["temperature.out_of_range"];
/** OPS-03 event: emitted once per expired label by the sweep. */
const prepLabelExpiredEvent = operationsEvents["prep_label.expired"];

type TemperatureLogQuery = z.output<typeof listTemperatureLogsEndpoint.query>;
type CreateTemperatureLogInput = z.output<
  typeof createTemperatureLogEndpoint.body
>;
type PrepItemSettingQuery = z.output<typeof listPrepItemSettingsEndpoint.query>;
type PutPrepItemSettingInput = z.output<typeof putPrepItemSettingEndpoint.body>;
type PrepLabelQuery = z.output<typeof listPrepLabelsEndpoint.query>;
type CreatePrepLabelInput = z.output<typeof createPrepLabelEndpoint.body>;
type PrintPrepLabelInput = z.output<typeof printPrepLabelEndpoint.body>;
type PrepListQuery = z.output<typeof listPrepListsEndpoint.query>;
type CreatePrepListInput = z.output<typeof createPrepListEndpoint.body>;
type TransitionPrepListInput = z.output<
  typeof postPrepListTransitionEndpoint.body
>;

type PrepListRow = typeof prepLists.$inferSelect;

const TEMPERATURE_RESULT_TABLE = "temperature_log";
const PREP_ITEM_SETTING_RESULT_TABLE = "prep_item_setting";
const PREP_LABEL_RESULT_TABLE = "prep_label";
const PREP_LIST_RESULT_TABLE = "prep_list";
const PREP_LIST_TRANSITION_RESULT_TABLE = "prep_list_transition";

// ------------------------------------------------------------- helpers

/** Strict cursor decode; a tampered cursor is a 422, never a 500. */
function cursorKeys(cursor: string | undefined, size: number): string[] {
  if (!cursor) return [];
  try {
    const keys = decodeCursor(cursor);
    if (keys.length !== size || keys.some((key) => typeof key !== "string"))
      throw new RangeError("Invalid cursor");
    // Every keyset here ends on a UUID id; a tampered value must not reach a
    // `::uuid` cast and turn into a 500.
    if (size === 2 && !uuidSchema.safeParse(keys[1]).success)
      throw new RangeError("Invalid cursor");
    return keys as string[];
  } catch {
    // A tampered cursor is client input, not a server failure (D-CORE-5).
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
}

/** Cursor/query instant; an unparseable value is a 422, never an Invalid Date. */
function asInstant(value: string, message = "Check the cursor."): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime()))
    throw new HttpError(422, "VALIDATION_ERROR", message);
  return at;
}

/** PostgreSQL error code (unique violation, RLS) through Drizzle's wrapper. */
function pgErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null)
    return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return pgErrorCode(candidate.cause, depth + 1);
}

function toPage<Row, Item>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Item,
  keys: (row: Row) => [string, string],
): CursorPage<Item> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data: data.map(map),
    meta: {
      limit,
      nextCursor: rows.length > limit && last ? encodeCursor(keys(last)) : null,
    },
  };
}

const toTemperatureLog = (
  row: typeof temperatureLogs.$inferSelect,
): TemperatureLog =>
  temperatureLogSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    equipmentId: row.equipmentId,
    readingCelsius: row.readingCelsius,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recordedBy,
    inRange: row.inRange,
    correctiveAction: row.correctiveAction,
  });

const toPrepItemSetting = (
  row: typeof prepItemSettings.$inferSelect,
): PrepItemSetting =>
  prepItemSettingSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    inventoryItemId: row.inventoryItemId,
    shelfLifeMinutes: row.shelfLifeMinutes,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  });

const toPrepLabel = (row: typeof prepLabels.$inferSelect): PrepLabel =>
  prepLabelSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    inventoryItemId: row.inventoryItemId,
    batchId: row.batchId,
    producedAt: row.producedAt.toISOString(),
    useBy: row.useBy.toISOString(),
    producedBy: row.producedBy,
    printedAt: row.printedAt?.toISOString() ?? null,
  });

const toPrepList = (row: PrepListRow, lines: PrepListLine[]): PrepList =>
  prepListSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    prepDate: row.prepDate,
    lines,
    status: row.status,
    generatedFromForecastId: row.generatedFromForecastId,
    generatedAt: row.generatedAt.toISOString(),
  });

// --------------------------------------------------------- temperature

async function loadTemperatureLog(
  tx: OperationsTx,
  context: ScopedTenantContext,
  temperatureLogId: string,
): Promise<TemperatureLog> {
  const [row] = await tx
    .select()
    .from(temperatureLogs)
    .where(
      and(
        eq(temperatureLogs.tenantId, context.tenant.tenantId),
        eq(temperatureLogs.id, temperatureLogId),
      ),
    )
    .limit(1);
  if (!row) throw new CoreError("NOT_FOUND", "Log suhu tidak ditemukan.");
  return toTemperatureLog(row);
}

/** Filters by outlet, equipment and the recorded_at range (inclusive). */
export async function listTemperatureLogs(
  context: ScopedTenantContext,
  query: TemperatureLogQuery,
): Promise<CursorPage<TemperatureLog>> {
  assertOutletInScope(context.outletScope, query.outletId);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(temperatureLogs.tenantId, context.tenant.tenantId),
      eq(temperatureLogs.outletId, query.outletId),
    ];
    if (query.equipmentId)
      filters.push(eq(temperatureLogs.equipmentId, query.equipmentId));
    if (query.from)
      filters.push(
        gte(
          temperatureLogs.recordedAt,
          asInstant(query.from, "Check the instant."),
        ),
      );
    if (query.to)
      filters.push(
        lte(
          temperatureLogs.recordedAt,
          asInstant(query.to, "Check the instant."),
        ),
      );
    const [at, id] = cursorKeys(query.cursor, 2);
    if (at !== undefined && id !== undefined) {
      const cursorAt = asInstant(at);
      // Strict descending keyset: `recordedAt <= cursor` would repeat the row.
      filters.push(
        or(
          lt(temperatureLogs.recordedAt, cursorAt),
          and(
            eq(temperatureLogs.recordedAt, cursorAt),
            sql`${temperatureLogs.id} < ${id}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(temperatureLogs)
      .where(and(...filters))
      .orderBy(desc(temperatureLogs.recordedAt), desc(temperatureLogs.id))
      .limit(query.limit + 1);
    return toPage(rows, query.limit, toTemperatureLog, (row) => [
      row.recordedAt.toISOString(),
      row.id,
    ]);
  });
}

/**
 * Records one reading. OPS-02: the threshold must exist, the verdict is
 * stored, and an out-of-range reading needs its corrective action.
 */
export async function createTemperatureLog(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateTemperatureLogInput,
  now: Date = new Date(),
): Promise<TemperatureLog> {
  assertOutletInScope(context.outletScope, input.outletId);
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      actor,
      TEMPERATURE_PERMISSION,
      input.outletId,
      now,
    );
    const { idempotencyKey, ...body } = input;
    const fingerprint = operationsFingerprint(body);
    const replayed = await readIdempotentResult(
      tx,
      context,
      idempotencyKey,
      fingerprint,
      TEMPERATURE_RESULT_TABLE,
    );
    if (replayed) return loadTemperatureLog(tx, context, replayed);

    const [asset] = await tx
      .select()
      .from(equipment)
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.outletId, input.outletId),
          eq(equipment.id, input.equipmentId),
        ),
      )
      .limit(1);
    if (!asset) throw new CoreError("NOT_FOUND", "Peralatan tidak ditemukan.");
    const threshold = temperatureThresholdSchema.safeParse(
      asset.temperatureThreshold,
    );
    if (!threshold.success)
      throw new OperationsError("TEMPERATURE_READING_INVALID");
    if (!decimal4Schema.safeParse(input.readingCelsius).success)
      throw new OperationsError("TEMPERATURE_READING_INVALID");

    const inRange = isTemperatureInRange(input.readingCelsius, threshold.data);
    const correctiveAction = (input.correctiveAction ?? "").trim();
    if (!inRange && correctiveAction.length === 0)
      throw new OperationsError("TEMPERATURE_CORRECTIVE_ACTION_REQUIRED");

    const [row] = await tx
      .insert(temperatureLogs)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        equipmentId: input.equipmentId,
        readingCelsius: input.readingCelsius,
        recordedAt: input.recordedAt ? new Date(input.recordedAt) : now,
        recordedBy: actor,
        inRange,
        correctiveAction: inRange ? null : correctiveAction,
      })
      .returning();
    if (!row)
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        "Pembacaan suhu gagal disimpan.",
      );
    const log = toTemperatureLog(row);

    if (!inRange)
      await emitOperationsEvent(tx, context, temperatureOutOfRangeEvent, {
        aggregateId: log.id,
        outletId: log.outletId,
        actor: { type: "user", id: actor },
        payload: {
          temperatureLogId: log.id,
          equipmentId: log.equipmentId,
          readingCelsius: log.readingCelsius,
          minCelsius: threshold.data.minCelsius,
          maxCelsius: threshold.data.maxCelsius,
          recordedAt: log.recordedAt,
          correctiveAction,
        },
        now,
      });

    await storeIdempotentResult(tx, context, {
      key: idempotencyKey,
      fingerprint,
      outletId: input.outletId,
      resultTable: TEMPERATURE_RESULT_TABLE,
      resultId: log.id,
    });
    return log;
  });
}

// -------------------------------------------------- prep shelf-life settings

export async function listPrepItemSettings(
  context: ScopedTenantContext,
  query: PrepItemSettingQuery,
): Promise<CursorPage<PrepItemSetting>> {
  assertOutletInScope(context.outletScope, query.outletId);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(prepItemSettings.tenantId, context.tenant.tenantId),
      eq(prepItemSettings.outletId, query.outletId),
    ];
    if (query.inventoryItemId)
      filters.push(eq(prepItemSettings.inventoryItemId, query.inventoryItemId));
    const [updatedAt, id] = cursorKeys(query.cursor, 2);
    if (updatedAt !== undefined && id !== undefined) {
      const cursorAt = asInstant(updatedAt);
      filters.push(
        or(
          gt(prepItemSettings.updatedAt, cursorAt),
          and(
            eq(prepItemSettings.updatedAt, cursorAt),
            sql`${prepItemSettings.id} > ${id}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(prepItemSettings)
      .where(and(...filters))
      .orderBy(asc(prepItemSettings.updatedAt), asc(prepItemSettings.id))
      .limit(query.limit + 1);
    return toPage(rows, query.limit, toPrepItemSetting, (row) => [
      row.updatedAt.toISOString(),
      row.id,
    ]);
  });
}

export async function upsertPrepItemSetting(
  context: ScopedTenantContext,
  actorUserId: string,
  inventoryItemId: string,
  input: PutPrepItemSettingInput,
  now: Date = new Date(),
): Promise<PrepItemSetting> {
  assertOutletInScope(context.outletScope, input.outletId);
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      actor,
      PREP_PERMISSION,
      input.outletId,
      now,
    );
    const { idempotencyKey, ...body } = input;
    const fingerprint = operationsFingerprint({ inventoryItemId, ...body });
    const replayed = await readIdempotentResult(
      tx,
      context,
      idempotencyKey,
      fingerprint,
      PREP_ITEM_SETTING_RESULT_TABLE,
    );
    if (replayed) {
      const [row] = await tx
        .select()
        .from(prepItemSettings)
        .where(
          and(
            eq(prepItemSettings.tenantId, context.tenant.tenantId),
            eq(prepItemSettings.outletId, input.outletId),
            eq(prepItemSettings.id, replayed),
          ),
        )
        .limit(1);
      if (!row)
        throw new CoreError(
          "NOT_FOUND",
          "Masa simpan bahan prep tidak ditemukan.",
        );
      return toPrepItemSetting(row);
    }
    const [item] = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.tenantId, context.tenant.tenantId),
          eq(inventoryItems.id, inventoryItemId),
        ),
      )
      .limit(1);
    if (!item) throw new CoreError("NOT_FOUND", "Bahan prep tidak ditemukan.");
    const [row] = await tx
      .insert(prepItemSettings)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        inventoryItemId,
        shelfLifeMinutes: input.shelfLifeMinutes,
        updatedAt: now,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: [
          prepItemSettings.tenantId,
          prepItemSettings.outletId,
          prepItemSettings.inventoryItemId,
        ],
        set: {
          shelfLifeMinutes: input.shelfLifeMinutes,
          updatedAt: now,
          updatedBy: actor,
        },
      })
      .returning();
    if (!row)
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        "Masa simpan bahan prep gagal disimpan.",
      );
    await storeIdempotentResult(tx, context, {
      key: idempotencyKey,
      fingerprint,
      outletId: input.outletId,
      resultTable: PREP_ITEM_SETTING_RESULT_TABLE,
      resultId: row.id,
    });
    return toPrepItemSetting(row);
  });
}

// --------------------------------------------------------- prep labels

/** Filters by outlet, inventory item and use_by (expiry window, OPS-03). */
export async function listPrepLabels(
  context: ScopedTenantContext,
  query: PrepLabelQuery,
  now: Date = new Date(),
): Promise<CursorPage<PrepLabel>> {
  assertOutletInScope(context.outletScope, query.outletId);
  // The signature carries the server clock for parity with the write paths;
  // the current filter set is fully described by `query` (OPS-03).
  void now;
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(prepLabels.tenantId, context.tenant.tenantId),
      eq(prepLabels.outletId, query.outletId),
    ];
    if (query.inventoryItemId)
      filters.push(eq(prepLabels.inventoryItemId, query.inventoryItemId));
    if (query.expiringBefore)
      filters.push(
        lt(
          prepLabels.useBy,
          asInstant(query.expiringBefore, "Check the instant."),
        ),
      );
    const [at, id] = cursorKeys(query.cursor, 2);
    if (at !== undefined && id !== undefined) {
      const cursorAt = asInstant(at);
      // Ascending keyset on (use_by, id): the soonest expiry comes first.
      filters.push(
        or(
          gt(prepLabels.useBy, cursorAt),
          and(
            eq(prepLabels.useBy, cursorAt),
            sql`${prepLabels.id} > ${id}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(prepLabels)
      .where(and(...filters))
      .orderBy(asc(prepLabels.useBy), asc(prepLabels.id))
      .limit(query.limit + 1);
    return toPage(rows, query.limit, toPrepLabel, (row) => [
      row.useBy.toISOString(),
      row.id,
    ]);
  });
}

/**
 * OPS-03: the label names the batch it came from. The batch must exist in the
 * same tenant and outlet and belong to the given inventory item.
 */
export async function createPrepLabel(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePrepLabelInput,
  now: Date = new Date(),
): Promise<PrepLabel> {
  assertOutletInScope(context.outletScope, input.outletId);
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      actor,
      PREP_PERMISSION,
      input.outletId,
      now,
    );
    const { idempotencyKey, ...body } = input;
    const fingerprint = operationsFingerprint(body);
    const replayed = await readIdempotentResult(
      tx,
      context,
      idempotencyKey,
      fingerprint,
      PREP_LABEL_RESULT_TABLE,
    );
    if (replayed) {
      const [row] = await tx
        .select()
        .from(prepLabels)
        .where(
          and(
            eq(prepLabels.tenantId, context.tenant.tenantId),
            eq(prepLabels.id, replayed),
          ),
        )
        .limit(1);
      if (!row) throw new CoreError("NOT_FOUND", "Label prep tidak ditemukan.");
      return toPrepLabel(row);
    }

    const [batch] = await tx
      .select({
        id: stockBatches.id,
        outletId: stockBatches.outletId,
        inventoryItemId: stockBatches.inventoryItemId,
      })
      .from(stockBatches)
      .where(
        and(
          eq(stockBatches.tenantId, context.tenant.tenantId),
          eq(stockBatches.outletId, input.outletId),
          eq(stockBatches.id, input.batchId),
        ),
      )
      .limit(1);
    if (!batch || batch.inventoryItemId !== input.inventoryItemId)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Batch stok tidak sesuai outlet atau item inventori.",
      );

    const [setting] = await tx
      .select({ shelfLifeMinutes: prepItemSettings.shelfLifeMinutes })
      .from(prepItemSettings)
      .where(
        and(
          eq(prepItemSettings.tenantId, context.tenant.tenantId),
          eq(prepItemSettings.outletId, input.outletId),
          eq(prepItemSettings.inventoryItemId, input.inventoryItemId),
        ),
      )
      .limit(1);
    if (!setting)
      throw new HttpError(
        422,
        "PREP_SHELF_LIFE_REQUIRED",
        "Atur masa simpan bahan prep di outlet ini sebelum membuat label.",
      );
    const calculatedUseBy = calculatePrepUseBy(
      input.producedAt,
      setting.shelfLifeMinutes,
    );
    if (
      calculatedUseBy === null ||
      (input.useBy !== undefined &&
        Date.parse(input.useBy) !== Date.parse(calculatedUseBy))
    )
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Batas pakai harus sesuai waktu produksi dan masa simpan bahan prep.",
      );
    const producedAt = new Date(input.producedAt);
    const useBy = new Date(calculatedUseBy);

    const [row] = await tx
      .insert(prepLabels)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        inventoryItemId: input.inventoryItemId,
        batchId: input.batchId,
        producedAt,
        useBy,
        producedBy: actor,
        printedAt: null,
      })
      .returning();
    if (!row)
      throw new HttpError(500, "INTERNAL_ERROR", "Label prep gagal disimpan.");
    const label = toPrepLabel(row);

    await storeIdempotentResult(tx, context, {
      key: idempotencyKey,
      fingerprint,
      outletId: input.outletId,
      resultTable: PREP_LABEL_RESULT_TABLE,
      resultId: label.id,
    });
    return label;
  });
}

/**
 * Marks the label printed once; a repeat print returns the stored row and
 * never moves `printed_at`, so the print agent can retry safely. The print
 * agent job itself belongs to legend-46p; this endpoint only records it.
 */
export async function printPrepLabel(
  context: ScopedTenantContext,
  actorUserId: string,
  labelId: string,
  input: PrintPrepLabelInput,
  now: Date = new Date(),
): Promise<PrepLabel> {
  // Print is naturally idempotent (printed_at is set once); the client key is
  // accepted for symmetry with the other operations writes but not stored.
  void input;
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const [locked] = await tx
      .select()
      .from(prepLabels)
      .where(
        and(
          eq(prepLabels.tenantId, context.tenant.tenantId),
          eq(prepLabels.id, labelId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked)
      throw new CoreError("NOT_FOUND", "Label prep tidak ditemukan.");
    await assertOutletPermission(
      tx,
      context,
      actor,
      PREP_PERMISSION,
      locked.outletId,
      now,
    );
    if (locked.printedAt !== null) return toPrepLabel(locked);
    const [row] = await tx
      .update(prepLabels)
      .set({ printedAt: now })
      .where(
        and(
          eq(prepLabels.tenantId, context.tenant.tenantId),
          eq(prepLabels.id, labelId),
          isNull(prepLabels.printedAt),
        ),
      )
      .returning();
    if (!row)
      throw new HttpError(500, "INTERNAL_ERROR", "Label prep gagal dicetak.");
    return toPrepLabel(row);
  });
}

/**
 * OPS-03 expiry sweep, run by the worker inside a tenant transaction: locks up
 * to 200 expired, not-yet-alerted labels (`FOR UPDATE SKIP LOCKED`), stamps
 * `expiry_alerted_at` and emits `prep_label.expired` once per label. A second
 * run finds nothing, so retries never duplicate the alert. Returns the number
 * of labels alerted.
 */
export async function sweepExpiredPrepLabels(
  tx: OperationsTx,
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<number> {
  const filters: SQL[] = [
    eq(prepLabels.tenantId, context.tenant.tenantId),
    lte(prepLabels.useBy, now),
    isNull(prepLabels.expiryAlertedAt),
  ];
  if (context.outletScope.kind === "outlets")
    filters.push(
      inArray(prepLabels.outletId, [...context.outletScope.outletIds]),
    );
  const expired = await tx
    .select()
    .from(prepLabels)
    .where(and(...filters))
    .orderBy(asc(prepLabels.useBy))
    .limit(200)
    .for("update", { skipLocked: true });

  let alerted = 0;
  for (const row of expired) {
    const [updated] = await tx
      .update(prepLabels)
      .set({ expiryAlertedAt: now })
      .where(
        and(
          eq(prepLabels.tenantId, context.tenant.tenantId),
          eq(prepLabels.id, row.id),
          isNull(prepLabels.expiryAlertedAt),
        ),
      )
      .returning({ id: prepLabels.id });
    if (!updated) continue;
    await emitOperationsEvent(tx, context, prepLabelExpiredEvent, {
      aggregateId: row.id,
      outletId: row.outletId,
      actor: { type: "system" },
      payload: {
        prepLabelId: row.id,
        inventoryItemId: row.inventoryItemId,
        batchId: row.batchId,
        useBy: row.useBy.toISOString(),
        detectedAt: now.toISOString(),
      },
      now,
    });
    alerted += 1;
  }
  return alerted;
}

// ---------------------------------------------------------- prep lists

/**
 * Lines grouped by list, ordered by inventory item name then id (PRD §3 F45:
 * the kitchen reads the list by ingredient). Each line is parsed by the
 * contract schema so the branded ids survive the DB round trip.
 */
async function loadPrepListLines(
  tx: OperationsTx,
  tenantId: TenantId,
  prepListIds: readonly string[],
): Promise<Map<string, PrepListLine[]>> {
  const lines = new Map<string, PrepListLine[]>();
  if (prepListIds.length === 0) return lines;
  const rows = await tx
    .select({
      prepListId: prepListItems.prepListId,
      id: prepListItems.id,
      inventoryItemId: prepListItems.inventoryItemId,
      plannedQuantity: prepListItems.plannedQuantity,
      productionOrderId: prepListItems.productionOrderId,
    })
    .from(prepListItems)
    .leftJoin(
      inventoryItems,
      and(
        eq(inventoryItems.tenantId, tenantId),
        eq(inventoryItems.id, prepListItems.inventoryItemId),
      ),
    )
    .where(
      and(
        eq(prepListItems.tenantId, tenantId),
        inArray(prepListItems.prepListId, [...prepListIds]),
      ),
    )
    .orderBy(asc(inventoryItems.name), asc(prepListItems.id));
  for (const row of rows) {
    const line = prepListLineSchema.parse({
      id: row.id,
      inventoryItemId: row.inventoryItemId,
      plannedQuantity: row.plannedQuantity,
      productionOrderId: row.productionOrderId,
    });
    const bucket = lines.get(row.prepListId);
    if (bucket) bucket.push(line);
    else lines.set(row.prepListId, [line]);
  }
  return lines;
}

async function loadPrepList(
  tx: OperationsTx,
  context: ScopedTenantContext,
  prepListId: string,
): Promise<PrepList> {
  const [row] = await tx
    .select()
    .from(prepLists)
    .where(
      and(
        eq(prepLists.tenantId, context.tenant.tenantId),
        eq(prepLists.id, prepListId),
      ),
    )
    .limit(1);
  if (!row) throw new CoreError("NOT_FOUND", "Daftar prep tidak ditemukan.");
  const lines = await loadPrepListLines(tx, context.tenant.tenantId, [row.id]);
  return toPrepList(row, lines.get(row.id) ?? []);
}

/** Newest business date first, optionally filtered by date and status. */
export async function listPrepLists(
  context: ScopedTenantContext,
  query: PrepListQuery,
): Promise<CursorPage<PrepList>> {
  assertOutletInScope(context.outletScope, query.outletId);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(prepLists.tenantId, context.tenant.tenantId),
      eq(prepLists.outletId, query.outletId),
    ];
    if (query.prepDate) filters.push(eq(prepLists.prepDate, query.prepDate));
    if (query.status) filters.push(eq(prepLists.status, query.status));
    const [prepDate, id] = cursorKeys(query.cursor, 2);
    if (prepDate !== undefined && id !== undefined) {
      if (!businessDateSchema.safeParse(prepDate).success)
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          lt(prepLists.prepDate, prepDate),
          and(
            eq(prepLists.prepDate, prepDate),
            sql`${prepLists.id} < ${id}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(prepLists)
      .where(and(...filters))
      .orderBy(desc(prepLists.prepDate), desc(prepLists.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const lines = await loadPrepListLines(
      tx,
      context.tenant.tenantId,
      page.map((row) => row.id),
    );
    return {
      data: page.map((row) => toPrepList(row, lines.get(row.id) ?? [])),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.prepDate, last.id])
            : null,
      },
    };
  });
}

export async function getPrepList(
  context: ScopedTenantContext,
  prepListId: string,
): Promise<PrepList> {
  return withTenant(db, context, (tx) => loadPrepList(tx, context, prepListId));
}

/**
 * Creates the daily list and its lines in one transaction (AI-07 forecast id
 * optional until WS-12 lands). Duplicate items and unknown items are 422; a
 * second list for the same outlet and date is CONFLICT.
 */
export async function createPrepList(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePrepListInput,
  now: Date = new Date(),
): Promise<PrepList> {
  assertOutletInScope(context.outletScope, input.outletId);
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      actor,
      PREP_PERMISSION,
      input.outletId,
      now,
    );
    const { idempotencyKey, ...body } = input;
    const fingerprint = operationsFingerprint(body);
    const replayed = await readIdempotentResult(
      tx,
      context,
      idempotencyKey,
      fingerprint,
      PREP_LIST_RESULT_TABLE,
    );
    if (replayed) return loadPrepList(tx, context, replayed);

    const itemIds = input.lines.map((line) => line.inventoryItemId);
    if (new Set(itemIds).size !== itemIds.length)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Satu baris per item inventori.",
      );
    const known = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.tenantId, context.tenant.tenantId),
          inArray(inventoryItems.id, itemIds),
        ),
      );
    if (known.length !== itemIds.length)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Item inventori tidak ditemukan.",
      );

    const prepListId = await (async () => {
      try {
        const [list] = await tx
          .insert(prepLists)
          .values({
            tenantId: context.tenant.tenantId,
            outletId: input.outletId,
            prepDate: input.prepDate,
            status: "pending",
            generatedFromForecastId: input.generatedFromForecastId ?? null,
            generatedAt: now,
          })
          .returning({ id: prepLists.id });
        if (!list)
          throw new HttpError(
            500,
            "INTERNAL_ERROR",
            "Daftar prep gagal disimpan.",
          );
        return list.id;
      } catch (error) {
        if (pgErrorCode(error) === "23505")
          throw new CoreError(
            "CONFLICT",
            "Daftar prep untuk tanggal ini sudah ada.",
          );
        throw error;
      }
    })();

    await tx.insert(prepListItems).values(
      input.lines.map((line) => ({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        prepListId,
        inventoryItemId: line.inventoryItemId,
        plannedQuantity: line.plannedQuantity,
      })),
    );

    const created = await loadPrepList(tx, context, prepListId);
    await storeIdempotentResult(tx, context, {
      key: idempotencyKey,
      fingerprint,
      outletId: input.outletId,
      resultTable: PREP_LIST_RESULT_TABLE,
      resultId: prepListId,
    });
    return created;
  });
}

/**
 * Moves the list through the contract machine. Completing it hands the lines
 * to the WS-06 production port (no-op until legend-ugo), so the status change
 * and the production orders commit together.
 */
export async function transitionPrepList(
  context: ScopedTenantContext,
  actorUserId: string,
  prepListId: string,
  input: TransitionPrepListInput,
  now: Date = new Date(),
): Promise<PrepList> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const [locked] = await tx
      .select()
      .from(prepLists)
      .where(
        and(
          eq(prepLists.tenantId, context.tenant.tenantId),
          eq(prepLists.id, prepListId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked)
      throw new CoreError("NOT_FOUND", "Daftar prep tidak ditemukan.");
    await assertOutletPermission(
      tx,
      context,
      actor,
      PREP_PERMISSION,
      locked.outletId,
      now,
    );
    // A retried transition (lost response) must replay, not answer
    // PREP_LIST_TRANSITION_INVALID because the first attempt already moved
    // the list. The key binds to (list, action) only.
    const { idempotencyKey, action } = input;
    const fingerprint = operationsFingerprint({ prepListId, action });
    const replayed = await readIdempotentResult(
      tx,
      context,
      idempotencyKey,
      fingerprint,
      PREP_LIST_TRANSITION_RESULT_TABLE,
    );
    if (replayed) return loadPrepList(tx, context, replayed);
    const status = transitionPrepListMachine(locked.status, action);
    const [row] = await tx
      .update(prepLists)
      .set({ status, updatedAt: now })
      .where(
        and(
          eq(prepLists.tenantId, context.tenant.tenantId),
          eq(prepLists.id, prepListId),
        ),
      )
      .returning();
    if (!row)
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        "Daftar prep gagal diperbarui.",
      );
    if (status === "completed")
      await linkProductionOrdersForPrepList(tx, context, row.id, now);
    await storeIdempotentResult(tx, context, {
      key: idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: PREP_LIST_TRANSITION_RESULT_TABLE,
      resultId: row.id,
    });
    return loadPrepList(tx, context, row.id);
  });
}
