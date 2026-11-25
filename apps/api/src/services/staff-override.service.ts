// POS supervisor override (bead legend-dxb; PRD v1.7 §3 F6 "Override
// Supervisor": "Void, diskon di atas ambang, refund, buka laci tanpa
// transaksi, dan koreksi harga memerlukan PIN supervisor atau approval dari
// ponsel supervisor, beserta alasan"; AUTH-06: "Override di POS selalu
// mencatat pemohon, penyetuju, alasan, dan nilai; penyetuju tidak dapat sama
// dengan pemohon").
//
// Two ways to approve:
// - `supervisor_pin` (approver present): the approver's pin is checked with
//   the device pin service (counted, lockable), the approver must hold the
//   action's override permission on the outlet (permission-resolver, fail
//   closed), and the override is recorded approved at once.
// - `supervisor_phone` (approver away): a request is opened in the generic
//   approval inbox (platform-approval.service `openApprovalRequest`,
//   sourceModule `pos_override`); the supervisor decides there. The override
//   resolves when its chain ends: approved → recorded, with the final
//   approver re-checked for the override permission (fail closed);
//   rejected / expired / cancelled → no override.
//
// Every recorded override writes requester, approver, reason, value and
// outlet (pos_overrides + recordAudit) and appends `pos_override.recorded` to
// the outbox in the same transaction. The free-text reason is in the row and
// the audit log, never in the event.
//
// Idempotency: an `Idempotency-Key` is bound to the request fingerprint
// (requester, outlet, action, value, reason, object, method, approver). Same
// key + same body → the stored override (no second pin check, no second
// record); same key + another body → IDEMPOTENCY_KEY_REUSED. Creation for one
// key is serialised with an advisory lock.

import { AccessError, type PosOverrideAction } from "@starter/shared/access";
import {
  POS_OVERRIDE_APPROVE_PERMISSION,
  posOverrideRecordedEvent,
  posOverrideViewSchema,
  type CreatePosOverrideInput,
  type PosOverrideStatus,
  type PosOverrideView,
} from "@starter/shared/access/override";
import {
  CoreError,
  createUlid,
  idempotencyKeySchema,
  outletIdSchema,
  ulidSchema,
  userIdSchema,
  uuidSchema,
  type Idr,
  type ScopedTenantContext,
  type TenantContext,
  type TenantId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { ApprovalRequest } from "@starter/shared/identity";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { approvalRequests } from "../db/schema/platform-approval";
import { posOverrides } from "../db/schema/device-pin";
import { posShiftCounts, posShifts } from "../db/schema/pos-shift";
import { SHIFT_COUNT_OBJECT_TYPE } from "./pos-shift-support";
import { withTenant } from "../db/tenant";
import { getEdgeRuntimeState } from "../edge/runtime";
import { recordAudit } from "./audit-writer";
import { attemptApproverPin } from "./staff-pin-proof.service";
import {
  appendDevicePinEvent,
  isOutletMember,
  membershipContext,
  outletContext,
  outletTarget,
  posOverrideFingerprint,
} from "./device-pin-support";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver";
import {
  cancelOwnModuleApprovalRequest,
  getOwnModuleApprovalRequest,
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service";

type Row = typeof posOverrides.$inferSelect;

/** `sourceModule` of the approval requests this service opens. */
export const POS_OVERRIDE_SOURCE_MODULE = "pos_override";
/** `objectType` of those approval requests (the override row itself). */
const APPROVAL_OBJECT_TYPE = "pos_override";

// ------------------------------------------------------------------ helpers

function notFound(): CoreError {
  return new CoreError("NOT_FOUND", "Override tidak ditemukan.");
}

/**
 * `viewerId` is the caller; omitted for the in-process consumer. A blind
 * cash count (`cash_shift_close`) hides its value (the |variance|) from the
 * requester, so the cashier never learns the expected cash.
 */
function toView(row: Row, viewerId?: string): PosOverrideView {
  const hideValue =
    row.action === "cash_shift_close" &&
    viewerId !== undefined &&
    viewerId.toLowerCase() === row.requestedBy.toLowerCase();
  return posOverrideViewSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    action: row.action,
    method: row.method,
    status: row.status,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    reasonCode: row.reasonCode,
    reason: row.reason,
    valueIdr: hideValue ? null : row.valueIdr,
    objectType: row.objectType,
    objectId: row.objectId,
    approvalRequestId: row.approvalRequestId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  });
}

/**
 * Fail closed: true only when `userId` holds the action's approve permission on
 * the outlet. `pinProven`: the override is recorded only with this approver's
 * own PIN; otherwise the edge PIN session of the caller cuts their role as on
 * any other request (E2, brief 1269).
 */
async function holdsOverridePermission(
  tx: Tx,
  tenant: TenantContext,
  context: ScopedTenantContext,
  userId: string,
  action: PosOverrideAction,
  outletId: string,
  now: Date,
  pinProven: boolean,
): Promise<boolean> {
  const permission = POS_OVERRIDE_APPROVE_PERMISSION[action];
  if (permission === undefined) return false;
  const data = await loadTenantAccessInTransaction(tx, context, userId, {
    approver: pinProven,
  });
  return resolveAccessSnapshot({
    tenant,
    userId,
    ...data,
    mfaVerified: false,
    now,
  }).allows(permission, outletTarget(outletId));
}

async function assertRequesterMember(
  tx: Tx,
  tenant: TenantContext,
  context: ScopedTenantContext,
  requestedBy: string,
  outletId: string,
  now: Date,
): Promise<void> {
  const data = await loadTenantAccessInTransaction(tx, context, requestedBy);
  if (!isOutletMember(tenant, requestedBy, data, outletId, now))
    throw new AccessError(
      "PERMISSION_DENIED",
      "Anda tidak terdaftar di outlet ini.",
    );
}

async function lockIdempotencyKey(
  tx: Tx,
  tenantId: TenantId,
  requestedBy: string,
  key: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-override:${tenantId}:${requestedBy}:${key}`}, 0))`,
  );
}

/** Same key + same body → the stored row; same key + another body → refused. */
async function findReplay(
  tx: Tx,
  tenantId: TenantId,
  requestedBy: string,
  key: string | null,
  requestFingerprint: string,
): Promise<Row | null> {
  if (key === null) return null;
  const [existing] = await tx
    .select()
    .from(posOverrides)
    .where(
      and(
        eq(posOverrides.tenantId, tenantId),
        eq(posOverrides.requestedBy, requestedBy),
        eq(posOverrides.idempotencyKey, key),
      ),
    );
  if (!existing) return null;
  if (existing.requestFingerprint !== requestFingerprint)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key already used for a different override.",
    );
  return existing;
}

/**
 * True on an edge node (same rule as device-pin.service.ts and
 * pos-receipt.service.ts): the runtime flag, or the static `EDGE_MODE`
 * setting during the boot window.
 */
function isEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

type ShiftCloseFigures = {
  readonly expectedIdr: Idr;
  readonly countedIdr: Idr;
  readonly varianceIdr: Idr;
};

/**
 * The figures of the count a `cash_shift_close` override names (legend-7iti),
 * for the audit row. Null when the count row is gone: the audit then lacks the
 * figures but the approval is not stranded (the count is validated when the
 * override is created, and counts are never deleted).
 */
async function shiftCloseFigures(
  tx: Tx,
  row: Row,
): Promise<ShiftCloseFigures | null> {
  const countId = uuidSchema.safeParse(row.objectId);
  if (!countId.success) return null;
  const [count] = await tx
    .select({
      expectedIdr: posShiftCounts.expectedIdr,
      countedIdr: posShiftCounts.countedIdr,
      varianceIdr: posShiftCounts.varianceIdr,
    })
    .from(posShiftCounts)
    .where(
      and(
        eq(posShiftCounts.tenantId, row.tenantId),
        eq(posShiftCounts.outletId, row.outletId),
        eq(posShiftCounts.id, countId.data),
      ),
    );
  return count ?? null;
}

/** AUTH-06 record: audit (requester, approver, reason, value, outlet) + outbox event. */
async function recordApprovedOverride(
  tx: Tx,
  context: ScopedTenantContext,
  row: Row,
  deviceId: string | null,
  now: Date,
): Promise<void> {
  if (row.approvedBy === null)
    throw new Error("approved override without approver");
  const figures =
    row.action === "cash_shift_close" ? await shiftCloseFigures(tx, row) : null;
  await appendDevicePinEvent(tx, context, posOverrideRecordedEvent, {
    aggregateId: row.id,
    outletId: row.outletId,
    actor: { type: "user", id: row.approvedBy },
    deviceId,
    now,
    payload: {
      overrideId: row.id,
      action: row.action,
      method: row.method,
      requestedBy: row.requestedBy,
      approvedBy: row.approvedBy,
      // Blind-count variance must not leave the audit (legend-o0w6).
      valueIdr: row.action === "cash_shift_close" ? null : row.valueIdr,
      objectType: row.objectType,
      objectId: row.objectId,
      approvalRequestId: row.approvalRequestId,
      // legend-kyie: the cloud writes the audit row of an edge override.
      reasonCode: row.reasonCode,
      reason: row.reason,
      // legend-7iti: the cloud writes the audit row of an edge override and
      // cannot read the count, so the figures travel with the event. Edge
      // process only: the event flows edge -> cloud and never to a device, but
      // the cloud's own event stays free of them (blind count, legend-o0w6).
      ...(figures !== null && isEdgeProcess()
        ? { shiftCloseVariance: figures }
        : {}),
    },
  });
  await recordAudit(
    {
      tenantId: row.tenantId,
      outletId: row.outletId,
      actorType: "user",
      actorId: row.approvedBy,
      deviceId,
      action: "pos_override.recorded",
      objectType: "pos_override",
      objectId: row.id,
      reason: row.reason,
      before: null,
      after: {
        action: row.action,
        method: row.method,
        requestedBy: row.requestedBy,
        approvedBy: row.approvedBy,
        valueIdr: row.valueIdr,
        reasonCode: row.reasonCode,
        objectType: row.objectType,
        objectId: row.objectId,
        approvalRequestId: row.approvalRequestId,
        // Same shape as the cloud audit of an edge override (applyPosOverrideRecorded).
        ...(figures ?? {}),
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
}

// ------------------------------------------------------------------ create

export type CreatePosOverrideOptions = {
  readonly idempotencyKey: string | null;
  readonly deviceId?: string | null;
  readonly now?: Date;
};

/**
 * The value of a `cash_shift_close` override: |variance| of the count
 * submission it names, which must be the latest count of an open shift,
 * submitted by the requester (the shift's cashier).
 */
async function shiftCloseApprovalValue(
  context: ScopedTenantContext,
  requestedBy: string,
  input: CreatePosOverrideInput,
): Promise<Idr> {
  const refused = () =>
    new CoreError(
      "VALIDATION_ERROR",
      "Persetujuan tutup shift harus menunjuk hitungan kas terakhir dari shift yang masih terbuka.",
    );
  if (input.objectType !== SHIFT_COUNT_OBJECT_TYPE) throw refused();
  const countId = uuidSchema.safeParse(input.objectId);
  if (!countId.success) throw refused();
  return withTenant(db, context, async (tx) => {
    const [count] = await tx
      .select({
        shiftId: posShiftCounts.shiftId,
        sequence: posShiftCounts.sequence,
        varianceIdr: posShiftCounts.varianceIdr,
        submittedBy: posShiftCounts.submittedBy,
        shiftStatus: posShifts.status,
      })
      .from(posShiftCounts)
      .innerJoin(
        posShifts,
        and(
          eq(posShifts.tenantId, posShiftCounts.tenantId),
          eq(posShifts.id, posShiftCounts.shiftId),
        ),
      )
      .where(
        and(
          eq(posShiftCounts.tenantId, context.tenant.tenantId),
          eq(posShiftCounts.outletId, input.outletId),
          eq(posShiftCounts.id, countId.data),
        ),
      );
    if (
      !count ||
      count.shiftStatus !== "open" ||
      count.submittedBy.toLowerCase() !== requestedBy.toLowerCase()
    )
      throw refused();
    const [latest] = await tx
      .select({ sequence: posShiftCounts.sequence })
      .from(posShiftCounts)
      .where(
        and(
          eq(posShiftCounts.tenantId, context.tenant.tenantId),
          eq(posShiftCounts.shiftId, count.shiftId),
        ),
      )
      .orderBy(desc(posShiftCounts.sequence))
      .limit(1);
    if (latest?.sequence !== count.sequence) throw refused();
    return Math.abs(Number(count.varianceIdr)) as Idr;
  });
}

/**
 * POST /api/pos-overrides, and the in-process entry point for the POS order
 * service (legend-kk7), which passes the trusted requester id. Returns the
 * override (approved for a PIN, pending for a phone approval).
 */
export async function createPosOverride(
  tenant: TenantContext,
  requesterUserId: string,
  input: CreatePosOverrideInput,
  options: CreatePosOverrideOptions,
): Promise<{ override: PosOverrideView; replayed: boolean }> {
  const now = options.now ?? new Date();
  const requestedBy = userIdSchema.parse(requesterUserId);
  const outletId = outletIdSchema.parse(input.outletId);
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Alasan override wajib 3 sampai 500 karakter.",
    );
  if (!Number.isSafeInteger(input.valueIdr) || input.valueIdr < 0)
    throw new CoreError("VALIDATION_ERROR", "Nilai override tidak valid.");
  // legend-m4fv, EDC-04: a standalone EDC payment is approved by a supervisor
  // PIN on this device (no phone approval), for a real amount on one POS order.
  if (
    input.action === "edc_standalone" &&
    (input.approval.method !== "supervisor_pin" ||
      input.valueIdr <= 0 ||
      input.objectType !== "pos_order")
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pembayaran EDC standalone butuh PIN supervisor di perangkat ini, nominal lebih dari 0, dan nomor pesanan.",
    );
  // legend-6c0 round 2: a shift-close approval is worth the server's variance
  // of the blind count it names. The cashier counts blind and cannot know
  // it, so the submitted value is ignored for this action and the close
  // (pos-shift.service.ts) checks the approval against the real value. The
  // phone chain does not route by it (see amountIdr below): the value stays in
  // the payload for approvers only.
  const valueIdr =
    input.action === "cash_shift_close"
      ? await shiftCloseApprovalValue(
          outletContext(tenant, outletId),
          requestedBy,
          input,
        )
      : input.valueIdr;
  const reasonCode = input.reasonCode?.trim() || null;
  const approval = input.approval;
  const approverUserId =
    approval.method === "supervisor_pin"
      ? userIdSchema.parse(approval.approverUserId)
      : null;
  // AUTH-06: the approver is never the requester.
  if (
    approverUserId !== null &&
    approverUserId.toLowerCase() === requestedBy.toLowerCase()
  )
    throw new AccessError("APPROVER_IS_REQUESTER");
  const key =
    options.idempotencyKey === null
      ? null
      : idempotencyKeySchema.parse(options.idempotencyKey);
  const deviceId = options.deviceId ?? null;
  // A PIN approval is bound to the verified device it was typed on
  // (legend-fjwxo); a phone approval is not (its approver acts elsewhere).
  const requestFingerprint = posOverrideFingerprint(
    {
      requestedBy,
      outletId,
      action: input.action,
      valueIdr: valueIdr,
      reason,
      reasonCode,
      objectType: input.objectType,
      objectId: input.objectId,
      method: approval.method,
      approverUserId,
    },
    approval.method === "supervisor_pin" ? deviceId : null,
  );
  const context = outletContext(tenant, outletId);

  if (approval.method === "supervisor_phone")
    return withTenant(db, context, async (tx) => {
      if (key !== null)
        await lockIdempotencyKey(tx, tenant.tenantId, requestedBy, key);
      const replay = await findReplay(
        tx,
        tenant.tenantId,
        requestedBy,
        key,
        requestFingerprint,
      );
      if (replay)
        return { override: toView(replay, requestedBy), replayed: true };
      await assertRequesterMember(
        tx,
        tenant,
        context,
        requestedBy,
        outletId,
        now,
      );
      const id = createUlid(now.getTime());
      const opened = await openApprovalRequest(tx, context, {
        sourceModule: POS_OVERRIDE_SOURCE_MODULE,
        actionType: input.action,
        objectType: APPROVAL_OBJECT_TYPE,
        objectId: id,
        // A shift close routes without an amount (every tier applies, so the
        // top tier decides). The route and the answer to the cashier must not
        // depend on the variance, or repeated counts would reveal it.
        amountIdr: input.action === "cash_shift_close" ? null : valueIdr,
        outletId,
        requestedBy,
        source: "user",
        requestReason: reason,
        payload: {
          action: input.action,
          valueIdr: valueIdr,
          objectType: input.objectType,
          objectId: input.objectId,
          reasonCode,
        },
        now,
      });
      // An override always needs an approver (AUTH-06). If the matrix asks
      // for none there is nobody to route it to: refuse rather than record an
      // override without an approver. A shift close has no amount, so this
      // never depends on its variance; it only fires without a matching policy.
      if (!opened.required)
        throw new CoreError(
          "PRECONDITION_FAILED",
          "Matriks approval tidak menunjuk penyetuju untuk nilai ini; gunakan PIN supervisor.",
        );
      const [row] = await tx
        .insert(posOverrides)
        .values({
          id,
          tenantId: tenant.tenantId,
          outletId,
          action: input.action,
          method: "supervisor_phone",
          status: "pending",
          requestedBy,
          approvedBy: null,
          reasonCode,
          reason,
          valueIdr: valueIdr,
          objectType: input.objectType,
          objectId: input.objectId,
          approvalRequestId: opened.chainId,
          idempotencyKey: key,
          requestFingerprint,
          createdAt: now,
          resolvedAt: null,
        })
        .returning();
      if (!row) throw new Error("pos override insert returned no row");
      await recordAudit(
        {
          tenantId: tenant.tenantId,
          outletId,
          actorType: "user",
          actorId: requestedBy,
          deviceId,
          action: "pos_override.requested",
          objectType: "pos_override",
          objectId: row.id,
          reason,
          before: null,
          after: {
            action: row.action,
            method: row.method,
            valueIdr: row.valueIdr,
            objectType: row.objectType,
            objectId: row.objectId,
            approvalRequestId: row.approvalRequestId,
          },
          sensitiveAccess: false,
        },
        { tx, context },
      );
      return { override: toView(row, requestedBy), replayed: false };
    });

  // supervisor_pin ----------------------------------------------------------
  if (approverUserId === null || approval.method !== "supervisor_pin")
    throw new Error("unreachable: pin override without approver");
  // 1. Replay, requester membership and approver permission, before the pin
  //    is touched: a retry never re-checks a pin, and a user without the
  //    override permission never has an attempt counted.
  const replay = await withTenant(db, context, async (tx) => {
    const found = await findReplay(
      tx,
      tenant.tenantId,
      requestedBy,
      key,
      requestFingerprint,
    );
    if (found) return found;
    await assertRequesterMember(
      tx,
      tenant,
      context,
      requestedBy,
      outletId,
      now,
    );
    if (
      !(await holdsOverridePermission(
        tx,
        tenant,
        context,
        approverUserId,
        input.action,
        outletId,
        now,
        true,
      ))
    )
      throw new AccessError(
        "PERMISSION_DENIED",
        "Penyetuju tidak memiliki izin override untuk tindakan ini di outlet ini.",
      );
    return null;
  });
  if (replay) return { override: toView(replay, requestedBy), replayed: true };

  // 2. The approver's pin: counted and committed on its own (§3 F6 lock).
  await attemptApproverPin(tenant, {
    outletId,
    approverUserId,
    requesterUserId: requestedBy,
    pin: approval.pin,
    deviceId,
    now,
  });

  // 3. Record it. A concurrent retry with the same key waits on the lock and
  //    then returns the row the first one wrote.
  return withTenant(db, context, async (tx) => {
    if (key !== null)
      await lockIdempotencyKey(tx, tenant.tenantId, requestedBy, key);
    const raced = await findReplay(
      tx,
      tenant.tenantId,
      requestedBy,
      key,
      requestFingerprint,
    );
    if (raced) return { override: toView(raced, requestedBy), replayed: true };
    // Re-check on this transaction's snapshot: a role ended meanwhile fails closed.
    if (
      !(await holdsOverridePermission(
        tx,
        tenant,
        context,
        approverUserId,
        input.action,
        outletId,
        now,
        true,
      ))
    )
      throw new AccessError("PERMISSION_DENIED");
    const [row] = await tx
      .insert(posOverrides)
      .values({
        id: createUlid(now.getTime()),
        tenantId: tenant.tenantId,
        outletId,
        action: input.action,
        method: "supervisor_pin",
        status: "approved",
        requestedBy,
        approvedBy: approverUserId,
        reasonCode,
        reason,
        valueIdr: valueIdr,
        objectType: input.objectType,
        objectId: input.objectId,
        approvalRequestId: null,
        idempotencyKey: key,
        requestFingerprint,
        createdAt: now,
        resolvedAt: now,
      })
      .returning();
    if (!row) throw new Error("pos override insert returned no row");
    await recordApprovedOverride(tx, context, row, deviceId, now);
    return { override: toView(row, requestedBy), replayed: false };
  });
}

// ----------------------------------------------------------------- resolve

/**
 * Settles a pending phone-approved override from its approval chain, on the
 * caller's transaction (row locked FOR UPDATE, so concurrent polls and the
 * consumer produce one outcome). Approved → recorded with the final approver,
 * re-checked for the override permission; anything else → no override.
 */
async function settlePending(
  tx: Tx,
  tenant: TenantContext,
  context: ScopedTenantContext,
  row: Row,
  now: Date,
): Promise<Row> {
  if (row.status !== "pending" || row.approvalRequestId === null) return row;
  const chainId = row.approvalRequestId;
  // Locks the chain head and applies the deadline atomically (§3 F7 "batas
  // waktu", fail closed): an inbox decision already in flight commits first
  // and wins. Read the last level only afterwards so `decidedBy` is fresh.
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: POS_OVERRIDE_SOURCE_MODULE,
    now,
  });
  const levels = await tx
    .select({
      level: approvalRequests.level,
      requiredLevels: approvalRequests.requiredLevels,
      status: approvalRequests.status,
      decidedBy: approvalRequests.decidedBy,
      deadlineAt: approvalRequests.deadlineAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenant.tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level));
  const last = levels[0];
  if (!last) throw notFound();
  if (outcome === "pending") return row;

  let status: PosOverrideStatus = outcome === "approved" ? "approved" : outcome;
  let approvedBy: string | null = null;
  let deniedBecause: string | null = null;
  if (status === "approved") {
    approvedBy = last.decidedBy;
    if (
      approvedBy === null ||
      approvedBy.toLowerCase() === row.requestedBy.toLowerCase() ||
      !(await holdsOverridePermission(
        tx,
        tenant,
        context,
        approvedBy,
        row.action,
        row.outletId,
        now,
        false,
      ))
    ) {
      // The inbox approver lacks the POS override permission here: no override.
      status = "rejected";
      approvedBy = null;
      deniedBecause = "approver_lacks_override_permission";
    }
  }
  const [updated] = await tx
    .update(posOverrides)
    .set({ status, approvedBy, resolvedAt: now })
    .where(and(eq(posOverrides.id, row.id), eq(posOverrides.status, "pending")))
    .returning();
  if (!updated) throw new Error("pos override changed under its row lock");
  if (status === "approved") {
    await recordApprovedOverride(tx, context, updated, null, now);
  } else {
    await recordAudit(
      {
        tenantId: updated.tenantId,
        outletId: updated.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "pos_override.denied",
        objectType: "pos_override",
        objectId: updated.id,
        reason: deniedBecause,
        before: { status: "pending" },
        after: {
          status,
          approvalOutcome: outcome,
          approvalRequestId: updated.approvalRequestId,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
  }
  return updated;
}

/**
 * GET /api/pos-overrides/:overrideId — the requester (or the recorded
 * approver) polls; a pending phone approval is settled on the way. Rows
 * outside the caller's outlets are invisible (RLS) and answer 404. With
 * `outletId` (the acting-staff token's outlet) only that outlet's row is
 * visible, so a mismatch answers 404 and nothing is settled.
 */
export async function getPosOverride(
  tenant: TenantContext,
  actorUserId: string,
  overrideId: string,
  outletId: string | null = null,
  now = new Date(),
): Promise<PosOverrideView> {
  const actorId = userIdSchema.parse(actorUserId);
  if (!ulidSchema.safeParse(overrideId).success) throw notFound();
  const bootstrap = establishScopedTenantContext(tenant, { kind: "tenant" });
  const data = await withTenant(db, bootstrap, (tx) =>
    loadTenantAccessInTransaction(tx, bootstrap, actorId),
  );
  const context = membershipContext(tenant, actorId, data, now);
  if (context === null) throw notFound();
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(posOverrides)
      .where(
        and(
          eq(posOverrides.tenantId, tenant.tenantId),
          eq(posOverrides.id, overrideId),
          outletId === null
            ? undefined
            : eq(posOverrides.outletId, outletIdSchema.parse(outletId)),
          or(
            eq(posOverrides.requestedBy, actorId),
            eq(posOverrides.approvedBy, actorId),
          ),
        ),
      )
      .for("update");
    if (!row) throw notFound();
    return toView(
      await settlePending(
        tx,
        tenant,
        outletContext(tenant, row.outletId),
        row,
        now,
      ),
      actorId,
    );
  });
}

/**
 * Consumer entry point for `approval.resolved` with sourceModule
 * `pos_override` (to be registered by the wiring bead): settles the override
 * that owns the chain. Idempotent: an already-settled override is returned
 * unchanged. Runs on a context that covers the override's outlet.
 */
export async function settlePosOverrideForApproval(
  context: ScopedTenantContext,
  chainId: string,
  now = new Date(),
): Promise<PosOverrideView | null> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(posOverrides)
      .where(
        and(
          eq(posOverrides.tenantId, context.tenant.tenantId),
          eq(posOverrides.approvalRequestId, chainId),
        ),
      )
      .for("update");
    if (!row) return null;
    return toView(await settlePending(tx, context.tenant, context, row, now));
  });
}

/**
 * POST /api/pos-overrides/approvals/:requestId/cancel (sub-brief E3, POS
 * "Berhenti menunggu"): the device's acting cashier withdraws their own
 * pending phone-approval override. `requestId` is the override's
 * `approvalRequestId`. Only a `pos_override` request requested by that
 * cashier at the device's outlet qualifies (cancelOwnModuleApprovalRequest);
 * anything else is 404, decided or expired is 409, a repeat is 200. The
 * override row is then settled at once (cancelled: no override), so the next
 * poll sees it; the approval.resolved consumer would settle it too
 * (idempotent).
 */
export async function cancelOwnPosOverrideApproval(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  outletId: string,
  options: { readonly deviceId?: string | null; readonly now?: Date } = {},
): Promise<ApprovalRequest> {
  const now = options.now ?? new Date();
  const { request, chainId } = await cancelOwnModuleApprovalRequest(
    tenant,
    actorUserId,
    requestId,
    { outletId, sourceModule: POS_OVERRIDE_SOURCE_MODULE },
    options.deviceId ?? null,
    now,
  );
  await settlePosOverrideForApproval(
    outletContext(tenant, outletId),
    chainId,
    now,
  );
  return request;
}

/**
 * GET /api/pos-overrides/approvals/:requestId (sub-brief E3): the acting
 * cashier polls their own phone override's approval request (PhoneWait reads
 * its deadline, decider and reason). Same scope as the cancel: a
 * `pos_override` request by that cashier at the device's outlet, else 404.
 */
export async function getOwnPosOverrideApproval(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  outletId: string,
  now = new Date(),
): Promise<ApprovalRequest> {
  return getOwnModuleApprovalRequest(
    tenant,
    actorUserId,
    requestId,
    { outletId, sourceModule: POS_OVERRIDE_SOURCE_MODULE },
    now,
  );
}
