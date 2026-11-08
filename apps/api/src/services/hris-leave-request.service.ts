// Leave requests and their approval settle (PRD v1.7 §3 Kelompok D 29 "Cuti,
// Izin & Lembur", F27; §6 H `leave_requests`, `leave_balances`; bead
// legend-hggk). Routes: routes/hris-leave.routes.ts.
//
// - A request is created by the employee for themselves (`self.leave.request`
//   on their own employee row; HR does not file on someone's behalf here).
// - The approval matrix owns the decision: `openApprovalRequest` (source module
//   `hris_leave`, action `leave`) opens the chain, `decideApprovalRequest`
//   records each level. This module never decides by itself.
// - `settleLeaveRequest` applies the outcome to the request and the balance
//   from the chain outcome re-read under the request row lock, so a replayed
//   or forged `approval.resolved` event is a no-op (see
//   hris-approval-consumers.ts). It is also called inline after a decision.
// - Balance days move under row locks: pending on request, pending → used on
//   approval, pending released on rejection/cancel, used released when an
//   approved leave that has not started is cancelled.
// - The leave reason and attachment are personal data: never in an audit
//   field, event payload or approval request reason.

import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CoreError,
  encodeCursor,
  formatDecimal4,
  localDateOf,
  parseDecimal4,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  createLeaveRequest as createLeaveRequestEndpoint,
  decideLeaveRequest as decideLeaveRequestEndpoint,
  leavePolicySchema,
  leaveRequestSchema,
  listLeaveRequests as listLeaveRequestsEndpoint,
  transitionLeaveRequest,
  type LeavePolicy,
  type LeaveRequest,
  type LeaveRequestStatus,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
} from "../db/schema/hris-leave.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";
import { countLeaveDays, lockBalanceForUpdate } from "./hris-leave.service.ts";
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  getApprovalChainOutcome,
  openApprovalRequest,
} from "./platform-approval.service.ts";

export const HRIS_LEAVE_SOURCE_MODULE = "hris_leave";
export const HRIS_LEAVE_OBJECT_TYPE = "leave_request";

type LeaveRequestRow = typeof leaveRequests.$inferSelect;
type CreateBody = z.output<typeof createLeaveRequestEndpoint.body>;
type DecideBody = z.output<typeof decideLeaveRequestEndpoint.body>;
type ListQuery = z.output<typeof listLeaveRequestsEndpoint.query>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

const APPROVE_REASON = "Cuti disetujui";
const REJECT_REASON = "Cuti ditolak";
const REQUEST_REASON = "Pengajuan cuti";

const lower = (value: string) => value.toLowerCase();

/** RLS scope of exactly one outlet: approval rows are outlet-owned (TEN-03). */
function outletScoped(
  context: ScopedTenantContext,
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(context.tenant, {
    kind: "outlets",
    outletIds: [outletId],
  } as Parameters<typeof establishScopedTenantContext>[1]);
}

/**
 * TODO(storage): `attachmentUrl` stays null until a core-storage signer port
 * (like hris-contract.service `HrisFileSigner`) is wired for leave files.
 */
export function toLeaveRequest(row: LeaveRequestRow): LeaveRequest {
  return leaveRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    leaveTypeId: row.leaveTypeId,
    startDate: row.startDate,
    endDate: row.endDate,
    days: row.days,
    reason: row.reason,
    attachmentUrl: null,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  });
}

async function loadLeaveType(
  tx: Tx,
  tenantId: TenantId,
  leaveTypeId: string,
  share = false,
) {
  const query = tx
    .select()
    .from(leaveTypes)
    .where(
      and(eq(leaveTypes.tenantId, tenantId), eq(leaveTypes.id, leaveTypeId)),
    )
    .limit(1);
  // FOR SHARE serialises with updateLeaveType's FOR UPDATE (tracksBalance flip).
  const [row] = await (share ? query.for("share") : query);
  if (!row) return null;
  return { row, policy: leavePolicySchema.parse(row.policy) as LeavePolicy };
}

/**
 * Moves days on the (already locked) balance row. `pending` and `used` are
 * signed Decimal4 scaled bigints.
 */
async function adjustBalance(
  tx: Tx,
  row: Pick<
    LeaveRequestRow,
    "tenantId" | "employeeId" | "leaveTypeId" | "periodYear"
  >,
  delta: { readonly pending: bigint; readonly used: bigint },
  now: Date,
): Promise<void> {
  await tx
    .update(leaveBalances)
    .set({
      pendingDays: sql`${leaveBalances.pendingDays} + ${formatDecimal4(delta.pending)}::numeric`,
      usedDays: sql`${leaveBalances.usedDays} + ${formatDecimal4(delta.used)}::numeric`,
      updatedAt: now,
    })
    .where(
      and(
        eq(leaveBalances.tenantId, row.tenantId),
        eq(leaveBalances.employeeId, row.employeeId),
        eq(leaveBalances.leaveTypeId, row.leaveTypeId),
        eq(leaveBalances.periodYear, row.periodYear),
      ),
    );
}

/** Applies a delta only when the leave type tracks a balance (else no-op). */
async function moveBalance(
  tx: Tx,
  row: LeaveRequestRow,
  delta: { readonly pending: bigint; readonly used: bigint },
  now: Date,
): Promise<void> {
  const type = await loadLeaveType(tx, row.tenantId, row.leaveTypeId);
  if (!type?.policy.tracksBalance) return;
  const balance = await lockBalanceForUpdate(
    tx,
    row.tenantId,
    row.employeeId,
    row.leaveTypeId,
    row.periodYear,
  );
  if (!balance) return;
  await adjustBalance(tx, row, delta, now);
}

async function auditLeave(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: LeaveRequestRow,
  action: string,
) {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      outletId: row.outletId,
      action,
      objectType: HRIS_LEAVE_OBJECT_TYPE,
      objectId: row.id,
      after: { status: row.status },
    }),
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------ visibility

/** Outlets whose leave the caller may list/decide, plus their own rows. */
function visibleCondition(access: HrisAccess): SQL | null {
  const reach = access.reach([HRIS_MANAGE_CODE, "hr.leave.approve"]);
  const conditions: SQL[] = [];
  if (reach?.kind === "tenant") return sql`true`;
  if (reach)
    conditions.push(inArray(leaveRequests.outletId, [...reach.outletIds]));
  if (access.own) conditions.push(eq(leaveRequests.employeeId, access.own.id));
  return conditions.length === 0 ? null : or(...conditions)!;
}

function canSee(access: HrisAccess, row: LeaveRequestRow): boolean {
  if (access.own && lower(access.own.id) === lower(row.employeeId)) return true;
  const reach = access.reach([HRIS_MANAGE_CODE, "hr.leave.approve"]);
  if (!reach) return false;
  return (
    reach.kind === "tenant" ||
    reach.outletIds.some((id) => id === lower(row.outletId))
  );
}

/** GET /api/hris/leave/requests — HR/approver reach by outlet, else own rows. */
export async function listLeaveRequests(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
): Promise<Page<LeaveRequest>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const visible = visibleCondition(access);
    if (visible === null) throw forbidden();
    const filters: SQL[] = [
      eq(leaveRequests.tenantId, context.tenant.tenantId),
      visible,
    ];
    if (query.employeeId)
      filters.push(eq(leaveRequests.employeeId, query.employeeId));
    if (query.status) filters.push(eq(leaveRequests.status, query.status));
    if (query.cursor) {
      const [requestedAt, id] = cursorPair(query.cursor);
      const at = new Date(requestedAt);
      if (Number.isNaN(at.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          lt(leaveRequests.requestedAt, at),
          and(eq(leaveRequests.requestedAt, at), lt(leaveRequests.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(leaveRequests)
      .where(and(...filters))
      .orderBy(desc(leaveRequests.requestedAt), desc(leaveRequests.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toLeaveRequest),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.requestedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** One request; outside the caller's reach it looks exactly like a missing row. */
export async function getLeaveRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  leaveRequestId: string,
): Promise<LeaveRequest> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const row = await findRequest(tx, context.tenant.tenantId, leaveRequestId);
    if (!row || !canSee(access, row)) throw notFound("Pengajuan cuti");
    return toLeaveRequest(row);
  });
}

async function findRequest(
  tx: Tx,
  tenantId: TenantId,
  leaveRequestId: string,
  lock = false,
): Promise<LeaveRequestRow | null> {
  const query = tx
    .select()
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.tenantId, tenantId),
        eq(leaveRequests.id, leaveRequestId),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

// --------------------------------------------------------------- create

/**
 * POST /api/hris/leave/requests — the employee files leave for themselves.
 * Replaying the same Idempotency-Key returns the stored request.
 */
export async function createLeaveRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateBody,
  now = new Date(),
): Promise<LeaveRequest> {
  if (input.endDate < input.startDate)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Tanggal selesai tidak boleh sebelum tanggal mulai.",
    );
  const periodYear = Number(input.startDate.slice(0, 4));
  if (periodYear !== Number(input.endDate.slice(0, 4)))
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Pengajuan cuti tidak boleh melewati pergantian tahun; ajukan terpisah.",
    );

  // The requester's own home outlet decides the RLS scope the approval chain
  // is opened under (approval rows are outlet-owned).
  const home = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (
      access.own === null ||
      !access.snapshot.permissions.includes("self.leave.request")
    )
      throw forbidden();
    return access.own.homeOutletId;
  });
  const scoped = outletScoped(context, home);

  return withTenant(db, scoped, async (tx) => {
    const access = await loadHrisAccess(tx, scoped, actorUserId, now);
    const own = access.own;
    if (
      own === null ||
      lower(own.homeOutletId) !== lower(home) ||
      !access.snapshot.permissions.includes("self.leave.request")
    )
      throw forbidden();
    const tenantId = scoped.tenant.tenantId;
    const [employee] = await tx
      .select({ status: employees.status })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, own.id)))
      .limit(1);
    if (!employee) throw forbidden();
    if (employee.status !== "active" && employee.status !== "onboarding")
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Karyawan tidak aktif; tidak bisa mengajukan cuti.",
      );

    // One leave filing per employee at a time: serialises the overlap check,
    // the balance reservation and the idempotency lookup.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:leave:${tenantId}:${own.id}`}, 0))`,
    );

    const [replayed] = await tx
      .select()
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.createIdempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (replayed) {
      if (
        lower(replayed.employeeId) !== lower(own.id) ||
        lower(replayed.leaveTypeId) !== lower(input.leaveTypeId) ||
        replayed.startDate !== input.startDate ||
        replayed.endDate !== input.endDate
      )
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different request.",
        );
      return toLeaveRequest(replayed);
    }

    const type = await loadLeaveType(tx, tenantId, input.leaveTypeId, true);
    if (!type || !type.row.isActive)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Jenis cuti tidak ditemukan atau tidak aktif.",
      );
    if (type.row.requiresAttachment && input.attachmentUploadRef === null)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Jenis cuti ini wajib melampirkan dokumen pendukung.",
      );

    const [overlap] = await tx
      .select({ id: leaveRequests.id })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.employeeId, own.id),
          inArray(leaveRequests.status, ["pending", "approved"]),
          sql`${leaveRequests.startDate} <= ${input.endDate}::date`,
          sql`${leaveRequests.endDate} >= ${input.startDate}::date`,
        ),
      )
      .limit(1);
    if (overlap)
      throw new HttpError(
        409,
        "LEAVE_OVERLAP",
        "Sudah ada pengajuan cuti pada tanggal tersebut.",
      );

    const days = await countLeaveDays(tx, {
      tenantId,
      outletId: own.homeOutletId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    const scaledDays = parseDecimal4(days);
    if (scaledDays <= 0n)
      throw new HttpError(
        422,
        "LEAVE_NO_WORKING_DAYS",
        "Rentang tanggal tidak memuat hari kerja (semua hari libur).",
      );

    if (type.policy.tracksBalance) {
      // Make sure the row exists, then lock it: the check and the reservation
      // are one atomic decision per balance.
      await tx
        .insert(leaveBalances)
        .values({
          tenantId,
          employeeId: own.id,
          leaveTypeId: type.row.id,
          periodYear,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const balance = await lockBalanceForUpdate(
        tx,
        tenantId,
        own.id,
        type.row.id,
        periodYear,
      );
      if (!balance) throw new Error("Leave balance row missing after upsert");
      const available =
        parseDecimal4(balance.entitledDays) +
        parseDecimal4(balance.carriedOverDays) -
        parseDecimal4(balance.usedDays) -
        parseDecimal4(balance.pendingDays) +
        parseDecimal4(type.policy.negativeAllowanceDays);
      if (scaledDays > available)
        throw new HttpError(
          409,
          "INSUFFICIENT_LEAVE_BALANCE",
          "Saldo cuti tidak cukup untuk pengajuan ini.",
        );
    }

    const [inserted] = await tx
      .insert(leaveRequests)
      .values({
        tenantId,
        outletId: own.homeOutletId,
        employeeId: own.id,
        leaveTypeId: type.row.id,
        periodYear,
        startDate: input.startDate,
        endDate: input.endDate,
        days,
        reason: input.reason,
        attachmentKey: input.attachmentUploadRef,
        status: "pending",
        requestedBy: access.actorUserId,
        requestedAt: now,
        createIdempotencyKey: input.idempotencyKey,
        updatedAt: now,
      })
      .returning()
      .catch((error: unknown) => {
        // The advisory lock is per employee, so only another employee racing
        // on the same key reaches the unique index.
        if (
          uniqueViolation(error)?.constraint ===
          "leave_requests_tenant_idempotency_key"
        )
          throw new CoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key already used for a different request.",
          );
        throw error;
      });
    if (!inserted) throw new Error("Leave request insert returned no row");

    const opened = await openApprovalRequest(tx, scoped, {
      sourceModule: HRIS_LEAVE_SOURCE_MODULE,
      actionType: "leave",
      objectType: HRIS_LEAVE_OBJECT_TYPE,
      objectId: inserted.id,
      amountIdr: null,
      outletId: own.homeOutletId,
      requestedBy: access.actorUserId,
      source: "user",
      requestReason: REQUEST_REASON,
      now,
    });

    let row: LeaveRequestRow;
    if (opened.required) {
      if (type.policy.tracksBalance)
        await adjustBalance(
          tx,
          inserted,
          { pending: scaledDays, used: 0n },
          now,
        );
      [row] = (await tx
        .update(leaveRequests)
        .set({ approvalChainId: opened.chainId })
        .where(eq(leaveRequests.id, inserted.id))
        .returning()) as [LeaveRequestRow];
    } else {
      // Below every tier of the matrix: approved on filing, days used at once.
      if (type.policy.tracksBalance)
        await adjustBalance(
          tx,
          inserted,
          { pending: 0n, used: scaledDays },
          now,
        );
      [row] = (await tx
        .update(leaveRequests)
        .set({
          status: transitionLeaveRequest("pending", "approve"),
          decidedBy: access.actorUserId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(leaveRequests.id, inserted.id))
        .returning()) as [LeaveRequestRow];
    }
    await auditLeave(
      tx,
      scoped,
      access.actorUserId,
      now,
      row,
      "hris.leave_request.created",
    );
    return toLeaveRequest(row);
  });
}

// --------------------------------------------------------------- decide

/**
 * POST /api/hris/leave/requests/:id/decision. approve/reject go through the
 * approval matrix (same rules as `/api/approvals/:id/decisions`: reach, level
 * order, requester != approver, MFA) then settle; cancel is the requester or
 * HR withdrawing it.
 */
export async function decideLeaveRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  leaveRequestId: string,
  input: DecideBody,
  options: { readonly mfaVerified: boolean },
  now = new Date(),
): Promise<LeaveRequest> {
  const gate = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const row = await findRequest(tx, context.tenant.tenantId, leaveRequestId);
    if (!row || !canSee(access, row)) throw notFound("Pengajuan cuti");
    const at = { type: "outlet", id: row.outletId } as const;
    if (input.action === "cancel") {
      const isOwn =
        access.own !== null && lower(access.own.id) === lower(row.employeeId);
      if (
        !isOwn &&
        !access.permissionsAt(row.outletId).includes(HRIS_MANAGE_CODE)
      )
        throw forbidden();
    } else if (!access.snapshot.allows("hr.leave.approve", at)) {
      throw forbidden();
    }
    const replay =
      (input.action === "approve" && row.status === "approved") ||
      (input.action === "reject" && row.status === "rejected") ||
      (input.action === "cancel" && row.status === "cancelled");
    if (replay) return { row, openId: null, replay: true };
    // Validates the transition (409 CONFLICT when not allowed).
    transitionLeaveRequest(row.status as LeaveRequestStatus, input.action);
    let openId: string | null = null;
    if (input.action !== "cancel" && row.approvalChainId) {
      const [open] = await tx
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.chainId, row.approvalChainId),
            eq(approvalRequests.status, "pending"),
          ),
        )
        .limit(1);
      openId = open?.id ?? null;
    }
    return { row, openId, replay: false };
  });

  if (gate.replay) return toLeaveRequest(gate.row);

  if (input.action === "cancel") {
    await cancelLeaveRequest(context, actorUserId, gate.row, now);
  } else {
    if (gate.openId !== null)
      await decideApprovalRequest(
        context.tenant,
        actorUserId,
        gate.openId,
        {
          decision: input.action === "approve" ? "approved" : "rejected",
          reason: input.action === "approve" ? APPROVE_REASON : REJECT_REASON,
        } as Parameters<typeof decideApprovalRequest>[3],
        {
          mfaVerified: options.mfaVerified,
          idempotencyKey: input.idempotencyKey,
          now,
        },
      );
    await settleLeaveRequest(context, gate.row.id, now);
  }
  return getLeaveRequest(context, actorUserId, gate.row.id);
}

/** Pending: withdraw the chain and release the days. Approved + not started: release used. */
async function cancelLeaveRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  gateRow: LeaveRequestRow,
  now: Date,
): Promise<void> {
  const scoped = outletScoped(context, gateRow.outletId);
  await withTenant(db, scoped, async (tx) => {
    const row = await findRequest(tx, scoped.tenant.tenantId, gateRow.id, true);
    if (!row) throw notFound("Pengajuan cuti");
    if (row.status === "cancelled") return;
    transitionLeaveRequest(row.status as LeaveRequestStatus, "cancel");
    const scaledDays = parseDecimal4(row.days);
    if (row.status === "pending") {
      if (row.approvalChainId) {
        const outcome = await cancelApprovalRequest(tx, scoped, {
          chainId: row.approvalChainId,
          sourceModule: HRIS_LEAVE_SOURCE_MODULE,
          actorUserId,
          now,
        });
        // The chain finished first (approved/rejected): settle decides, not us.
        if (outcome !== "cancelled" && outcome !== "pending") {
          await applyOutcome(tx, row, outcome, now);
          return;
        }
      }
      await moveBalance(tx, row, { pending: -scaledDays, used: 0n }, now);
    } else {
      // approved: only before the first day of leave.
      if (row.startDate <= localDateOf(now))
        throw new HttpError(
          409,
          "CONFLICT",
          "Cuti yang sudah berjalan tidak dapat dibatalkan.",
        );
      await moveBalance(tx, row, { pending: 0n, used: -scaledDays }, now);
    }
    const [updated] = await tx
      .update(leaveRequests)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(leaveRequests.id, row.id))
      .returning();
    if (!updated) throw new Error("Leave request update returned no row");
    await auditLeave(
      tx,
      scoped,
      actorUserId,
      now,
      updated,
      "hris.leave_request.cancelled",
    );
  });
}

// --------------------------------------------------------------- settle

/** Chain outcome (not pending) → request + balance. Caller holds the row lock. */
async function applyOutcome(
  tx: Tx,
  row: LeaveRequestRow,
  outcome: "approved" | "rejected" | "expired" | "cancelled",
  now: Date,
): Promise<LeaveRequestStatus> {
  const scaledDays = parseDecimal4(row.days);
  if (outcome === "approved") {
    const [final] = await tx
      .select({
        decidedBy: approvalRequests.decidedBy,
        decidedAt: approvalRequests.decidedAt,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.chainId, row.approvalChainId!))
      .orderBy(desc(approvalRequests.level))
      .limit(1);
    await moveBalance(tx, row, { pending: -scaledDays, used: scaledDays }, now);
    await tx
      .update(leaveRequests)
      .set({
        status: "approved",
        decidedBy: final?.decidedBy
          ? userIdSchema.parse(final.decidedBy)
          : null,
        decidedAt: final?.decidedAt ?? now,
        updatedAt: now,
      })
      .where(eq(leaveRequests.id, row.id));
    return "approved";
  }
  // A human rejection keeps the chain's last decision. A matrix expiry or a
  // system cancel has no human decider: decidedBy stays null (never the
  // requester) and decidedAt is the settle time.
  const systemEnded = outcome === "expired" || outcome === "cancelled";
  const [last] = await tx
    .select({
      decidedBy: approvalRequests.decidedBy,
      decidedAt: approvalRequests.decidedAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.chainId, row.approvalChainId!),
        isNotNull(approvalRequests.decidedAt),
      ),
    )
    .orderBy(desc(approvalRequests.level))
    .limit(1);
  await moveBalance(tx, row, { pending: -scaledDays, used: 0n }, now);
  await tx
    .update(leaveRequests)
    .set({
      status: "rejected",
      decidedBy:
        systemEnded || !last?.decidedBy
          ? null
          : userIdSchema.parse(last.decidedBy),
      decidedAt: systemEnded ? now : (last?.decidedAt ?? now),
      updatedAt: now,
    })
    .where(eq(leaveRequests.id, row.id));
  return "rejected";
}

/**
 * Applies the approval chain outcome to the request and the balance. Locks the
 * request row, re-reads the chain from the database (an event payload is a
 * trigger, never the authority) and does nothing when the request is no longer
 * pending or the chain is still open: idempotent and replay safe.
 */
export async function settleLeaveRequest(
  context: ScopedTenantContext,
  leaveRequestId: string,
  now = new Date(),
): Promise<LeaveRequestStatus> {
  const outletId = await withTenant(db, context, async (tx) => {
    const row = await findRequest(tx, context.tenant.tenantId, leaveRequestId);
    return row?.outletId ?? null;
  });
  if (outletId === null) throw notFound("Pengajuan cuti");
  const scoped = outletScoped(context, outletId);
  return withTenant(db, scoped, async (tx) => {
    const row = await findRequest(
      tx,
      scoped.tenant.tenantId,
      leaveRequestId,
      true,
    );
    if (!row) throw notFound("Pengajuan cuti");
    if (row.status !== "pending") return row.status as LeaveRequestStatus;
    if (!row.approvalChainId) return "pending";
    const outcome = await getApprovalChainOutcome(tx, {
      chainId: row.approvalChainId,
      sourceModule: HRIS_LEAVE_SOURCE_MODULE,
    });
    if (outcome === "pending") return "pending";
    const status = await applyOutcome(tx, row, outcome, now);
    const [updated] = await tx
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, row.id));
    if (updated)
      await recordAudit(
        tx,
        scoped,
        {
          ...hrisAuditEntry(
            scoped,
            updated.decidedBy ?? updated.requestedBy,
            now,
            {
              outletId: updated.outletId,
              action: `hris.leave_request.${status}`,
              objectType: HRIS_LEAVE_OBJECT_TYPE,
              objectId: updated.id,
              after: { status },
            },
          ),
          // System end (expired / system cancel) has no human actor.
          ...(updated.decidedBy
            ? {}
            : { actorType: "system" as const, actorId: null }),
        },
        HRIS_AUDIT_SAFE_FIELDS,
      );
    return status;
  });
}
