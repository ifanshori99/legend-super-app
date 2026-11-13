// Printer registry, cloud side (bead legend-2lp.6; PRD v1.7 §3 F5 "Print
// Agent" and "Registri Perangkat", EDG-05). Back-office CRUD over
// `edge_printers`, the table the edge Print Agent reads.
//
// Link to the device registry without a migration: a printer has the same id
// in `devices` (type 'printer') and `edge_printers`. Create inserts both rows
// in one transaction, update keeps label and station in sync, delete revokes
// the device row (terminal, never deleted: EDG-03). For a station printer,
// `stations.printer_device_id` points at the printer; it is cleared when the
// printer is unassigned or deleted.
//
// Tenant and outlet are filtered in SQL on every read and write, besides RLS.
// An unknown id, another tenant's printer and another outlet's printer answer
// the same NOT_FOUND. Input mirrors the table's CHECK constraints (shared
// `printers.ts`); the merged state of an update is re-checked here.
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  outletIdSchema,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
  type TenantId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  printerSchema,
  type CreatePrinterBody,
  type Printer,
  type PrinterListQuery,
  type UpdatePrinterBody,
} from "@starter/shared/edge";
import { menuUpdatedEvent } from "@starter/shared/menu";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { edgePrintJobs, edgePrinters } from "../db/schema/edge-print.ts";
import { stations } from "../db/schema/menu.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./audit-writer.ts";
import { closeTrainingPeriod } from "./device.service.ts";
import { appendMenuEvent } from "./menu-internals.ts";
import type { Tx } from "./permission-resolver.ts";

type PrinterRow = typeof edgePrinters.$inferSelect;

/** Same clock the device registry uses, so the edge watermark never skews. */
const dbClock = sql`clock_timestamp()`;

const DEFAULT_PRINTER_PORT = 9100;
const DEFAULT_PAPER_WIDTH = 48;

const notFound = () => new CoreError("NOT_FOUND", "Printer tidak ditemukan.");

export function toPrinter(row: PrinterRow): Printer {
  return printerSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    label: row.label,
    role: row.role,
    stationId: row.stationId,
    transport: row.transport,
    host: row.host,
    port: row.port,
    devicePath: row.devicePath,
    paperWidth: row.paperWidth,
    fallbackPrinterId: row.fallbackPrinterId,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    offlineSince: row.offlineSince?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** What an audit row keeps of a printer (no heartbeat fields). */
function auditView(row: PrinterRow): Record<string, unknown> {
  return {
    label: row.label,
    role: row.role,
    stationId: row.stationId,
    transport: row.transport,
    host: row.host,
    port: row.port,
    devicePath: row.devicePath,
    paperWidth: row.paperWidth,
    fallbackPrinterId: row.fallbackPrinterId,
  };
}

/**
 * The outlet of a printer, read under tenant-wide RLS, so a route can check
 * the permission on that outlet. null = unknown printer (or another tenant's).
 */
export async function findPrinterOutletId(
  tenant: TenantContext,
  printerId: string,
): Promise<string | null> {
  const [row] = await withTenant(
    db,
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    (tx) =>
      tx
        .select({ outletId: edgePrinters.outletId })
        .from(edgePrinters)
        .where(
          and(
            eq(edgePrinters.tenantId, tenant.tenantId),
            eq(edgePrinters.id, uuidSchema.parse(printerId)),
          ),
        )
        .limit(1),
  );
  return row?.outletId ?? null;
}

export async function listPrinters(
  context: ScopedTenantContext,
  query: PrinterListQuery,
): Promise<Printer[]> {
  assertTrustedScopedContext(context);
  const outletId = outletIdSchema.parse(query.outletId);
  assertOutletInScope(context.outletScope, outletId);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(edgePrinters)
      .where(
        and(
          eq(edgePrinters.tenantId, context.tenant.tenantId),
          eq(edgePrinters.outletId, outletId),
        ),
      )
      .orderBy(asc(edgePrinters.createdAt), asc(edgePrinters.id)),
  );
  return rows.map(toPrinter);
}

export async function getPrinter(
  context: ScopedTenantContext,
  printerId: string,
): Promise<Printer> {
  assertTrustedScopedContext(context);
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(edgePrinters)
      .where(
        and(
          eq(edgePrinters.tenantId, context.tenant.tenantId),
          eq(edgePrinters.id, uuidSchema.parse(printerId)),
        ),
      )
      .limit(1),
  );
  if (!row) throw notFound();
  assertOutletInScope(context.outletScope, row.outletId);
  return toPrinter(row);
}

async function assertStationInOutlet(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  stationId: string,
): Promise<void> {
  const [station] = await tx
    .select({ id: stations.id })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.outletId, outletId),
        eq(stations.id, stationId),
        isNull(stations.deletedAt),
      ),
    )
    .limit(1);
  if (!station)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Stasiun tidak ditemukan di outlet ini.",
    );
}

async function assertFallbackInOutlet(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  fallbackPrinterId: string,
): Promise<void> {
  const [fallback] = await tx
    .select({ id: edgePrinters.id })
    .from(edgePrinters)
    .where(
      and(
        eq(edgePrinters.tenantId, tenantId),
        eq(edgePrinters.outletId, outletId),
        eq(edgePrinters.id, fallbackPrinterId),
      ),
    )
    .limit(1);
  if (!fallback)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Printer cadangan tidak ditemukan di outlet ini.",
    );
}

/** Postgres foreign key violation (a row another printer or job points at). */
function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if ((current as { code?: unknown }).code === "23503") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A foreign key hit (concurrent change) is a 409, not a database error. */
async function guardForeignKey<T>(run: PromiseLike<T>): Promise<T> {
  try {
    return await run;
  } catch (error) {
    if (isForeignKeyViolation(error))
      throw new CoreError(
        "CONFLICT",
        "Printer terkait dengan data lain, coba lagi.",
      );
    throw error;
  }
}

/**
 * Rejects a fallback chain that loops back to the printer (A -> B -> A). Walks
 * the chain inside the transaction and share-locks each hop, so two updates
 * cannot each close half of a loop.
 */
async function assertNoFallbackCycle(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  printerId: string,
  fallbackPrinterId: string,
): Promise<void> {
  const seen = new Set<string>([printerId]);
  let next: string | null = fallbackPrinterId;
  while (next !== null) {
    if (seen.has(next))
      throw new CoreError(
        "VALIDATION_ERROR",
        "Printer cadangan tidak boleh membentuk lingkaran.",
      );
    seen.add(next);
    const [hop]: { fallbackPrinterId: string | null }[] = await tx
      .select({ fallbackPrinterId: edgePrinters.fallbackPrinterId })
      .from(edgePrinters)
      .where(
        and(
          eq(edgePrinters.tenantId, tenantId),
          eq(edgePrinters.outletId, outletId),
          eq(edgePrinters.id, next),
        ),
      )
      .for("share");
    next = hop?.fallbackPrinterId ?? null;
  }
}

/**
 * Makes `stations.printer_device_id` agree with the printer: a station printer
 * is bound to its station, and no other station points at it. Emits the same
 * event updateStation does, so KDS and menu clients refresh.
 */
async function syncStationBinding(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  printer: {
    id: string;
    outletId: OutletId;
    stationId: string | null;
  } | null,
  printerId: string,
  now: Date,
): Promise<string[]> {
  const tenantId = context.tenant.tenantId;
  const changed: { id: string; outletId: string }[] = [];
  const cleared = await tx
    .update(stations)
    .set({ printerDeviceId: null, updatedAt: now })
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.printerDeviceId, printerId),
        printer?.stationId ? ne(stations.id, printer.stationId) : undefined,
      ),
    )
    .returning({ id: stations.id, outletId: stations.outletId });
  changed.push(...cleared);
  if (printer?.stationId) {
    // Share lock on the registry row: a concurrent revoke waits for this
    // transaction, so it cannot slip between the check and the bind (same
    // rule as menu.service assertStationPrinter). No active device row (a
    // legacy printer, or a revoked one) means no binding.
    const [device] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, tenantId),
          eq(devices.outletId, printer.outletId),
          eq(devices.id, printerId),
          eq(devices.type, "printer"),
          eq(devices.status, "active"),
          isNull(devices.revokedAt),
        ),
      )
      .for("share");
    if (device) {
      const [station] = await tx
        .select({
          id: stations.id,
          outletId: stations.outletId,
          printerDeviceId: stations.printerDeviceId,
        })
        .from(stations)
        .where(
          and(
            eq(stations.tenantId, tenantId),
            eq(stations.outletId, printer.outletId),
            eq(stations.id, printer.stationId),
            isNull(stations.deletedAt),
          ),
        )
        .for("update");
      if (station && station.printerDeviceId !== printerId) {
        if (station.printerDeviceId !== null)
          throw new CoreError(
            "CONFLICT",
            "Stasiun ini sudah memakai printer lain.",
          );
        await tx
          .update(stations)
          .set({ printerDeviceId: printerId, updatedAt: now })
          .where(eq(stations.id, station.id));
        changed.push({ id: station.id, outletId: station.outletId });
      }
    }
  }
  for (const station of changed)
    await appendMenuEvent(tx, context, menuUpdatedEvent, {
      aggregateId: station.id,
      actorUserId,
      payload: {
        entity: "station",
        entityId: station.id,
        operation: "updated",
      },
      affects: { kind: "outlet", outletId: station.outletId },
      now,
    });
  return changed.map((station) => station.id);
}

export async function createPrinter(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePrinterBody,
  now: Date = new Date(),
): Promise<Printer> {
  assertTrustedScopedContext(context);
  const outletId = outletIdSchema.parse(input.outletId);
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  const stationId = input.stationId ?? null;
  if (input.role !== "station" && stationId !== null)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Stasiun hanya untuk printer berperan station.",
    );
  return withTenant(db, context, async (tx) => {
    if (stationId !== null)
      await assertStationInOutlet(tx, tenantId, outletId, stationId);
    if (input.fallbackPrinterId)
      await assertFallbackInOutlet(
        tx,
        tenantId,
        outletId,
        input.fallbackPrinterId,
      );
    const network = input.transport === "network";
    const [row] = await guardForeignKey(
      tx
        .insert(edgePrinters)
        .values({
          tenantId,
          outletId,
          label: input.label,
          role: input.role,
          stationId,
          transport: input.transport,
          host: network ? (input.host ?? null) : null,
          port: network ? (input.port ?? DEFAULT_PRINTER_PORT) : null,
          devicePath: network ? null : (input.devicePath ?? null),
          paperWidth: input.paperWidth ?? DEFAULT_PAPER_WIDTH,
          fallbackPrinterId: input.fallbackPrinterId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    if (!row) throw new CoreError("CONFLICT", "Printer gagal dibuat.");
    // The registry row: same id, so the device registry lists the printer.
    await tx.insert(devices).values({
      id: row.id,
      tenantId,
      outletId,
      type: "printer",
      stationId,
      label: input.label,
      enrolledBy: actorUserId,
      createdAt: now,
      updatedAt: dbClock,
    });
    await syncStationBinding(tx, context, actorUserId, row, row.id, now);
    await recordAudit(
      {
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "printer.created",
        objectType: "printer",
        objectId: row.id,
        reason: null,
        before: null,
        after: auditView(row),
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toPrinter(row);
  });
}

export async function updatePrinter(
  context: ScopedTenantContext,
  actorUserId: string,
  printerId: string,
  input: UpdatePrinterBody,
  now: Date = new Date(),
): Promise<Printer> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const id = uuidSchema.parse(printerId);
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(edgePrinters)
      .where(and(eq(edgePrinters.tenantId, tenantId), eq(edgePrinters.id, id)))
      .for("update");
    if (!current) throw notFound();
    assertOutletInScope(context.outletScope, current.outletId);
    const outletId = current.outletId;

    const role = input.role ?? current.role;
    // Moving to the receipt role drops the station unless the caller names one
    // (which the merged check below then refuses).
    const stationId =
      input.stationId !== undefined
        ? input.stationId
        : role === "receipt"
          ? null
          : current.stationId;
    if (role !== "station" && stationId !== null)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Stasiun hanya untuk printer berperan station.",
      );
    const fallbackPrinterId =
      input.fallbackPrinterId !== undefined
        ? input.fallbackPrinterId
        : current.fallbackPrinterId;
    if (fallbackPrinterId === id)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Printer tidak boleh menjadi cadangan dirinya sendiri.",
      );
    if (stationId !== null && stationId !== current.stationId)
      await assertStationInOutlet(tx, tenantId, outletId, stationId);
    if (
      fallbackPrinterId !== null &&
      fallbackPrinterId !== current.fallbackPrinterId
    ) {
      await assertFallbackInOutlet(tx, tenantId, outletId, fallbackPrinterId);
      await assertNoFallbackCycle(
        tx,
        tenantId,
        outletId,
        id,
        fallbackPrinterId,
      );
    }

    const connection =
      input.transport === undefined
        ? {}
        : input.transport === "network"
          ? {
              transport: "network" as const,
              host: input.host ?? null,
              port: input.port ?? DEFAULT_PRINTER_PORT,
              devicePath: null,
            }
          : {
              transport: "usb" as const,
              host: null,
              port: null,
              devicePath: input.devicePath ?? null,
            };
    const label = input.label ?? current.label;
    const [updated] = await guardForeignKey(
      tx
        .update(edgePrinters)
        .set({
          ...connection,
          label,
          role,
          stationId,
          paperWidth: input.paperWidth ?? current.paperWidth,
          fallbackPrinterId,
          updatedAt: now,
        })
        .where(
          and(
            eq(edgePrinters.tenantId, tenantId),
            eq(edgePrinters.outletId, outletId),
            eq(edgePrinters.id, id),
          ),
        )
        .returning(),
    );
    if (!updated)
      throw new CoreError("CONFLICT", "Printer berubah, coba lagi.");
    // Registry row follows label and station; a legacy printer without one is
    // left alone, a revoked one is never touched (terminal).
    await tx
      .update(devices)
      .set({ label, stationId, updatedAt: dbClock })
      .where(
        and(
          eq(devices.tenantId, tenantId),
          eq(devices.outletId, outletId),
          eq(devices.id, id),
          eq(devices.type, "printer"),
          eq(devices.status, "active"),
        ),
      );
    await syncStationBinding(tx, context, actorUserId, updated, id, now);
    await recordAudit(
      {
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "printer.updated",
        objectType: "printer",
        objectId: id,
        reason: null,
        before: auditView(current),
        after: auditView(updated),
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toPrinter(updated);
  });
}

/**
 * CONFLICT while another printer falls back to this one or the printer has
 * print jobs (they keep the history). Otherwise: the station binding is
 * cleared, the row is deleted and the linked registry device is revoked.
 */
export async function deletePrinter(
  context: ScopedTenantContext,
  actorUserId: string,
  printerId: string,
  now: Date = new Date(),
): Promise<void> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const id = uuidSchema.parse(printerId);
  await withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(edgePrinters)
      .where(and(eq(edgePrinters.tenantId, tenantId), eq(edgePrinters.id, id)))
      .for("update");
    if (!current) throw notFound();
    assertOutletInScope(context.outletScope, current.outletId);
    const outletId = current.outletId;
    const [fallbackOf] = await tx
      .select({ id: edgePrinters.id })
      .from(edgePrinters)
      .where(
        and(
          eq(edgePrinters.tenantId, tenantId),
          eq(edgePrinters.outletId, outletId),
          eq(edgePrinters.fallbackPrinterId, id),
        ),
      )
      .limit(1);
    if (fallbackOf)
      throw new CoreError(
        "CONFLICT",
        "Printer masih menjadi cadangan printer lain.",
      );
    const [job] = await tx
      .select({ id: edgePrintJobs.id })
      .from(edgePrintJobs)
      .where(
        and(
          eq(edgePrintJobs.tenantId, tenantId),
          eq(edgePrintJobs.outletId, outletId),
          or(
            eq(edgePrintJobs.printerId, id),
            eq(edgePrintJobs.originalPrinterId, id),
          ),
        ),
      )
      .limit(1);
    if (job)
      throw new CoreError(
        "CONFLICT",
        "Printer sudah punya riwayat cetak dan tidak bisa dihapus.",
      );
    const clearedStationIds = await syncStationBinding(
      tx,
      context,
      actorUserId,
      null,
      id,
      now,
    );
    await guardForeignKey(
      tx
        .delete(edgePrinters)
        .where(
          and(
            eq(edgePrinters.tenantId, tenantId),
            eq(edgePrinters.outletId, outletId),
            eq(edgePrinters.id, id),
          ),
        ),
    );
    await closeTrainingPeriod(tx, id, actorUserId, now);
    await tx
      .update(devices)
      .set({
        status: "revoked",
        revokedAt: now,
        revokedBy: actorUserId,
        revokeReason: "Printer dihapus dari registri.",
        trainingMode: false,
        updatedAt: dbClock,
      })
      .where(
        and(
          eq(devices.tenantId, tenantId),
          eq(devices.outletId, outletId),
          eq(devices.id, id),
          eq(devices.type, "printer"),
          eq(devices.status, "active"),
        ),
      );
    await recordAudit(
      {
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "printer.deleted",
        objectType: "printer",
        objectId: id,
        reason: null,
        before: auditView(current),
        after: { clearedStationIds },
        sensitiveAccess: false,
      },
      { tx, context },
    );
  });
}
