// Reservation policy administration (PRD v1.7 §3.22 "DP & Kebijakan"; RSV-03;
// bead legend-u0q8). Routes: routes/reservation-policy.routes.ts.
//
// A save never edits a stored row: it retires the active version and inserts a
// new one with the next label (`v1`, `v2`, ...). Bookings copy the policy into
// `reservations.policy_snapshot` (reservation-booking.ts) and carry no foreign
// key to it, so old versions are history only and stay readable.
import { and, desc, eq, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  createUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  putReservationPolicyInputSchema,
  reservationPolicyOverviewSchema,
  reservationPolicySchema,
  type PutReservationPolicyInput,
  type ReservationPolicy,
  type ReservationPolicyOverview,
} from "@starter/shared/reservation";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/index.ts";
import { reservationPolicies } from "../db/schema/reservation.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  MANAGE_PERMISSION,
  VIEW_PERMISSION,
  assertPermission,
  type Tx,
} from "./reservation-core.ts";

type PolicyRow = typeof reservationPolicies.$inferSelect;

const RULE_FIELDS = [
  "depositRequirement",
  "depositAmountIdr",
  "paymentWindowMinutes",
  "freeCancellationHours",
  "lateCancellationRefundBp",
  "noShowRefundBp",
  "minimumSpendIdr",
  "defaultDurationMinutes",
  "slotIntervalMinutes",
] as const;

/** Rule fields only: safe to audit (no personal data). */
const POLICY_AUDIT_SAFE_FIELDS = ["version", ...RULE_FIELDS] as const;

const outletTarget = (outletId: OutletId) =>
  ({ type: "outlet", id: outletId }) as const;

function toPolicy(row: PolicyRow): ReservationPolicy {
  return reservationPolicySchema.parse({
    id: row.id,
    outletId: row.outletId,
    version: row.version,
    depositRequirement: row.depositRequirement,
    depositAmountIdr: row.depositAmountIdr,
    paymentWindowMinutes: row.paymentWindowMinutes,
    freeCancellationHours: row.freeCancellationHours,
    lateCancellationRefundBp: row.lateCancellationRefundBp,
    noShowRefundBp: row.noShowRefundBp,
    minimumSpendIdr: row.minimumSpendIdr,
    defaultDurationMinutes: row.defaultDurationMinutes,
    slotIntervalMinutes: row.slotIntervalMinutes,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  });
}

async function assertOutletExists(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<void> {
  assertOutletInScope(context.outletScope, outletId);
  const [outlet] = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
}

async function listPolicyRows(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<PolicyRow[]> {
  return tx
    .select()
    .from(reservationPolicies)
    .where(
      and(
        eq(reservationPolicies.tenantId, context.tenant.tenantId),
        eq(reservationPolicies.outletId, outletId),
      ),
    )
    .orderBy(desc(reservationPolicies.createdAt), desc(reservationPolicies.id));
}

export async function getReservationPolicyOverview(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
): Promise<ReservationPolicyOverview> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      VIEW_PERMISSION,
      outletTarget(outletId),
    );
    await assertOutletExists(tx, context, outletId);
    const rows = await listPolicyRows(tx, context, outletId);
    const active = rows.find((row) => row.isActive);
    return reservationPolicyOverviewSchema.parse({
      active: active ? toPolicy(active) : null,
      history: rows.filter((row) => !row.isActive).map(toPolicy),
    });
  });
}

/** `v1`, `v2`, ...: the first label after the count that no version uses yet. */
function nextVersionLabel(rows: readonly PolicyRow[]): string {
  const used = new Set(rows.map((row) => row.version));
  let n = rows.length + 1;
  while (used.has(`v${n}`)) n += 1;
  return `v${n}`;
}

function sameRules(row: PolicyRow, input: PutReservationPolicyInput): boolean {
  return RULE_FIELDS.every((field) => row[field] === input[field]);
}

function rulesOf(row: PolicyRow): Record<string, unknown> {
  return {
    version: row.version,
    ...Object.fromEntries(RULE_FIELDS.map((field) => [field, row[field]])),
  };
}

export async function putReservationPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: OutletId,
  rawInput: PutReservationPolicyInput,
  now = new Date(),
): Promise<ReservationPolicy> {
  const input = putReservationPolicyInputSchema.parse(rawInput);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      MANAGE_PERMISSION,
      outletTarget(outletId),
    );
    await assertOutletExists(tx, context, outletId);
    // One writer per outlet policy at a time; the unique active index is the
    // backstop if another code path ever writes without this lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reservation-policy:${context.tenant.tenantId}:${outletId}`}, 0))`,
    );
    const rows = await listPolicyRows(tx, context, outletId);
    const active = rows.find((row) => row.isActive) ?? null;

    // Same rules as the active version: nothing to save (safe retry).
    if (active && sameRules(active, input)) return toPolicy(active);
    if ((active?.version ?? null) !== input.expectedVersion)
      throw new HttpError(
        409,
        "RESERVATION_POLICY_VERSION_CONFLICT",
        "Kebijakan sudah diubah oleh orang lain. Muat ulang lalu simpan lagi.",
      );

    if (active)
      await tx
        .update(reservationPolicies)
        .set({ isActive: false, updatedAt: now })
        .where(
          and(
            eq(reservationPolicies.tenantId, context.tenant.tenantId),
            eq(reservationPolicies.id, active.id),
          ),
        );
    const [created] = await tx
      .insert(reservationPolicies)
      .values({
        tenantId: context.tenant.tenantId,
        outletId,
        version: nextVersionLabel(rows),
        depositRequirement: input.depositRequirement,
        depositAmountIdr: input.depositAmountIdr,
        paymentWindowMinutes: input.paymentWindowMinutes,
        freeCancellationHours: input.freeCancellationHours,
        lateCancellationRefundBp: input.lateCancellationRefundBp,
        noShowRefundBp: input.noShowRefundBp,
        minimumSpendIdr: input.minimumSpendIdr,
        defaultDurationMinutes: input.defaultDurationMinutes,
        slotIntervalMinutes: input.slotIntervalMinutes,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("reservation policy insert returned no row");

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "reservation.policy.save",
        objectType: "reservation_policy",
        objectId: created.id,
        reason: null,
        maskedChanges: {
          before: active ? rulesOf(active) : {},
          after: rulesOf(created),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      POLICY_AUDIT_SAFE_FIELDS,
    );
    return toPolicy(created);
  });
}
