// Cashier shift service (bead legend-6c0; PRD v1.7 §3 F8 "Shift Kasir", §4 E;
// acceptance POS-03: "Tutup shift memakai blind count; selisih kas tidak dapat
// disembunyikan atau diubah setelah disetujui").
//
// - Open: from a registered terminal only (device token verified by the route,
//   device -> outlet resolved by WS-02), one open shift per terminal and per
//   cashier, never on a closed business day.
// - Cash movements (kas masuk / keluar / setoran) on the cashier's own open
//   shift, with a reason; append-only.
// - Close: blind count (denominations only, the server derives counted,
//   expected and variance), a supervisor approval (`cash_shift_close`
//   override, re-verified here) and a written note for any difference. The
//   closing UPDATE writes everything at once; the closed row is frozen by the
//   pos-shift.custom.sql triggers.
// - Money is computed on the server only. Every mutation is one `withTenant`
//   transaction: row lock + write + outbox event + audit. Idempotency keys are
//   bound to a request fingerprint stored on the row.
// - Permissions are checked here on the outlet (fail closed) as well as at the
//   route; a shift of another outlet or tenant is 404.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import {
  AccessError,
  approvalPolicySchema,
  approvalRequirementFor,
  assertApprovalDecisionAllowed,
} from "@starter/shared/access";
import {
  CoreError,
  decodeCursor,
  encodeCursor,
  isoDateTimeSchema,
  toIsoDateTime,
  ulidSchema,
  ulidToUuid,
  uuidSchema,
  uuidToUlid,
  z,
  type CursorPage,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  blindCountTotalIdr,
  closeShift,
  assertCashMovementAllowed,
  shiftExpectedCashIdr,
  listPosCashMovements as listMovementsEndpoint,
  listPosShifts as listShiftsEndpoint,
  PosError,
  storedApprovalIdSchema,
  type PosCashMovement,
  type PosShift,
  type PosShiftWithFigures,
  type PosShiftCount,
  type PosShiftCountReceipt,
  type PosShiftReport,
  formatReceiptNumber,
  posShiftReportSchema,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { approvalPolicies } from "../db/schema/platform-access.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { posOverrides } from "../db/schema/device-pin.ts";
import {
  cashMovementOutcomes,
  cashMovementRefusals,
  cashMovements,
  posDailyCloses,
  posShiftCounts,
  posShifts,
} from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { resolveDeviceOutlet } from "./device-pin.service.ts";
import {
  outletTarget,
  posOverrideUsableFromDevice,
} from "./device-pin-support.ts";
import { loadOutlet, businessDateFor } from "./pos-order-support.ts";
import type { PosShiftLookup } from "./pos-order-ports.ts";
import { posReceiptGapsPort } from "./pos-shift-ports.ts";
import {
  appendShiftEvent,
  assertOutletPermission,
  assertShiftOutflowBound,
  auditShift,
  cashWatermarkOf,
  computeShiftAggregates,
  countDto,
  countReceiptDto,
  expireHeldCashMovements,
  findShift,
  heldCashOutIdrOf,
  heldCorrectionCashIdrOf,
  loadOutletAccess,
  movementDto,
  movementsOf,
  parseShiftId,
  shiftAuditView,
  blindShiftDto,
  shiftDto,
  shiftFiguresDto,
  shiftFingerprint,
  permissionDenied,
  SHIFT_COUNT_OBJECT_TYPE,
  uniqueViolationOf,
  type ClosePosShiftInput,
  type ForceClosePosShiftInput,
  type OpenPosShiftInput,
  type RecordCashMovementInput,
  type ShiftAggregates,
  type ShiftCaller,
  type ShiftCountRow,
  type ShiftRow,
  type SubmitPosShiftCountInput,
} from "./pos-shift-support.ts";
import {
  loadTenantAccessInTransaction,
  type Tx,
} from "./permission-resolver.ts";
import { revokeActingStaffForDevice } from "./pos-acting-staff-revoke.ts";
import { POS_OVERRIDE_SOURCE_MODULE } from "./staff-override.service.ts";

export type { ShiftCaller } from "./pos-shift-support.ts";

type ShiftListQuery = z.output<typeof listShiftsEndpoint.query>;
type MovementListQuery = z.output<typeof listMovementsEndpoint.query>;

/** A PIN approval is only good for this long after the supervisor typed it. */
const PIN_APPROVAL_WINDOW_MS = 15 * 60_000;

/** The cashier may submit this many counts per shift; then a supervisor closes. */
const MAX_CASHIER_COUNTS = 3;
const MIN_REASON_LENGTH = 4;

const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function invalidCursor(): CoreError {
  return new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
}

/** Keyset cursor `[isoInstant, id]` of a (time, id) ordered list. */
function decodeTimeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = decodeCursor(cursor);
    return {
      at: isoDateTimeSchema.parse(at),
      id: uuidSchema.parse(id),
    };
  } catch {
    throw invalidCursor();
  }
}

// ---- Open -------------------------------------------------------------------

export async function openPosShift(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  input: OpenPosShiftInput,
): Promise<PosShift> {
  if (caller.deviceId === null)
    throw new CoreError(
      "FORBIDDEN",
      "Shift hanya dapat dibuka dari perangkat kasir terdaftar.",
    );
  const deviceId = caller.deviceId;
  const tenantId = context.tenant.tenantId;
  const deviceOutlet = await resolveDeviceOutlet(tenantId, deviceId);
  if (deviceOutlet === null || !sameUser(deviceOutlet, outletId))
    throw new CoreError(
      "FORBIDDEN",
      "Shift hanya dapat dibuka dari perangkat kasir terdaftar.",
    );
  const { idempotencyKey, ...request } = input;
  const fingerprint = shiftFingerprint({
    op: "shift.open",
    outletId,
    userId: caller.userId,
    body: request,
  });
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const outlet = await loadOutlet(tx, context, outletId);
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "shift.cash.operate",
    );
    // One opener per outlet at a time: the replay lookup, the open-shift
    // checks and the insert then see one state.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-shift-open:${tenantId}:${outletId}`}, 0))`,
    );
    const [replay] = await tx
      .select()
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, tenantId),
          eq(posShifts.outletId, outletId),
          eq(posShifts.openKey, idempotencyKey),
        ),
      );
    if (replay) {
      if (replay.openFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      // POS-03 blind count: the cashier never sees the drawer figures.
      return shiftDto(replay, undefined, { blind: true });
    }
    const businessDate = businessDateFor(outlet, now);
    const [closedDay] = await tx
      .select({ id: posDailyCloses.id })
      .from(posDailyCloses)
      .where(
        and(
          eq(posDailyCloses.tenantId, tenantId),
          eq(posDailyCloses.outletId, outletId),
          eq(posDailyCloses.businessDate, businessDate),
        ),
      );
    if (closedDay) throw new PosError("BUSINESS_DAY_ALREADY_CLOSED");
    const [open] = await tx
      .select({ id: posShifts.id })
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, tenantId),
          eq(posShifts.outletId, outletId),
          eq(posShifts.status, "open"),
          or(
            eq(posShifts.deviceId, deviceId),
            eq(posShifts.cashierId, caller.userId),
          ),
        ),
      );
    if (open) throw new PosError("SHIFT_ALREADY_OPEN");
    let row: ShiftRow | undefined;
    try {
      [row] = await tx
        .insert(posShifts)
        .values({
          tenantId,
          outletId,
          deviceId,
          cashierId: caller.userId,
          businessDate,
          status: "open",
          openedAt: now,
          openingFloatIdr: input.openingFloatIdr,
          openKey: idempotencyKey,
          openFingerprint: fingerprint,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      const constraint = uniqueViolationOf(error);
      if (
        constraint === "pos_shifts_open_device_key" ||
        constraint === "pos_shifts_open_cashier_key"
      )
        throw new PosError("SHIFT_ALREADY_OPEN");
      throw error;
    }
    if (!row) throw new Error("Shift insert returned no row");
    await appendShiftEvent(tx, context, "cashier_shift.opened", {
      aggregateId: row.id,
      outletId,
      payload: {
        shiftId: row.id,
        outletId,
        deviceId,
        cashierId: caller.userId,
        businessDate,
        openingFloatIdr: Number(row.openingFloatIdr),
        openedAt: toIsoDateTime(now),
      },
      caller,
      now,
    });
    await auditShift(
      tx,
      context,
      {
        action: "pos_shift.opened",
        outletId,
        objectType: "pos_shift",
        objectId: row.id,
        caller,
        before: null,
        after: shiftAuditView(row),
      },
      now,
    );
    return shiftDto(row, undefined, { blind: true });
  });
}

// ---- Reads ------------------------------------------------------------------

/**
 * Own shift needs `operate`; any shift of the outlet needs view_all or
 * approve_close. Returns whether the caller may see the live drawer figures of
 * an open shift: POS-03 blind count ("kasir menghitung tanpa melihat angka
 * sistem") hides them from the shift's own cashier until the close, whatever
 * else that cashier may hold.
 */
async function assertCanRead(
  tx: Tx,
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shift: Pick<ShiftRow, "cashierId">,
): Promise<{ seesLiveFigures: boolean }> {
  const access = await loadOutletAccess(tx, context, caller.userId, outletId);
  const own = sameUser(shift.cashierId, caller.userId);
  if (
    access.has("shift.cash.view_all") ||
    access.has("shift.cash.approve_close")
  )
    return { seesLiveFigures: !own };
  if (access.has("shift.cash.operate") && own)
    return { seesLiveFigures: false };
  throw permissionDenied();
}

export async function getPosShiftReport(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
): Promise<PosShiftReport> {
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    const row = await findShift(tx, context, outletId, shiftId);
    const { seesLiveFigures } = await assertCanRead(
      tx,
      context,
      caller,
      outletId,
      row,
    );
    const live =
      row.status === "open" && seesLiveFigures
        ? await computeShiftAggregates(tx, row)
        : undefined;
    const movements = await movementsOf(tx, row);
    const receiptGaps = await posReceiptGapsPort()(tx, context, {
      outletId,
      deviceId: row.deviceId,
    });
    return posShiftReportSchema.parse({
      // legend-4wrfd: blind (no breakdown, expected or variance), open or
      // closed, for a caller who may not see the variance.
      shift: shiftDto(row, live, { blind: !seesLiveFigures }),
      movements: movements.map((movement) =>
        movementDto(movement, { withApproval: seesLiveFigures }),
      ),
      receiptGaps: receiptGaps.map((run) => ({
        prefix: run.prefix,
        missing: run.missing.map((n) => formatReceiptNumber(run.prefix, n)),
        writtenOff: run.writtenOff.map((n) =>
          formatReceiptNumber(run.prefix, n),
        ),
        lostRange: run.lost
          ? {
              from: formatReceiptNumber(run.prefix, run.lost.from),
              to: formatReceiptNumber(run.prefix, run.lost.to),
            }
          : null,
      })),
    });
  });
}

export async function listPosShifts(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  query: ShiftListQuery,
): Promise<CursorPage<PosShift>> {
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    const access = await loadOutletAccess(tx, context, caller.userId, outletId);
    const seesAll =
      access.has("shift.cash.view_all") ||
      access.has("shift.cash.approve_close");
    if (!seesAll && !access.has("shift.cash.operate")) throw permissionDenied();
    const tenantId = context.tenant.tenantId;
    const filters = [
      eq(posShifts.tenantId, tenantId),
      eq(posShifts.outletId, outletId),
    ];
    if (!seesAll) filters.push(eq(posShifts.cashierId, caller.userId));
    if (query.businessDate)
      filters.push(eq(posShifts.businessDate, query.businessDate));
    if (query.deviceId) filters.push(eq(posShifts.deviceId, query.deviceId));
    if (query.cursor) {
      const after = decodeTimeCursor(query.cursor);
      filters.push(
        sql`(${posShifts.openedAt}, ${posShifts.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(posShifts)
      .where(and(...filters))
      .orderBy(desc(posShifts.openedAt), desc(posShifts.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const data: PosShift[] = [];
    for (const row of page) {
      // POS-03 blind count (legend-4wrfd): never the caller's own shift,
      // open or closed, nor any shift for a caller without view_all.
      const seesFigures = seesAll && !sameUser(row.cashierId, caller.userId);
      data.push(
        shiftDto(
          row,
          row.status === "open" && seesFigures
            ? await computeShiftAggregates(tx, row)
            : undefined,
          { blind: !seesFigures },
        ),
      );
    }
    const last = page.at(-1);
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([toIsoDateTime(last.openedAt), last.id])
            : null,
      },
    };
  });
}

export async function listCashMovements(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
  query: MovementListQuery,
): Promise<CursorPage<PosCashMovement>> {
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    const row = await findShift(tx, context, outletId, shiftId);
    const { seesLiveFigures } = await assertCanRead(
      tx,
      context,
      caller,
      outletId,
      row,
    );
    const filters = [
      eq(cashMovements.tenantId, context.tenant.tenantId),
      eq(cashMovements.outletId, outletId),
      eq(cashMovements.shiftId, row.id),
    ];
    if (query.type) filters.push(eq(cashMovements.type, query.type));
    if (query.cursor) {
      const after = decodeTimeCursor(query.cursor);
      filters.push(
        sql`(${cashMovements.recordedAt}, ${cashMovements.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await tx
      .select({
        movement: cashMovements,
        outcome: cashMovementOutcomes.outcome,
      })
      .from(cashMovements)
      .leftJoin(
        cashMovementOutcomes,
        and(
          eq(cashMovementOutcomes.tenantId, cashMovements.tenantId),
          eq(cashMovementOutcomes.movementId, cashMovements.id),
        ),
      )
      .where(and(...filters))
      .orderBy(
        sql`${cashMovements.recordedAt} asc`,
        sql`${cashMovements.id} asc`,
      )
      .limit(query.limit + 1)
      .then((joined) =>
        joined.map((r) => ({ ...r.movement, outcome: r.outcome })),
      );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((movement) =>
        movementDto(movement, { withApproval: seesLiveFigures }),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([toIsoDateTime(last.recordedAt), last.id])
            : null,
      },
    };
  });
}

// ---- Cash movement ----------------------------------------------------------

export async function recordCashMovement(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
  input: RecordCashMovementInput,
): Promise<PosCashMovement> {
  const { idempotencyKey, ...rest } = input;
  // Spaces alone are not a reason: trim before the length check (the contract
  // schema trims too; this keeps direct callers honest). Length is in code
  // points, as the database check counts them ("😀😀" is 2, not 4).
  const reasonNote = input.reasonNote.trim();
  if (Array.from(reasonNote).length < MIN_REASON_LENGTH)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Alasan kas minimal 4 karakter (tanpa spasi di awal dan akhir).",
    );
  const request = { ...rest, reasonNote };
  const id = parseShiftId(shiftId);
  const fingerprint = shiftFingerprint({
    op: "cash_movement.record",
    outletId,
    shiftId: id,
    userId: caller.userId,
    body: request,
  });
  const now = new Date();
  const tenantId = context.tenant.tenantId;
  const outcome = await withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "shift.cash.operate",
    );
    const shift = await findShift(tx, context, outletId, id, true);
    if (!sameUser(shift.cashierId, caller.userId))
      throw new CoreError(
        "FORBIDDEN",
        "Kas hanya dapat dicatat oleh kasir pemilik shift.",
      );
    const [replay] = await tx
      .select()
      .from(cashMovements)
      .where(
        and(
          eq(cashMovements.tenantId, tenantId),
          eq(cashMovements.shiftId, shift.id),
          eq(cashMovements.idempotencyKey, idempotencyKey),
        ),
      );
    if (replay) {
      if (replay.requestFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      return movementDto(replay);
    }
    // Legacy (legend-uw47): a cash out refused before legend-67dt left a
    // refusal row under its key. Same body now simply records; another body
    // under the key is still a conflict.
    const [refusedBefore] = await tx
      .select()
      .from(cashMovementRefusals)
      .where(
        and(
          eq(cashMovementRefusals.tenantId, tenantId),
          eq(cashMovementRefusals.shiftId, shift.id),
          eq(cashMovementRefusals.idempotencyKey, idempotencyKey),
        ),
      );
    if (refusedBefore && refusedBefore.requestFingerprint !== fingerprint)
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk permintaan lain.",
      );
    assertCashMovementAllowed(shift);
    // legend-1hza: a cash in must keep every drawer figure a safe integer
    // (count and close sum opening + sales + cash in with sumIdr, which
    // throws past the bound). Checked in bigint before the insert. This bounds
    // cash in only: cash tenders (pos-order-payment.ts) are not bounded here.
    if (input.type === "cash_in") {
      const live = await computeShiftAggregates(tx, shift);
      const inflow =
        BigInt(shift.openingFloatIdr) +
        BigInt(live.cashSalesIdr) +
        BigInt(live.cashInIdr) +
        BigInt(input.amountIdr);
      if (inflow > BigInt(Number.MAX_SAFE_INTEGER))
        throw new CoreError(
          "VALIDATION_ERROR",
          "Jumlah kas masuk terlalu besar untuk shift ini.",
        );
    }
    // Cash out and drops larger than the expected drawer cash are accepted
    // like any other (the response is identical, so the cashier cannot probe
    // the expected cash by being refused) but held for supervisor review
    // (legend-67dt): the row is flagged, left out of the drawer figures, and
    // audited without any expected figure. The shift row is locked, so the
    // figures cannot move under this check. The cash of a held refund or void
    // has already left the drawer though the figures leave it out, so it is
    // taken off the limit too: the physical cash bounds the movement, the same
    // bound the approval applies (pos-shift-cash-approval.service.ts).
    let needsApproval = false;
    if (input.type !== "cash_in") {
      // Every cash outflow of the shift, held or not and whichever writer
      // recorded it, stays a safe integer (held rows are no longer bounded by
      // the drawer). The bound ignores the held flag, so it says nothing
      // about the drawer (legend-utqr, legend-q7jj F3).
      await assertShiftOutflowBound(tx, shift, input.amountIdr);
      const live = await computeShiftAggregates(tx, shift);
      const expected =
        Number(shift.openingFloatIdr) +
        live.cashSalesIdr -
        live.cashRefundsIdr +
        live.cashInIdr -
        live.cashOutIdr -
        live.cashDropIdr;
      needsApproval =
        input.amountIdr > expected - (await heldCorrectionCashIdrOf(tx, shift));
    }
    const [row] = await tx
      .insert(cashMovements)
      .values({
        tenantId,
        outletId,
        shiftId: shift.id,
        type: input.type,
        amountIdr: input.amountIdr,
        reasonNote,
        recordedBy: caller.userId,
        recordedAt: now,
        approvedBy: null,
        needsApproval,
        idempotencyKey,
        requestFingerprint: fingerprint,
      })
      .returning();
    if (!row) throw new Error("Cash movement insert returned no row");
    const dto = movementDto(row);
    await appendShiftEvent(tx, context, "cash_movement.recorded", {
      aggregateId: row.id,
      outletId,
      payload: {
        movementId: row.id,
        shiftId: shift.id,
        outletId,
        deviceId: shift.deviceId,
        type: dto.type,
        amountIdr: dto.amountIdr,
        reasonNote: dto.reasonNote,
        recordedBy: dto.recordedBy,
        recordedAt: dto.recordedAt,
      },
      caller,
      now,
    });
    await auditShift(
      tx,
      context,
      {
        action: "pos_shift.cash_movement_recorded",
        outletId,
        objectType: "cash_movement",
        objectId: row.id,
        caller,
        before: null,
        after: {
          id: row.id,
          shiftId: shift.id,
          type: dto.type,
          amountIdr: dto.amountIdr,
        },
        reason: dto.reasonNote,
      },
      now,
    );
    if (needsApproval)
      await auditShift(
        tx,
        context,
        {
          action: "pos_shift.cash_movement_held",
          outletId,
          objectType: "cash_movement",
          objectId: row.id,
          caller,
          before: null,
          after: {
            id: row.id,
            shiftId: shift.id,
            type: dto.type,
            amountIdr: dto.amountIdr,
          },
          reason: dto.reasonNote,
        },
        now,
      );
    return dto;
  });
  return outcome;
}

// ---- Blind count submissions (POS-03) ---------------------------------------
//
// Second-opinion round 2 (legend-6c0, P1 "approval not bound to the variance"
// and P2 "count discarded without a note"): the cashier first submits the
// count. The server stores it append-only (pos_shift_counts) with the
// expected cash and variance it computed under the shift lock, and the
// cashier only learns whether a note will be needed. The supervisor approval
// names that submission (object `pos_shift_count`) and its value is the
// server variance (staff-override.service.ts). Different numbers are a new
// submission and therefore need a new approval; every submission stays on
// record for the supervisor.

/** Expected drawer cash of `shift` with `aggregates`; RangeError -> 409. */
function expectedCashOf(shift: ShiftRow, aggregates: ShiftAggregates): number {
  try {
    return Number(shiftExpectedCashIdr(shiftFiguresDto(shift, aggregates)));
  } catch (error) {
    if (error instanceof RangeError)
      throw new CoreError("CONFLICT", error.message);
    throw error;
  }
}

function countedCashOf(counts: ShiftCountRow["counts"]): number {
  try {
    return Number(blindCountTotalIdr(counts));
  } catch (error) {
    if (error instanceof RangeError)
      throw new CoreError("VALIDATION_ERROR", error.message);
    throw error;
  }
}

/** sha256 of the denomination lines in a canonical order. */
function countsFingerprintOf(counts: ShiftCountRow["counts"]): string {
  const lines = [...counts]
    .map((line) => [line.denominationIdr, line.quantity] as const)
    .sort((a, b) => b[0] - a[0]);
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex");
}

export async function submitPosShiftCount(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
  input: SubmitPosShiftCountInput,
): Promise<PosShiftCountReceipt> {
  const { idempotencyKey, ...request } = input;
  const id = parseShiftId(shiftId);
  const fingerprint = shiftFingerprint({
    op: "shift.count",
    outletId,
    shiftId: id,
    userId: caller.userId,
    body: request,
  });
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    // Same row lock as cash, cash movements and the close: the expected cash
    // stored with the count is the drawer at this instant.
    const shift = await findShift(tx, context, outletId, id, true);
    // The shift's cashier counts (operate); a supervisor holding
    // approve_close counts a shift that is not theirs: a forced count (U9),
    // the first step of a force close, outside the cashier's recount limit.
    const forced = !sameUser(shift.cashierId, caller.userId);
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      forced ? "shift.cash.approve_close" : "shift.cash.operate",
    );
    const [replay] = await tx
      .select()
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, tenantId),
          eq(posShiftCounts.shiftId, shift.id),
          eq(posShiftCounts.idempotencyKey, idempotencyKey),
        ),
      );
    if (replay) {
      if (replay.requestFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      return countReceiptDto(replay);
    }
    if (shift.status !== "open") throw new PosError("SHIFT_ALREADY_CLOSED");
    const now = new Date();
    const aggregates = await computeShiftAggregates(tx, shift);
    const expectedIdr = expectedCashOf(shift, aggregates);
    const heldCashOutIdr = await heldCashOutIdrOf(tx, shift);
    const heldCorrectionIdr = await heldCorrectionCashIdrOf(tx, shift);
    const cashWatermark = await cashWatermarkOf(tx, shift);
    const counts = request.counts.map((line) => ({
      denominationIdr: line.denominationIdr,
      quantity: line.quantity,
    }));
    const countedIdr = countedCashOf(counts);
    const [last] = await tx
      .select({ sequence: posShiftCounts.sequence })
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, tenantId),
          eq(posShiftCounts.shiftId, shift.id),
        ),
      )
      .orderBy(desc(posShiftCounts.sequence))
      .limit(1);
    // The limit counts the cashier's own counts only: a supervisor's forced
    // count must not use up the cashier's recounts.
    if (!forced) {
      const [own] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(posShiftCounts)
        .where(
          and(
            eq(posShiftCounts.tenantId, tenantId),
            eq(posShiftCounts.shiftId, shift.id),
            eq(posShiftCounts.forced, false),
          ),
        );
      if ((own?.n ?? 0) >= MAX_CASHIER_COUNTS)
        throw new PosError("SHIFT_COUNT_LIMIT");
    }
    const [row] = await tx
      .insert(posShiftCounts)
      .values({
        tenantId,
        outletId,
        shiftId: shift.id,
        sequence: (last?.sequence ?? 0) + 1,
        counts,
        countsFingerprint: countsFingerprintOf(counts),
        countedIdr: countedIdr as Idr,
        expectedIdr: expectedIdr as Idr,
        varianceIdr: (countedIdr - expectedIdr) as Idr,
        heldCashOutIdr: heldCashOutIdr as Idr,
        heldCorrectionIdr: heldCorrectionIdr as Idr,
        cashWatermark,
        submittedBy: caller.userId,
        submittedAt: now,
        forced,
        idempotencyKey,
        requestFingerprint: fingerprint,
      })
      .returning();
    if (!row) throw new Error("pos_shift_counts insert returned no row");
    await auditShift(
      tx,
      context,
      {
        action: "pos_shift.counted",
        outletId,
        objectType: "pos_shift_count",
        objectId: row.id,
        caller,
        before: null,
        after: {
          shiftId: row.shiftId,
          sequence: row.sequence,
          counts: row.counts,
          countedIdr: Number(row.countedIdr),
          expectedIdr: Number(row.expectedIdr),
          varianceIdr: Number(row.varianceIdr),
          heldCashOutIdr: Number(row.heldCashOutIdr),
        },
      },
      now,
    );
    return countReceiptDto(row);
  });
}

/** Every count submission of a shift, oldest first (supervisors only). */
export async function listPosShiftCounts(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
): Promise<PosShiftCount[]> {
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    const shift = await findShift(tx, context, outletId, shiftId);
    const { seesLiveFigures } = await assertCanRead(
      tx,
      context,
      caller,
      outletId,
      shift,
    );
    // The shift's own cashier counts blind: the trail shows the variance.
    if (!seesLiveFigures) throw permissionDenied();
    const rows = await tx
      .select()
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, context.tenant.tenantId),
          eq(posShiftCounts.outletId, outletId),
          eq(posShiftCounts.shiftId, shift.id),
        ),
      )
      .orderBy(asc(posShiftCounts.sequence));
    return rows.map(countDto);
  });
}

// ---- Close ------------------------------------------------------------------

type OverrideRow = typeof posOverrides.$inferSelect;

const approvalRefused = () =>
  new CoreError("FORBIDDEN", "Persetujuan supervisor tidak sah.");

/**
 * The supervisor decision a close names: an approved `cash_shift_close`
 * override for exactly this count submission, requested by the cashier,
 * decided by `approvedBy` (never the cashier), worth exactly the server
 * variance, found by its phone chain id or its own id, fresh when it is a PIN
 * decision, `approvedBy` still holding the approve permission, and the
 * approval matrix tier for that value satisfied now. Anything else is
 * refused (fail closed).
 */
async function verifyCloseApproval(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    shift: ShiftRow;
    /** Who asked for the approval: the cashier, or the supervisor on a force close. */
    requestedBy: string;
    /** What the approval names: the cashier's count, or the shift on a force close. */
    object: { type: string; id: string };
    valueIdr: number;
    approvedBy: string;
    approvalRequestId: string;
    /** The verified device the caller acts from (null: no device). */
    deviceId: string | null;
    now: Date;
  },
): Promise<OverrideRow> {
  const { shift, object } = input;
  if (sameUser(input.approvedBy, shift.cashierId)) throw approvalRefused();
  // The id is either the PIN override's own ULID (what the override service
  // returns), or a uuid: the phone approval chain id, or an override id in its
  // stored `ulidToUuid` form. Both name the same override row.
  let requestUuid: string;
  let overrideId: string | null = null;
  const ulid = ulidSchema.safeParse(input.approvalRequestId);
  if (ulid.success) {
    overrideId = ulid.data;
    requestUuid = ulidToUuid(ulid.data);
  } else {
    const uuid = storedApprovalIdSchema.safeParse(input.approvalRequestId);
    if (!uuid.success) throw approvalRefused();
    requestUuid = uuid.data;
    try {
      overrideId = uuidToUlid(requestUuid);
    } catch {
      overrideId = null;
    }
  }
  // Candidates: approved cash_shift_close overrides for exactly this count
  // submission, requested by the shift's cashier and decided by the named
  // approver.
  const candidates = await tx
    .select()
    .from(posOverrides)
    .where(
      and(
        eq(posOverrides.tenantId, context.tenant.tenantId),
        eq(posOverrides.outletId, input.outletId),
        eq(posOverrides.status, "approved"),
        eq(posOverrides.action, "cash_shift_close"),
        eq(posOverrides.objectType, object.type),
        sql`lower(${posOverrides.objectId}) = ${object.id.toLowerCase()}`,
        sql`lower(${posOverrides.requestedBy}) = ${input.requestedBy.toLowerCase()}`,
        sql`lower(${posOverrides.approvedBy}) = ${input.approvedBy.toLowerCase()}`,
      ),
    )
    .orderBy(desc(posOverrides.createdAt))
    .for("update");
  // 1. The named approval: the phone chain id, or the override id itself.
  // 2. A PIN override has no approval request and its ULID id rarely parses
  //    as an RFC UUID (same contract gap as pos-order consumeApproval): the
  //    newest PIN override for this very count, cashier and approver. The
  //    override names one immutable count of one shift and a shift closes
  //    once; approval_override_id is unique besides.
  const named = candidates.find(
    (row) =>
      row.approvalRequestId?.toLowerCase() === requestUuid ||
      (overrideId !== null && row.id === overrideId),
  );
  let override = named;
  if (!override) {
    // The fallback only serves an id that names no override at all: an id
    // that names another decision (another count, action or approver) is
    // refused, never silently swapped for a different approval.
    const [elsewhere] = await tx
      .select({ id: posOverrides.id })
      .from(posOverrides)
      .where(
        and(
          eq(posOverrides.tenantId, context.tenant.tenantId),
          overrideId === null
            ? eq(posOverrides.approvalRequestId, requestUuid)
            : or(
                eq(posOverrides.approvalRequestId, requestUuid),
                eq(posOverrides.id, overrideId),
              ),
        ),
      )
      .limit(1);
    if (elsewhere) throw approvalRefused();
    // Nor an id of a request in the approval inbox (another module's, or a
    // rejected one): the shift and its event would name the wrong decision.
    const [inbox] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.id, requestUuid),
        ),
      )
      .limit(1);
    if (inbox) throw approvalRefused();
    override = candidates.find((row) => row.method === "supervisor_pin");
  }
  if (
    !override ||
    override.approvedBy === null ||
    sameUser(override.approvedBy, override.requestedBy)
  )
    throw approvalRefused();
  // Bound to the value: the approval was given for exactly this variance.
  if (Number(override.valueIdr) !== input.valueIdr) throw approvalRefused();
  // A PIN approval typed on a verified device is bound to it (legend-fjwxo).
  if (!posOverrideUsableFromDevice(override, input.deviceId))
    throw approvalRefused();
  if (
    override.method === "supervisor_pin" &&
    input.now.getTime() - override.createdAt.getTime() > PIN_APPROVAL_WINDOW_MS
  )
    throw approvalRefused();
  const approver = await loadOutletAccess(
    tx,
    context,
    override.approvedBy,
    input.outletId,
    input.now,
  );
  if (!approver.has("shift.cash.approve_close")) throw approvalRefused();
  await assertApprovalTier(tx, context, {
    override,
    approvedBy: override.approvedBy,
    cashierId: input.requestedBy,
    outletId: input.outletId,
    valueIdr: input.valueIdr,
    now: input.now,
  });
  return override;
}

/**
 * §3.7 approval matrix, checked when the approval is used (not only when it
 * was asked for). Shift-close authority does not depend on the variance: the
 * cashier counts blind, and a tier that followed the variance would let
 * repeated counts reveal it. So the check uses no amount, which applies every
 * tier and lands on the top tier as the tenant's matrix stands now. A tenant
 * without a `cash_shift_close` rule relies on the approve permission alone
 * (checked by the caller), though a phone chain must still have the shape
 * below (legend-q7jj F4).
 * - Phone approval: the chain was opened without an amount (a chain with an
 *   amount is an old one and is refused), its payload names exactly this
 *   variance, and it is approved at least at as many levels as the top tier
 *   asks for.
 * - PIN approval: one person decides at the device, so the top tier must have
 *   one level and the approver must hold one of its roles on this outlet.
 */
async function assertApprovalTier(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    override: OverrideRow;
    approvedBy: string;
    cashierId: string;
    outletId: OutletId;
    valueIdr: number;
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const policies = (
    await tx
      .select()
      .from(approvalPolicies)
      .where(
        and(
          eq(approvalPolicies.tenantId, tenantId),
          eq(approvalPolicies.actionType, "cash_shift_close"),
        ),
      )
  ).map((row) =>
    approvalPolicySchema.parse({
      id: row.id,
      actionType: row.actionType,
      thresholdIdr: row.thresholdIdr,
      approverRoleId: row.approverRoleId,
      levels: row.levels,
      requiresDistinctActor: true,
    }),
  );
  const { override } = input;
  // legend-q7jj F4: the shape of a phone chain is checked before the matrix
  // is read, so an old chain (opened with an amount, or a payload without
  // this numeric variance) is refused even once the admin deleted every
  // cash_shift_close rule. Only the level count depends on the matrix.
  let approvedLevels: number | null = null;
  if (override.method === "supervisor_phone") {
    if (override.approvalRequestId === null) throw approvalRefused();
    const chain = await tx
      .select({
        level: approvalRequests.level,
        status: approvalRequests.status,
        amountIdr: approvalRequests.amountIdr,
        sourceModule: approvalRequests.sourceModule,
        actionType: approvalRequests.actionType,
        payload: approvalRequests.payload,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          eq(approvalRequests.chainId, override.approvalRequestId),
        ),
      );
    const first = chain.find((row) => row.level === 1);
    if (
      !first ||
      first.sourceModule !== POS_OVERRIDE_SOURCE_MODULE ||
      first.actionType !== "cash_shift_close" ||
      first.amountIdr !== null ||
      typeof first.payload.valueIdr !== "number" ||
      first.payload.valueIdr !== input.valueIdr ||
      chain.some((row) => row.status !== "approved")
    )
      throw approvalRefused();
    approvedLevels = chain.length;
  }
  if (policies.length === 0) return;
  const requirement = approvalRequirementFor(
    policies,
    "cash_shift_close",
    null,
  );
  if (!requirement.required) return;
  if (approvedLevels !== null) {
    if (approvedLevels < requirement.steps.length) throw approvalRefused();
    return;
  }
  if (requirement.steps.length !== 1)
    throw new CoreError(
      "FORBIDDEN",
      "Penutupan shift ini perlu persetujuan supervisor lewat ponsel.",
    );
  const step = requirement.steps[0];
  if (!step) throw approvalRefused();
  const data = await loadTenantAccessInTransaction(
    tx,
    context,
    input.approvedBy,
  );
  try {
    assertApprovalDecisionAllowed({
      requirement,
      requestedBy: input.cashierId,
      priorDecisions: [],
      level: step.level,
      approver: {
        tenantId,
        userId: input.approvedBy as UserId,
        assignments: data.assignments,
      },
      approverRoles: data.roles,
      approverMfaVerified: false,
      surface: "pos",
      target: outletTarget(input.outletId),
      org: data.org,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof AccessError) throw approvalRefused();
    throw error;
  }
}

export async function closePosShift(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
  input: ClosePosShiftInput,
): Promise<PosShift> {
  const { idempotencyKey, ...request } = input;
  const id = parseShiftId(shiftId);
  const fingerprint = shiftFingerprint({
    op: "shift.close",
    outletId,
    shiftId: id,
    userId: caller.userId,
    body: { ...request, varianceNote: request.varianceNote ?? null },
  });
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "shift.cash.operate",
    );
    // Row lock first: cash tenders, refunds and voids take the same row
    // (pos-cash-guard.ts, FOR SHARE), so everything that committed before
    // this point is in the figures below and nothing lands after it.
    const shift = await findShift(tx, context, outletId, id, true);
    const now = new Date();
    if (!sameUser(shift.cashierId, caller.userId))
      throw new CoreError(
        "FORBIDDEN",
        "Shift hanya dapat ditutup oleh kasir pemilik shift.",
      );
    if (shift.status === "closed") {
      if (shift.closeKey !== idempotencyKey)
        throw new PosError("SHIFT_ALREADY_CLOSED");
      if (shift.closeFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      // The closer is the shift's cashier: blind replay (legend-4wrfd).
      return shiftDto(shift, undefined, { blind: true });
    }
    const [count] = await tx
      .select()
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, tenantId),
          eq(posShiftCounts.outletId, outletId),
          eq(posShiftCounts.shiftId, shift.id),
          eq(posShiftCounts.id, input.countId),
        ),
      );
    if (!count)
      throw new CoreError("NOT_FOUND", "Hitungan kas tidak ditemukan.");
    const [latest] = await tx
      .select({ id: posShiftCounts.id })
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, tenantId),
          eq(posShiftCounts.shiftId, shift.id),
        ),
      )
      .orderBy(desc(posShiftCounts.sequence))
      .limit(1);
    if (!latest || latest.id !== count.id)
      throw new PosError("SHIFT_COUNT_SUPERSEDED");
    // A supervisor's forced count is closed with force-close, never by the cashier.
    if (count.forced)
      throw new CoreError(
        "FORBIDDEN",
        "Shift ini hanya dapat ditutup oleh supervisor.",
      );
    // legend-q7jj F1: any cash row since the count (held or not) makes it
    // stale, checked first and the same way for every row, so the answer
    // never tells a held row from a normal one. A count made before the
    // watermark existed is stale too, and so is one made before the held
    // correction was stored (legend-y9bf): its receipt judged the note
    // with the old formula.
    if (
      count.cashWatermark === null ||
      count.heldCorrectionIdr === null ||
      (await cashWatermarkOf(tx, shift)) !== count.cashWatermark
    )
      throw new PosError("SHIFT_COUNT_STALE");
    const aggregates: ShiftAggregates = await computeShiftAggregates(tx, shift);
    // The variance is the server's: if the drawer moved since the count, the
    // approved value no longer describes it and the cashier counts again.
    // A cash out held for review moves no drawer figure, so it is checked
    // on its own: the supervisor approved the count with its held sum.
    // Backstop of the watermark above.
    // legend-y9bf: the close books variance + the held refund and void cash
    // the count stored (their own events book that cash); held cash outs
    // expire in writeClose. The note rule follows that booked difference.
    // The recomputed held correction is a cheap backstop of the count's.
    const heldCorrectionIdr = Number(count.heldCorrectionIdr);
    if (
      expectedCashOf(shift, aggregates) !== Number(count.expectedIdr) ||
      (await heldCashOutIdrOf(tx, shift)) !== Number(count.heldCashOutIdr) ||
      (await heldCorrectionCashIdrOf(tx, shift)) !== heldCorrectionIdr
    )
      throw new PosError("SHIFT_COUNT_STALE");
    let closed: PosShiftWithFigures;
    try {
      closed = closeShift(shiftFiguresDto(shift, aggregates), {
        counts: count.counts,
        countId: count.id,
        heldCashOutIdr: heldCorrectionIdr,
        varianceNote: input.varianceNote ?? null,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        approvedAt: toIsoDateTime(now),
        closedAt: toIsoDateTime(now),
      });
    } catch (error) {
      if (error instanceof RangeError)
        throw new CoreError("CONFLICT", error.message);
      throw error;
    }
    if (
      closed.expectedIdr === null ||
      closed.countedIdr === null ||
      closed.varianceIdr === null ||
      closed.varianceIdr !== Number(count.varianceIdr)
    )
      throw new Error("Closed shift figures differ from its count");
    const override = await verifyCloseApproval(tx, context, {
      outletId,
      shift,
      requestedBy: shift.cashierId,
      object: { type: SHIFT_COUNT_OBJECT_TYPE, id: count.id },
      valueIdr: Math.abs(closed.varianceIdr),
      approvedBy: input.approvedBy,
      approvalRequestId: input.approvalRequestId,
      deviceId: caller.deviceId,
      now,
    });
    // The closer is the shift's cashier: blind response (legend-4wrfd).
    return blindShiftDto(
      await writeClose(tx, context, caller, {
        outletId,
        shift,
        aggregates,
        count,
        closed,
        heldCorrectionIdr,
        override,
        idempotencyKey,
        fingerprint,
        now,
        auditAction: "pos_shift.closed",
      }),
    );
  });
}

/**
 * The closing UPDATE, the `cashier_shift.closed` event and the audit row,
 * shared by the cashier close and the supervisor force close. The stored
 * approval id and approver are the verified override's, never the raw client
 * values.
 */
async function writeClose(
  tx: Tx,
  context: ScopedTenantContext,
  caller: ShiftCaller,
  input: {
    outletId: OutletId;
    shift: ShiftRow;
    aggregates: ShiftAggregates;
    count: ShiftCountRow;
    closed: PosShiftWithFigures;
    /** Held refund and void cash of the shift (heldCorrectionCashIdrOf). */
    heldCorrectionIdr: number;
    override: OverrideRow;
    idempotencyKey: string;
    fingerprint: string;
    now: Date;
    auditAction: "pos_shift.closed" | "pos_shift.force_closed";
  },
): Promise<PosShift> {
  const { outletId, shift, aggregates, count, closed, override, now } = input;
  const tenantId = context.tenant.tenantId;
  // legend-y9bf: the booked difference. Held cash outs and drops are left
  // out: they expire here, their cash still in the drawer (counted against
  // an expected that never subtracted them).
  const differenceIdr = (closed.varianceIdr ?? 0) + input.heldCorrectionIdr;
  const expiredIdr = await expireHeldCashMovements(
    tx,
    context,
    shift,
    caller,
    now,
  );
  const approvedAt = override.resolvedAt ?? override.createdAt;
  // The verified override's approver, never the client's spelling of the id.
  const approvedBy = override.approvedBy;
  if (approvedBy === null) throw new Error("Verified override has no approver");
  const approvalRequestId =
    override.approvalRequestId ?? ulidToUuid(override.id);
  let row: ShiftRow | undefined;
  try {
    [row] = await tx
      .update(posShifts)
      .set({
        status: "closed",
        cashSalesIdr: closed.cashSalesIdr,
        cashRefundsIdr: closed.cashRefundsIdr,
        cashInIdr: closed.cashInIdr,
        cashOutIdr: closed.cashOutIdr,
        cashDropIdr: closed.cashDropIdr,
        expectedIdr: closed.expectedIdr,
        countedIdr: closed.countedIdr,
        varianceIdr: closed.varianceIdr,
        varianceNote: closed.varianceNote,
        heldCashOutIdr: count.heldCashOutIdr,
        differenceIdr: differenceIdr as Idr,
        counts: count.counts,
        countId: count.id,
        approvedBy,
        approvalRequestId,
        approvalOverrideId: ulidToUuid(override.id),
        approvedAt,
        closedAt: now,
        closedBy: caller.userId,
        closeKey: input.idempotencyKey,
        closeFingerprint: input.fingerprint,
        version: shift.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(posShifts.tenantId, tenantId),
          eq(posShifts.outletId, outletId),
          eq(posShifts.id, shift.id),
          eq(posShifts.status, "open"),
        ),
      )
      .returning();
  } catch (error) {
    if (uniqueViolationOf(error) === "pos_shifts_approval_override_key")
      throw new CoreError(
        "FORBIDDEN",
        "Persetujuan supervisor ini sudah dipakai.",
      );
    throw error;
  }
  if (!row) throw new CoreError("CONFLICT", "Shift sudah tidak terbuka.");
  // legend-aruta: the acting cashier of the shift's device ends with the shift.
  await revokeActingStaffForDevice(tx, context.tenant, {
    deviceId: row.deviceId,
    reason: "shift_closed",
  });
  const dto = shiftFiguresDto(row);
  await appendShiftEvent(tx, context, "cashier_shift.closed", {
    aggregateId: row.id,
    outletId,
    payload: {
      shiftId: row.id,
      outletId,
      deviceId: row.deviceId,
      cashierId: row.cashierId,
      businessDate: row.businessDate,
      openingFloatIdr: dto.openingFloatIdr,
      cashSalesIdr: dto.cashSalesIdr,
      cashRefundsIdr: dto.cashRefundsIdr,
      cashInIdr: dto.cashInIdr,
      cashOutIdr: dto.cashOutIdr,
      cashDropIdr: dto.cashDropIdr,
      expectedIdr: closed.expectedIdr,
      countedIdr: closed.countedIdr,
      // counted − (expected − held refund and void cash) (legend-y9bf): a
      // held refund is already credited to cash by order.refunded, so the
      // stored variance alone would book it twice. Expired held cash outs
      // are not in it. Stored as pos_shifts.difference_idr.
      differenceIdr,
      heldCashOutIdr: input.heldCorrectionIdr,
      varianceNote: dto.varianceNote,
      approvedBy,
      approvalRequestId,
      closedAt: toIsoDateTime(now),
    },
    caller,
    now,
  });
  await auditShift(
    tx,
    context,
    {
      action: input.auditAction,
      outletId,
      objectType: "pos_shift",
      objectId: row.id,
      caller,
      before: shiftAuditView(shift, aggregates),
      after: {
        ...shiftAuditView(row),
        countId: count.id,
        heldCashOutIdr: Number(count.heldCashOutIdr),
        differenceIdr,
        expiredCashOutIdr: expiredIdr,
      },
      reason: dto.varianceNote,
    },
    now,
  );
  return dto;
}

// ---- Force close (U9) --------------------------------------------------------

/**
 * A supervisor closes a shift the cashier could not (recount limit, absent
 * cashier), in two steps: the supervisor submits a forced count
 * (`submitPosShiftCount`), the witness approves it through the normal
 * `cash_shift_close` override on that count (requested by the supervisor), then
 * this closes the shift with it. One transaction under the shift lock. Never
 * the shift's cashier; the witness is neither the caller nor the cashier.
 */
export async function forceClosePosShift(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  shiftId: string,
  input: ForceClosePosShiftInput,
): Promise<PosShift> {
  const { idempotencyKey, ...request } = input;
  const id = parseShiftId(shiftId);
  const fingerprint = shiftFingerprint({
    op: "shift.force_close",
    outletId,
    shiftId: id,
    userId: caller.userId,
    body: request,
  });
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await loadOutlet(tx, context, outletId);
    await assertOutletPermission(
      tx,
      context,
      caller.userId,
      outletId,
      "shift.cash.approve_close",
    );
    const shift = await findShift(tx, context, outletId, id, true);
    const now = new Date();
    if (sameUser(shift.cashierId, caller.userId))
      throw new CoreError(
        "FORBIDDEN",
        "Kasir pemilik shift tidak dapat menutup paksa shiftnya sendiri.",
      );
    if (shift.status === "closed") {
      if (shift.closeKey !== idempotencyKey)
        throw new PosError("SHIFT_ALREADY_CLOSED");
      if (shift.closeFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk permintaan lain.",
        );
      return shiftDto(shift);
    }
    // The witness is a third person.
    if (
      sameUser(input.approvedBy, caller.userId) ||
      sameUser(input.approvedBy, shift.cashierId)
    )
      throw approvalRefused();
    const [count] = await tx
      .select()
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, tenantId),
          eq(posShiftCounts.outletId, outletId),
          eq(posShiftCounts.shiftId, shift.id),
          eq(posShiftCounts.id, input.countId),
        ),
      );
    if (!count)
      throw new CoreError("NOT_FOUND", "Hitungan kas tidak ditemukan.");
    if (!count.forced || !sameUser(count.submittedBy, caller.userId))
      throw new CoreError(
        "FORBIDDEN",
        "Penutupan paksa harus memakai hitungan kas Anda sendiri.",
      );
    const [latest] = await tx
      .select({ id: posShiftCounts.id })
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, tenantId),
          eq(posShiftCounts.shiftId, shift.id),
        ),
      )
      .orderBy(desc(posShiftCounts.sequence))
      .limit(1);
    if (!latest || latest.id !== count.id)
      throw new PosError("SHIFT_COUNT_SUPERSEDED");
    // legend-q7jj F1, legend-y9bf: same staleness check as the cashier close.
    if (
      count.cashWatermark === null ||
      count.heldCorrectionIdr === null ||
      (await cashWatermarkOf(tx, shift)) !== count.cashWatermark
    )
      throw new PosError("SHIFT_COUNT_STALE");
    const aggregates: ShiftAggregates = await computeShiftAggregates(tx, shift);
    // A cash out held for review moves no drawer figure, so it is checked
    // on its own: the supervisor approved the count with its held sum.
    // Backstop of the watermark above.
    // legend-y9bf: the close books variance + the held refund and void cash
    // the count stored (their own events book that cash); held cash outs
    // expire in writeClose. The note rule follows that booked difference.
    // The recomputed held correction is a cheap backstop of the count's.
    const heldCorrectionIdr = Number(count.heldCorrectionIdr);
    if (
      expectedCashOf(shift, aggregates) !== Number(count.expectedIdr) ||
      (await heldCashOutIdrOf(tx, shift)) !== Number(count.heldCashOutIdr) ||
      (await heldCorrectionCashIdrOf(tx, shift)) !== heldCorrectionIdr
    )
      throw new PosError("SHIFT_COUNT_STALE");
    let closed: PosShiftWithFigures;
    try {
      closed = closeShift(shiftFiguresDto(shift, aggregates), {
        counts: count.counts,
        countId: count.id,
        heldCashOutIdr: heldCorrectionIdr,
        varianceNote: input.note,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        approvedAt: toIsoDateTime(now),
        closedAt: toIsoDateTime(now),
      });
    } catch (error) {
      if (error instanceof RangeError)
        throw new CoreError("CONFLICT", error.message);
      throw error;
    }
    if (
      closed.varianceIdr === null ||
      closed.varianceIdr !== Number(count.varianceIdr)
    )
      throw new Error("Closed shift figures differ from its count");
    const override = await verifyCloseApproval(tx, context, {
      outletId,
      shift,
      requestedBy: caller.userId,
      object: { type: SHIFT_COUNT_OBJECT_TYPE, id: count.id },
      valueIdr: Math.abs(closed.varianceIdr),
      approvedBy: input.approvedBy,
      approvalRequestId: input.approvalRequestId,
      deviceId: caller.deviceId,
      now,
    });
    return writeClose(tx, context, caller, {
      outletId,
      shift,
      aggregates,
      count,
      closed,
      heldCorrectionIdr,
      override,
      idempotencyKey,
      fingerprint,
      now,
      auditAction: "pos_shift.force_closed",
    });
  });
}

// ---- Order service hook -----------------------------------------------------

/** The open shift of a cashier (and terminal, when given) for order attribution. */
export const findOpenShiftId: PosShiftLookup = async (tx, context, input) => {
  const filters = [
    eq(posShifts.tenantId, context.tenant.tenantId),
    eq(posShifts.outletId, input.outletId as OutletId),
    eq(posShifts.status, "open"),
    eq(posShifts.cashierId, input.cashierId),
  ];
  if (input.deviceId) filters.push(eq(posShifts.deviceId, input.deviceId));
  const [row] = await tx
    .select({ id: posShifts.id })
    .from(posShifts)
    .where(and(...filters))
    .limit(1);
  return row?.id ?? null;
};
