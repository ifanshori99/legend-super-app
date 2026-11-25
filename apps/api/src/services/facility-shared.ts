// Shared helpers of the facility services (PRD v1.7 §3 F22; bead legend-nm4f):
// service-layer permission checks, row -> contract DTO mappers, audit entry,
// and the outlet-time-zone arithmetic the slot grid needs (business dates are
// outlet-local, instants are stored in UTC).
import { and, eq } from "drizzle-orm";
import type { AccessTarget, PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accessTicketSchema,
  facilityAreaSchema,
  facilitySchema,
  facilityUnitSchema,
  type AccessTicket,
  type Facility,
  type FacilityArea,
  type FacilityUnit,
} from "@starter/shared/facility";
import {
  accessTickets,
  facilities,
  facilityAreas,
  facilityUnits,
} from "../db/schema/facility.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { HttpError } from "../lib/http-error.ts";
import { maskAuditChanges } from "@starter/shared/audit";
import { recordAudit } from "./core-audit.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";

export type { Tx };

/** Booth operation: status board, availability, queue, unit maintenance flag. */
export const OPERATE_PERMISSION: PermissionCode = "facility.booth.operate";
/** Facility / area / unit configuration (admin panel). */
export const CONFIG_PERMISSION: PermissionCode = "facility.config.manage";

export type FacilityRow = typeof facilities.$inferSelect;
export type AreaRow = typeof facilityAreas.$inferSelect;
export type UnitRow = typeof facilityUnits.$inferSelect;
export type TicketRow = typeof accessTickets.$inferSelect;

/** Service-layer authorization on the facility's outlet (TEN-03). */
export async function assertFacilityPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  outletId: string,
): Promise<void> {
  const target: AccessTarget = { type: "outlet", id: outletId };
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  if (!snapshot.allows(permission, target))
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action in this outlet.",
    );
}

export const notFound = (what: string) =>
  new HttpError(404, "NOT_FOUND", `${what} tidak ditemukan.`);

/** A facility of this tenant; RLS hides other outlets, so this is also TEN-03. */
export async function loadFacility(
  tx: Tx,
  context: ScopedTenantContext,
  facilityId: string,
): Promise<FacilityRow> {
  const [row] = await tx
    .select()
    .from(facilities)
    .where(
      and(
        eq(facilities.tenantId, context.tenant.tenantId),
        eq(facilities.id, facilityId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Fasilitas");
  return row;
}

export async function loadArea(
  tx: Tx,
  context: ScopedTenantContext,
  areaId: string,
): Promise<AreaRow> {
  const [row] = await tx
    .select()
    .from(facilityAreas)
    .where(
      and(
        eq(facilityAreas.tenantId, context.tenant.tenantId),
        eq(facilityAreas.id, areaId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Area");
  return row;
}

/** Time zone of the outlet that owns a facility (business dates, hours). */
export async function outletTimeZone(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<string> {
  const [row] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Outlet");
  return row.timezone;
}

// ---- Mappers ---------------------------------------------------------------

export function toFacility(row: FacilityRow): Facility {
  return facilitySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    type: row.type,
    sessionMinutes: row.sessionMinutes,
    cleaningMinutes: row.cleaningMinutes,
    arrivalGraceMinutes: row.arrivalGraceMinutes,
    operatingHours: row.operatingHours,
    overtimePolicy: row.overtimePolicy,
    cancellationPolicy: row.cancellationPolicy,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toArea(row: AreaRow): FacilityArea {
  return facilityAreaSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    name: row.name,
    entranceLockDeviceId: row.entranceLockDeviceId,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toUnit(row: UnitRow): FacilityUnit {
  return facilityUnitSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    areaId: row.areaId,
    code: row.code,
    lockDeviceId: row.lockDeviceId,
    panicDeviceId: row.panicDeviceId,
    status: row.status,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toTicket(row: TicketRow): AccessTicket {
  return accessTicketSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    areaId: row.areaId,
    unitId: row.unitId,
    customerProfileId: row.customerProfileId,
    productId: row.productId,
    source: row.source,
    entitlementLedgerId: row.entitlementLedgerId,
    slot: {
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      cleaningEndsAt: row.cleaningEndsAt.toISOString(),
    },
    graceMinutes: row.graceMinutes,
    addons: row.addons,
    status: row.status,
    issuedOffline: row.issuedOffline,
    firstOpenedAt: row.firstOpenedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    overtimeMinutes: row.overtimeMinutes,
    overtimeFeeIdr: row.overtimeFeeIdr,
    createdAt: row.createdAt.toISOString(),
  });
}

// ---- Audit ------------------------------------------------------------------

/** Field names that may stay readable in a facility audit entry (no free text). */
export const FACILITY_AUDIT_SAFE_FIELDS: readonly string[] = [
  "id",
  "facilityId",
  "areaId",
  "unitId",
  "ticketId",
  "outletId",
  "status",
  "action",
  "type",
  "code",
  "sortOrder",
  "sessionMinutes",
  "cleaningMinutes",
  "arrivalGraceMinutes",
  "startsAt",
  "endsAt",
  "cleaningEndsAt",
  "source",
  "timing",
  // Price and quota values: an admin's change must stay readable as old and
  // new (bead legend-6jms). Money amounts and counts, never personal data.
  "priceIdr",
  // Split of a WFC product (brief 1270 W1).
  "seatFeeIdr",
  "creditIdr",
  "quotaPerPeriod",
  // `sessions` itself is on the audit deny list ("session"); `quota` is the
  // sessions a purchase or rule grants.
  "quota",
  "maxPerDay",
  "interval",
  "isActive",
  "isEnabled",
  "freeMinutes",
  "peakFreeMinutes",
  "spendPerExtraHourIdr",
  "extraMinutes",
  "maxDevices",
  "minSpendPerHourIdr",
  "minSpendIdr",
  "baseSpeedKbps",
  "fullSpeedKbps",
  "spendMode",
];

export async function auditFacility(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string | null,
  now: Date,
  entry: {
    action: string;
    objectType: string;
    objectId: string;
    outletId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: entry.outletId,
      actorType: actorUserId === null ? "system" : "user",
      actorId: actorUserId === null ? null : userIdSchema.parse(actorUserId),
      deviceId: null,
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId,
      reason: null,
      maskedChanges: {
        before:
          entry.before === null
            ? null
            : maskAuditChanges(entry.before, FACILITY_AUDIT_SAFE_FIELDS),
        after:
          entry.after === null
            ? null
            : maskAuditChanges(entry.after, FACILITY_AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y" as const,
      createdAt: now.toISOString(),
    },
    FACILITY_AUDIT_SAFE_FIELDS,
  );
}

// ---- Errors -----------------------------------------------------------------

/** PostgreSQL error code, directly or wrapped by drizzle's cause chain. */
export function pgErrorCode(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (
    typeof candidate.code === "string" &&
    /^[0-9A-Z]{5}$/.test(candidate.code)
  )
    return candidate.code;
  return pgErrorCode(candidate.cause, depth + 1);
}

/** 23P01 = exclusion_violation (the FAC-02 constraint). */
export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_UNIQUE_VIOLATION = "23505";

export { zonedInstant } from "./facility-rules.ts";
