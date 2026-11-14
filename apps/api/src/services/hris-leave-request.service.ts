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
  createUlid,
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
  leaveApproved,
  leaveChanged,
  leavePolicySchema,
  leaveRequestSchema,
  listLeaveRequests as listLeaveRequestsEndpoint,
  transitionLeaveRequest,
  type LeavePolicy,
  type LeaveRequest,
  type LeaveRequestStatus,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { storagePurposePolicy } from "@starter/shared/storage";
import { db } from "../db/index.ts";
import { employeeDocuments, employees } from "../db/schema/hris.ts";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
} from "../db/schema/hris-leave.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { linkStorageObjectSource } from "./core-storage.ts";
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
import {
  noHrisFileSigner,
  type HrisFileSigner,
} from "./hris-contract.service.ts";
import { lockEmployeeLeaveAttendance } from "./hris-leave-attendance-lock.ts";
import { flagAttendanceForApprovedLeave } from "./hris-leave-attendance-flag.service.ts";
import {
  assertPayrollOpenInRange,
  isPayrollClosedInRange,
} from "./hris-payroll-lock.ts";
import {
  countLeaveDays,
  expireBalanceCarryOver,
  lockBalanceForUpdate,
} from "./hris-leave.service.ts";
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
const REQUEST_REASON = "Pengajuan cuti";

const lower = (value: string) => value.toLowerCase();

/**
 * `leave.approved` goes to cloud sync only: the notification adapter has no
 * rule for it (worker/notification-adapters.ts throws on unknown names).
 */
const LEAVE_EVENT_DESTINATIONS = ["cloud-sync"] as const;
const LEAVE_BALANCE_AUDIT_SAFE_FIELDS = [
  ...HRIS_AUDIT_SAFE_FIELDS,
  "periodYear",
  "forfeitedDays",
  "carriedOverDays",
] as const;

const LEAVE_REQUEST_AUDIT_SAFE_FIELDS = [
  ...HRIS_AUDIT_SAFE_FIELDS,
  "cause",
] as const;

const PAYROLL_LOCKED_MESSAGE =
  "Periode payroll sudah dikunci; cuti pada tanggal itu tidak bisa diubah.";

/** legend-0c5yg: 409 when any day of the leave lies in a closed payroll run. */
function assertLeaveRangeOpen(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  start: string,
  end: string,
): Promise<void> {
  return assertPayrollOpenInRange(
    tx,
    tenantId,
    employeeId,
    start,
    end,
    PAYROLL_LOCKED_MESSAGE,
  );
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

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
 * `attachmentUrl` is the short-lived signed URL minted by the injected signer
 * (presentRequest); it is null whenever the viewer may not open the file.
 */
export function toLeaveRequest(
  row: LeaveRequestRow,
  attachmentUrl: string | null = null,
): LeaveRequest {
  return leaveRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    leaveTypeId: row.leaveTypeId,
    startDate: row.startDate,
    endDate: row.endDate,
    days: row.days,
    reason: row.reason,
    rejectionReason: row.rejectionReason,
    attachmentUrl,
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

/**
 * Applies a delta only when the leave type tracks a balance (else no-op).
 *
 * Releasing days (reject, cancel, expiry of a pending or approved leave) after
 * the carry-over expiry date must not bring forfeited carry-over back: days
 * taken consume the carried-over part first (same rule as
 * `expireLeaveCarryOver`), so the carried-over days are clamped to what is
 * still used or pending and the difference is forfeited (bead legend-arj.3).
 * `actor` null means the system (settle of a matrix outcome).
 */
async function moveBalance(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string | null,
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

  const released = delta.pending < 0n || delta.used < 0n;
  if (
    !released ||
    balance.carryOverExpiresOn === null ||
    balance.carryOverExpiresOn > localDateOf(now)
  )
    return;
  const carried = parseDecimal4(balance.carriedOverDays);
  const stillTaken =
    parseDecimal4(balance.usedDays) +
    delta.used +
    parseDecimal4(balance.pendingDays) +
    delta.pending;
  const keep = stillTaken > 0n ? stillTaken : 0n;
  if (carried <= keep) return;
  const forfeited = carried - keep;
  await tx
    .update(leaveBalances)
    .set({ carriedOverDays: formatDecimal4(keep), updatedAt: now })
    .where(
      and(
        eq(leaveBalances.tenantId, balance.tenantId),
        eq(leaveBalances.id, balance.id),
      ),
    );
  await recordAudit(
    tx,
    context,
    {
      ...hrisAuditEntry(context, actor ?? row.requestedBy, now, {
        outletId: row.outletId,
        action: "hris.leave_carry_over.forfeited",
        objectType: "leave_balance",
        objectId: balance.id,
        after: {
          periodYear: balance.periodYear,
          forfeitedDays: formatDecimal4(forfeited),
          carriedOverDays: formatDecimal4(keep),
        },
      }),
      ...(actor === null
        ? { actorType: "system" as const, actorId: null }
        : {}),
    },
    LEAVE_BALANCE_AUDIT_SAFE_FIELDS,
  );
}

async function nextLeaveEventSequence(
  tx: Tx,
  tenantId: string,
  destination: string,
  leaveRequestId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, destination),
        eq(domainEventOutbox.aggregateType, leaveApproved.entry.aggregateType),
        eq(domainEventOutbox.aggregateId, leaveRequestId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/**
 * Appends `leave.approved` in the caller's transaction (transactional outbox),
 * right where the request becomes approved. The aggregate is the request; the
 * request row lock (or the per-employee filing lock) serialises the sequence.
 * No reason or attachment in the payload (personal data).
 */
async function appendLeaveApproved(
  tx: Tx,
  context: ScopedTenantContext,
  row: LeaveRequestRow,
  now: Date,
): Promise<void> {
  if (row.status !== "approved" || !row.decidedBy || !row.decidedAt)
    throw new Error("leave.approved needs an approved request with a decider");
  const decidedBy = userIdSchema.parse(row.decidedBy);
  for (const destination of LEAVE_EVENT_DESTINATIONS) {
    const sequence = await nextLeaveEventSequence(
      tx,
      row.tenantId,
      destination,
      row.id,
    );
    const event = leaveApproved.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: leaveApproved.name,
      version: leaveApproved.version,
      aggregateType: leaveApproved.entry.aggregateType,
      aggregateId: row.id,
      sequence,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: decidedBy },
      deviceId: null,
      idempotencyKey: `${leaveApproved.name}:${row.id}:${sequence}`,
      payloadSchemaRef: leaveApproved.payloadSchemaRef,
      payload: {
        leaveRequestId: row.id,
        employeeId: row.employeeId,
        leaveTypeId: row.leaveTypeId,
        startDate: row.startDate,
        endDate: row.endDate,
        days: row.days,
        decidedBy,
        decidedAt: row.decidedAt.toISOString(),
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination,
      direction: null,
      peerId: null,
    });
  }
}

/**
 * Appends `leave.changed` (legend-x0avw F5) for one leave row HR just narrowed,
 * split off or cancelled, in the caller's transaction (all events commit or
 * none, with the leave UPDATE/INSERT). Same sequencing as `leave.approved`:
 * per aggregate and destination; the caller holds the request row lock (or just
 * inserted the row). No reason or attachment in the payload (personal data).
 */
async function appendLeaveChanged(
  tx: Tx,
  context: ScopedTenantContext,
  row: LeaveRequestRow,
  change: {
    readonly changeReason:
      "range_split" | "range_cancelled" | "requester_cancelled";
    readonly splitFromLeaveRequestId: string | null;
    readonly actorUserId: string;
  },
  now: Date,
): Promise<void> {
  if (row.status !== "approved" && row.status !== "cancelled")
    throw new Error("leave.changed needs an approved or cancelled request");
  const actorId = userIdSchema.parse(change.actorUserId);
  for (const destination of LEAVE_EVENT_DESTINATIONS) {
    const sequence = await nextLeaveEventSequence(
      tx,
      row.tenantId,
      destination,
      row.id,
    );
    const event = leaveChanged.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: leaveChanged.name,
      version: leaveChanged.version,
      aggregateType: leaveChanged.entry.aggregateType,
      aggregateId: row.id,
      sequence,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: actorId },
      deviceId: null,
      idempotencyKey: `${leaveChanged.name}:${row.id}:${sequence}`,
      payloadSchemaRef: leaveChanged.payloadSchemaRef,
      payload: {
        leaveRequestId: row.id,
        employeeId: row.employeeId,
        outletId: row.outletId,
        startDate: row.startDate,
        endDate: row.endDate,
        days: row.days,
        excludedHolidayDates: row.excludedHolidayDates,
        status: row.status,
        changeReason: change.changeReason,
        splitFromLeaveRequestId: change.splitFromLeaveRequestId,
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination,
      direction: null,
      peerId: null,
    });
  }
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

/**
 * The DTO with the signed attachment URL. Only a viewer who can see the
 * request (the requester or approver at its outlet) gets
 * one; each URL issued is audited with a sensitive-access reason.
 */
async function presentRequest(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  row: LeaveRequestRow,
  signer: HrisFileSigner,
  now: Date,
): Promise<LeaveRequest> {
  // The requester needs a live self.leave.request grant at the leave's
  // outlet (same rule as the storage read route, legend-9ujp5); otherwise an
  // approver at that outlet. The row itself stays visible either way.
  const canOpenAttachment =
    (access.own !== null &&
      lower(access.own.id) === lower(row.employeeId) &&
      access.snapshot.allows("self.leave.request", {
        type: "outlet",
        id: row.outletId,
      })) ||
    access.snapshot.allows("hr.leave.approve", {
      type: "outlet",
      id: row.outletId,
    });
  if (row.attachmentKey === null || !canOpenAttachment)
    return toLeaveRequest(row);
  const url = await signer(context, row.attachmentKey, tx);
  if (url !== null)
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: row.outletId,
        action: "hris.leave_request.attachment_url_issued",
        objectType: HRIS_LEAVE_OBJECT_TYPE,
        objectId: row.id,
        after: { status: row.status },
        sensitiveReason: "Membuka lampiran pengajuan cuti.",
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
  return toLeaveRequest(row, url);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The upload must be a fresh `document` object preclassified as
 * `leave_request` at the requester's home outlet, uploaded by the requester.
 * Preclassification prevents a generic document reader from receiving a URL
 * just before the object is attached as sensitive leave evidence.
 * Ownership stops attaching someone else's private file (an HR employee
 * document, another request's proof) or an unowned system file (the printed
 * menu PDF); freshness plus single use still bound reuse.
 */
async function assertAttachmentUsable(
  tx: Tx,
  tenantId: TenantId,
  homeOutletId: string,
  actorUserId: string,
  uploadRef: string,
  now: Date,
) {
  const [object] = UUID_PATTERN.test(uploadRef)
    ? await tx
        .select({
          outletId: coreStorageObjects.outletId,
          purpose: coreStorageObjects.purpose,
          sourceKind: coreStorageObjects.sourceKind,
          createdAt: coreStorageObjects.createdAt,
          ownerUserId: coreStorageObjects.ownerUserId,
        })
        .from(coreStorageObjects)
        .where(
          and(
            eq(coreStorageObjects.tenantId, tenantId),
            eq(coreStorageObjects.id, uploadRef),
          ),
        )
        .limit(1)
    : [];
  const policy = object
    ? (storagePurposePolicy as Record<string, { visibility: string }>)[
        object.purpose
      ]
    : undefined;
  const invalid = () =>
    new HttpError(
      422,
      "VALIDATION_ERROR",
      "Lampiran tidak ditemukan atau tidak valid.",
    );
  if (
    !object ||
    object.purpose !== "document" ||
    object.sourceKind !== "leave_request" ||
    policy?.visibility !== "private" ||
    object.outletId === null ||
    lower(object.outletId) !== lower(homeOutletId) ||
    object.ownerUserId !== actorUserId ||
    object.createdAt.getTime() < now.getTime() - ATTACHMENT_MAX_AGE_MS
  )
    throw invalid();
  const [document] = await tx
    .select({ id: employeeDocuments.id })
    .from(employeeDocuments)
    .where(
      and(
        eq(employeeDocuments.tenantId, tenantId),
        eq(employeeDocuments.storageObjectId, uploadRef),
      ),
    )
    .limit(1);
  const [used] = await tx
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.tenantId, tenantId),
        eq(leaveRequests.attachmentKey, uploadRef),
      ),
    )
    .limit(1);
  if (document || used) throw invalid();
}

/** GET /api/hris/leave/requests — HR/approver reach by outlet, else own rows. */
export async function listLeaveRequests(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
  signer: HrisFileSigner = noHrisFileSigner,
  now = new Date(),
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
    const names =
      page.length === 0
        ? []
        : await tx
            .select({
              id: employees.id,
              outletId: employees.homeOutletId,
              name: employees.fullName,
            })
            .from(employees)
            .where(
              and(
                eq(employees.tenantId, context.tenant.tenantId),
                inArray(employees.id, [
                  ...new Set(page.map((row) => row.employeeId)),
                ]),
                inArray(employees.homeOutletId, [
                  ...new Set(page.map((row) => row.outletId)),
                ]),
              ),
            );
    const data: LeaveRequest[] = [];
    for (const row of page)
      data.push({
        ...(await presentRequest(tx, context, access, row, signer, now)),
        employeeName:
          names.find(
            (item) =>
              lower(item.id) === lower(row.employeeId) &&
              lower(item.outletId) === lower(row.outletId),
          )?.name ?? null,
      });
    return {
      data,
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
  signer: HrisFileSigner = noHrisFileSigner,
  now = new Date(),
): Promise<LeaveRequest> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const row = await findRequest(tx, context.tenant.tenantId, leaveRequestId);
    if (!row || !canSee(access, row)) throw notFound("Pengajuan cuti");
    return presentRequest(tx, context, access, row, signer, now);
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
  signer: HrisFileSigner = noHrisFileSigner,
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
    // Lock order on every leave path: hris:leave, employee leave-attendance,
    // then the balance row. Taken here before the balance lock, so it cannot
    // deadlock with applyOutcome and the cancel paths (employee lock first).
    await lockEmployeeLeaveAttendance(tx, tenantId, own.id);

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
      return presentRequest(tx, scoped, access, replayed, signer, now);
    }

    // Before any write: leave on a date in a closed payroll run would change
    // pay already settled (backdated filing included).
    await assertLeaveRangeOpen(
      tx,
      tenantId,
      own.id,
      input.startDate,
      input.endDate,
    );

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
    if (input.attachmentUploadRef !== null)
      await assertAttachmentUsable(
        tx,
        tenantId,
        own.homeOutletId,
        access.actorUserId,
        input.attachmentUploadRef,
        now,
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

    const { days, excludedDates } = await countLeaveDays(tx, {
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
      const locked = await lockBalanceForUpdate(
        tx,
        tenantId,
        own.id,
        type.row.id,
        periodYear,
      );
      if (!locked) throw new Error("Leave balance row missing after upsert");
      // From the expiry date on, carried days not held by used or pending
      // ones are forfeit: write them off now (once, through the ledger) so a
      // later filing cannot reopen them before the expiry job runs.
      const { balance } = await expireBalanceCarryOver(
        tx,
        scoped,
        locked,
        localDateOf(now),
        now,
        (after) =>
          recordAudit(
            tx,
            scoped,
            hrisAuditEntry(scoped, access.actorUserId, now, {
              outletId: own.homeOutletId,
              action: "hris.leave_carry_over.forfeited",
              objectType: "leave_balance",
              objectId: locked.id,
              after,
            }),
            LEAVE_BALANCE_AUDIT_SAFE_FIELDS,
          ),
      );
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
        excludedHolidayDates: excludedDates,
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
        // Two requests racing to attach the same upload.
        if (
          uniqueViolation(error)?.constraint ===
          "leave_requests_tenant_attachment_key"
        )
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Lampiran tidak ditemukan atau tidak valid.",
          );
        throw error;
      });
    if (!inserted) throw new Error("Leave request insert returned no row");
    if (input.attachmentUploadRef !== null)
      await linkStorageObjectSource(tx, {
        tenantId,
        objectId: input.attachmentUploadRef,
        sourceKind: "leave_request",
        sourceId: inserted.id,
        actorUserId: access.actorUserId,
        ownerUserId: access.actorUserId,
        outletId: own.homeOutletId,
      });

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
      // The employee lock is already held (taken right after hris:leave).
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
      await appendLeaveApproved(tx, scoped, row, now);
      await flagAttendanceForApprovedLeave(tx, scoped, row);
    }
    await auditLeave(
      tx,
      scoped,
      access.actorUserId,
      now,
      row,
      "hris.leave_request.created",
    );
    return presentRequest(tx, scoped, access, row, signer, now);
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
  signer: HrisFileSigner = noHrisFileSigner,
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
    // Refuse before the approval chain records the decision (applyOutcome
    // checks again under the employee lock).
    if (input.action === "approve")
      await assertLeaveRangeOpen(
        tx,
        context.tenant.tenantId,
        row.employeeId,
        row.startDate,
        row.endDate,
      );
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

  if (gate.replay)
    return getLeaveRequest(context, actorUserId, gate.row.id, signer, now);

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
          reason:
            input.action === "approve"
              ? APPROVE_REASON
              : input.rejectionReason!,
        } as Parameters<typeof decideApprovalRequest>[3],
        {
          mfaVerified: options.mfaVerified,
          idempotencyKey: input.idempotencyKey,
          now,
        },
      );
    await settleLeaveRequest(context, gate.row.id, now);
  }
  return getLeaveRequest(context, actorUserId, gate.row.id, signer, now);
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
    // Employee lock first, then the leave row, then balances: the same order as
    // cancelApprovedLeaveOnDateByHr (HR cancel), so the two cannot deadlock.
    await lockEmployeeLeaveAttendance(tx, gateRow.tenantId, gateRow.employeeId);
    let row = await findRequest(tx, scoped.tenant.tenantId, gateRow.id, true);
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
          const settled = await applyOutcome(tx, scoped, row, outcome, now);
          // Approver won the race and the leave is now approved: the end state
          // is the serial order approve-then-cancel, so go on into the
          // approved-cancel branch below (payroll guard included).
          if (outcome !== "approved" || settled.status !== "approved") return;
          const settledRow = await findRequest(
            tx,
            scoped.tenant.tenantId,
            gateRow.id,
            true,
          );
          if (!settledRow) throw notFound("Pengajuan cuti");
          row = settledRow;
        }
      }
    }
    if (row.status === "pending") {
      await moveBalance(
        tx,
        scoped,
        actorUserId,
        row,
        { pending: -scaledDays, used: 0n },
        now,
      );
    } else {
      // approved: giving the days back would change pay of a closed period.
      await assertLeaveRangeOpen(
        tx,
        scoped.tenant.tenantId,
        row.employeeId,
        row.startDate,
        row.endDate,
      );
      // approved: only before the first day of leave.
      if (row.startDate <= localDateOf(now))
        throw new HttpError(
          409,
          "CONFLICT",
          "Cuti yang sudah berjalan tidak dapat dibatalkan.",
        );
      await moveBalance(
        tx,
        scoped,
        actorUserId,
        row,
        { pending: 0n, used: -scaledDays },
        now,
      );
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
    // A pending request was never published as approved: only an approved
    // one that goes away tells the consumers (leave.changed).
    if (row.status === "approved")
      await appendLeaveChanged(
        tx,
        scoped,
        updated,
        {
          changeReason: "requester_cancelled",
          splitFromLeaveRequestId: null,
          actorUserId,
        },
        now,
      );
  });
}

// ------------------------------------------- HR decision on a clock-in day

/** One approved leave that covers a date, as `app.approved_leaves_on` returns it. */
export interface ApprovedLeaveOnDate {
  readonly leaveRequestId: string;
  readonly outletId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly days: string;
}

/**
 * Approved leave of one employee whose range holds `businessDate` (bead
 * legend-9y6ri). Reads through `app.approved_leaves_on` (SECURITY DEFINER,
 * tenant-bound, no outlet limit): `leave_requests` RLS is per home outlet of
 * the employee, so a clock-in or an HR decision at another outlet would not
 * see the leave through the table and would miss the clash.
 */
export async function findApprovedLeaveOnDate(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  businessDate: string,
): Promise<ApprovedLeaveOnDate[]> {
  const result = await tx.execute(
    sql`SELECT leave_request_id, outlet_id, start_date::text AS start_date, end_date::text AS end_date, days::text AS days FROM app.approved_leaves_on(${tenantId}::uuid, ${employeeId}::uuid, ${businessDate}::date) ORDER BY start_date, leave_request_id`,
  );
  return result.rows.map((row) => ({
    leaveRequestId: String(row.leave_request_id),
    outletId: String(row.outlet_id),
    startDate: String(row.start_date),
    endDate: String(row.end_date),
    days: String(row.days),
  }));
}

/**
 * HR cancels the approved leave that covers a day the employee clocked in
 * (attendance review `cancel_leave`). Runs in the caller's transaction, so the
 * balance refund, the status change and the audit commit together with the
 * attendance log update; any 409/403 here rolls all of it back. Unlike the
 * requester's cancel, a leave that already started may be cancelled: that is
 * the point of the decision.
 *
 * Only the day of the clock-in is cancelled (founder W8 Q27, bead
 * legend-5nt2z): the leave range is split around `businessDate`. The original
 * row keeps its id and shrinks to the head (or to the tail when the day is the
 * first one); a middle day adds one new approved row (new id) for the tail. A
 * range left without paid days is `cancelled`, as a one-day leave always was.
 * The refund is exactly the paid day removed (original days minus the days of
 * the pieces left, must be one whole day, else 409), moved once. A day listed
 * in `excludedHolidayDates` was never paid as leave: nothing is split or
 * refunded. Idempotent: only rows still `approved` (locked) are touched, so a
 * replay finds no leave on the day and refunds nothing.
 * Needs `hr.leave.approve` at the outlet of each leave. A leave the caller's
 * RLS cannot lock, or any approved leave still paying the day after the
 * cancel, is a 409 (never a valid log with the leave still paid).
 * Returns the ids of the leave rows changed (split, narrowed or cancelled;
 * the new tail row included; empty when none covers the day any more).
 */
export async function cancelApprovedLeaveOnDateByHr(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  input: { readonly employeeId: string; readonly businessDate: string },
  now: Date,
): Promise<string[]> {
  const tenantId = context.tenant.tenantId;
  const day = input.businessDate;
  // Employee lock before any leave row or balance lock (idempotent per tx).
  await lockEmployeeLeaveAttendance(tx, tenantId, input.employeeId);
  const leaves = await findApprovedLeaveOnDate(
    tx,
    tenantId,
    input.employeeId,
    day,
  );
  const changed: string[] = [];
  // Leaves that cover the day but never paid it (holiday excluded at filing).
  const unpaid = new Set<string>();
  for (const leave of leaves) {
    if (
      !access.snapshot.allows("hr.leave.approve", {
        type: "outlet",
        id: leave.outletId,
      })
    )
      throw forbidden();
    const row = await findRequest(tx, tenantId, leave.leaveRequestId, true);
    if (!row)
      throw conflict(
        "ATTENDANCE_LEAVE_NOT_REACHABLE",
        "Cuti tidak dapat dibatalkan dari akses saat ini. Pilih tetap cuti.",
      );
    // Decided meanwhile by someone else: nothing to refund here.
    if (row.status !== "approved") continue;
    // Re-check on the locked row: the range may have changed since the read.
    if (row.startDate > day || row.endDate < day) continue;
    if (row.excludedHolidayDates.includes(day)) {
      unpaid.add(row.id);
      continue;
    }
    // legend-0c5yg: cancelling changes pay of the whole leave, so any day of
    // it in a closed payroll run refuses (the tx rolls back, nothing changed).
    await assertLeaveRangeOpen(
      tx,
      tenantId,
      row.employeeId,
      row.startDate,
      row.endDate,
    );
    const pieces = [
      leavePiece(row, row.startDate, addDays(day, -1)),
      leavePiece(row, addDays(day, 1), row.endDate),
    ].filter((piece) => piece.range && piece.days > 0n);
    const refund =
      parseDecimal4(row.days) - pieces.reduce((sum, p) => sum + p.days, 0n);
    // The day is one paid day. Anything else means `days` and the range
    // disagree: refund nothing rather than guess (never pay or refund extra).
    if (refund !== 10000n)
      throw conflict(
        "ATTENDANCE_LEAVE_DAYS_MISMATCH",
        "Jumlah hari cuti tidak cocok dengan rentangnya. Pilih tetap cuti.",
      );
    await moveBalance(
      tx,
      context,
      access.actorUserId,
      row,
      { pending: 0n, used: -refund },
      now,
    );
    const [first, second] = pieces;
    const [updated] = await tx
      .update(leaveRequests)
      .set(
        first
          ? {
              startDate: first.range!.start,
              endDate: first.range!.end,
              days: formatDecimal4(first.days),
              excludedHolidayDates: first.excluded,
              updatedAt: now,
            }
          : { status: "cancelled", updatedAt: now },
      )
      .where(
        and(
          eq(leaveRequests.tenantId, row.tenantId),
          eq(leaveRequests.id, row.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Leave request update returned no row");
    changed.push(updated.id);
    await appendLeaveChanged(
      tx,
      context,
      updated,
      {
        changeReason: first ? "range_split" : "range_cancelled",
        splitFromLeaveRequestId: null,
        actorUserId: access.actorUserId,
      },
      now,
    );
    let tail: LeaveRequestRow | null = null;
    if (second) {
      const [inserted] = await tx
        .insert(leaveRequests)
        .values({
          tenantId: row.tenantId,
          outletId: row.outletId,
          employeeId: row.employeeId,
          leaveTypeId: row.leaveTypeId,
          periodYear: row.periodYear,
          startDate: second.range!.start,
          endDate: second.range!.end,
          days: formatDecimal4(second.days),
          excludedHolidayDates: second.excluded,
          reason: row.reason,
          attachmentKey: null,
          status: "approved",
          approvalChainId: null,
          requestedBy: row.requestedBy,
          requestedAt: row.requestedAt,
          decidedBy: row.decidedBy,
          decidedAt: row.decidedAt,
          createIdempotencyKey: null,
          updatedAt: now,
        })
        .returning();
      if (!inserted) throw new Error("Leave request insert returned no row");
      tail = inserted;
      changed.push(inserted.id);
      await appendLeaveChanged(
        tx,
        context,
        inserted,
        {
          changeReason: "range_split",
          splitFromLeaveRequestId: updated.id,
          actorUserId: access.actorUserId,
        },
        now,
      );
    }
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: row.outletId,
        action: first
          ? "hris.leave_request.split_by_attendance_review"
          : "hris.leave_request.cancelled_by_attendance_review",
        objectType: HRIS_LEAVE_OBJECT_TYPE,
        objectId: row.id,
        after: {
          status: updated.status,
          changedFields: [
            `day=${day}`,
            `before=${row.startDate}..${row.endDate}`,
            `after=${updated.startDate}..${updated.endDate}`,
            ...(tail ? [`tail=${tail.id}`] : []),
          ].join(","),
        },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    if (tail)
      await auditLeave(
        tx,
        context,
        access.actorUserId,
        now,
        tail,
        "hris.leave_request.created_by_attendance_review_split",
      );
  }
  // Nothing may still pay the day (another outlet's leave, or a row that was
  // hidden): else the day would be paid as leave and as work. A leave that
  // never paid it (excluded holiday) is not a clash.
  const remaining = await findApprovedLeaveOnDate(
    tx,
    tenantId,
    input.employeeId,
    day,
  );
  if (remaining.some((leave) => !unpaid.has(leave.leaveRequestId)))
    throw conflict(
      "ATTENDANCE_LEAVE_STILL_APPROVED",
      "Masih ada cuti disetujui pada hari itu. Pilih tetap cuti.",
    );
  return changed;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO date `delta` calendar days away (dates are plain calendar days, UTC math). */
function addDays(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The part of an approved leave inside `start..end`: its range (null when
 * empty), the holiday dates it keeps and its paid days (calendar days minus
 * those holidays), scaled by 4 decimals.
 */
function leavePiece(row: LeaveRequestRow, start: string, end: string) {
  if (start > end) return { range: null, excluded: [] as string[], days: 0n };
  const excluded = row.excludedHolidayDates.filter(
    (date) => date >= start && date <= end,
  );
  const calendar =
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      DAY_MS +
    1;
  return {
    range: { start, end },
    excluded,
    days: BigInt(calendar - excluded.length) * 10000n,
  };
}

// --------------------------------------------------------------- settle

/**
 * Chain outcome (not pending) → request + balance. Caller holds the row lock.
 * `cause` is set when an approval ends rejected because the period is closed.
 */
async function applyOutcome(
  tx: Tx,
  context: ScopedTenantContext,
  row: LeaveRequestRow,
  outcome: "approved" | "rejected" | "expired" | "cancelled",
  now: Date,
): Promise<{ status: LeaveRequestStatus; cause?: "payroll_locked" }> {
  // legend-x0avw F1: before any leave or balance write, serialise with
  // clock-ins and corrections of this employee (lock first, always).
  await lockEmployeeLeaveAttendance(tx, row.tenantId, row.employeeId);
  const scaledDays = parseDecimal4(row.days);
  // legend-0c5yg: approving moves the balance and flags the clash logs; both
  // change pay. Approved through the general inbox while the period closed
  // (the chain is already approved, a 409 would loop): end rejected by the
  // system, days released, nothing deducted or flagged.
  const payrollLocked =
    outcome === "approved" &&
    (await isPayrollClosedInRange(
      tx,
      context.tenant.tenantId,
      row.employeeId,
      row.startDate,
      row.endDate,
    ));
  if (outcome === "approved" && !payrollLocked) {
    const [final] = await tx
      .select({
        decidedBy: approvalRequests.decidedBy,
        decidedAt: approvalRequests.decidedAt,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.chainId, row.approvalChainId!))
      .orderBy(desc(approvalRequests.level))
      .limit(1);
    await moveBalance(
      tx,
      context,
      null,
      row,
      { pending: -scaledDays, used: scaledDays },
      now,
    );
    const [approved] = await tx
      .update(leaveRequests)
      .set({
        status: "approved",
        decidedBy: final?.decidedBy
          ? userIdSchema.parse(final.decidedBy)
          : null,
        decidedAt: final?.decidedAt ?? now,
        updatedAt: now,
      })
      .where(eq(leaveRequests.id, row.id))
      .returning();
    if (!approved) throw new Error("Leave request update returned no row");
    await appendLeaveApproved(tx, context, approved, now);
    await flagAttendanceForApprovedLeave(tx, context, approved);
    return { status: "approved" };
  }
  // A human rejection keeps the chain's last decision. A matrix expiry or a
  // system cancel has no human decider: decidedBy stays null (never the
  // requester) and decidedAt is the settle time.
  const systemEnded =
    outcome === "expired" || outcome === "cancelled" || payrollLocked;
  const [last] = await tx
    .select({
      decidedBy: approvalRequests.decidedBy,
      decidedAt: approvalRequests.decidedAt,
      reason: approvalRequests.reason,
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
  await moveBalance(
    tx,
    context,
    null,
    row,
    { pending: -scaledDays, used: 0n },
    now,
  );
  await tx
    .update(leaveRequests)
    .set({
      status: "rejected",
      rejectionReason: systemEnded ? null : (last?.reason ?? null),
      decidedBy:
        systemEnded || !last?.decidedBy
          ? null
          : userIdSchema.parse(last.decidedBy),
      decidedAt: systemEnded ? now : (last?.decidedAt ?? now),
      updatedAt: now,
    })
    .where(eq(leaveRequests.id, row.id));
  return payrollLocked
    ? { status: "rejected", cause: "payroll_locked" }
    : { status: "rejected" };
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
  const target = await withTenant(db, context, async (tx) => {
    const row = await findRequest(tx, context.tenant.tenantId, leaveRequestId);
    return row ? { outletId: row.outletId, employeeId: row.employeeId } : null;
  });
  if (target === null) throw notFound("Pengajuan cuti");
  const scoped = outletScoped(context, target.outletId);
  return withTenant(db, scoped, async (tx) => {
    // Employee lock first, then the leave row: the one order every leave path
    // uses (cancelLeaveRequest, HR cancel), so settle cannot deadlock with them.
    await lockEmployeeLeaveAttendance(
      tx,
      scoped.tenant.tenantId,
      target.employeeId,
    );
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
    const { status, cause } = await applyOutcome(tx, scoped, row, outcome, now);
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
              after: cause ? { status, cause } : { status },
            },
          ),
          // System end (expired / system cancel / closed period) has no human actor.
          ...(updated.decidedBy
            ? {}
            : { actorType: "system" as const, actorId: null }),
        },
        LEAVE_REQUEST_AUDIT_SAFE_FIELDS,
      );
    return status;
  });
}
