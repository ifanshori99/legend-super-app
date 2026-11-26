// End-of-day recap and "Tutup Hari" (bead legend-6c0; PRD v1.7 §3 F8; POS-05
// "Total penjualan harian di POS, akuntansi, dan dashboard identik").
//
// One recap function builds the figures for the live (open) view and for the
// close; the close freezes that recap in `pos_daily_closes.recap` and appends
// `day.closed` with the same totals, so POS, accounting and the dashboard read
// one set of numbers. The identity the contract enforces is
//   Σ tender net = sales − DP applied − refunds − voided paid sales.
//
// How the figures are derived (read the columns the order rows carry):
// - Sales set: `pos_orders` rows whose `orders` row has this business date and
//   status `completed`. A paid sale voided by correction (pos-order-corrections)
//   keeps status `completed` and a `pos_order_voids` row, so it stays in the
//   sales set and its amount is deducted as a void. Totals are the stored
//   `orders` columns (the table check forces total = subtotal − discount +
//   service + tax + rounding).
// - Voids and refunds belong to the business date of `voided_at` /
//   `refunded_at` (outlet clock), attributed to the original order's device.
// - A void is paid back through the tenders the sale was captured with.
// - A reservation deposit (DP) has no tender row: it is a liability bucket
//   (`deposit_applied_idr` of the day's sales, and the DP paid back by the
//   day's refunds, legend-vet9d). A sale whose captured tenders plus DP do not
//   equal its total cannot keep the identity: the recap fails closed
//   (CONFLICT) instead of publishing figures that disagree.
//
// Lock order of the close: advisory lock (tenant, outlet, date) -> reads ->
// pos_daily_closes insert + outbox + audit, all in one withTenant transaction.

import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { maskAuditChanges } from "@starter/shared/audit";
import type { PermissionCode } from "@starter/shared/access";
import {
  assertOutletInScope,
  businessDateOf,
  businessDayRange,
  CoreError,
  type BusinessDayClock,
  createUlid,
  idr,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  closeBusinessDayInputSchema,
  endOfDayBlindRecapSchema,
  endOfDayRecapSchema,
  formatReceiptNumber,
  isFailoverReceiptPrefix,
  PosError,
  POS_TENDER_METHODS,
  posEvents,
  type EndOfDayRecap,
  type EndOfDayRecapView,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { posReceipts, receiptSequences } from "../db/schema/pos-receipt.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { edgeOrderIngests } from "../db/schema/edge-order-ingest.ts";
import { edgePosIngests } from "../db/schema/edge-pos-ingest.ts";
import { edgeAlertId } from "../edge/late-adjustment.ts";
import { isHeartbeatFreshForDayClose } from "../edge/link-freshness.ts";
import { logger } from "../lib/logger.ts";
import {
  domainEventOutbox,
  outlets,
  posDepositRefunds,
} from "../db/schema/index.ts";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import {
  posOrderRefunds,
  posOrders,
  posOrderTenders,
  posOrderVoids,
} from "../db/schema/pos-order.ts";
import {
  cashMovementOutcomes,
  cashMovements,
  posDailyCloses,
  posShifts,
} from "../db/schema/pos-shift.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";
import { outletTarget } from "./device-pin-support.ts";
import { activeFailoverWindow } from "./edge-failover-window.ts";
import { revokeActingStaffForOutlet } from "./pos-acting-staff-revoke.ts";
import { reportablePosOrders } from "./device-training.ts";
import { orderRevenueSplit } from "./order-revenue.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";
import { isEdgeProcess } from "./pos-edge-outlet.ts";
import {
  posDayInventoryPort,
  posOutletReceiptGapsPort,
} from "./pos-shift-ports.ts";

type DayCaller = { userId: UserId };
type CloseBusinessDayInput = z.infer<typeof closeBusinessDayInputSchema>;

const NIL_DEVICE = "00000000-0000-0000-0000-000000000000";
const EVENT_DESTINATION = "cloud-sync";
// Founder Q9 (2026-11-08): only the outlet manager closes the business day
// (`pos.day.close`, granted to outlet_manager and general_manager). Shift
// supervisors may read the recap but not close it.
const CLOSE_PERMISSIONS = ["pos.day.close"] as const;
const READ_PERMISSIONS = [
  "pos.day.close",
  "shift.cash.view_all",
  "shift.cash.approve_close",
] as const;
const AUDIT_SAFE_FIELDS = [
  "id",
  "businessDate",
  "orderCount",
  "totalSalesIdr",
  "totalRefundsIdr",
  "totalVoidsIdr",
  "totalVarianceIdr",
  "inventoryDeductionApplied",
] as const;

// ---- Helpers ----------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Fingerprint of the request; key order is fixed, so the JSON is canonical. */
function closeFingerprint(
  userId: string,
  outletId: string,
  input: CloseBusinessDayInput,
): string {
  return sha256(
    JSON.stringify({
      op: "pos_day.close",
      outletId,
      userId,
      body: {
        businessDate: input.businessDate,
        inventoryDeduction: input.inventoryDeduction,
      },
    }),
  );
}

async function loadOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<typeof outlets.$inferSelect> {
  assertOutletInScope(context.outletScope, outletId);
  const [row] = await tx
    .select()
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  return row;
}

/** Fail closed: the caller must hold one of `permissions` on the outlet. */
async function assertApprover(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  outletId: OutletId,
  now: Date,
  permissions: readonly PermissionCode[],
): Promise<ReturnType<typeof resolveAccessSnapshot>> {
  assertOutletInScope(context.outletScope, outletId);
  const data = await loadTenantAccessInTransaction(tx, context, userId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId,
    ...data,
    mfaVerified: false,
    now,
  });
  const allowed = permissions.some((code) =>
    snapshot.allows(code, outletTarget(outletId)),
  );
  if (!allowed)
    throw new CoreError(
      "FORBIDDEN",
      "Anda tidak berwenang melihat atau menutup hari kerja outlet ini.",
    );
  return snapshot;
}

/**
 * POS-03 blind rule on the day report (legend-awg5p, CTO 9 Nov). A reader
 * below the outlet manager (no `pos.day.close`) who holds a shift on this
 * business day must not read the drawer figures of their own shift here
 * either, before or after the close: the cash variance and expired cash outs
 * of every device they ran a shift on, the outlet totals that sum them, and
 * the captured / refunded / net per method (on a one-device outlet those are
 * their own cash). The whole device row is blank, so another shift on the same
 * device is hidden with it (fail closed). The outlet manager reviews.
 */
async function blindOwnDrawer(
  tx: Tx,
  context: ScopedTenantContext,
  snapshot: ReturnType<typeof resolveAccessSnapshot>,
  caller: DayCaller,
  outletId: OutletId,
  recap: EndOfDayRecap,
): Promise<EndOfDayRecapView> {
  if (snapshot.allows("pos.day.close", outletTarget(outletId))) return recap;
  const own = await tx
    .selectDistinct({ deviceId: posShifts.deviceId })
    .from(posShifts)
    .where(
      and(
        eq(posShifts.tenantId, context.tenant.tenantId),
        eq(posShifts.outletId, outletId),
        eq(posShifts.businessDate, recap.businessDate),
        // Ids compare case-insensitively, as sameUser does in pos-shift.
        eq(sql`lower(${posShifts.cashierId})`, caller.userId.toLowerCase()),
      ),
    );
  if (own.length === 0) return recap;
  const ownDevices = new Set(own.map((row) => row.deviceId.toLowerCase()));
  const devices = recap.devices.map((device) =>
    ownDevices.has(device.deviceId.toLowerCase())
      ? { ...device, cashVarianceIdr: null, expiredCashOutIdr: null }
      : device,
  );
  // An own shift whose device has no row (no sales, no shift row keyed the
  // same) still blanks the recap: never fall back to the full figures.
  if (!devices.some((device) => device.cashVarianceIdr === null))
    for (const device of devices) {
      device.cashVarianceIdr = null;
      device.expiredCashOutIdr = null;
    }
  return endOfDayBlindRecapSchema.parse({
    ...recap,
    devices,
    // Every method, used today or not: which methods appear would tell a
    // one-device, cash-only day apart (sales − refunds − voids = cash net).
    tenders: POS_TENDER_METHODS.map((method) => ({
      method,
      capturedIdr: null,
      refundedIdr: null,
      netIdr: null,
    })),
    totalVarianceIdr: null,
    totalExpiredCashOutIdr: null,
    drawerFiguresHidden: true,
  });
}

// ---- Recap ------------------------------------------------------------------

type DeviceAcc = {
  deviceId: string;
  orderCount: number;
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
  totalIdr: number;
  voidedOrderCount: number;
  voidedAmountIdr: number;
  refundCount: number;
  refundAmountIdr: number;
  depositAppliedIdr: number;
  depositRefundedIdr: number;
  shiftCount: number;
  cashVarianceIdr: number;
  expiredCashOutIdr: number;
  closed: boolean;
};

function newDevice(deviceId: string): DeviceAcc {
  return {
    deviceId,
    orderCount: 0,
    grossSalesIdr: 0,
    discountIdr: 0,
    serviceChargeIdr: 0,
    taxIdr: 0,
    roundingIdr: 0,
    totalIdr: 0,
    voidedOrderCount: 0,
    voidedAmountIdr: 0,
    refundCount: 0,
    refundAmountIdr: 0,
    depositAppliedIdr: 0,
    depositRefundedIdr: 0,
    shiftCount: 0,
    cashVarianceIdr: 0,
    expiredCashOutIdr: 0,
    closed: true,
  };
}

/**
 * Which rows a recap reads. `cloud`: every row (live view, cloud Tutup Hari).
 * `edgeComparable` (1269 E3): what the edge froze, so no late adjustments, no
 * failover rows (1271 F5, D1: the edge never had them) and no receipt gaps.
 * `edgeMirror` (1271 F5, D5): the stored recap of an edge close whose date has
 * failover rows: the comparable rows plus the failover rows; only the F-run
 * gaps of the date (the edge reported its own). `cloud` counts every other
 * run's gaps outlet-wide and the F-run gaps of the date.
 */
type RecapMode = "cloud" | "edgeComparable" | "edgeMirror";

type OutletReceiptGap = { prefix: string; deviceId: string; missing: number[] };

/**
 * 1271 F5 (re-review P3): the business date a missing F number belongs to:
 * the nearest issued receipt above it (the number was taken before that
 * sale), else the date the run last moved (an end gap: never a date the
 * receipt below it may already have closed), else the nearest issued receipt
 * below it. Null when the run has nothing to date it by.
 */
export function failoverGapBusinessDate(
  missing: number,
  issued: readonly { sequenceNumber: number; businessDate: string }[],
  movedAt: Date | null,
  clock: BusinessDayClock,
): string | null {
  const sorted = [...issued].sort(
    (a, b) => a.sequenceNumber - b.sequenceNumber,
  );
  const above = sorted.find((row) => row.sequenceNumber > missing);
  if (above) return String(above.businessDate);
  if (movedAt) return businessDateOf(movedAt, clock);
  const below = sorted.filter((row) => row.sequenceNumber < missing).at(-1);
  return below ? String(below.businessDate) : null;
}

/**
 * 1271 F5 (CTO 27 Nov): the missing numbers of F (failover) runs that belong
 * to `businessDate`. An F number is issued in the sale's own transaction, so a
 * gap cannot hide a paid sale: it never blocks Tutup Hari and is never written
 * off, it is counted on its own date only (see failoverGapBusinessDate).
 */
async function failoverGapsOnDate(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: typeof outlets.$inferSelect,
  gaps: readonly OutletReceiptGap[],
  businessDate: string,
): Promise<OutletReceiptGap[]> {
  const runs = gaps.filter((run) => isFailoverReceiptPrefix(run.prefix));
  if (runs.length === 0) return [];
  const tenantId = context.tenant.tenantId;
  const prefixes = runs.map((run) => run.prefix);
  const issued = await tx
    .select({
      prefix: receiptSequences.prefix,
      sequenceNumber: posReceipts.sequenceNumber,
      businessDate: orders.businessDate,
    })
    .from(posReceipts)
    .innerJoin(
      receiptSequences,
      and(
        eq(receiptSequences.tenantId, posReceipts.tenantId),
        eq(receiptSequences.id, posReceipts.sequenceId),
      ),
    )
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posReceipts.tenantId),
        eq(orders.id, posReceipts.orderId),
      ),
    )
    .where(
      and(
        eq(posReceipts.tenantId, tenantId),
        eq(receiptSequences.outletId, outlet.id as OutletId),
        inArray(receiptSequences.prefix, prefixes),
      ),
    );
  const moved = await tx
    .select({
      prefix: receiptSequences.prefix,
      updatedAt: sql<Date>`max(${receiptSequences.updatedAt})`.mapWith(
        (value: string | Date) => new Date(value),
      ),
    })
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.outletId, outlet.id as OutletId),
        inArray(receiptSequences.prefix, prefixes),
      ),
    )
    .groupBy(receiptSequences.prefix);
  const clock = outletBusinessDayClock(outlet);
  const result: OutletReceiptGap[] = [];
  for (const run of runs) {
    const own = issued.filter((row) => row.prefix === run.prefix);
    const movedAt = moved.find((row) => row.prefix === run.prefix)?.updatedAt;
    const missing = run.missing.filter(
      (n) =>
        failoverGapBusinessDate(n, own, movedAt ?? null, clock) ===
        businessDate,
    );
    if (missing.length > 0) result.push({ ...run, missing });
  }
  return result;
}

/**
 * 1271 F5 (CTO 27 Nov): owners (and the outlet's supervisors) hear once per
 * outlet and date that F numbers are missing; the technical team investigates.
 */
export async function alertFailoverReceiptGaps(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: OutletId; businessDate: string; count: number },
): Promise<void> {
  if (input.count <= 0) return;
  const tenantId = context.tenant.tenantId;
  const id = edgeAlertId(
    "failover_receipt_gap",
    tenantId,
    input.outletId,
    input.businessDate,
  );
  try {
    await tx.transaction((sp) =>
      notifyOutletSupervisors(
        sp,
        context,
        {
          tenantId,
          outletId: input.outletId,
          alsoOwners: true,
          id,
          eventName: "pos_day.failover_receipt_gap",
          aggregateType: "pos_day",
          aggregateId: id,
          payload: {
            businessDate: input.businessDate,
            count: String(input.count),
          },
          title: "Nomor struk mode cloud hilang",
          body: `Ada ${input.count} nomor struk mode cloud (F) yang hilang pada hari ${input.businessDate}. Tutup Hari tetap berjalan; tim teknis memeriksanya.`,
        },
        new Date(),
      ),
    );
  } catch {
    logger.warn(
      { outletId: input.outletId },
      "Failover receipt gap alert failed",
    );
  }
}

/** The recap of one business date, computed live from the rows (status open). */
async function computeRecap(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: typeof outlets.$inferSelect,
  outletId: OutletId,
  businessDate: string,
  now: Date,
  mode: RecapMode = "cloud",
): Promise<EndOfDayRecap> {
  const tenantId = context.tenant.tenantId;
  const edgeRows = mode !== "cloud";
  // 1269 E3: late adjustments (legend-k0i8) belong to this open day in the
  // cloud but are not in the recap the edge froze for it.
  const notLateOrder = edgeRows
    ? sql`NOT EXISTS (SELECT 1 FROM ${edgeOrderIngests} WHERE ${edgeOrderIngests.tenantId} = ${orders.tenantId} AND ${edgeOrderIngests.orderId} = ${orders.id} AND ${edgeOrderIngests.lateBusinessDate} IS NOT NULL)`
    : undefined;
  const notLateShift = edgeRows
    ? sql`NOT EXISTS (SELECT 1 FROM ${edgePosIngests} WHERE ${edgePosIngests.tenantId} = ${posShifts.tenantId} AND ${edgePosIngests.kind} = 'shift' AND ${edgePosIngests.aggregateId} = ${posShifts.id} AND ${edgePosIngests.lateBusinessDate} IS NOT NULL)`
    : undefined;
  // 1271 F5: failover orders (and their voids and refunds) and failover shifts
  // are cloud-only; the edge recap never holds them.
  const notFailoverOrder =
    mode === "edgeComparable" ? isNull(posOrders.failoverWindowId) : undefined;
  const notFailoverShift =
    mode === "edgeComparable" ? isNull(posShifts.failoverWindowId) : undefined;
  const range = businessDayRange(
    businessDate as never,
    outletBusinessDayClock(outlet),
  );
  const devices = new Map<string, DeviceAcc>();
  const deviceOf = (id: string | null | undefined): DeviceAcc => {
    const key = (id ?? NIL_DEVICE).toLowerCase();
    let acc = devices.get(key);
    if (!acc) {
      acc = newDevice(key);
      devices.set(key, acc);
    }
    return acc;
  };

  // Sales set.
  const sales = await tx
    .select({
      id: orders.id,
      channel: orders.channel,
      subtotalIdr: orders.subtotalIdr,
      discountIdr: orders.discountIdr,
      serviceChargeIdr: orders.serviceChargeIdr,
      taxIdr: orders.taxIdr,
      roundingIdr: orders.roundingIdr,
      totalIdr: orders.totalIdr,
      depositAppliedIdr: orders.depositAppliedIdr,
      pricesIncludeTax: orders.pricesIncludeTax,
      deviceId: posOrders.deviceId,
      shiftDeviceId: posShifts.deviceId,
    })
    .from(orders)
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, orders.tenantId),
        eq(posOrders.orderId, orders.id),
        eq(posOrders.outletId, orders.outletId),
      ),
    )
    .leftJoin(
      posShifts,
      and(
        eq(posShifts.tenantId, posOrders.tenantId),
        eq(posShifts.outletId, posOrders.outletId),
        eq(posShifts.id, posOrders.shiftId),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, outletId),
        eq(orders.businessDate, businessDate),
        eq(orders.status, "completed"),
        reportablePosOrders(),
        notLateOrder,
        notFailoverOrder,
      ),
    );
  const channels = new Map<string, { orderCount: number; totalIdr: number }>();
  let salesTotal = 0;
  let depositAppliedTotal = 0;
  for (const row of sales) {
    const acc = deviceOf(row.deviceId ?? row.shiftDeviceId);
    acc.orderCount += 1;
    // legend-npnh: an inclusive order's subtotal already holds service + tax.
    acc.grossSalesIdr += orderRevenueSplit({
      subtotalIdr: Number(row.subtotalIdr),
      discountIdr: Number(row.discountIdr),
      serviceChargeIdr: Number(row.serviceChargeIdr),
      taxIdr: Number(row.taxIdr),
      roundingIdr: Number(row.roundingIdr),
      totalIdr: Number(row.totalIdr),
      pricesIncludeTax: row.pricesIncludeTax,
    }).grossSalesIdr;
    acc.discountIdr += Number(row.discountIdr);
    acc.serviceChargeIdr += Number(row.serviceChargeIdr);
    acc.taxIdr += Number(row.taxIdr);
    acc.roundingIdr += Number(row.roundingIdr);
    acc.totalIdr += Number(row.totalIdr);
    salesTotal += Number(row.totalIdr);
    // legend-vet9d: DP is a liability bucket beside the tenders, never a tender.
    acc.depositAppliedIdr += Number(row.depositAppliedIdr);
    depositAppliedTotal += Number(row.depositAppliedIdr);
    const channel = channels.get(row.channel) ?? { orderCount: 0, totalIdr: 0 };
    channel.orderCount += 1;
    channel.totalIdr += Number(row.totalIdr);
    channels.set(row.channel, channel);
  }

  // Captured tenders of the sales set, per method.
  const capturedRows = await tx
    .select({
      method: posOrderTenders.method,
      amount: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)::text`,
    })
    .from(posOrderTenders)
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posOrderTenders.tenantId),
        eq(orders.id, posOrderTenders.orderId),
      ),
    )
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, orders.tenantId),
        eq(posOrders.orderId, orders.id),
        eq(posOrders.outletId, orders.outletId),
      ),
    )
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        eq(posOrderTenders.outletId, outletId),
        eq(posOrderTenders.status, "captured"),
        eq(orders.tenantId, tenantId),
        eq(orders.outletId, outletId),
        eq(orders.businessDate, businessDate),
        eq(orders.status, "completed"),
        reportablePosOrders(),
        notLateOrder,
        notFailoverOrder,
      ),
    )
    .groupBy(posOrderTenders.method);
  const captured = new Map<string, number>();
  let capturedTotal = 0;
  for (const row of capturedRows) {
    captured.set(row.method, Number(row.amount));
    capturedTotal += Number(row.amount);
  }
  if (capturedTotal + depositAppliedTotal !== salesTotal)
    throw new CoreError(
      "CONFLICT",
      "Rekap hari ini tidak seimbang: pembayaran yang diterima ditambah DP tidak sama dengan total penjualan.",
    );

  // Voids (paid sales voided by correction) dated this business day.
  const refunded = new Map<string, number>();
  const addRefunded = (method: string, amount: number) =>
    refunded.set(method, (refunded.get(method) ?? 0) + amount);
  const voids = await tx
    .select({
      orderId: posOrderVoids.orderId,
      amountIdr: posOrderVoids.amountIdr,
      depositAppliedIdr: orders.depositAppliedIdr,
      deviceId: posOrders.deviceId,
      shiftDeviceId: posShifts.deviceId,
    })
    .from(posOrderVoids)
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderVoids.tenantId),
        eq(posOrders.orderId, posOrderVoids.orderId),
        eq(posOrders.outletId, posOrderVoids.outletId),
      ),
    )
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posOrderVoids.tenantId),
        eq(orders.id, posOrderVoids.orderId),
      ),
    )
    .leftJoin(
      posShifts,
      and(
        eq(posShifts.tenantId, posOrders.tenantId),
        eq(posShifts.outletId, posOrders.outletId),
        eq(posShifts.id, posOrders.shiftId),
      ),
    )
    .leftJoin(
      edgeOrderIngests,
      and(
        eq(edgeOrderIngests.tenantId, posOrderVoids.tenantId),
        eq(edgeOrderIngests.orderId, posOrderVoids.orderId),
      ),
    )
    .where(
      and(
        eq(posOrderVoids.tenantId, tenantId),
        eq(posOrderVoids.outletId, outletId),
        // legend-k0i8: a late edge void counts on the day it was posted to.
        or(
          and(
            gte(posOrderVoids.voidedAt, range.start),
            lt(posOrderVoids.voidedAt, range.end),
            isNull(edgeOrderIngests.lateVoidBusinessDate),
          ),
          edgeRows
            ? undefined
            : eq(edgeOrderIngests.lateVoidBusinessDate, businessDate),
        ),
        reportablePosOrders(),
        notFailoverOrder,
      ),
    );
  // legend-vet9d: a DP order is never voided (voidPosOrder refuses it); a void
  // on one cannot be paid back through its tenders, so fail closed.
  if (voids.some((row) => Number(row.depositAppliedIdr) > 0))
    throw new CoreError(
      "CONFLICT",
      "Rekap hari ini tidak seimbang: ada void pada pesanan yang memakai DP.",
    );
  if (voids.length > 0) {
    const tenders = await tx
      .select({
        orderId: posOrderTenders.orderId,
        method: posOrderTenders.method,
        amountIdr: posOrderTenders.amountIdr,
      })
      .from(posOrderTenders)
      .where(
        and(
          eq(posOrderTenders.tenantId, tenantId),
          eq(posOrderTenders.outletId, outletId),
          eq(posOrderTenders.status, "captured"),
          inArray(
            posOrderTenders.orderId,
            voids.map((row) => row.orderId),
          ),
        ),
      )
      .orderBy(asc(posOrderTenders.requestedAt), asc(posOrderTenders.id));
    for (const row of voids) {
      const acc = deviceOf(row.deviceId ?? row.shiftDeviceId);
      acc.voidedOrderCount += 1;
      acc.voidedAmountIdr += Number(row.amountIdr);
      // The cash (or other tender) goes back through what the sale paid with.
      let remaining = Number(row.amountIdr);
      for (const tender of tenders) {
        if (remaining === 0) break;
        if (tender.orderId.toLowerCase() !== row.orderId.toLowerCase())
          continue;
        const part = Math.min(remaining, Number(tender.amountIdr));
        addRefunded(tender.method, part);
        remaining -= part;
      }
      if (remaining !== 0)
        throw new CoreError(
          "CONFLICT",
          "Rekap hari ini tidak seimbang: void tidak dapat dialokasikan ke pembayaran asal.",
        );
    }
  }

  // Refunds dated this business day.
  const refunds = await tx
    .select({
      amountIdr: posOrderRefunds.amountIdr,
      lines: posOrderRefunds.lines,
      deviceId: posOrders.deviceId,
      shiftDeviceId: posShifts.deviceId,
    })
    .from(posOrderRefunds)
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderRefunds.tenantId),
        eq(posOrders.orderId, posOrderRefunds.orderId),
        eq(posOrders.outletId, posOrderRefunds.outletId),
      ),
    )
    .leftJoin(
      posShifts,
      and(
        eq(posShifts.tenantId, posOrders.tenantId),
        eq(posShifts.outletId, posOrders.outletId),
        eq(posShifts.id, posOrders.shiftId),
      ),
    )
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.outletId, outletId),
        // A Rp0 goods return (legend-wkl3) moved no money: not a refund here,
        // unless it paid DP back (legend-vet9d): that counts as a refund.
        or(
          gt(posOrderRefunds.amountIdr, idr(0)),
          sql`exists (select 1 from ${posDepositRefunds} where ${posDepositRefunds.tenantId} = ${posOrderRefunds.tenantId} and ${posDepositRefunds.posRefundId} = ${posOrderRefunds.id})`,
        ),
        gte(posOrderRefunds.refundedAt, range.start),
        lt(posOrderRefunds.refundedAt, range.end),
        reportablePosOrders(),
        notFailoverOrder,
      ),
    );
  for (const row of refunds) {
    const acc = deviceOf(row.deviceId ?? row.shiftDeviceId);
    acc.refundCount += 1;
    acc.refundAmountIdr += Number(row.amountIdr);
    const lineTotal = row.lines.reduce(
      (sum, line) => sum + Number(line.amountIdr),
      0,
    );
    if (lineTotal !== Number(row.amountIdr))
      throw new CoreError(
        "CONFLICT",
        "Rekap hari ini tidak seimbang: baris refund tidak sama dengan nilai refund.",
      );
    for (const line of row.lines)
      addRefunded(line.method, Number(line.amountIdr));
  }

  // legend-vet9d: DP paid back by this day's refunds (additive to the tender
  // part above). Read from POS-native rows only, never `payment_refunds`, so a
  // WS-05 mirror of the same return cannot be counted twice.
  const depositRows = await tx
    .select({
      depositOrderId: posDepositRefunds.orderId,
      refundOrderId: posOrderRefunds.orderId,
      amountIdr: posDepositRefunds.amountIdr,
      releasedAt: posDepositRefunds.releasedAt,
      depositOutletId: posDepositRefunds.outletId,
      refundOutletId: posOrderRefunds.outletId,
      orderDepositIdr: orders.depositAppliedIdr,
      deviceId: posOrders.deviceId,
      shiftDeviceId: posShifts.deviceId,
    })
    .from(posDepositRefunds)
    .innerJoin(
      posOrderRefunds,
      and(
        eq(posOrderRefunds.tenantId, posDepositRefunds.tenantId),
        eq(posOrderRefunds.id, posDepositRefunds.posRefundId),
      ),
    )
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, posOrderRefunds.tenantId),
        eq(posOrders.orderId, posOrderRefunds.orderId),
        eq(posOrders.outletId, posOrderRefunds.outletId),
      ),
    )
    .innerJoin(
      orders,
      and(
        eq(orders.tenantId, posOrders.tenantId),
        eq(orders.id, posOrders.orderId),
      ),
    )
    .leftJoin(
      posShifts,
      and(
        eq(posShifts.tenantId, posOrders.tenantId),
        eq(posShifts.outletId, posOrders.outletId),
        eq(posShifts.id, posOrders.shiftId),
      ),
    )
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.outletId, outletId),
        gte(posOrderRefunds.refundedAt, range.start),
        lt(posOrderRefunds.refundedAt, range.end),
        reportablePosOrders(),
        notFailoverOrder,
      ),
    );
  for (const row of depositRows) {
    if (row.depositOrderId.toLowerCase() !== row.refundOrderId.toLowerCase())
      throw new CoreError(
        "CONFLICT",
        "Rekap hari ini tidak seimbang: order refund DP tidak sama dengan order refund.",
      );
    if (row.depositOutletId.toLowerCase() !== row.refundOutletId.toLowerCase())
      throw new CoreError(
        "CONFLICT",
        "Rekap hari ini tidak seimbang: outlet refund DP tidak sama dengan outlet refund.",
      );
    if (row.releasedAt < range.start || row.releasedAt >= range.end)
      throw new CoreError(
        "CONFLICT",
        "Rekap hari ini tidak seimbang: tanggal pelepasan DP di luar hari kerja refund.",
      );
    if (Number(row.orderDepositIdr) <= 0)
      throw new CoreError(
        "CONFLICT",
        "Rekap hari ini tidak seimbang: refund DP pada pesanan tanpa DP.",
      );
    deviceOf(row.deviceId ?? row.shiftDeviceId).depositRefundedIdr += Number(
      row.amountIdr,
    );
  }
  if (depositRows.length > 0) {
    // Never pay back more DP than the order took, counting every earlier day.
    const paidBack = await tx
      .select({
        orderId: posDepositRefunds.orderId,
        amount: sql<string>`coalesce(sum(${posDepositRefunds.amountIdr}), 0)::text`,
      })
      .from(posDepositRefunds)
      .innerJoin(
        posOrderRefunds,
        and(
          eq(posOrderRefunds.tenantId, posDepositRefunds.tenantId),
          eq(posOrderRefunds.id, posDepositRefunds.posRefundId),
        ),
      )
      .where(
        and(
          eq(posDepositRefunds.tenantId, tenantId),
          inArray(
            posDepositRefunds.orderId,
            depositRows.map((row) => row.depositOrderId),
          ),
          lt(posOrderRefunds.refundedAt, range.end),
        ),
      )
      .groupBy(posDepositRefunds.orderId);
    const depositOf = new Map(
      depositRows.map((row) => [
        row.depositOrderId.toLowerCase(),
        Number(row.orderDepositIdr),
      ]),
    );
    for (const row of paidBack)
      if (Number(row.amount) > (depositOf.get(row.orderId.toLowerCase()) ?? 0))
        throw new CoreError(
          "CONFLICT",
          "Rekap hari ini tidak seimbang: refund DP melebihi DP pesanan asal.",
        );
  }

  // Shifts of this business day: count, variance, all closed?
  const shifts = await tx
    .select({
      deviceId: posShifts.deviceId,
      status: posShifts.status,
      varianceIdr: posShifts.varianceIdr,
      heldCashOutIdr: posShifts.heldCashOutIdr,
      differenceIdr: posShifts.differenceIdr,
    })
    .from(posShifts)
    .where(
      and(
        eq(posShifts.tenantId, tenantId),
        eq(posShifts.outletId, outletId),
        eq(posShifts.businessDate, businessDate),
        notLateShift,
        notFailoverShift,
      ),
    );
  for (const row of shifts) {
    const acc = deviceOf(row.deviceId);
    acc.shiftCount += 1;
    // Book variance, as the shift close booked it (cashier_shift.closed
    // differenceIdr, legend-ifnb): difference_idr, counted − (expected −
    // held refund and void cash) (legend-y9bf). Held cash refunds already sit
    // in refundedIdr, so counted − expected would count them twice. A shift
    // closed before difference_idr booked counted − (expected − held).
    if (row.status === "closed")
      acc.cashVarianceIdr +=
        row.differenceIdr !== null
          ? Number(row.differenceIdr)
          : Number(row.varianceIdr ?? 0) + Number(row.heldCashOutIdr);
    else acc.closed = false;
  }

  // Held cash outs / drops that expired at the close of this day's shifts
  // (legend-y9bf): the cash stayed in the drawer and nothing was booked.
  const expired = await tx
    .select({
      deviceId: posShifts.deviceId,
      amountIdr: sql<string>`coalesce(sum(${cashMovements.amountIdr}), 0)`,
    })
    .from(cashMovementOutcomes)
    .innerJoin(
      cashMovements,
      and(
        eq(cashMovements.tenantId, cashMovementOutcomes.tenantId),
        eq(cashMovements.id, cashMovementOutcomes.movementId),
      ),
    )
    .innerJoin(
      posShifts,
      and(
        eq(posShifts.tenantId, cashMovementOutcomes.tenantId),
        eq(posShifts.id, cashMovementOutcomes.shiftId),
      ),
    )
    .where(
      and(
        eq(cashMovementOutcomes.tenantId, tenantId),
        eq(cashMovementOutcomes.outletId, outletId),
        eq(cashMovementOutcomes.outcome, "expired"),
        eq(posShifts.businessDate, businessDate),
        notLateShift,
        notFailoverShift,
      ),
    )
    .groupBy(posShifts.deviceId);
  for (const row of expired)
    deviceOf(row.deviceId).expiredCashOutIdr += Number(row.amountIdr);

  if (devices.size === 0) deviceOf(NIL_DEVICE);
  const deviceRows = [...devices.values()].sort((a, b) =>
    a.deviceId.localeCompare(b.deviceId),
  );

  const methods = POS_TENDER_METHODS.filter(
    (method) => captured.has(method) || refunded.has(method),
  );
  const tenderRows = (methods.length > 0 ? methods : (["cash"] as const)).map(
    (method) => {
      const capturedIdr = captured.get(method) ?? 0;
      const refundedIdr = refunded.get(method) ?? 0;
      return {
        method,
        capturedIdr,
        refundedIdr,
        netIdr: capturedIdr - refundedIdr,
      };
    },
  );
  const channelRows =
    channels.size > 0
      ? [...channels.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([channel, value]) => ({ channel, ...value }))
      : [{ channel: "pos", orderCount: 0, totalIdr: 0 }];

  const sum = (pick: (device: DeviceAcc) => number) =>
    deviceRows.reduce((total, device) => total + pick(device), 0);
  // legend-21c8n: the same outlet-wide numbers RECEIPT_SEQUENCE_GAP names.
  // Review K F1 + CTO 27 Nov: an F-run gap counts on its own date only.
  const outletGaps =
    mode === "edgeComparable"
      ? []
      : await posOutletReceiptGapsPort()(tx, context, { outletId });
  const receiptGaps = [
    ...(mode === "cloud"
      ? outletGaps.filter((run) => !isFailoverReceiptPrefix(run.prefix))
      : []),
    ...(await failoverGapsOnDate(
      tx,
      context,
      outlet,
      outletGaps,
      businessDate,
    )),
  ];
  const unsyncedReceiptCount = receiptGaps.reduce(
    (total, run) => total + run.missing.length,
    0,
  );
  return endOfDayRecapSchema.parse({
    id: randomUUID(),
    tenantId,
    outletId,
    businessDate,
    status: "open",
    generatedAt: toIsoDateTime(now),
    closedAt: null,
    closedBy: null,
    devices: deviceRows,
    tenders: tenderRows,
    channels: channelRows,
    totalSalesIdr: sum((device) => device.totalIdr),
    totalRefundsIdr: sum((device) => device.refundAmountIdr),
    totalVoidsIdr: sum((device) => device.voidedAmountIdr),
    totalVarianceIdr: sum((device) => device.cashVarianceIdr),
    totalExpiredCashOutIdr: sum((device) => device.expiredCashOutIdr),
    totalDepositAppliedIdr: sum((device) => device.depositAppliedIdr),
    totalDepositRefundedIdr: sum((device) => device.depositRefundedIdr),
    inventoryDeductionApplied: false,
    unsyncedReceiptCount,
    accountingSync: { status: "pending", journalCount: 0, postedAt: null },
  });
}

/**
 * 1269 E3: the cloud's figures of one business day of an edge outlet, to compare
 * with the recap its edge froze: without late adjustments, receipt gaps and
 * (1271 F5) failover rows.
 */
export function computeEdgeComparableRecap(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: typeof outlets.$inferSelect,
  outletId: OutletId,
  businessDate: string,
  now: Date,
): Promise<EndOfDayRecap> {
  return computeRecap(
    tx,
    context,
    outlet,
    outletId,
    businessDate,
    now,
    "edgeComparable",
  );
}

/**
 * 1271 F5 (D5): the cloud's recap of an edge-closed day with failover rows:
 * the edge's rows (as compared) plus the failover rows. Late adjustments stay
 * out, as in the comparable recap; `unsyncedReceiptCount` counts the F-run
 * gaps of the date only (the caller adds the edge's own count).
 */
export function computeEdgeMirrorRecap(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: typeof outlets.$inferSelect,
  outletId: OutletId,
  businessDate: string,
  now: Date,
): Promise<EndOfDayRecap> {
  return computeRecap(
    tx,
    context,
    outlet,
    outletId,
    businessDate,
    now,
    "edgeMirror",
  );
}

// ---- Public API -------------------------------------------------------------

/** GET end-of-day recap: the frozen recap of a closed day, else the live one. */
export async function getEndOfDayRecap(
  context: ScopedTenantContext,
  caller: DayCaller,
  outletId: OutletId,
  businessDate: string,
): Promise<EndOfDayRecapView> {
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const outlet = await loadOutlet(tx, context, outletId);
    const snapshot = await assertApprover(
      tx,
      context,
      caller.userId,
      outletId,
      now,
      READ_PERMISSIONS,
    );
    const [closed] = await tx
      .select({ recap: posDailyCloses.recap })
      .from(posDailyCloses)
      .where(
        and(
          eq(posDailyCloses.tenantId, context.tenant.tenantId),
          eq(posDailyCloses.outletId, outletId),
          eq(posDailyCloses.businessDate, businessDate),
        ),
      );
    const recap = closed
      ? endOfDayRecapSchema.parse(closed.recap)
      : await computeRecap(tx, context, outlet, outletId, businessDate, now);
    return blindOwnDrawer(tx, context, snapshot, caller, outletId, recap);
  });
}

/**
 * legend-k0i8 + founder Q24 (docs/design/edge-cloud-failover.md, "Founder
 * decisions"): an outlet served by a HEALTHY active primary edge closes its
 * day on the edge (day/close is an edge route). Late offline orders reach the
 * cloud only through the order ingest, so a cloud close would freeze a recap
 * that misses them: refuse with 409 DAY_CLOSE_ON_EDGE. An active primary whose
 * heartbeat is older than EDGE_DAY_CLOSE_STALE_SECONDS (default 15 min, not the
 * 45 s link freshness: a short link drop must not close a live edge's day; edge
 * down at end of day) must not strand the day, so the
 * cloud may close it (Q24); edge data that arrives later is a late adjustment
 * (full flow with the failover bead legend-b3k). Returns true for that stale
 * case so the caller audits it. Same edge-process rule as pos-receipt (static
 * EDGE_MODE counts in the boot window): the edge itself refuses only while its
 * failover window copy is open (1271 D5, FAILOVER_ACTIVE).
 */
async function assertDayClosesOnCloud(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  now: Date,
): Promise<{ staleEdge: boolean }> {
  if (isEdgeProcess()) {
    // 1271 D5: the cloud sells for this outlet until the window is closed and
    // its closing event applied here; the edge's day would miss those sales.
    if (await activeFailoverWindow(tx, context.tenant.tenantId, outletId))
      throw new PosError("FAILOVER_ACTIVE");
    return { staleEdge: false };
  }
  const [edge] = await tx
    .select({ lastHeartbeatAt: edgeNodes.lastHeartbeatAt })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, context.tenant.tenantId),
        eq(edgeNodes.outletId, outletId),
        eq(edgeNodes.role, "primary"),
        eq(edgeNodes.status, "active"),
      ),
    )
    .limit(1);
  if (!edge) return { staleEdge: false };
  if (isHeartbeatFreshForDayClose(edge.lastHeartbeatAt, now)) {
    // 1271 F5 (CTO 27 Nov): a window opened while the edge was live (override)
    // blocks the close on both sides until the outlet is back on its edge.
    if (await activeFailoverWindow(tx, context.tenant.tenantId, outletId))
      throw new PosError(
        "FAILOVER_ACTIVE",
        "Selesaikan Kembali ke edge dulu, lalu Tutup Hari di kasir edge.",
      );
    throw new PosError("DAY_CLOSE_ON_EDGE");
  }
  return { staleEdge: true };
}

/** POST close business day (Tutup Hari): freezes the recap, emits `day.closed`. */
export async function closePosDay(
  context: ScopedTenantContext,
  caller: DayCaller,
  outletId: OutletId,
  input: CloseBusinessDayInput,
): Promise<EndOfDayRecap> {
  const body = closeBusinessDayInputSchema.parse(input);
  const now = new Date();
  const tenantId = context.tenant.tenantId;
  const fingerprint = closeFingerprint(caller.userId, outletId, body);
  return withTenant(db, context, async (tx) => {
    const outlet = await loadOutlet(tx, context, outletId);
    await assertApprover(
      tx,
      context,
      caller.userId,
      outletId,
      now,
      CLOSE_PERMISSIONS,
    );
    // Same per-outlet lock as openPosShift first, so a shift cannot open on
    // a day that is closing (check-then-insert on both sides), then the day.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-shift-open:${tenantId}:${outletId}`}, 0))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`pos-day:${tenantId}:${outletId}:${body.businessDate}`}))`,
    );

    // Replay by key: same body -> the stored recap, other body -> refused.
    const [replay] = await tx
      .select({
        recap: posDailyCloses.recap,
        fingerprint: posDailyCloses.requestFingerprint,
      })
      .from(posDailyCloses)
      .where(
        and(
          eq(posDailyCloses.tenantId, tenantId),
          eq(posDailyCloses.outletId, outletId),
          eq(posDailyCloses.idempotencyKey, body.idempotencyKey),
        ),
      );
    if (replay) {
      if (replay.fingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      return endOfDayRecapSchema.parse(replay.recap);
    }

    // After the replay check, so a retry with the same key still gets 200.
    const { staleEdge } = await assertDayClosesOnCloud(
      tx,
      context,
      outletId,
      now,
    );

    const [existing] = await tx
      .select({ id: posDailyCloses.id })
      .from(posDailyCloses)
      .where(
        and(
          eq(posDailyCloses.tenantId, tenantId),
          eq(posDailyCloses.outletId, outletId),
          eq(posDailyCloses.businessDate, body.businessDate),
        ),
      );
    if (existing) throw new PosError("BUSINESS_DAY_ALREADY_CLOSED");

    // A day is closed only once it has started on the outlet clock: closing a
    // future date would lock tomorrow's shifts before anyone could open them.
    if (body.businessDate > businessDateOf(now, outletBusinessDayClock(outlet)))
      throw new CoreError(
        "CONFLICT",
        "Hari kerja ini belum dimulai dan belum dapat ditutup.",
      );

    // legend-yhia9 D-01: a QR (also a guest split QR) can still be paid.
    const [waitingQr] = await tx
      .select({ id: posQrisHolds.id })
      .from(posQrisHolds)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, posQrisHolds.tenantId),
          eq(orders.id, posQrisHolds.orderId),
        ),
      )
      .where(
        and(
          eq(posQrisHolds.tenantId, tenantId),
          eq(posQrisHolds.outletId, outletId),
          eq(orders.businessDate, body.businessDate),
          inArray(posQrisHolds.state, ["open", "cancelling"]),
        ),
      )
      .limit(1);
    if (waitingQr) throw new PosError("QRIS_HOLD_ACTIVE");

    const [openShift] = await tx
      .select({ id: posShifts.id })
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, tenantId),
          eq(posShifts.outletId, outletId),
          lte(posShifts.businessDate, body.businessDate),
          eq(posShifts.status, "open"),
        ),
      )
      .limit(1);
    if (openShift)
      throw new CoreError("CONFLICT", "Masih ada shift kasir yang terbuka.");

    // QR orders never reach `completed`; only orders the POS owns must be final.
    const [pending] = await tx
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(
        posOrders,
        and(
          eq(posOrders.tenantId, orders.tenantId),
          eq(posOrders.orderId, orders.id),
          eq(posOrders.outletId, orders.outletId),
        ),
      )
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.outletId, outletId),
          eq(orders.businessDate, body.businessDate),
          notInArray(orders.status, ["completed", "voided"]),
          // A training order left open never holds the real day (Q63).
          reportablePosOrders(),
        ),
      )
      .limit(1);
    if (pending)
      throw new CoreError("CONFLICT", "Masih ada pesanan yang belum selesai.");

    const open = await computeRecap(
      tx,
      context,
      outlet,
      outletId,
      body.businessDate,
      now,
    );

    // legend-6b0ld: POS-06 covers every run of the outlet, also devices idle
    // today and the cloud sequence. Lost ranges (legend-yd0h8) are not in this
    // result: they are for reconciliation display only and never block the
    // close. One check only (legend-sgh4l): a per-device loop before it hid
    // the message that names the missing numbers.
    // 1271 F5 (CTO 27 Nov): F-run gaps never block; the recap counts the
    // ones of this date and the owners are alerted after the close.
    const outletGaps = (
      await posOutletReceiptGapsPort()(tx, context, { outletId })
    ).filter((run) => !isFailoverReceiptPrefix(run.prefix));
    if (outletGaps.length > 0) {
      // Name the numbers: the run may be an idle device or the cloud
      // sequence, which no shift report shows. Capped at 20, like the merge.
      const numbers = outletGaps.flatMap((run) =>
        run.missing.slice(0, 21).map((n) => formatReceiptNumber(run.prefix, n)),
      );
      const more = numbers.length > 20 ? " dan lainnya" : "";
      throw new PosError(
        "RECEIPT_SEQUENCE_GAP",
        `Ada nomor struk yang hilang di outlet ini: ${numbers.slice(0, 20).join(", ")}${more}.`,
      );
    }

    if (body.inventoryDeduction)
      await posDayInventoryPort()(tx, context, {
        outletId,
        businessDate: body.businessDate,
        closedBy: caller.userId,
      });

    const closedAt = toIsoDateTime(now);
    const recap = endOfDayRecapSchema.parse({
      ...open,
      status: "closed",
      generatedAt: closedAt,
      closedAt,
      closedBy: caller.userId,
      inventoryDeductionApplied: body.inventoryDeduction,
    });
    const orderCount = recap.devices.reduce(
      (total, device) => total + device.orderCount,
      0,
    );

    await tx.insert(posDailyCloses).values({
      id: recap.id,
      tenantId,
      outletId,
      businessDate: body.businessDate,
      orderCount,
      totalSalesIdr: recap.totalSalesIdr,
      totalRefundsIdr: recap.totalRefundsIdr,
      totalVoidsIdr: recap.totalVoidsIdr,
      totalVarianceIdr: recap.totalVarianceIdr,
      inventoryDeductionApplied: recap.inventoryDeductionApplied,
      recap: recap as unknown as Record<string, unknown>,
      closedBy: caller.userId,
      closedAt: now,
      idempotencyKey: body.idempotencyKey,
      requestFingerprint: fingerprint,
    });

    // Any other gap refused the close above, so the count is F of this date.
    if (!isEdgeProcess())
      await alertFailoverReceiptGaps(tx, context, {
        outletId,
        businessDate: body.businessDate,
        count: recap.unsyncedReceiptCount,
      });

    // legend-aruta: closing the day ends every acting cashier of the outlet.
    await revokeActingStaffForOutlet(tx, context.tenant, {
      outletId,
      reason: "day_closed",
    });

    // day.closed on the outbox (same envelope/destination as appendPosEvent).
    const definition = posEvents["day.closed"];
    const [last] = await tx
      .select({
        last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
      })
      .from(domainEventOutbox)
      .where(
        and(
          eq(domainEventOutbox.tenantId, tenantId),
          eq(domainEventOutbox.destination, EVENT_DESTINATION),
          eq(domainEventOutbox.aggregateType, definition.entry.aggregateType),
          eq(domainEventOutbox.aggregateId, recap.id),
        ),
      );
    const sequence = Number(last?.last ?? 0) + 1;
    const event = definition.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId,
      outletId,
      name: definition.name,
      version: definition.version,
      aggregateType: definition.entry.aggregateType,
      aggregateId: recap.id,
      sequence,
      occurredAt: closedAt,
      actor: { type: "user", id: caller.userId },
      deviceId: null,
      idempotencyKey: `${definition.name}:${recap.id}:${sequence}`.slice(
        0,
        100,
      ),
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: {
        outletId,
        businessDate: body.businessDate,
        orderCount,
        totalSalesIdr: recap.totalSalesIdr,
        totalRefundsIdr: recap.totalRefundsIdr,
        totalVoidsIdr: recap.totalVoidsIdr,
        totalVarianceIdr: recap.totalVarianceIdr,
        inventoryDeductionApplied: recap.inventoryDeductionApplied,
        accountingSyncStatus: "pending",
        closedBy: caller.userId,
        closedAt,
        // 1269 E3: the cloud mirrors an edge close from its frozen recap.
        ...(isEdgeProcess() ? { recap } : {}),
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination: EVENT_DESTINATION,
      direction: null,
      peerId: null,
    });

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        actorType: "user",
        actorId: caller.userId,
        deviceId: null,
        action: "pos_day.closed",
        objectType: "pos_daily_close",
        objectId: recap.id,
        reason: null,
        maskedChanges: {
          before: null,
          after: maskAuditChanges(
            {
              id: recap.id,
              businessDate: body.businessDate,
              orderCount,
              totalSalesIdr: recap.totalSalesIdr,
              totalRefundsIdr: recap.totalRefundsIdr,
              totalVoidsIdr: recap.totalVoidsIdr,
              totalVarianceIdr: recap.totalVarianceIdr,
              inventoryDeductionApplied: recap.inventoryDeductionApplied,
            },
            AUDIT_SAFE_FIELDS,
          ),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: closedAt,
      },
      AUDIT_SAFE_FIELDS,
    );
    if (staleEdge)
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId,
          actorType: "user",
          actorId: caller.userId,
          deviceId: null,
          action: "day.closed_from_cloud_edge_stale",
          objectType: "pos_daily_close",
          objectId: recap.id,
          reason: null,
          maskedChanges: {
            before: null,
            after: { businessDate: body.businessDate },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: closedAt,
        },
        AUDIT_SAFE_FIELDS,
      );
    return recap;
  });
}
