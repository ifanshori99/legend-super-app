// Equipment registry, maintenance schedules/tickets and shift handovers
// (PRD v1.7 §3 F41 "Peralatan & Perawatan", §6 L; bead legend-i57s, WS-14).
// Routes: routes/operations-equipment.routes.ts.
//
// Rules that live here, not in the routes:
// - every query runs inside `withTenant`, so Postgres RLS scopes rows to the
//   tenant and the caller's outlets (TEN-01..03); the permission is re-checked
//   on the concrete outlet inside the same transaction;
// - equipment state changes only through the contract machine
//   `transitionEquipment` and maintenance tickets through
//   `transitionMaintenanceTicket`; a handover is acknowledged through
//   `acknowledgeShiftHandover`, which refuses self-acknowledgement (OPS-05);
// - OPS-04: a breakdown ticket that marks equipment broken writes the mapped
//   menu items sold out in the same transaction through
//   `syncEquipmentAvailability` and emits `equipment.broken`, so both the
//   write and the event commit or roll back together;
// - creates and transitions bind their idempotency key to the request
//   fingerprint and to the document they created (D-CORE-5), so a replay
//   returns the same row and a reused key is a 409;
// - a resolved ticket does NOT repair the equipment: repair is the equipment
//   `complete_maintenance` transition, which is what restores menu items.
//
// The contract has no HTTP statuses for unexpected failures; expected
// OperationsError codes carry their declared status, so they are translated to
// HttpError at this boundary (docs/backend.md, "expected failures").

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  decodeCursor,
  encodeCursor,
  idr,
  userIdSchema,
  type CursorPage,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  acknowledgeShiftHandover,
  assertMaintenanceTicketHasPhoto,
  createEquipmentInputSchema,
  createMaintenanceScheduleInputSchema,
  createMaintenanceTicketInputSchema,
  createShiftHandoverInputSchema,
  equipmentListQuerySchema,
  equipmentSchema,
  maintenanceScheduleListQuerySchema,
  maintenanceScheduleSchema,
  maintenanceTicketListQuerySchema,
  maintenanceTicketSchema,
  operationsEvents,
  shiftHandoverListQuerySchema,
  shiftHandoverSchema,
  transitionEquipment,
  transitionEquipmentInputSchema,
  transitionMaintenanceTicket,
  transitionMaintenanceTicketInputSchema,
  updateEquipmentInputSchema,
  OperationsError,
  type Equipment,
  type EquipmentStatus,
  type MaintenanceSchedule,
  type MaintenanceTicket,
  type OperationsErrorCode,
  type ShiftHandover,
} from "@starter/shared/operations";
import type { z } from "zod";
import { menuItems } from "../db/schema/menu.ts";
import {
  equipment,
  maintenanceSchedules,
  maintenanceTickets,
  shiftHandovers,
} from "../db/schema/operations.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertOutletPermission } from "./menu-internals.ts";
import { syncEquipmentAvailability } from "./operations-availability.service.ts";
import { emitOperationsEvent } from "./operations-events.ts";
import {
  operationsFingerprint,
  readIdempotentResult,
  storeIdempotentResult,
  type OperationsTx,
} from "./operations-idempotency.ts";

type CreateEquipmentInput = z.infer<typeof createEquipmentInputSchema>;
type UpdateEquipmentInput = z.infer<typeof updateEquipmentInputSchema>;
type EquipmentTransitionInput = z.infer<typeof transitionEquipmentInputSchema>;
type CreateMaintenanceScheduleInput = z.infer<
  typeof createMaintenanceScheduleInputSchema
>;
type CreateMaintenanceTicketInput = z.infer<
  typeof createMaintenanceTicketInputSchema
>;
type MaintenanceTicketTransitionInput = z.infer<
  typeof transitionMaintenanceTicketInputSchema
>;
type CreateShiftHandoverInput = z.infer<typeof createShiftHandoverInputSchema>;

type EquipmentListQuery = z.infer<typeof equipmentListQuerySchema>;
type MaintenanceScheduleListQuery = z.infer<
  typeof maintenanceScheduleListQuerySchema
>;
type MaintenanceTicketListQuery = z.infer<
  typeof maintenanceTicketListQuerySchema
>;
type ShiftHandoverListQuery = z.infer<typeof shiftHandoverListQuerySchema>;

/** PRD §3 F41: the equipment registry and its maintenance work. */
const EQUIPMENT_PERMISSION = "ops.equipment.maintain" as const;
/** PRD §3 F45: recording a shift handover. */
const HANDOVER_PERMISSION = "ops.handover.record" as const;

const NOT_FOUND_EQUIPMENT = "Peralatan tidak ditemukan.";
const NOT_FOUND_TICKET = "Tiket perawatan tidak ditemukan.";
const NOT_FOUND_SCHEDULE = "Jadwal perawatan tidak ditemukan.";
const NOT_FOUND_HANDOVER = "Serah terima shift tidak ditemukan.";
const OUTLET_NOT_FOUND = "Outlet tidak ditemukan.";

type EquipmentRow = typeof equipment.$inferSelect;
type MaintenanceScheduleRow = typeof maintenanceSchedules.$inferSelect;
type MaintenanceTicketRow = typeof maintenanceTickets.$inferSelect;
type ShiftHandoverRow = typeof shiftHandovers.$inferSelect;

// ------------------------------------------------------------------ errors

/**
 * Expected OperationsError carries the contract's HTTP status (OPS-04/OPS-05
 * codes); HttpError is what the API error handler renders. Zod and database
 * failures are left alone.
 */
function contract<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof OperationsError)
      throw new HttpError(error.status, error.code, error.message);
    throw error;
  }
}

/** A contract failure raised by the service itself (not by a machine call). */
function operationsFailure(code: OperationsErrorCode): never {
  const error = new OperationsError(code);
  throw new HttpError(error.status, error.code, error.message);
}

function validationError(message: string): never {
  throw new HttpError(422, "VALIDATION_ERROR", message);
}

// -------------------------------------------------------------- request keys

/**
 * Fingerprint of the client payload (the idempotency key itself excluded), so
 * a replay of the same body is a no-op and a reused key with another body is
 * IDEMPOTENCY_KEY_REUSED (D-CORE-5). A transition/update also binds the target
 * row id, so the same key cannot replay one row's result onto another row.
 */
function requestFingerprint(
  input: { idempotencyKey: string },
  targetId?: string,
): string {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input))
    if (key !== "idempotencyKey") payload[key] = value;
  if (targetId !== undefined) payload.targetId = targetId;
  return operationsFingerprint(payload);
}

// ---------------------------------------------------------------- cursors

/** A cursor this endpoint did not issue is client input, never a 500. */
function cursorKeys(cursor: string | undefined, size: number): string[] {
  if (!cursor) return [];
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    return validationError("Cursor tidak valid.");
  }
  if (keys.length !== size || keys.some((key) => typeof key !== "string"))
    return validationError("Cursor tidak valid.");
  return keys as string[];
}

/** Instant key of a timestamp-ordered cursor; a tampered value is a 422. */
function cursorInstant(value: string): Date {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()))
    return validationError("Cursor tidak valid.");
  return instant;
}

// ------------------------------------------------------------------ mappers

function toEquipment(row: EquipmentRow): Equipment {
  return equipmentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    category: row.category,
    assetId: row.assetId,
    linkedMenuItemIds: row.linkedMenuItemIds,
    status: row.status,
    temperatureThreshold: row.temperatureThreshold,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toMaintenanceSchedule(
  row: MaintenanceScheduleRow,
): MaintenanceSchedule {
  return maintenanceScheduleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    equipmentId: row.equipmentId,
    intervalDays: row.intervalDays,
    nextDueAt: row.nextDueAt.toISOString(),
    vendorId: row.vendorId,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toMaintenanceTicket(row: MaintenanceTicketRow): MaintenanceTicket {
  return maintenanceTicketSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    equipmentId: row.equipmentId,
    reportedBy: row.reportedBy,
    urgency: row.urgency,
    description: row.description,
    mediaIds: row.mediaIds,
    vendorId: row.vendorId,
    costIdr: row.costIdr,
    status: row.status,
    marksEquipmentBroken: row.marksEquipmentBroken,
    reportedAt: row.reportedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  });
}

function toShiftHandover(row: ShiftHandoverRow): ShiftHandover {
  return shiftHandoverSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    fromShiftTemplateId: row.fromShiftTemplateId,
    toShiftTemplateId: row.toShiftTemplateId,
    notes: row.notes,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt.toISOString(),
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    status: row.status,
  });
}

// ------------------------------------------------------------------ guards

/** TEN-03: a requested outlet must be inside the caller's scope, and exist. */
async function outletBrandId(
  tx: OperationsTx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<string> {
  assertOutletInScope(context.outletScope, outletId);
  const [row] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", OUTLET_NOT_FOUND);
  return row.brandId;
}

/**
 * OPS-04 mapping integrity: every linked id must be a live menu item of the
 * outlet's brand. `menu_items` is brand-owned, so the outlet check goes
 * through the outlet's brand rather than a menu_items outlet column.
 */
async function assertLinkedMenuItems(
  tx: OperationsTx,
  context: ScopedTenantContext,
  brandId: string,
  linkedMenuItemIds: readonly string[],
): Promise<void> {
  if (linkedMenuItemIds.length === 0) return;
  const ids = [...new Set(linkedMenuItemIds)];
  const rows = await tx
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, context.tenant.tenantId),
        eq(menuItems.brandId, brandId),
        inArray(menuItems.id, ids),
        isNull(menuItems.deletedAt),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  if (ids.some((id) => !found.has(id)))
    return validationError(
      "Menu yang ditautkan tidak ditemukan di outlet ini.",
    );
}

// ----------------------------------------------------------------- replay

async function replayEquipment(
  tx: OperationsTx,
  context: ScopedTenantContext,
  key: string,
  fingerprint: string,
): Promise<Equipment | null> {
  const resultId = await readIdempotentResult(
    tx,
    context,
    key,
    fingerprint,
    "equipment",
  );
  if (!resultId) return null;
  const [row] = await tx
    .select()
    .from(equipment)
    .where(
      and(
        eq(equipment.tenantId, context.tenant.tenantId),
        eq(equipment.id, resultId),
      ),
    )
    .limit(1);
  if (!row) throw new CoreError("NOT_FOUND", NOT_FOUND_EQUIPMENT);
  return toEquipment(row);
}

async function replayMaintenanceSchedule(
  tx: OperationsTx,
  context: ScopedTenantContext,
  key: string,
  fingerprint: string,
): Promise<MaintenanceSchedule | null> {
  const resultId = await readIdempotentResult(
    tx,
    context,
    key,
    fingerprint,
    "maintenance_schedule",
  );
  if (!resultId) return null;
  const [row] = await tx
    .select()
    .from(maintenanceSchedules)
    .where(
      and(
        eq(maintenanceSchedules.tenantId, context.tenant.tenantId),
        eq(maintenanceSchedules.id, resultId),
      ),
    )
    .limit(1);
  if (!row) throw new CoreError("NOT_FOUND", NOT_FOUND_SCHEDULE);
  return toMaintenanceSchedule(row);
}

async function replayMaintenanceTicket(
  tx: OperationsTx,
  context: ScopedTenantContext,
  key: string,
  fingerprint: string,
): Promise<MaintenanceTicket | null> {
  const resultId = await readIdempotentResult(
    tx,
    context,
    key,
    fingerprint,
    "maintenance_ticket",
  );
  if (!resultId) return null;
  const [row] = await tx
    .select()
    .from(maintenanceTickets)
    .where(
      and(
        eq(maintenanceTickets.tenantId, context.tenant.tenantId),
        eq(maintenanceTickets.id, resultId),
      ),
    )
    .limit(1);
  if (!row) throw new CoreError("NOT_FOUND", NOT_FOUND_TICKET);
  return toMaintenanceTicket(row);
}

async function replayShiftHandover(
  tx: OperationsTx,
  context: ScopedTenantContext,
  key: string,
  fingerprint: string,
): Promise<ShiftHandover | null> {
  const resultId = await readIdempotentResult(
    tx,
    context,
    key,
    fingerprint,
    "shift_handover",
  );
  if (!resultId) return null;
  const [row] = await tx
    .select()
    .from(shiftHandovers)
    .where(
      and(
        eq(shiftHandovers.tenantId, context.tenant.tenantId),
        eq(shiftHandovers.id, resultId),
      ),
    )
    .limit(1);
  if (!row) throw new CoreError("NOT_FOUND", NOT_FOUND_HANDOVER);
  return toShiftHandover(row);
}

// -------------------------------------------------------------- equipment

export async function listEquipment(
  context: ScopedTenantContext,
  actorUserId: string,
  query: EquipmentListQuery,
): Promise<CursorPage<Equipment>> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    assertOutletInScope(context.outletScope, query.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      query.outletId,
      now,
    );
    const filters: SQL[] = [
      eq(equipment.tenantId, context.tenant.tenantId),
      eq(equipment.outletId, query.outletId),
    ];
    if (query.category) filters.push(eq(equipment.category, query.category));
    if (query.status) filters.push(eq(equipment.status, query.status));
    const [name, id] = cursorKeys(query.cursor, 2);
    if (name !== undefined && id !== undefined) {
      const keyset = or(
        gt(equipment.name, name),
        and(eq(equipment.name, name), gt(equipment.id, id)),
      );
      if (keyset) filters.push(keyset);
    }
    const rows = await tx
      .select()
      .from(equipment)
      .where(and(...filters))
      .orderBy(asc(equipment.name), asc(equipment.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toEquipment),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

export async function getEquipment(
  context: ScopedTenantContext,
  actorUserId: string,
  equipmentId: string,
): Promise<Equipment> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(equipment)
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.id, equipmentId),
        ),
      )
      .limit(1);
    // RLS already hid another outlet's row; this also hides a wrong tenant id.
    if (!row) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_EQUIPMENT);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      row.outletId,
      new Date(),
    );
    return toEquipment(row);
  });
}

export async function createEquipment(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateEquipmentInput,
): Promise<Equipment> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    assertOutletInScope(context.outletScope, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      input.outletId,
      now,
    );
    const replay = await replayEquipment(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const brandId = await outletBrandId(tx, context, input.outletId);
    await assertLinkedMenuItems(
      tx,
      context,
      brandId,
      input.linkedMenuItemIds ?? [],
    );
    const [row] = await tx
      .insert(equipment)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        name: input.name,
        category: input.category,
        assetId: input.assetId ?? null,
        linkedMenuItemIds: input.linkedMenuItemIds ?? [],
        // PRD §3 F41: a new asset starts sellable in the registry.
        status: "operational",
        temperatureThreshold: input.temperatureThreshold ?? null,
      })
      .returning();
    if (!row) throw new Error("Peralatan gagal disimpan.");
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: "equipment",
      resultId: row.id,
    });
    return toEquipment(row);
  });
}

export async function updateEquipment(
  context: ScopedTenantContext,
  actorUserId: string,
  equipmentId: string,
  input: UpdateEquipmentInput,
): Promise<Equipment> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input, equipmentId);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    const [locked] = await tx
      .select()
      .from(equipment)
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.id, equipmentId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_EQUIPMENT);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      locked.outletId,
      now,
    );
    const replay = await replayEquipment(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    // Optimistic concurrency (contract `expectedUpdatedAt`).
    if (locked.updatedAt.toISOString() !== input.expectedUpdatedAt)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Peralatan berubah sejak dibaca; muat ulang lalu coba lagi.",
      );
    if (input.linkedMenuItemIds !== undefined) {
      const brandId = await outletBrandId(tx, context, locked.outletId);
      await assertLinkedMenuItems(
        tx,
        context,
        brandId,
        input.linkedMenuItemIds,
      );
    }
    const [row] = await tx
      .update(equipment)
      .set({
        name: input.name ?? locked.name,
        category: input.category ?? locked.category,
        assetId: input.assetId === undefined ? locked.assetId : input.assetId,
        linkedMenuItemIds: input.linkedMenuItemIds ?? locked.linkedMenuItemIds,
        temperatureThreshold:
          input.temperatureThreshold === undefined
            ? locked.temperatureThreshold
            : input.temperatureThreshold,
        updatedAt: now,
      })
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.id, equipmentId),
        ),
      )
      .returning();
    if (!row) throw new Error("Peralatan gagal diperbarui.");
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: "equipment",
      resultId: row.id,
    });
    return toEquipment(row);
  });
}

/**
 * OPS-04: a transition writes the equipment status and, in the same
 * transaction, the sold-out/restore write-through of the linked menu items.
 * The availability helper maintains `disabled_item_ids`, so the row is re-read
 * before it is returned and before the idempotency result is stored.
 */
export async function postEquipmentTransition(
  context: ScopedTenantContext,
  actorUserId: string,
  equipmentId: string,
  input: EquipmentTransitionInput,
): Promise<Equipment> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input, equipmentId);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    const [locked] = await tx
      .select()
      .from(equipment)
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.id, equipmentId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_EQUIPMENT);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      locked.outletId,
      now,
    );
    const replay = await replayEquipment(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const previousStatus: EquipmentStatus = locked.status;
    const next = contract(() =>
      transitionEquipment(locked.status, input.action),
    );
    const [updated] = await tx
      .update(equipment)
      .set({ status: next, updatedAt: now })
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.id, equipmentId),
        ),
      )
      .returning();
    if (!updated) throw new Error("Peralatan gagal diperbarui.");
    await syncEquipmentAvailability(
      tx,
      context,
      actor,
      {
        id: updated.id,
        outletId: updated.outletId,
        name: updated.name,
        status: updated.status,
        linkedMenuItemIds: updated.linkedMenuItemIds,
        disabledItemIds: updated.disabledItemIds,
      },
      previousStatus,
      now,
    );
    const [row] = await tx
      .select()
      .from(equipment)
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.id, equipmentId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Peralatan hilang setelah transisi.");
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: "equipment",
      resultId: row.id,
    });
    return toEquipment(row);
  });
}

// ----------------------------------------------------- maintenance schedules

export async function listMaintenanceSchedules(
  context: ScopedTenantContext,
  actorUserId: string,
  query: MaintenanceScheduleListQuery,
): Promise<CursorPage<MaintenanceSchedule>> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, query.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      query.outletId,
      new Date(),
    );
    const filters: SQL[] = [
      eq(maintenanceSchedules.tenantId, context.tenant.tenantId),
      eq(maintenanceSchedules.outletId, query.outletId),
    ];
    if (query.equipmentId)
      filters.push(eq(maintenanceSchedules.equipmentId, query.equipmentId));
    if (query.dueBefore)
      filters.push(
        lte(maintenanceSchedules.nextDueAt, new Date(query.dueBefore)),
      );
    const [dueAt, id] = cursorKeys(query.cursor, 2);
    if (dueAt !== undefined && id !== undefined) {
      const instant = cursorInstant(dueAt);
      const keyset = or(
        gt(maintenanceSchedules.nextDueAt, instant),
        and(
          eq(maintenanceSchedules.nextDueAt, instant),
          gt(maintenanceSchedules.id, id),
        ),
      );
      if (keyset) filters.push(keyset);
    }
    const rows = await tx
      .select()
      .from(maintenanceSchedules)
      .where(and(...filters))
      .orderBy(
        asc(maintenanceSchedules.nextDueAt),
        asc(maintenanceSchedules.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toMaintenanceSchedule),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.nextDueAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function createMaintenanceSchedule(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateMaintenanceScheduleInput,
): Promise<MaintenanceSchedule> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    assertOutletInScope(context.outletScope, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      input.outletId,
      now,
    );
    const replay = await replayMaintenanceSchedule(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const [asset] = await tx
      .select({ id: equipment.id })
      .from(equipment)
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.outletId, input.outletId),
          eq(equipment.id, input.equipmentId),
        ),
      )
      .limit(1);
    if (!asset) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_EQUIPMENT);
    const [row] = await tx
      .insert(maintenanceSchedules)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        equipmentId: input.equipmentId,
        intervalDays: input.intervalDays,
        nextDueAt: new Date(input.nextDueAt),
        vendorId: input.vendorId ?? null,
      })
      .returning();
    if (!row) throw new Error("Jadwal perawatan gagal disimpan.");
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: "maintenance_schedule",
      resultId: row.id,
    });
    return toMaintenanceSchedule(row);
  });
}

// ------------------------------------------------------ maintenance tickets

export async function listMaintenanceTickets(
  context: ScopedTenantContext,
  actorUserId: string,
  query: MaintenanceTicketListQuery,
): Promise<CursorPage<MaintenanceTicket>> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, query.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      query.outletId,
      new Date(),
    );
    const filters: SQL[] = [
      eq(maintenanceTickets.tenantId, context.tenant.tenantId),
      eq(maintenanceTickets.outletId, query.outletId),
    ];
    if (query.equipmentId)
      filters.push(eq(maintenanceTickets.equipmentId, query.equipmentId));
    if (query.status) filters.push(eq(maintenanceTickets.status, query.status));
    if (query.urgency)
      filters.push(eq(maintenanceTickets.urgency, query.urgency));
    const [reportedAt, id] = cursorKeys(query.cursor, 2);
    if (reportedAt !== undefined && id !== undefined) {
      const instant = cursorInstant(reportedAt);
      const keyset = or(
        lt(maintenanceTickets.reportedAt, instant),
        and(
          eq(maintenanceTickets.reportedAt, instant),
          lt(maintenanceTickets.id, id),
        ),
      );
      if (keyset) filters.push(keyset);
    }
    const rows = await tx
      .select()
      .from(maintenanceTickets)
      .where(and(...filters))
      .orderBy(desc(maintenanceTickets.reportedAt), desc(maintenanceTickets.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toMaintenanceTicket),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.reportedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function getMaintenanceTicket(
  context: ScopedTenantContext,
  actorUserId: string,
  ticketId: string,
): Promise<MaintenanceTicket> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(maintenanceTickets)
      .where(
        and(
          eq(maintenanceTickets.tenantId, context.tenant.tenantId),
          eq(maintenanceTickets.id, ticketId),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_TICKET);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      row.outletId,
      new Date(),
    );
    return toMaintenanceTicket(row);
  });
}

/**
 * PRD §3 F45: a breakdown ticket carries a photo, urgency and description.
 * OPS-04: when it marks the equipment broken, the equipment row and the
 * mapped menu items change in this same transaction and `equipment.broken`
 * tells consumers the mapping without another read.
 */
export async function createMaintenanceTicket(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateMaintenanceTicketInput,
): Promise<MaintenanceTicket> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    assertOutletInScope(context.outletScope, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      input.outletId,
      now,
    );
    const replay = await replayMaintenanceTicket(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    // The input schema already requires one photo; the contract gate keeps a
    // direct service caller (worker, test double) honest too.
    contract(() => assertMaintenanceTicketHasPhoto(input.mediaIds));
    const [locked] = await tx
      .select()
      .from(equipment)
      .where(
        and(
          eq(equipment.tenantId, context.tenant.tenantId),
          eq(equipment.outletId, input.outletId),
          eq(equipment.id, input.equipmentId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_EQUIPMENT);

    const [ticket] = await tx
      .insert(maintenanceTickets)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        equipmentId: input.equipmentId,
        reportedBy: actor,
        urgency: input.urgency,
        description: input.description,
        mediaIds: input.mediaIds,
        vendorId: input.vendorId ?? null,
        costIdr: input.costIdr == null ? null : idr(input.costIdr),
        status: "reported",
        marksEquipmentBroken: input.marksEquipmentBroken ?? false,
        reportedAt: now,
      })
      .returning();
    if (!ticket) throw new Error("Tiket perawatan gagal disimpan.");

    if (ticket.marksEquipmentBroken) {
      // A retired asset is terminal (contract equipment machine): a breakdown
      // cannot force it back into service, so the ticket is refused with the
      // machine's own code instead of storing an inconsistent pair.
      if (locked.status === "retired")
        operationsFailure("EQUIPMENT_TRANSITION_INVALID");
      const previousStatus: EquipmentStatus = locked.status;
      let broken: EquipmentRow = locked;
      if (locked.status !== "broken") {
        const [updated] = await tx
          .update(equipment)
          .set({ status: "broken", updatedAt: now })
          .where(
            and(
              eq(equipment.tenantId, context.tenant.tenantId),
              eq(equipment.id, locked.id),
            ),
          )
          .returning();
        if (!updated) throw new Error("Peralatan gagal diperbarui.");
        broken = updated;
      }
      await syncEquipmentAvailability(
        tx,
        context,
        actor,
        {
          id: broken.id,
          outletId: broken.outletId,
          name: broken.name,
          status: "broken",
          linkedMenuItemIds: broken.linkedMenuItemIds,
          disabledItemIds: broken.disabledItemIds,
        },
        previousStatus,
        now,
      );
      await emitOperationsEvent(
        tx,
        context,
        operationsEvents["equipment.broken"],
        {
          aggregateId: broken.id,
          outletId: broken.outletId,
          actor: { type: "user", id: actor },
          payload: {
            equipmentId: broken.id,
            ticketId: ticket.id,
            urgency: ticket.urgency,
            linkedMenuItemIds: broken.linkedMenuItemIds,
            reportedAt: ticket.reportedAt.toISOString(),
          },
          now,
        },
      );
    }

    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: ticket.outletId,
      resultTable: "maintenance_ticket",
      resultId: ticket.id,
    });
    return toMaintenanceTicket(ticket);
  });
}

/**
 * Resolving a ticket records the vendor and cost but does not flip the asset:
 * the repair is the equipment `complete_maintenance` transition, which is what
 * restores the menu items OPS-04 disabled.
 */
export async function postMaintenanceTicketTransition(
  context: ScopedTenantContext,
  actorUserId: string,
  ticketId: string,
  input: MaintenanceTicketTransitionInput,
): Promise<MaintenanceTicket> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input, ticketId);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    const [locked] = await tx
      .select()
      .from(maintenanceTickets)
      .where(
        and(
          eq(maintenanceTickets.tenantId, context.tenant.tenantId),
          eq(maintenanceTickets.id, ticketId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_TICKET);
    await assertOutletPermission(
      tx,
      context,
      actor,
      EQUIPMENT_PERMISSION,
      locked.outletId,
      now,
    );
    const replay = await replayMaintenanceTicket(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const next = contract(() =>
      transitionMaintenanceTicket(locked.status, input.action),
    );
    const resolved = next === "resolved";
    const costIdr: Idr | null = !resolved
      ? locked.costIdr
      : input.costIdr === undefined
        ? locked.costIdr
        : input.costIdr === null
          ? null
          : idr(input.costIdr);
    const [row] = await tx
      .update(maintenanceTickets)
      .set({
        status: next,
        resolvedAt: resolved ? now : locked.resolvedAt,
        vendorId: resolved
          ? input.vendorId === undefined
            ? locked.vendorId
            : input.vendorId
          : locked.vendorId,
        costIdr,
        updatedAt: now,
      })
      .where(
        and(
          eq(maintenanceTickets.tenantId, context.tenant.tenantId),
          eq(maintenanceTickets.id, ticketId),
        ),
      )
      .returning();
    if (!row) throw new Error("Tiket perawatan gagal diperbarui.");
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: "maintenance_ticket",
      resultId: row.id,
    });
    return toMaintenanceTicket(row);
  });
}

// ---------------------------------------------------------- shift handovers

export async function listShiftHandovers(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ShiftHandoverListQuery,
): Promise<CursorPage<ShiftHandover>> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, query.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      HANDOVER_PERMISSION,
      query.outletId,
      new Date(),
    );
    const filters: SQL[] = [
      eq(shiftHandovers.tenantId, context.tenant.tenantId),
      eq(shiftHandovers.outletId, query.outletId),
    ];
    if (query.status) filters.push(eq(shiftHandovers.status, query.status));
    const [submittedAt, id] = cursorKeys(query.cursor, 2);
    if (submittedAt !== undefined && id !== undefined) {
      const instant = cursorInstant(submittedAt);
      const keyset = or(
        lt(shiftHandovers.submittedAt, instant),
        and(eq(shiftHandovers.submittedAt, instant), lt(shiftHandovers.id, id)),
      );
      if (keyset) filters.push(keyset);
    }
    const rows = await tx
      .select()
      .from(shiftHandovers)
      .where(and(...filters))
      .orderBy(desc(shiftHandovers.submittedAt), desc(shiftHandovers.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toShiftHandover),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.submittedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function getShiftHandover(
  context: ScopedTenantContext,
  actorUserId: string,
  handoverId: string,
): Promise<ShiftHandover> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(shiftHandovers)
      .where(
        and(
          eq(shiftHandovers.tenantId, context.tenant.tenantId),
          eq(shiftHandovers.id, handoverId),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_HANDOVER);
    await assertOutletPermission(
      tx,
      context,
      actor,
      HANDOVER_PERMISSION,
      row.outletId,
      new Date(),
    );
    return toShiftHandover(row);
  });
}

/** PRD §3 F45 / OPS-05: submitted by the closing shift, confirmed by the next. */
export async function createShiftHandover(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateShiftHandoverInput,
): Promise<ShiftHandover> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    assertOutletInScope(context.outletScope, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actor,
      HANDOVER_PERMISSION,
      input.outletId,
      now,
    );
    const replay = await replayShiftHandover(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    // Shift templates are HRIS rows; this branch has no table for them yet
    // (WS-10 owns it), so the ids stay plain UUIDs like the contract.
    const [row] = await tx
      .insert(shiftHandovers)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        fromShiftTemplateId: input.fromShiftTemplateId,
        toShiftTemplateId: input.toShiftTemplateId,
        notes: input.notes,
        submittedBy: actor,
        submittedAt: now,
        status: "submitted",
      })
      .returning();
    if (!row) throw new Error("Serah terima shift gagal disimpan.");
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: "shift_handover",
      resultId: row.id,
    });
    return toShiftHandover(row);
  });
}

/**
 * OPS-05: the receiving shift confirms. The contract refuses a confirmation
 * by the submitting shift (403 HANDOVER_SELF_ACKNOWLEDGEMENT) and a second
 * acknowledgement (409 HANDOVER_ALREADY_ACKNOWLEDGED); until then the handover
 * cannot close (`assertShiftHandoverClosable`).
 */
export async function postShiftHandoverAcknowledgement(
  context: ScopedTenantContext,
  actorUserId: string,
  handoverId: string,
  input: { idempotencyKey: string },
): Promise<ShiftHandover> {
  const actor = userIdSchema.parse(actorUserId);
  const fingerprint = requestFingerprint(input, handoverId);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    const [locked] = await tx
      .select()
      .from(shiftHandovers)
      .where(
        and(
          eq(shiftHandovers.tenantId, context.tenant.tenantId),
          eq(shiftHandovers.id, handoverId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw new HttpError(404, "NOT_FOUND", NOT_FOUND_HANDOVER);
    await assertOutletPermission(
      tx,
      context,
      actor,
      HANDOVER_PERMISSION,
      locked.outletId,
      now,
    );
    const replay = await replayShiftHandover(
      tx,
      context,
      input.idempotencyKey,
      fingerprint,
    );
    if (replay) return replay;
    const acknowledged = contract(() =>
      acknowledgeShiftHandover(toShiftHandover(locked), {
        acknowledgedBy: actor,
        acknowledgedAt: now.toISOString(),
      }),
    );
    const [row] = await tx
      .update(shiftHandovers)
      .set({
        status: acknowledged.status,
        acknowledgedBy: acknowledged.acknowledgedBy,
        acknowledgedAt:
          acknowledged.acknowledgedAt === null
            ? null
            : new Date(acknowledged.acknowledgedAt),
        updatedAt: now,
      })
      .where(
        and(
          eq(shiftHandovers.tenantId, context.tenant.tenantId),
          eq(shiftHandovers.id, handoverId),
        ),
      )
      .returning();
    if (!row) throw new Error("Serah terima shift gagal diperbarui.");
    await storeIdempotentResult(tx, context, {
      key: input.idempotencyKey,
      fingerprint,
      outletId: row.outletId,
      resultTable: "shift_handover",
      resultId: row.id,
    });
    return toShiftHandover(row);
  });
}
