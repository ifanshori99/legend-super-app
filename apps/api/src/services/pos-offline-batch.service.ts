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
//
// Review O2: service charge, tax and rounding are checked against the kit's
// tax snapshot (`amount_mismatch`, a flag, never a refusal: R2); a second sale
// under a number the cloud already holds is stored `held` / `number_taken`
// (the money was taken; the tablet stops resending); a paidAt ahead of the
// cloud clock is flagged and booked on today's business date; one event id
// under two kits is a 409 OFFLINE_EVENT_CONFLICT.
//
// Review O3 P1 (CTO 27 Nov): the tablet then reports that sale
// (reportPosOfflineConflict). It is booked under an order id derived from
// (kit, eventId) with the `event_conflict` flag: its number fills the run's
// slot (the next sale is no gap), its cash is outside the drawer and the
// journal debits the offline clearing account, like a `shift_closed` sale.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  businessDateOf,
  CoreError,
  createUlid,
  idr,
  ulidTimestamp,
  ulidToUuid,
  uuidToUlid,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  formatReceiptNumber,
  offlineEventResultSchema,
  offlineStuckHeldReason,
  PosError,
  posOfflineBatchResultSchema,
  type OfflineEventResult,
  type OfflineSaleEvent,
  type OfflineSaleFlag,
  type PosOfflineBatchResult,
  type ReportPosOfflineConflictInput,
  type ReportPosOfflineStuckInput,
  type SubmitPosOfflineBatchInput,
} from "@starter/shared/pos";
import { formatRupiah } from "@starter/shared/i18n";
import { db } from "../db/index.ts";
import {
  posOfflineCatalogSnapshots,
  posOfflineKits,
  type PosOfflineKitSnapshot,
} from "../db/schema/pos-offline.ts";
import { posOfflineSales } from "../db/schema/pos-offline-sale.ts";
import {
  posOrderItems,
  posOrderTenders,
  posOrders,
} from "../db/schema/pos-order.ts";
import { posReceipts, receiptSequences } from "../db/schema/pos-receipt.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
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
import { recordAudit } from "./audit-writer.ts";
import { outletContext } from "./device-pin-support.ts";
import { resolveDeviceOutlet } from "./device-pin.service.ts";
import { sourceIdToDb } from "./inventory.service.ts";
import type { Tx } from "./menu-internals.ts";
import { orderRevenueSplit } from "./order-revenue.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import {
  computePosBill,
  posPriceChannel,
  type PosBillLine,
} from "./pos-order-pricing.ts";
import {
  appendOrderEvent,
  appendPosEvent,
  auditPos,
} from "./pos-order-support.ts";
import { isEdgeProcess } from "./pos-edge-outlet.ts";
import { outletSnapshotFor } from "./pos-receipt.service.ts";
import { assertOutletPermission } from "./pos-shift-support.ts";
import { holdsOverridePermission } from "./staff-override.service.ts";
import { attemptApproverPin } from "./staff-pin-proof.service.ts";
import { recordTaxSnapshotsFromPayload } from "./tax.service.ts";

export type OfflineBatchCaller = { userId: UserId; deviceId: string | null };

/** The ledger's name for this source (CTO O2 (d)). */
export const OFFLINE_SALE_SOURCE = "offline_tablet";
const NUMBER_TAKEN = "number_taken";

const NO_DEVICE = "Sinkron offline hanya untuk perangkat kasir terdaftar.";
/** Tablet clock drift tolerated before a paidAt counts as in the future. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A kit with its snapshot resolved (inline for pre-0542 kits). */
type KitRow = Omit<typeof posOfflineKits.$inferSelect, "snapshot"> & {
  snapshot: PosOfflineKitSnapshot;
};
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

type IngestInput = {
  outletId: OutletId;
  event: OfflineSaleEvent;
  now: Date;
  /** Review O3 P1: the tablet's eventId this reported sale conflicted on. */
  conflictOf: string | null;
};

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
  const deviceId = await assertOfflineCaller(context, caller, outletId);

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
      conflictOf: null,
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

/**
 * The caller of an offline write: the cloud process, a registered device of
 * the outlet, a user with shift.cash.operate there. Returns the device id.
 */
async function assertOfflineCaller(
  context: ScopedTenantContext,
  caller: OfflineBatchCaller,
  outletId: OutletId,
): Promise<string> {
  // Review O1 P2: the L-runs are the cloud's; an edge never takes them in.
  if (isEdgeProcess())
    throw new CoreError(
      "CONFLICT",
      "Penjualan offline hanya diterima server pusat.",
    );
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
  return deviceId;
}

/**
 * Review O3 P1: the order id of a reported conflicting sale. Derived from
 * (tenant, kit, eventId), so a resent report is the same sale; the time part
 * stays the sale's own.
 */
export function conflictOrderIdOf(
  tenantId: string,
  kitId: string,
  eventId: string,
): string {
  const time = ulidTimestamp(eventId).toString(16).padStart(12, "0");
  const random = createHash("sha256")
    .update(`offline-conflict:${tenantId}:${kitId.toLowerCase()}:${eventId}`)
    .digest("hex")
    .slice(0, 20);
  const hex = time + random;
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * POST .../pos/offline-conflicts (review O3 P1, CTO 27 Nov). The tablet
 * reports a sale the batch answered OFFLINE_EVENT_CONFLICT. While its eventId
 * is stored under another kit, the sale is booked under conflictOrderIdOf with
 * the `event_conflict` flag (number slot filled, cash to the clearing
 * account, supervisors and owners alerted). Otherwise it is an ordinary event.
 * The answer names the tablet's eventId.
 */
export async function reportPosOfflineConflict(
  context: ScopedTenantContext,
  caller: OfflineBatchCaller,
  outletId: OutletId,
  input: ReportPosOfflineConflictInput,
  now = new Date(),
): Promise<OfflineEventResult> {
  const deviceId = await assertOfflineCaller(context, caller, outletId);
  const { event } = input;
  const tenantId = context.tenant.tenantId;
  const [stored] = await withTenant(db, context, (tx) =>
    tx
      .select({ kitId: posOfflineSales.kitId })
      .from(posOfflineSales)
      .where(
        and(
          eq(posOfflineSales.tenantId, tenantId),
          eq(posOfflineSales.eventId, event.eventId),
        ),
      ),
  );
  const conflicting =
    stored !== undefined && !sameId(stored.kitId, event.kitId);
  const outcome = await ingestOne(context, caller.userId, deviceId, {
    outletId,
    event: conflicting
      ? {
          ...event,
          eventId: conflictOrderIdOf(
            tenantId,
            event.kitId,
            event.eventId,
          ) as OfflineSaleEvent["eventId"],
        }
      : event,
    now,
    conflictOf: conflicting ? event.eventId : null,
  });
  return offlineEventResultSchema.parse({
    ...outcome.result,
    eventId: event.eventId,
  });
}

/** The staff session on the tablet; the device token may be gone (revoked). */
export type OfflineStuckCaller = { userId: UserId; deviceId: string | null };

const STUCK_KIT_UNKNOWN =
  "Bekal offline penjualan ini tidak dikenal di outlet ini.";

/**
 * POST .../pos/offline-stuck (1273 second opinion P2-1, CTO). A sale the batch
 * refuses for good (kit_unknown, sequence_gap, a refused device) is reported
 * by the staff session on the tablet with a supervisor's PIN; the device token
 * is not needed (it may be revoked). The sale is stored `held` /
 * `stuck_<reason>`: no order, stock, tax or journal, supervisors and owners
 * alerted, audited with the approver. The kit must be one of this tenant and
 * outlet, on the run the sale names. Idempotent per eventId: a stored sale
 * answers its stored state (`ingested` stays ingested); another kit's is a 409
 * OFFLINE_EVENT_CONFLICT. The number is used up only when it continues the
 * run (like any held sale); a gap is never written off.
 */
export async function reportPosOfflineStuck(
  context: ScopedTenantContext,
  caller: OfflineStuckCaller,
  outletId: OutletId,
  input: ReportPosOfflineStuckInput,
  now = new Date(),
): Promise<OfflineEventResult> {
  if (isEdgeProcess())
    throw new CoreError(
      "CONFLICT",
      "Penjualan offline hanya diterima server pusat.",
    );
  const { tenant } = context;
  const { event, approverUserId } = input;
  // AUTH-06: the approver is never the requester.
  if (approverUserId.toLowerCase() === caller.userId.toLowerCase())
    throw new AccessError("APPROVER_IS_REQUESTER");
  const approver = outletContext(tenant, outletId);
  const assertApprover = async (tx: Tx) => {
    if (
      !(await holdsOverridePermission(
        tx,
        tenant,
        approver,
        approverUserId,
        "cash_shift_close",
        outletId,
        now,
        true,
      ))
    )
      throw new AccessError(
        "PERMISSION_DENIED",
        "Penyetuju tidak memiliki izin untuk tindakan ini di outlet ini.",
      );
  };
  // 1. The caller, the kit and the approver's permission, before the PIN.
  await withTenant(db, context, async (tx) => {
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "shift.cash.operate",
    );
    await stuckKitOf(tx, context, outletId, event);
  });
  await withTenant(db, approver, assertApprover);
  // 2. The PIN: counted and committed on its own.
  await attemptApproverPin(tenant, {
    outletId,
    approverUserId,
    requesterUserId: caller.userId,
    pin: input.pin,
    deviceId: caller.deviceId,
    now,
  });
  // 3. Store, under the run row lock (serialised with the batch).
  try {
    return await withTenant(db, context, async (tx) => {
      await assertApprover(tx);
      return storeStuckSale(tx, context, caller, outletId, input, now);
    });
  } catch (error) {
    if (sqlStateOf(error) === "23505")
      throw new PosError("OFFLINE_EVENT_CONFLICT");
    throw error;
  }
}

/** The kit of a stuck sale: this tenant's, this outlet's, the sale's run. */
async function stuckKitOf(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  event: OfflineSaleEvent,
) {
  const [kit] = await tx
    .select({
      id: posOfflineKits.id,
      deviceId: posOfflineKits.deviceId,
      outletId: posOfflineKits.outletId,
      shiftId: posOfflineKits.shiftId,
      sequenceId: posOfflineKits.sequenceId,
    })
    .from(posOfflineKits)
    .where(
      and(
        eq(posOfflineKits.tenantId, context.tenant.tenantId),
        eq(posOfflineKits.id, event.kitId),
      ),
    );
  if (
    !kit ||
    !sameId(kit.outletId, outletId) ||
    !sameId(kit.sequenceId, event.sequenceId)
  )
    throw new CoreError("NOT_FOUND", STUCK_KIT_UNKNOWN);
  return kit;
}

async function storeStuckSale(
  tx: Tx,
  context: ScopedTenantContext,
  caller: OfflineStuckCaller,
  outletId: OutletId,
  input: ReportPosOfflineStuckInput,
  now: Date,
): Promise<OfflineEventResult> {
  const { event } = input;
  const tenantId = context.tenant.tenantId;
  const kit = await stuckKitOf(tx, context, outletId, event);
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
  if (!run || run.series !== "offline")
    throw new CoreError("NOT_FOUND", STUCK_KIT_UNKNOWN);
  const receiptNumber = formatReceiptNumber(run.prefix, event.sequenceNumber);

  // Replay: one event id is one sale. Stored already: its stored answer.
  const [stored] = await tx
    .select({
      kitId: posOfflineSales.kitId,
      state: posOfflineSales.state,
      reason: posOfflineSales.reason,
      flags: posOfflineSales.flags,
      sequenceNumber: posOfflineSales.sequenceNumber,
    })
    .from(posOfflineSales)
    .where(
      and(
        eq(posOfflineSales.tenantId, tenantId),
        eq(posOfflineSales.eventId, event.eventId),
      ),
    );
  if (stored) {
    if (!sameId(stored.kitId, kit.id))
      throw new PosError("OFFLINE_EVENT_CONFLICT");
    return offlineEventResultSchema.parse(
      result(event, stored.state, {
        reason: stored.reason,
        flags: stored.flags,
        receiptNumber:
          stored.reason === NUMBER_TAKEN
            ? null
            : formatReceiptNumber(run.prefix, stored.sequenceNumber),
      }),
    );
  }

  const reason = offlineStuckHeldReason(input.stuck);
  // The number continues the run: used up, like any held sale. A gap stays a
  // gap (never written off); an older number keeps its own sale.
  if (event.sequenceNumber === run.lastNumber + 1)
    await tx
      .update(receiptSequences)
      .set({ lastNumber: event.sequenceNumber, updatedAt: now })
      .where(
        and(
          eq(receiptSequences.tenantId, tenantId),
          eq(receiptSequences.id, run.id),
        ),
      );
  await tx.insert(posOfflineSales).values({
    tenantId,
    eventId: event.eventId,
    outletId,
    deviceId: kit.deviceId,
    kitId: kit.id,
    shiftId: kit.shiftId,
    sequenceId: run.id,
    sequenceNumber: event.sequenceNumber,
    state: "held",
    reason,
    flags: [],
    payload: event,
    receivedBy: caller.userId,
  });
  await recordAudit(
    {
      tenantId,
      outletId,
      actorType: "user",
      actorId: caller.userId,
      deviceId: caller.deviceId,
      action: "pos_offline_sale.stuck_reported",
      objectType: "offline_sale",
      objectId: event.eventId,
      reason: input.reason,
      before: null,
      after: {
        state: "held",
        reason,
        approvedBy: input.approverUserId,
        kitDeviceId: kit.deviceId,
        kitId: kit.id,
        shiftId: kit.shiftId,
        receiptNumber,
        totalIdr: String(event.totalIdr),
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
  await alertSupervisors(tx, context, {
    alsoOwners: true,
    outletId,
    id: edgeAlertId("offline_sale_review", tenantId, event.eventId),
    eventName: "offline_sale.review_needed",
    aggregateType: "offline_sale",
    aggregateId: event.eventId,
    payload: {
      receiptNumber,
      state: "held",
      reason,
      shiftId: kit.shiftId,
      totalIdr: String(event.totalIdr),
    },
    title: "Penjualan offline perlu dicek",
    body: `Struk ${receiptNumber} (${formatRupiah(Number(event.totalIdr))}) tidak bisa dikirim dari tablet kasir (${input.stuck}) dan dilaporkan dengan PIN supervisor. Disimpan tanpa pesanan; uangnya sudah diterima, hubungi finance.`,
  });
  logger.warn({ eventId: event.eventId, reason }, "Offline sale stuck held");
  return offlineEventResultSchema.parse(
    result(event, "held", { reason, receiptNumber }),
  );
}

/** One event in its own transaction; lock trouble is a `retry` rejection. */
async function ingestOne(
  context: ScopedTenantContext,
  userId: UserId,
  deviceId: string,
  input: IngestInput,
): Promise<Outcome> {
  try {
    return await withTenant(db, context, (tx) =>
      ingestInTransaction(tx, context, userId, deviceId, input),
    );
  } catch (error) {
    // Review O2 P3 3: a concurrent batch stored the event id under another
    // kit first (ledger primary key).
    if (sqlStateOf(error) === "23505")
      throw new PosError("OFFLINE_EVENT_CONFLICT");
    if (
      error instanceof RetryLater ||
      isTransientReason(`db_error:${sqlStateOf(error)}`)
    )
      return {
        result: result(input.event, "rejected", { reason: "retry" }),
        run: null,
      };
    throw error;
  }
}

async function ingestInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  userId: UserId,
  deviceId: string,
  input: IngestInput,
): Promise<Outcome> {
  const { outletId, event, now, conflictOf } = input;
  const tenantId = context.tenant.tenantId;

  // 1. The kit names the device, the outlet and the run. Anything else is one
  //    answer, so a device learns nothing about another device's kits.
  const [kitRow] = await tx
    .select({
      kit: posOfflineKits,
      stored: posOfflineCatalogSnapshots.snapshot,
    })
    .from(posOfflineKits)
    .leftJoin(
      posOfflineCatalogSnapshots,
      and(
        eq(posOfflineCatalogSnapshots.tenantId, posOfflineKits.tenantId),
        eq(posOfflineCatalogSnapshots.outletId, posOfflineKits.outletId),
        eq(
          posOfflineCatalogSnapshots.catalogVersion,
          posOfflineKits.catalogVersion,
        ),
      ),
    )
    .where(
      and(
        eq(posOfflineKits.tenantId, tenantId),
        eq(posOfflineKits.id, event.kitId),
      ),
    );
  // Kits issued before 0542 hold their snapshot inline; later ones name it.
  const snapshot = kitRow?.kit.snapshot ?? kitRow?.stored ?? null;
  const kit: KitRow | null =
    kitRow && snapshot ? { ...kitRow.kit, snapshot } : null;
  if (
    !kit ||
    !sameId(kit.deviceId, deviceId) ||
    !sameId(kit.outletId, outletId) ||
    !sameId(kit.sequenceId, event.sequenceId)
  )
    return {
      result: result(event, "rejected", { reason: "kit_unknown" }),
      run: null,
    };

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
    return {
      result: result(event, "rejected", { reason: "kit_unknown" }),
      run: null,
    };
  const runOut = (lastNumber: number) => ({ sequenceId: run.id, lastNumber });

  // 3. Replay: one event id is one sale, whatever the resend carries.
  const [stored] = await tx
    .select({
      kitId: posOfflineSales.kitId,
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
  if (stored) {
    if (!sameId(stored.kitId, kit.id))
      throw new PosError("OFFLINE_EVENT_CONFLICT");
    return {
      result: result(event, "duplicate", {
        reason: stored.reason,
        flags: stored.flags,
        receiptNumber:
          stored.reason === NUMBER_TAKEN
            ? null
            : formatReceiptNumber(stored.prefix, stored.sequenceNumber),
      }),
      run: runOut(run.lastNumber),
    };
  }

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
    // Review O2 P3 1: a reused number is a sale the tablet took; it is kept
    // for finance (the number stays the other sale's, the run is unchanged).
    if (taken) {
      await tx.insert(posOfflineSales).values({
        tenantId,
        eventId: event.eventId,
        outletId,
        deviceId,
        kitId: kit.id,
        shiftId: kit.shiftId,
        sequenceId: run.id,
        sequenceNumber: event.sequenceNumber,
        state: "held",
        reason: NUMBER_TAKEN,
        flags: [],
        payload: event,
        receivedBy: userId,
      });
      return {
        result: result(event, "held", { reason: NUMBER_TAKEN }),
        run: runOut(run.lastNumber),
      };
    }
    return {
      result: result(event, "rejected", { reason: "sequence_gap" }),
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
      and(
        eq(receiptSequences.tenantId, tenantId),
        eq(receiptSequences.id, run.id),
      ),
    );
  const receiptNumber = formatReceiptNumber(run.prefix, number);

  // 6. The sale, in its own savepoint (R1): a refusal rolls back the sale only.
  let flags: OfflineSaleFlag[] = [];
  let late: { original: string; late: string } | null = null;
  let closedShift: string | null = null;
  let reason: string | null = null;
  try {
    const applied = await tx.transaction((sp) =>
      applySale(sp, context, {
        userId,
        kit,
        run,
        event,
        receiptNumber,
        now,
        conflict: conflictOf !== null,
      }),
    );
    flags = applied.flags;
    late = applied.late;
    closedShift = applied.closedShift;
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
      // Review O3 P1: a conflicting sale reaches finance (the owners) too.
      // Review K O5 P3 4: so does a sale the cashier marked "pelanggan lain".
      ...(conflictOf !== null || event.otherCustomerReason !== undefined
        ? { alsoOwners: true }
        : {}),
      outletId,
      id: edgeAlertId("offline_sale_review", tenantId, event.eventId),
      eventName: "offline_sale.review_needed",
      aggregateType: "offline_sale",
      aggregateId: event.eventId,
      payload: {
        receiptNumber,
        state: reason === null ? "ingested" : "held",
        reason: reason ?? flags.join(","),
        shiftId: kit.shiftId,
        totalIdr: String(event.totalIdr),
        ...(conflictOf !== null ? { conflictOf } : {}),
        ...(event.otherCustomerReason !== undefined
          ? { otherCustomerReason: event.otherCustomerReason }
          : {}),
      },
      title: "Penjualan offline perlu dicek",
      body:
        conflictOf !== null && reason === null
          ? `Struk ${receiptNumber} (${formatRupiah(Number(event.totalIdr))}) dari kasir offline memakai id penjualan yang sudah tercatat dari bekal lain. Penjualan dicatat sebagai pesanan sendiri; tunainya masuk Kas Offline Belum Dicocokkan, finance mencocokkannya dengan laci shift.`
          : reason !== null
            ? `Struk ${receiptNumber} (${formatRupiah(Number(event.totalIdr))}) dari kasir offline disimpan tanpa pesanan (${reason}). Uangnya sudah diterima; hubungi finance.`
            : closedShift !== null
              ? `Struk ${receiptNumber} (${formatRupiah(Number(event.totalIdr))}) dari kasir offline masuk sesudah ${closedShift} ditutup. Tunainya tidak ada di hitungan laci shift itu; finance mencocokkannya dengan selisih shift (${flags.join(", ")}).`
              : event.otherCustomerReason !== undefined
                ? `Struk ${receiptNumber} (${formatRupiah(Number(event.totalIdr))}) dari kasir offline berisi menu yang sama dengan pesanan yang belum pasti. Kasir menandai pelanggan lain: "${event.otherCustomerReason}". Finance memastikan bukan pesanan yang sama dua kali (${flags.join(", ")}).`
                : `Struk ${receiptNumber} (${formatRupiah(Number(event.totalIdr))}) dari kasir offline sudah masuk, tetapi perlu dicek (${flags.join(", ")}).`,
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
    aggregateType: "offline_sale",
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

/**
 * Review O2 P1: service charge, tax, rounding and total of the sale as the
 * kit's tax snapshot computes them for the sent lines (no discount offline,
 * no table zone). A line the kit does not know, or a snapshot the engine
 * refuses, is a mismatch.
 */
function amountsMatchSnapshot(
  context: ScopedTenantContext,
  kit: KitRow,
  event: OfflineSaleEvent,
  businessDate: string,
): boolean {
  const items = kit.snapshot.catalogs[event.serviceType]?.items ?? [];
  const lines: PosBillLine[] = [];
  for (const [index, line] of event.lines.entries()) {
    const item = items.find((row) => sameId(row.id, line.menuItemId));
    if (!item) return false;
    lines.push({
      lineId: createUlid(Date.parse(event.paidAt) + index),
      menuItemId: line.menuItemId,
      categoryId: item.categoryId,
      quantity: line.quantity,
      unitPriceIdr: Number(line.unitPriceIdr),
      modifiersTotalIdr: Number(line.modifiersTotalIdr),
    });
  }
  try {
    const bill = computePosBill({
      context,
      outletId: kit.outletId as OutletId,
      businessDate,
      channel: posPriceChannel("pos", event.serviceType),
      zone: null,
      lines,
      orderDiscountIdr: 0,
      taxConfig: { ...kit.snapshot.tax, ruleNames: new Map() },
    });
    return (
      Number(bill.serviceChargeIdr) === Number(event.serviceChargeIdr) &&
      Number(bill.taxIdr) === Number(event.taxIdr) &&
      Number(bill.roundingIdr) === Number(event.roundingIdr) &&
      Number(bill.totalIdr) === Number(event.totalIdr) &&
      bill.pricesIncludeTax === event.pricesIncludeTax
    );
  } catch {
    return false;
  }
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
    /** Review O3 P1: a reported conflicting sale; its cash is outside the drawer. */
    conflict: boolean;
  },
): Promise<{
  flags: OfflineSaleFlag[];
  late: { original: string; late: string } | null;
  /** "shift <cashier> dibuka <time>" when the kit shift was already closed. */
  closedShift: string | null;
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
  if (paidAt > kit.expiresAt || paidAt < kit.issuedAt)
    flags.push("kit_expired");
  // Review O2 P3 2: a tablet clock ahead of the cloud never books tomorrow.
  if (paidAt.getTime() > now.getTime() + FUTURE_SKEW_MS)
    flags.push("paid_in_future");
  const soldAt = paidAt > now ? now : paidAt;
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
      openedAt: posShifts.openedAt,
    })
    .from(posShifts)
    .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, kit.shiftId)))
    .for("share");
  if (!shift) throw new SaleRefusal("shift_unknown");
  // Review O3 P1: a reported conflicting sale is never counted in a drawer
  // (finance matches the clearing account against the drawer).
  const drawerShiftId =
    shift.status === "open" && !input.conflict ? shift.id : null;
  if (shift.status !== "open") flags.push("shift_closed");
  if (input.conflict) flags.push("event_conflict");
  // O5 (1): the cashier said it is another customer although the same lines
  // had an unclear order request. The sale stands (it is a sale, paid in cash
  // or by EDC, in the open drawer); Finance checks it is not one order twice.
  if (event.otherCustomerReason !== undefined) flags.push("other_customer");

  // Business date of the sale's own instant; a closed day posts late.
  const [outlet] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new SaleRefusal("outlet_unknown");
  const soldOn = businessDateOf(soldAt, outletBusinessDayClock(outlet));
  // Review O2 P1: what the kit's tax snapshot computes for these lines.
  if (!amountsMatchSnapshot(context, kit, event, soldOn))
    flags.push("amount_mismatch");
  let closedShift: string | null = null;
  if (shift.status !== "open") {
    const [cashier] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, shift.cashierId));
    const opened = new Intl.DateTimeFormat("id-ID", {
      timeZone: outlet.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(shift.openedAt);
    closedShift = `shift ${cashier?.name ?? "kasir"} (dibuka ${opened})`;
  }
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
  return { flags, late, closedShift };
}
