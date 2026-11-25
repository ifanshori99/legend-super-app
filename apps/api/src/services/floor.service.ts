// Floor zones, tables, layout and the signed permanent table QR (PRD v1.7
// §3 F9 "Denah & Meja": Zona, Meja, Papan Status; §6 C floor_zones/tables;
// contract `@starter/shared/qr-order` floor editor + table operations).
//
// Authorization arrives as the server-minted ScopedTenantContext: every
// function runs inside `withTenant` (RLS) and additionally filters by
// tenant/outlet and calls `assertOutletInScope`, so an outlet-scoped role
// cannot read or write another outlet (TEN-03). Tenant and outlet never come
// from the body (TEN-02); the route resolves the caller's outlet.
//
// Writes audit through the transactional append-only log (PRD §6 audit_logs).
// QR issuance never rotates a sticker: only rotateTableQr does, and it is
// audited (`table.qr_rotated`), so an old sticker stops resolving (ORD-04).

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  outletIdSchema,
  toIsoDateTime,
  z,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  createFloorZoneInputSchema,
  createTableInputSchema,
  floorBoardSchema,
  floorZoneSchema,
  qrTokenPayloadSchema,
  saveFloorLayoutInputSchema,
  tableLiveStatusSchema,
  tableQrSchema,
  tableSchema,
  tableSessionSummarySchema,
  updateFloorZoneInputSchema,
  updateTableInputSchema,
  type FloorBoard,
  type FloorZone,
  type Table,
  type TableQr,
} from "@starter/shared/qr-order";
import { env } from "../config/env";
import { db } from "../db";
import * as schema from "../db/schema";
import { linkGroupsForTables } from "./table-link.service";
import {
  brands,
  floorZones,
  outlets,
  serviceRequests,
  tableSessions,
  tables,
  zoneWaiterAssignments,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { sealSecret, openSecret } from "../lib/secrets";
import { recordAudit } from "./core-audit";
import { qrTokenHash, signTableQrToken } from "./qr-token";
import { qrOrderSettlementLookup } from "./qr-order.service";
import { lockTableLiveState } from "./table-session.service";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// isWfc may be left out by in-process callers; the route schema always sets it.
type CreateFloorZoneInput = Omit<
  z.infer<typeof createFloorZoneInputSchema>,
  "isWfc"
> & { isWfc?: boolean };
type UpdateFloorZoneInput = z.infer<typeof updateFloorZoneInputSchema>;
type CreateTableInput = z.infer<typeof createTableInputSchema>;
type UpdateTableInput = z.infer<typeof updateTableInputSchema>;
type SaveFloorLayoutInput = z.infer<typeof saveFloorLayoutInputSchema>;

const ACTIVE_SESSION_STATUSES = sql`${tableSessions.status} NOT IN ('closed', 'voided')`;

/** Scalars an audit row may keep; names and free text are always masked. */
const AUDIT_SAFE_FIELDS = [
  "id",
  "status",
  "paymentMode",
  "sortOrder",
  "capacity",
  "type",
  "zoneId",
  "tableId",
  "outletId",
  "serviceChargeBp",
  "minimumSpendIdr",
  "count",
  "tableIds",
] as const;

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

type ZoneRow = typeof floorZones.$inferSelect;
type TableRow = typeof tables.$inferSelect;

function toZone(row: ZoneRow): FloorZone {
  return floorZoneSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    paymentMode: row.paymentMode,
    serviceChargeBp: row.serviceChargeBp,
    minimumSpendIdr: row.minimumSpendIdr,
    hours: row.hours,
    status: row.status,
    sortOrder: row.sortOrder,
    isWfc: row.isWfc,
  });
}

function toTable(row: TableRow): Table {
  return tableSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    zoneId: row.zoneId,
    code: row.code,
    capacity: row.capacity,
    type: row.type,
    layout: row.layout,
    status: row.status,
  });
}

function qrSealAad(tenantId: string, tableId: string): string {
  return `table-qr:${tenantId}:${tableId}`;
}

function tableQrUrl(token: string): string {
  return `${env.WEB_URL.replace(/\/+$/, "")}/t/${token}`;
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorUserId: string;
    action: string;
    objectType: string;
    objectId: string | null;
    outletId: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: null,
      maskedChanges: {
        before: input.before ?? null,
        after: input.after ?? null,
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

async function zoneRow(tx: Tx, tenantId: TenantId, zoneId: string) {
  const [row] = await tx
    .select()
    .from(floorZones)
    .where(and(eq(floorZones.tenantId, tenantId), eq(floorZones.id, zoneId)));
  if (!row) throw new CoreError("NOT_FOUND", "Zona tidak ditemukan.");
  return row;
}

async function tableRow(
  tx: Tx,
  tenantId: TenantId,
  tableId: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(tables)
    .where(and(eq(tables.tenantId, tenantId), eq(tables.id, tableId)));
  const [row] = options.forUpdate ? await query.for("update") : await query;
  if (!row) throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
  return row;
}

async function hasOpenSession(tx: Tx, tenantId: TenantId, tableId: string) {
  const [row] = await tx
    .select({ id: tableSessions.id })
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.tableId, tableId),
        ACTIVE_SESSION_STATUSES,
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---- Reads ----------------------------------------------------------------

/**
 * Outlet ids of this tenant, oldest first. Used only to resolve which outlet
 * the caller's floor permission reaches (routes/floor-access.ts); the caller
 * must pass a tenant-wide context, so no outlet filter is applied here.
 */
export async function listTenantOutletIds(
  context: ScopedTenantContext,
): Promise<string[]> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(eq(outlets.tenantId, context.tenant.tenantId))
      .orderBy(asc(outlets.createdAt), asc(outlets.id));
    return rows.map((row) => row.id);
  });
}

/**
 * Zones, tables and the live session on each table for one outlet (PRD "Papan
 * Status", contract `floorBoardSchema`). The captain route supplies a
 * server-resolved waiter id to restrict the board to assigned zones. Bills
 * share the guest bill/close settlement rules, including captured POS money.
 */
export async function listFloorBoard(
  context: ScopedTenantContext,
  outletId: string,
  filters: { zoneId?: string; assignedWaiterId?: string } = {},
  now = new Date(),
): Promise<FloorBoard> {
  const outlet = outletIdSchema.parse(outletId);
  assertOutletInScope(context.outletScope, outlet);
  return withTenant(db, context, async (tx) => {
    const zoneRows = await tx
      .select()
      .from(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, context.tenant.tenantId),
          eq(floorZones.outletId, outlet),
          filters.zoneId ? eq(floorZones.id, filters.zoneId) : undefined,
          filters.assignedWaiterId
            ? inArray(
                floorZones.id,
                tx
                  .select({ zoneId: zoneWaiterAssignments.zoneId })
                  .from(zoneWaiterAssignments)
                  .where(
                    and(
                      eq(
                        zoneWaiterAssignments.tenantId,
                        context.tenant.tenantId,
                      ),
                      eq(zoneWaiterAssignments.outletId, outlet),
                      eq(
                        zoneWaiterAssignments.userId,
                        filters.assignedWaiterId,
                      ),
                    ),
                  ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(floorZones.sortOrder), asc(floorZones.id));
    const tableRows = await tx
      .select()
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.outletId, outlet),
          inArray(
            tables.zoneId,
            zoneRows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(asc(tables.code), asc(tables.id));
    if (tableRows.length === 0)
      return floorBoardSchema.parse({
        outletId: outlet,
        zones: zoneRows.map(toZone),
        tables: [],
        generatedAt: toIsoDateTime(now),
      });
    const tableIds = tableRows.map((row) => row.id);
    const sessionRows = await tx
      .select()
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, context.tenant.tenantId),
          eq(tableSessions.outletId, outlet),
          inArray(tableSessions.tableId, tableIds),
          ACTIVE_SESSION_STATUSES,
        ),
      );
    const sessionByTable = new Map(
      sessionRows.map((row) => [row.tableId, row]),
    );
    const settlements = new Map<
      string,
      Awaited<ReturnType<typeof qrOrderSettlementLookup>>
    >();
    for (const session of sessionRows)
      settlements.set(
        session.id,
        await qrOrderSettlementLookup({
          tx,
          tenantId: context.tenant.tenantId,
          sessionId: session.id,
        }),
      );
    const openCalls = await tx
      .select({
        tableId: serviceRequests.tableId,
        count: sql<number>`count(*)::int`,
      })
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.tenantId, context.tenant.tenantId),
          eq(serviceRequests.outletId, outlet),
          inArray(serviceRequests.tableId, tableIds),
          inArray(serviceRequests.status, ["pending", "acknowledged"]),
        ),
      )
      .groupBy(serviceRequests.tableId);
    const openCallCountByTable = new Map(
      openCalls.map((row) => [row.tableId, row.count]),
    );
    // Earliest live hold per table, time and party size only (no PII).
    const holdRows = await tx
      .select({
        tableId: schema.reservationTables.tableId,
        startsAt: schema.reservationTables.startsAt,
        endsAt: schema.reservationTables.endsAt,
        pax: schema.reservations.pax,
      })
      .from(schema.reservationTables)
      .innerJoin(
        schema.reservations,
        and(
          eq(schema.reservations.tenantId, schema.reservationTables.tenantId),
          eq(schema.reservations.id, schema.reservationTables.reservationId),
        ),
      )
      .where(
        and(
          eq(schema.reservationTables.tenantId, context.tenant.tenantId),
          eq(schema.reservationTables.outletId, outlet),
          inArray(schema.reservationTables.tableId, tableIds),
          isNull(schema.reservationTables.releasedAt),
          gt(schema.reservationTables.endsAt, now),
          inArray(schema.reservations.status, ["confirmed", "pending_deposit"]),
          isNull(schema.reservations.tableSessionId),
        ),
      )
      .orderBy(asc(schema.reservationTables.startsAt));
    const holdByTable = new Map<string, (typeof holdRows)[number]>();
    for (const row of holdRows)
      if (!holdByTable.has(row.tableId)) holdByTable.set(row.tableId, row);
    const linkGroups = await linkGroupsForTables(
      tx,
      context.tenant.tenantId,
      outlet,
    );
    return floorBoardSchema.parse({
      outletId: outlet,
      zones: zoneRows.map(toZone),
      tables: tableRows.map((row) => {
        const session = sessionByTable.get(row.id);
        const settlement = session ? settlements.get(session.id) : undefined;
        const linkGroup = linkGroups.get(row.id);
        const visibleMembers = linkGroup?.tableIds.filter((id) =>
          tableIds.includes(id),
        );
        return tableLiveStatusSchema.parse({
          table: toTable(row),
          session:
            session === undefined
              ? null
              : tableSessionSummarySchema.parse({
                  id: session.id,
                  status: session.status,
                  pax: session.pax,
                  paymentMode: session.paymentMode,
                  openedAt: session.openedAt.toISOString(),
                  lastActivityAt: session.lastActivityAt.toISOString(),
                  billTotalIdr: settlement?.billTotalIdr ?? 0,
                }),
          reservationHold: (() => {
            const hold = holdByTable.get(row.id);
            return hold
              ? {
                  startsAt: hold.startsAt.toISOString(),
                  endsAt: hold.endsAt.toISOString(),
                  pax: hold.pax,
                }
              : null;
          })(),
          openServiceRequestCount: openCallCountByTable.get(row.id) ?? 0,
          outstandingIdr: settlement
            ? Math.max(0, settlement.billTotalIdr - settlement.paidIdr)
            : 0,
          linkGroup:
            linkGroup && visibleMembers && visibleMembers.length >= 2
              ? { id: linkGroup.id, tableIds: visibleMembers }
              : null,
        });
      }),
      generatedAt: toIsoDateTime(now),
    });
  });
}

// ---- Zones ----------------------------------------------------------------

export async function createFloorZone(
  context: ScopedTenantContext,
  outletId: string,
  input: CreateFloorZoneInput,
  actorUserId: string,
  now = new Date(),
): Promise<FloorZone> {
  const outlet = outletIdSchema.parse(outletId);
  assertOutletInScope(context.outletScope, outlet);
  return withTenant(db, context, async (tx) => {
    let row: ZoneRow;
    try {
      [row] = await tx
        .insert(floorZones)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: outlet,
          name: input.name,
          paymentMode: input.paymentMode,
          serviceChargeBp: input.serviceChargeBp,
          minimumSpendIdr: input.minimumSpendIdr,
          hours: input.hours,
          status: input.status,
          sortOrder: input.sortOrder,
          isWfc: input.isWfc ?? false,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new CoreError(
          "CONFLICT",
          "Nama zona sudah dipakai di outlet ini.",
        );
      throw error;
    }
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "floor_zone.created",
        objectType: "floor_zone",
        objectId: row.id,
        outletId: outlet,
        after: {
          id: row.id,
          status: row.status,
          paymentMode: row.paymentMode,
          sortOrder: row.sortOrder,
          serviceChargeBp: row.serviceChargeBp,
          minimumSpendIdr: row.minimumSpendIdr,
        },
      },
      now,
    );
    return toZone(row);
  });
}

export async function updateFloorZone(
  context: ScopedTenantContext,
  zoneId: string,
  input: UpdateFloorZoneInput,
  actorUserId: string,
  now = new Date(),
): Promise<FloorZone> {
  return withTenant(db, context, async (tx) => {
    const row = await zoneRow(tx, context.tenant.tenantId, zoneId);
    assertOutletInScope(context.outletScope, row.outletId);
    let updated: ZoneRow;
    try {
      [updated] = await tx
        .update(floorZones)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.paymentMode === undefined
            ? {}
            : { paymentMode: input.paymentMode }),
          ...(input.serviceChargeBp === undefined
            ? {}
            : { serviceChargeBp: input.serviceChargeBp }),
          ...(input.minimumSpendIdr === undefined
            ? {}
            : { minimumSpendIdr: input.minimumSpendIdr }),
          ...(input.hours === undefined ? {} : { hours: input.hours }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.sortOrder === undefined
            ? {}
            : { sortOrder: input.sortOrder }),
          ...(input.isWfc === undefined ? {} : { isWfc: input.isWfc }),
          updatedAt: now,
        })
        .where(
          and(
            eq(floorZones.tenantId, context.tenant.tenantId),
            eq(floorZones.id, zoneId),
          ),
        )
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new CoreError(
          "CONFLICT",
          "Nama zona sudah dipakai di outlet ini.",
        );
      throw error;
    }
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "floor_zone.updated",
        objectType: "floor_zone",
        objectId: row.id,
        outletId: row.outletId,
        before: {
          id: row.id,
          status: row.status,
          paymentMode: row.paymentMode,
          sortOrder: row.sortOrder,
          serviceChargeBp: row.serviceChargeBp,
          minimumSpendIdr: row.minimumSpendIdr,
        },
        after: {
          id: updated.id,
          status: updated.status,
          paymentMode: updated.paymentMode,
          sortOrder: updated.sortOrder,
          serviceChargeBp: updated.serviceChargeBp,
          minimumSpendIdr: updated.minimumSpendIdr,
        },
      },
      now,
    );
    return toZone(updated);
  });
}

export async function deleteFloorZone(
  context: ScopedTenantContext,
  zoneId: string,
  actorUserId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const row = await zoneRow(tx, context.tenant.tenantId, zoneId);
    assertOutletInScope(context.outletScope, row.outletId);
    const [used] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.zoneId, zoneId),
        ),
      );
    if ((used?.count ?? 0) > 0)
      throw new CoreError(
        "CONFLICT",
        "Zona masih memiliki meja; pindahkan atau hapus mejanya dulu.",
      );
    await tx
      .delete(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, context.tenant.tenantId),
          eq(floorZones.id, zoneId),
        ),
      );
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "floor_zone.deleted",
        objectType: "floor_zone",
        objectId: row.id,
        outletId: row.outletId,
        before: { id: row.id, status: row.status },
      },
      now,
    );
  });
}

// ---- Tables ---------------------------------------------------------------

export async function createTable(
  context: ScopedTenantContext,
  input: CreateTableInput,
  actorUserId: string,
  now = new Date(),
): Promise<Table> {
  return withTenant(db, context, async (tx) => {
    const zone = await zoneRow(tx, context.tenant.tenantId, input.zoneId);
    assertOutletInScope(context.outletScope, zone.outletId);
    let row: TableRow;
    try {
      [row] = await tx
        .insert(tables)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: zone.outletId,
          zoneId: zone.id,
          code: input.code,
          capacity: input.capacity,
          type: input.type,
          layout: input.layout,
          status: input.status,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new CoreError(
          "CONFLICT",
          "Nomor meja sudah dipakai di outlet ini.",
        );
      throw error;
    }
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table.created",
        objectType: "table",
        objectId: row.id,
        outletId: row.outletId,
        after: {
          id: row.id,
          status: row.status,
          capacity: row.capacity,
          type: row.type,
          zoneId: row.zoneId,
        },
      },
      now,
    );
    return toTable(row);
  });
}

export async function updateTable(
  context: ScopedTenantContext,
  tableId: string,
  input: UpdateTableInput,
  actorUserId: string,
  now = new Date(),
): Promise<Table> {
  return withTenant(db, context, async (tx) => {
    // Same per-table lock as the scan: the open-session guard below and the
    // status write must not interleave with a first scan (ORD-10).
    await lockTableLiveState(tx, context.tenant.tenantId, tableId);
    const row = await tableRow(tx, context.tenant.tenantId, tableId);
    assertOutletInScope(context.outletScope, row.outletId);
    if (input.zoneId !== undefined && input.zoneId !== row.zoneId) {
      const zone = await zoneRow(tx, context.tenant.tenantId, input.zoneId);
      if (zone.outletId !== row.outletId)
        throw new CoreError(
          "CONFLICT",
          "Meja tidak dapat dipindah ke zona milik outlet lain.",
        );
    }
    // The editor only switches a table on or off; a live state belongs to the
    // board's ORD-10 guard (contract schemas.ts EDITOR_TABLE_STATUSES).
    if (input.status === "available" && row.status !== "inactive")
      throw new CoreError(
        "CONFLICT",
        "Status tersedia hanya dipakai untuk mengaktifkan kembali meja nonaktif.",
      );
    if (input.status === "inactive") {
      if (row.status !== "available")
        throw new CoreError(
          "CONFLICT",
          "Hanya meja berstatus tersedia yang dapat dinonaktifkan.",
        );
      if (await hasOpenSession(tx, context.tenant.tenantId, row.id))
        throw new CoreError(
          "CONFLICT",
          "Meja dengan sesi berjalan tidak dapat dinonaktifkan; tutup sesinya dulu.",
        );
    }
    let updated: TableRow;
    try {
      [updated] = await tx
        .update(tables)
        .set({
          ...(input.zoneId === undefined ? {} : { zoneId: input.zoneId }),
          ...(input.code === undefined ? {} : { code: input.code }),
          ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.layout === undefined ? {} : { layout: input.layout }),
          ...(input.status === undefined ? {} : { status: input.status }),
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.tenantId, context.tenant.tenantId),
            eq(tables.id, tableId),
          ),
        )
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new CoreError(
          "CONFLICT",
          "Nomor meja sudah dipakai di outlet ini.",
        );
      throw error;
    }
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table.updated",
        objectType: "table",
        objectId: row.id,
        outletId: row.outletId,
        before: {
          id: row.id,
          status: row.status,
          capacity: row.capacity,
          type: row.type,
          zoneId: row.zoneId,
        },
        after: {
          id: updated.id,
          status: updated.status,
          capacity: updated.capacity,
          type: updated.type,
          zoneId: updated.zoneId,
        },
      },
      now,
    );
    return toTable(updated);
  });
}

export async function deleteTable(
  context: ScopedTenantContext,
  tableId: string,
  actorUserId: string,
  now = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await lockTableLiveState(tx, context.tenant.tenantId, tableId);
    const row = await tableRow(tx, context.tenant.tenantId, tableId);
    assertOutletInScope(context.outletScope, row.outletId);
    // ORD-10: a table with an open session cannot be removed.
    if (await hasOpenSession(tx, context.tenant.tenantId, row.id))
      throw new CoreError(
        "CONFLICT",
        "Meja dengan sesi berjalan tidak dapat dihapus; tutup sesinya dulu.",
      );
    const [history] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, context.tenant.tenantId),
          eq(tableSessions.tableId, row.id),
        ),
      );
    if ((history?.count ?? 0) > 0)
      throw new CoreError(
        "CONFLICT",
        "Meja ini punya riwayat sesi; nonaktifkan saja agar laporan tetap utuh.",
      );
    await tx
      .delete(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, tableId),
        ),
      );
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table.deleted",
        objectType: "table",
        objectId: row.id,
        outletId: row.outletId,
        before: { id: row.id, status: row.status },
      },
      now,
    );
  });
}

/**
 * One-request save of moved tables (a drag session never saves half a move).
 * Every placement must be an existing table in the same outlet, which is the
 * caller's outlet scope.
 */
export async function saveFloorLayout(
  context: ScopedTenantContext,
  input: SaveFloorLayoutInput,
  actorUserId: string,
  now = new Date(),
): Promise<Table[]> {
  return withTenant(db, context, async (tx) => {
    const ids = input.placements.map((placement) => placement.tableId);
    if (new Set(ids).size !== ids.length)
      throw new CoreError(
        "CONFLICT",
        "Setiap meja hanya boleh muncul sekali dalam satu simpanan denah.",
      );
    const rows = await tx
      .select()
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          inArray(tables.id, ids),
        ),
      );
    if (rows.length !== ids.length)
      throw new CoreError("NOT_FOUND", "Ada meja yang tidak ditemukan.");
    const outletIds = new Set(rows.map((row) => row.outletId));
    const [outletId] = [...outletIds];
    if (outletId === undefined || outletIds.size !== 1)
      throw new CoreError(
        "CONFLICT",
        "Denah disimpan per outlet; jangan campur meja dari outlet berbeda.",
      );
    assertOutletInScope(context.outletScope, outletId);
    const updated: TableRow[] = [];
    for (const placement of input.placements) {
      const [row] = await tx
        .update(tables)
        .set({ layout: placement.layout, updatedAt: now })
        .where(
          and(
            eq(tables.tenantId, context.tenant.tenantId),
            eq(tables.id, placement.tableId),
          ),
        )
        .returning();
      updated.push(row);
    }
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "floor_layout.saved",
        objectType: "outlet",
        objectId: outletId,
        outletId,
        after: { outletId, count: updated.length, tableIds: ids },
      },
      now,
    );
    const order = new Map<string, number>(ids.map((id, index) => [id, index]));
    return updated
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map(toTable);
  });
}

// ---- Signed QR ------------------------------------------------------------

function openSealedToken(row: TableRow): string | null {
  if (row.qrTokenSealed === null) return null;
  try {
    return openSecret(row.qrTokenSealed, qrSealAad(row.tenantId, row.id));
  } catch {
    // A key change makes old seals unreadable. Do not silently print a new
    // sticker: the operator must use "Ganti QR" (audited) instead.
    throw new CoreError(
      "CONFLICT",
      "Token QR meja tidak dapat dibuka; terbitkan ulang dengan Ganti QR.",
    );
  }
}

/**
 * The table's current signed QR for printing. Never rotates: an existing seal
 * is opened and re-rendered so reprinting a floor does not invalidate the
 * stickers already on the tables (contract `issueTableQr`).
 *
 * The table row is locked while it is read: two concurrent first issues must
 * not mint competing credentials where the loser's printed sticker would stop
 * resolving (Codex pre-review MED).
 */
export async function issueTableQr(
  context: ScopedTenantContext,
  tableId: string,
  actorUserId: string,
  now = new Date(),
): Promise<TableQr> {
  return withTenant(db, context, async (tx) => {
    const row = await tableRow(tx, context.tenant.tenantId, tableId, {
      forUpdate: true,
    });
    assertOutletInScope(context.outletScope, row.outletId);
    const existing = openSealedToken(row);
    if (existing !== null) {
      const verified = qrTokenHash(existing);
      if (row.qrTokenHash !== verified)
        throw new CoreError(
          "CONFLICT",
          "Token QR meja tidak konsisten; terbitkan ulang dengan Ganti QR.",
        );
      return tableQrSchema.parse({
        tableId: row.id,
        token: existing,
        url: tableQrUrl(existing),
        issuedAt: issuedAtOf(existing),
      });
    }
    const token = signTableQrToken({
      tenantId: row.tenantId,
      outletId: row.outletId,
      tableId: row.id,
      issuedAt: now,
    });
    await tx
      .update(tables)
      .set({
        qrTokenHash: qrTokenHash(token),
        qrTokenSealed: sealSecret(token, qrSealAad(row.tenantId, row.id)),
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, row.id),
        ),
      );
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table.qr_issued",
        objectType: "table",
        objectId: row.id,
        outletId: row.outletId,
        after: { id: row.id, status: row.status },
      },
      now,
    );
    return tableQrSchema.parse({
      tableId: row.id,
      token,
      url: tableQrUrl(token),
      issuedAt: toIsoDateTime(now),
    });
  });
}

/** issuedAt inside a signed token; the payload schema validated it already. */
function issuedAtOf(token: string): string {
  const encoded = token.split(".")[1] ?? "";
  return qrTokenPayloadSchema.parse(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
  ).issuedAt;
}

/**
 * "Ganti QR": the only action that rotates a table's token (lost or copied
 * sticker). The old sticker is refused from then on (ORD-04); the rotation is
 * audited (contract `rotateTableQr`).
 */
export async function rotateTableQr(
  context: ScopedTenantContext,
  tableId: string,
  actorUserId: string,
  now = new Date(),
): Promise<TableQr> {
  return withTenant(db, context, async (tx) => {
    // Same row lock as issuance: a rotate racing a first issue serializes, so
    // the returned credential is always the one persisted last.
    const row = await tableRow(tx, context.tenant.tenantId, tableId, {
      forUpdate: true,
    });
    assertOutletInScope(context.outletScope, row.outletId);
    const previousHash = row.qrTokenHash;
    // A rotation in the same millisecond as the previous issue would mint the
    // same payload; bump the timestamp until the token (and hash) differs.
    let issuedAt = now;
    let token = signTableQrToken({
      tenantId: row.tenantId,
      outletId: row.outletId,
      tableId: row.id,
      issuedAt,
    });
    for (
      let attempt = 0;
      qrTokenHash(token) === previousHash && attempt < 5;
      attempt++
    ) {
      issuedAt = new Date(issuedAt.getTime() + 1);
      token = signTableQrToken({
        tenantId: row.tenantId,
        outletId: row.outletId,
        tableId: row.id,
        issuedAt,
      });
    }
    await tx
      .update(tables)
      .set({
        qrTokenHash: qrTokenHash(token),
        qrTokenSealed: sealSecret(token, qrSealAad(row.tenantId, row.id)),
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, row.id),
        ),
      );
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table.qr_rotated",
        objectType: "table",
        objectId: row.id,
        outletId: row.outletId,
        before: { id: row.id, status: row.status },
        after: { id: row.id, status: row.status },
      },
      now,
    );
    return tableQrSchema.parse({
      tableId: row.id,
      token,
      url: tableQrUrl(token),
      issuedAt: toIsoDateTime(issuedAt),
    });
  });
}

/** Outlet reference read used by the QR scan result. */
export async function floorOutletRef(
  tx: Tx,
  tenantId: string,
  outletId: string,
) {
  const [outlet] = await tx
    .select()
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  const [brand] = await tx
    .select()
    .from(brands)
    .where(and(eq(brands.tenantId, tenantId), eq(brands.id, outlet.brandId)));
  if (!brand) throw new CoreError("NOT_FOUND", "Brand tidak ditemukan.");
  return { outlet, brand };
}

export { tableRow, zoneRow, type Tx as FloorTx };
