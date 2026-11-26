// O2 offline batch ingest (bead legend-wasr7.6; docs/design/cloud-only-release.md
// §2 and "Keputusan CTO O2"; contract @starter/shared/pos offline-batch.ts).
//
// The tablet sends the sales it took offline under its kit (O1). Each event
// becomes a normal cloud order, source `offline_tablet`, recorded in its own
// ledger `pos_offline_sales` (never `edge_order_ingests`, so refunds take the
// normal cloud path, CTO O2 (d)). The edge ingest's rules carry over
// (edge/order-ingest.ts): every amount comes from the payload, nothing is
// repriced (R2), and once a sale is stored it never fails the batch (R1): a
// sale that cannot become an order is stored `held` with its reason. Unlike an
// edge sale, the offline sale is the cloud's own:
//  (a) its cash goes into the kit shift's drawer (`pos_order_tenders.shift_id`);
//  (b) it holds its `L<n>` receipt row, numbered by the tablet, gapless per run;
//  (c) the normal `order.paid` outbox event drives the stock deduction, the
//      sale journal and the points consumers, exactly as a cloud sale.
//
// Ordering: per run, events are taken in number order and must continue the
// cloud high-water (`receipt_sequences.last_number`) exactly. A gap is refused
// and alerted, never written off; nothing after it is stored until the tablet
// resends the missing sale. Each event commits in its own transaction under
// the run row lock, so concurrent batches of one tablet serialise per run.
// Review O1 P3 4: a run already retired (`offline_epoch`) still takes the
// sales the tablet made on it.
import { and, eq } from "drizzle-orm";
import {
  businessDateOf,
  CoreError,
  createUlid,
  idr,
  ulidToUuid,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  formatReceiptNumber,
  posOfflineBatchResultSchema,
  type OfflineEventResult,
  type OfflineSaleEvent,
  type OfflineSaleFlag,
  type PosOfflineBatchResult,
  type SubmitPosOfflineBatchInput,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { posOfflineKits } from "../db/schema/pos-offline.ts";
import { posOfflineSales } from "../db/schema/pos-offline-sale.ts";
import {
  posOrderItems,
  posOrderTenders,
  posOrders,
} from "../db/schema/pos-order.ts";
import { posReceipts, receiptSequences } from "../db/schema/pos-receipt.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import {
  isTransientReason,
  lockOrderSource,
  sqlStateOf,
} from "../edge/order-ingest.ts";
import {
  alertSupervisors,
  edgeAlertId,
  openBusinessDateFrom,
  recordLateAdjustment,
} from "../edge/late-adjustment.ts";
import { logger } from "../lib/logger.ts";
import { resolveDeviceOutlet } from "./device-pin.service.ts";
import { sourceIdToDb } from "./inventory.service.ts";
import type { Tx } from "./menu-internals.ts";
import { orderRevenueSplit } from "./order-revenue.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import {
  appendOrderEvent,
  appendPosEvent,
  auditPos,
} from "./pos-order-support.ts";
import { outletSnapshotFor } from "./pos-receipt.service.ts";
import { assertOutletPermission } from "./pos-shift-support.ts";
import { recordTaxSnapshotsFromPayload } from "./tax.service.ts";

export type OfflineBatchCaller = { userId: UserId; deviceId: string | null };

/** The ledger's name for this source (CTO O2 (d)). */
export const OFFLINE_SALE_SOURCE = "offline_tablet";

const NO_DEVICE = "Sinkron offline hanya untuk perangkat kasir terdaftar.";
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type KitRow = typeof posOfflineKits.$inferSelect;
type RunRow = typeof receiptSequences.$inferSelect;

/** A refusal of the sale itself: stored `held` with this code. */
class SaleRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Lock trouble on the event: nothing stored, the tablet resends. */
class RetryLater extends Error {}

function reasonOf(error: unknown): string {
  if (error instanceof SaleRefusal) return error.code;
  const state = sqlStateOf(error);
  return state ? `db_error:${state}` : "error";
}

const result = (
  event: OfflineSaleEvent,
  status: OfflineEventResult["status"],
  extra: Partial<Omit<OfflineEventResult, "eventId" | "status">> = {},
): OfflineEventResult => ({
  eventId: event.eventId,
  status,
  reason: extra.reason ?? null,
  flags: extra.flags ?? [],
  receiptNumber: extra.receiptNumber ?? null,
});

type Outcome = {
  result: OfflineEventResult;
  /** The run's high-water after the event; null when the run was not shown. */
  run: { sequenceId: string; lastNumber: number } | null;
};

/**
 * POST .../pos/offline-batch. The caller is the cashier on the registered
 * device the kits were issued to (route: shift.cash.operate, checked again
 * here). Results come back in the order of `input.events`.
 */
export async function submitPosOfflineBatch(
  context: ScopedTenantContext,
  caller: OfflineBatchCaller,
  outletId: OutletId,
  input: SubmitPosOfflineBatchInput,
  now = new Date(),
): Promise<PosOfflineBatchResult> {
  if (caller.deviceId === null) throw new CoreError("FORBIDDEN", NO_DEVICE);
  const deviceId = caller.deviceId;
  const deviceOutlet = await resolveDeviceOutlet(
    context.tenant.tenantId,
    deviceId,
  );
  if (deviceOutlet === null || !sameId(deviceOutlet, outletId))
    throw new CoreError("FORBIDDEN", NO_DEVICE);
  await withTenant(db, context, (tx) =>
    assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "shift.cash.operate",
    ),
  );

  // Walk every run in number order, whatever order the tablet sent.
  const ordered = [...input.events].sort(
    (x, y) =>
      x.sequenceId.localeCompare(y.sequenceId) ||
      x.sequenceNumber - y.sequenceNumber,
  );
  const byEvent = new Map<string, OfflineEventResult>();
  const stopped = new Map<string, string>();
  const runs = new Map<string, number>();
  for (const event of ordered) {
    if (byEvent.has(event.eventId)) continue;
    const stop = stopped.get(event.sequenceId.toLowerCase());
    if (stop !== undefined) {
      byEvent.set(event.eventId, result(event, "rejected", { reason: stop }));
      continue;
    }
    const outcome = await ingestOne(context, caller.userId, deviceId, {
      outletId,
      event,
      now,
    });
    byEvent.set(event.eventId, outcome.result);
    if (outcome.run) runs.set(outcome.run.sequenceId, outcome.run.lastNumber);
    const reason = outcome.result.reason;
    if (
      outcome.result.status === "rejected" &&
      reason !== null &&
      reason !== "number_taken"
    )
      stopped.set(event.sequenceId.toLowerCase(), reason);
  }
  return posOfflineBatchResultSchema.parse({
    results: input.events.map((event) => byEvent.get(event.eventId)!),
    runs: [...runs].map(([sequenceId, lastNumber]) => ({
      sequenceId,
      lastNumber,
    })),
  });
}

/** One event in its own transaction; lock trouble is a `retry` rejection. */
async function ingestOne(
  context: ScopedTenantContext,
  userId: UserId,
  deviceId: string,
  input: { outletId: OutletId; event: OfflineSaleEvent; now: Date },
): Promise<Outcome> {
  try {
    return await withTenant(db, context, (tx) =>
      ingestInTransaction(tx, context, userId, deviceId, input),
    );
  } catch (error) {
    if (
      error instanceof RetryLater ||
      isTransientReason(`db_error:${sqlStateOf(error)}`)
    )
      return { result: result(input.event, "rejected", { reason: "retry" }), run: null };
    throw error;
  }
}

async function ingestInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  userId: UserId,
  deviceId: string,
  input: { outletId: OutletId; event: OfflineSaleEvent; now: Date },
): Promise<Outcome> {
  const { outletId, event, now } = input;
  const tenantId = context.tenant.tenantId;

  // 1. The kit names the device, the outlet and the run. Anything else is one
  //    answer, so a device learns nothing about another device's kits.
  const [kit] = await tx
    .select()
    .from(posOfflineKits)
    .where(
      and(
        eq(posOfflineKits.tenantId, tenantId),
        eq(posOfflineKits.id, event.kitId),
      ),
    );
  if (
    !kit ||
    !sameId(kit.deviceId, deviceId) ||
    !sameId(kit.outletId, outletId) ||
    !sameId(kit.sequenceId, event.sequenceId)
  )
    return { result: result(event, "rejected", { reason: "kit_unknown" }), run: null };

  // 2. The run row lock serialises every sale of the run.
  const [run] = await tx
    .select()
    .from(receiptSequences)
    .where(
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.id, kit.sequenceId),
      ),
    )
    .for("update");
  if (!run || run.series !== "offline" || !sameId(run.deviceId, deviceId))
    return { result: result(event, "rejected", { reason: "kit_unknown" }), run: null };
  const runOut = (lastNumber: number) => ({ sequenceId: run.id, lastNumber });

  // 3. Replay: one event id is one sale, whatever the resend carries.
  const [stored] = await tx
    .select({
      state: posOfflineSales.state,
      reason: posOfflineSales.reason,
      flags: posOfflineSales.flags,
      sequenceNumber: posOfflineSales.sequenceNumber,
      prefix: receiptSequences.prefix,
    })
    .from(posOfflineSales)
    .innerJoin(
      receiptSequences,
      and(
        eq(receiptSequences.tenantId, posOfflineSales.tenantId),
        eq(receiptSequences.id, posOfflineSales.sequenceId),
      ),
    )
    .where(
      and(
        eq(posOfflineSales.tenantId, tenantId),
        eq(posOfflineSales.eventId, event.eventId),
      ),
    );
  if (stored)
    return {
      result: result(event, "duplicate", {
        reason: stored.reason,
        flags: stored.flags,
        receiptNumber: formatReceiptNumber(stored.prefix, stored.sequenceNumber),
      }),
      run: runOut(run.lastNumber),
    };

  // 4. The number must continue the run exactly.
  const expected = run.lastNumber + 1;
  if (event.sequenceNumber !== expected) {
    const taken = event.sequenceNumber < expected;
    await alertRun(tx, context, {
      outletId,
      run,
      kind: taken ? "number_taken" : "sequence_gap",
      number: taken ? event.sequenceNumber : expected,
    });
    return {
      result: result(event, "rejected", {
        reason: taken ? "number_taken" : "sequence_gap",
      }),
      run: runOut(run.lastNumber),
    };
  }

  // 5. The number is used up whatever happens to the sale (before the
  //    receipt: pos_receipts_match_sequence).
  const number = event.sequenceNumber;
  await tx
    .update(receiptSequences)
    .set({ lastNumber: number, updatedAt: now })
    .where(
      and(eq(receiptSequences.tenantId, tenantId), eq(receiptSequences.id, run.id)),
    );
  const receiptNumber = formatReceiptNumber(run.prefix, number);

  // 6. The sale, in its own savepoint (R1): a refusal rolls back the sale only.
  let flags: OfflineSaleFlag[] = [];
  let late: { original: string; late: string } | null = null;
  let reason: string | null = null;
  try {
    const applied = await tx.transaction((sp) =>
      applySale(sp, context, { userId, kit, run, event, receiptNumber, now }),
    );
    flags = applied.flags;
    late = applied.late;
  } catch (error) {
    reason = reasonOf(error);
    if (isTransientReason(reason)) throw new RetryLater();
    logger.warn({ eventId: event.eventId, reason }, "Offline sale held");
  }
  await tx.insert(posOfflineSales).values({
    tenantId,
    eventId: event.eventId,
    outletId,
    deviceId,
    kitId: kit.id,
    shiftId: kit.shiftId,
    sequenceId: run.id,
    sequenceNumber: number,
    state: reason === null ? "ingested" : "held",
    reason,
    flags,
    payload: event,
    receivedBy: userId,
    originalBusinessDate: late?.original ?? null,
    lateBusinessDate: late?.late ?? null,
  });
  if (reason !== null || flags.length > 0)
    await alertSupervisors(tx, context, {
      outletId,
      id: edgeAlertId("offline_sale_review", tenantId, event.eventId),
      eventName: "offline_sale.review_needed",
      aggregateType: "order",
      aggregateId: event.eventId,
      payload: {
        receiptNumber,
        state: reason === null ? "ingested" : "held",
        reason: reason ?? flags.join(","),
      },
      title: "Penjualan offline perlu dicek",
      body:
        reason === null
          ? `Struk ${receiptNumber} dari kasir offline sudah masuk, tetapi perlu dicek (${flags.join(", ")}).`
          : `Struk ${receiptNumber} dari kasir offline disimpan tanpa pesanan (${reason}). Uangnya sudah diterima; hubungi finance.`,
    });
  return {
    result: result(event, reason === null ? "ingested" : "held", {
      reason,
      flags,
      receiptNumber,
    }),
    run: runOut(number),
  };
}

/** One alert per run and number: a gap or a reused number is never silent. */
async function alertRun(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    run: RunRow;
    kind: "sequence_gap" | "number_taken";
    number: number;
  },
): Promise<void> {
  const receiptNumber = formatReceiptNumber(input.run.prefix, input.number);
  await alertSupervisors(tx, context, {
    outletId: input.outletId,
    id: edgeAlertId(
      `offline_${input.kind}`,
      context.tenant.tenantId,
      input.run.id,
      String(input.number),
    ),
    eventName: `offline_sale.${input.kind}`,
    aggregateType: "receipt_sequence",
    aggregateId: input.run.id,
    payload: { receiptNumber, kind: input.kind },
    title:
      input.kind === "sequence_gap"
        ? "Struk offline belum lengkap"
        : "Nomor struk offline dipakai dua kali",
    body:
      input.kind === "sequence_gap"
        ? `Kasir offline mengirim penjualan sesudah ${receiptNumber} sebelum ${receiptNumber} sendiri. Penjualan sesudahnya ditahan sampai ${receiptNumber} terkirim.`
        : `Kasir offline mengirim penjualan lain dengan nomor ${receiptNumber}. Penjualan itu tidak dicatat; periksa tablet kasir.`,
  });
}

/** Price of a line as the kit told the tablet, or null when it is not there. */
function kitPriceMatches(
  kit: KitRow,
  serviceType: OfflineSaleEvent["serviceType"],
  line: OfflineSaleEvent["lines"][number],
): boolean {
  const item = kit.snapshot.catalogs[serviceType]?.items.find((row) =>
    sameId(row.id, line.menuItemId),
  );
  if (!item) return false;
  const base =
    line.variantId === null
      ? item.plainPriceIdr
      : (item.variants.find((variant) => sameId(variant.id, line.variantId!))
          ?.priceIdr ?? null);
  if (base === null || Number(base) !== Number(line.unitPriceIdr)) return false;
  return line.modifiers.every((modifier) =>
    item.modifierGroups.some(
      (group) =>
        sameId(group.id, modifier.groupId) &&
        group.options.some(
          (option) =>
            sameId(option.id, modifier.modifierId) &&
            Number(option.priceDeltaIdr) === Number(modifier.priceIdr),
        ),
    ),
  );
}

async function applySale(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    userId: UserId;
    kit: KitRow;
    run: RunRow;
    event: OfflineSaleEvent;
    receiptNumber: string;
    now: Date;
  },
): Promise<{
  flags: OfflineSaleFlag[];
  late: { original: string; late: string } | null;
}> {
  const { kit, run, event, receiptNumber, now } = input;
  const tenantId = context.tenant.tenantId;
  const outletId = kit.outletId as OutletId;
  const orderId = event.eventId;
  const flags: OfflineSaleFlag[] = [];

  // R4: the order's one lock (paid, void, cost recompute).
  await lockOrderSource(tx, tenantId, sourceIdToDb(orderId));
  const [existing] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
  if (existing) throw new SaleRefusal("order_exists");

  // The cloud checks, never computes (R2).
  let linesTotal = 0;
  for (const line of event.lines) {
    const modifiers = line.modifiers.reduce(
      (sum, modifier) => sum + Number(modifier.priceIdr),
      0,
    );
    if (
      modifiers !== Number(line.modifiersTotalIdr) ||
      Number(line.lineTotalIdr) !==
        (Number(line.unitPriceIdr) + modifiers) * line.quantity
    )
      throw new SaleRefusal("lines_mismatch");
    linesTotal += Number(line.lineTotalIdr);
  }
  if (linesTotal !== Number(event.subtotalIdr))
    throw new SaleRefusal("lines_mismatch");
  const amounts = {
    subtotalIdr: Number(event.subtotalIdr),
    discountIdr: 0,
    serviceChargeIdr: Number(event.serviceChargeIdr),
    taxIdr: Number(event.taxIdr),
    roundingIdr: Number(event.roundingIdr),
    totalIdr: Number(event.totalIdr),
    pricesIncludeTax: event.pricesIncludeTax,
  };
  let split: ReturnType<typeof orderRevenueSplit>;
  try {
    split = orderRevenueSplit(amounts);
  } catch {
    throw new SaleRefusal("money_mismatch");
  }
  const tendered = event.tenders.reduce(
    (sum, tender) => sum + Number(tender.amountIdr),
    0,
  );
  if (tendered !== amounts.totalIdr) throw new SaleRefusal("money_mismatch");
  for (const tender of event.tenders)
    if (
      tender.method === "cash" &&
      Number(tender.receivedIdr) < Number(tender.amountIdr)
    )
      throw new SaleRefusal("tender_invalid");

  // "Perlu dicek": the sale stands, finance reviews.
  if (
    !event.lines.every((line) => kitPriceMatches(kit, event.serviceType, line))
  )
    flags.push("price_mismatch");
  const paidAt = new Date(event.paidAt);
  if (paidAt > kit.expiresAt || paidAt < kit.issuedAt) flags.push("kit_expired");
  const taxesUsable =
    event.taxes !== undefined &&
    event.taxes.reduce((sum, row) => sum + Number(row.taxIdr), 0) ===
      amounts.taxIdr;
  if (!taxesUsable && (event.taxes !== undefined || amounts.taxIdr > 0))
    flags.push(event.taxes === undefined ? "tax_missing" : "tax_mismatch");

  // The kit's shift: its drawer takes the cash while it is open (CTO O2 (a)).
  const [shift] = await tx
    .select({
      id: posShifts.id,
      status: posShifts.status,
      cashierId: posShifts.cashierId,
    })
    .from(posShifts)
    .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, kit.shiftId)))
    .for("share");
  if (!shift) throw new SaleRefusal("shift_unknown");
  const drawerShiftId = shift.status === "open" ? shift.id : null;
  if (drawerShiftId === null) flags.push("shift_closed");

  // Business date of the sale's own instant; a closed day posts late.
  const [outlet] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new SaleRefusal("outlet_unknown");
  const soldOn = businessDateOf(paidAt, outletBusinessDayClock(outlet));
  const businessDate = await openBusinessDateFrom(
    tx,
    context,
    outletId,
    soldOn,
  );
  if (businessDate === null) throw new SaleRefusal("no_open_day");
  let late: { original: string; late: string } | null = null;
  if (businessDate !== soldOn) {
    flags.push("late_day");
    late = { original: soldOn, late: businessDate };
    await recordLateAdjustment(tx, context, {
      outletId,
      action: "order.late_adjusted",
      objectType: "order",
      objectId: orderId,
      originalBusinessDate: soldOn,
      lateBusinessDate: businessDate,
    });
  }

  // Writes: a normal completed cloud POS order.
  await tx.insert(orders).values({
    id: orderId,
    tenantId,
    outletId,
    number: receiptNumber,
    channel: "pos",
    serviceType: event.serviceType,
    paymentMode: "pay_first",
    subtotalIdr: event.subtotalIdr,
    discountIdr: idr(0),
    serviceChargeIdr: event.serviceChargeIdr,
    taxIdr: event.taxIdr,
    roundingIdr: event.roundingIdr,
    totalIdr: event.totalIdr,
    pricesIncludeTax: event.pricesIncludeTax,
    customerProfileId: null,
    depositAppliedIdr: idr(0),
    status: "completed",
    businessDate,
    placedAt: paidAt,
  });
  await tx.insert(posOrders).values({
    orderId,
    tenantId,
    outletId,
    channel: "pos",
    shiftId: kit.shiftId,
    deviceId: kit.deviceId,
    cashierId: shift.cashierId,
    isTraining: false,
    submittedAt: paidAt,
    completedAt: paidAt,
  });
  for (const [index, line] of event.lines.entries()) {
    const itemId = createUlid(paidAt.getTime() + index);
    await tx.insert(orderItems).values({
      id: itemId,
      tenantId,
      outletId,
      orderId,
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      name: line.name,
      quantity: line.quantity,
      unitPriceIdr: line.unitPriceIdr,
      modifiersTotalIdr: line.modifiersTotalIdr,
      lineTotalIdr: line.lineTotalIdr,
      modifiers: line.modifiers.map((modifier) => ({
        modifierId: modifier.modifierId,
        groupId: modifier.groupId,
        name: modifier.name,
        priceIdr: Number(modifier.priceIdr),
      })),
      fireStatus: "fired",
      status: "served",
      reservedBusinessDate: businessDate,
    });
    await tx.insert(posOrderItems).values({
      itemId,
      tenantId,
      outletId,
      orderId,
      heldByCashier: false,
      firedAt: paidAt,
    });
  }
  for (const tender of event.tenders) {
    const cash = tender.method === "cash";
    await tx.insert(posOrderTenders).values({
      tenantId,
      outletId,
      orderId,
      method: tender.method,
      provider: cash ? "manual" : "edc",
      amountIdr: tender.amountIdr,
      receivedIdr: cash ? tender.receivedIdr : null,
      changeIdr: cash
        ? idr(Number(tender.receivedIdr) - Number(tender.amountIdr))
        : null,
      reference: cash ? null : tender.reference,
      status: "captured",
      requestedAt: paidAt,
      resolvedAt: paidAt,
      capturedBy: shift.cashierId,
      shiftId: cash ? drawerShiftId : null,
    });
  }
  await tx.insert(posReceipts).values({
    tenantId,
    outletId,
    orderId,
    sequenceId: run.id,
    deviceId: run.deviceId,
    number: receiptNumber,
    sequenceNumber: event.sequenceNumber,
    status: "issued",
    issuedAt: paidAt,
    outletSnapshot: await outletSnapshotFor(tx, context, outletId),
  });
  if (taxesUsable && event.taxes !== undefined)
    await recordTaxSnapshotsFromPayload(tx, context, {
      sourceType: "order",
      sourceId: ulidToUuid(orderId),
      outletId,
      businessDate,
      taxes: event.taxes,
    });

  // (c) The cloud sale's own event: stock, journal and points consumers.
  const bucket = (method: "cash" | "edc_card"): Idr =>
    idr(
      event.tenders
        .filter((tender) => tender.method === method)
        .reduce((sum, tender) => sum + Number(tender.amountIdr), 0),
    );
  const paidPayload = {
    orderId,
    outletId,
    businessDate,
    channel: "pos",
    serviceType: event.serviceType,
    ...split,
    paidCashIdr: bucket("cash"),
    paidGatewayIdr: idr(0),
    paidEdcIdr: bucket("edc_card"),
    paidPointsIdr: idr(0),
    paidDepositIdr: idr(0),
    tenders: event.tenders.map((tender) => ({
      method: tender.method,
      amountIdr: tender.amountIdr,
      provider: tender.method === "cash" ? "manual" : "edc",
      ...(tender.method === "cash" ? { receivedIdr: tender.receivedIdr } : {}),
    })),
    shiftId: kit.shiftId,
    cashierId: shift.cashierId,
    deviceId: kit.deviceId,
    paidAt: paidAt.toISOString(),
    orderNumber: receiptNumber,
    subtotalIdr: event.subtotalIdr,
    pricesIncludeTax: event.pricesIncludeTax,
    paymentMode: "pay_first",
    isTraining: false,
    customerProfileId: null,
    ...(taxesUsable && event.taxes !== undefined ? { taxes: event.taxes } : {}),
  };
  const order = { id: orderId, outletId };
  const caller = { userId: input.userId, deviceId: kit.deviceId };
  await appendPosEvent(tx, context, "order.paid", {
    order,
    payload: paidPayload,
    caller,
    now,
  });
  await appendOrderEvent(tx, context, {
    order,
    type: "order.paid",
    payload: paidPayload,
    caller,
    now,
  });
  await appendOrderEvent(tx, context, {
    order,
    type: "order.completed",
    payload: { receiptNumber, totalIdr: event.totalIdr },
    caller,
    now,
  });
  await auditPos(
    tx,
    context,
    {
      action: "pos_order.offline_ingested",
      order,
      caller,
      before: null,
      after: {
        id: orderId,
        status: "completed",
        totalIdr: event.totalIdr,
        receiptNumber,
        source: OFFLINE_SALE_SOURCE,
      },
    },
    now,
  );
  return { flags, late };
}
