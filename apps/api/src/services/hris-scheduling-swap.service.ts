// Shift swaps and covers (PRD v1.7 §3 Kelompok D 28 "Penjadwalan Shift", F26;
// HR-05; §6 H `shift_swap_requests`). Routes: routes/hris-scheduling.routes.ts.
//
// - The requester files for their own `published` assignment
//   (`self.shift_swap.request`). A cover hands it to another active employee of
//   the same outlet; a swap (`toAssignmentId`) exchanges it with one of theirs.
//   The compliance diff (`evaluateShiftSwapCompliance`) is frozen on the row.
// - An approver (`hr.shift_swap.approve` at the outlet, never the requester or
//   the target) decides. HR-05: the diff is recomputed against the roster as it
//   is now; `approve` with a violation is refused, `approve_with_override`
//   needs a reason (both enforced by `transitionShiftSwap`). Unlike leave there
//   is no approval matrix and no MFA step: this module decides by itself.
// - Approval moves `employee_id` on the assignment(s), marks them `swapped` and
//   emits, per changed assignment and in the same transaction (outbox),
//   `shift.cancelled` (cause `swapped_away`) for the previous owner and then
//   `shift.published` for the new one (hris-scheduling-events.ts). The
//   published event carries the approver and decision time as publisher; the
//   assignment row keeps its original `published_by` / `published_at`.
// - A `swapped` shift cannot be swapped or covered again (only `published` ones
//   can; decision recorded 2026-11, default until product says otherwise).
// - Repeating the same decision returns the stored request; a different action
//   on a decided request answers 409.
// - Responses carry employee ids only: no names, NIK or pay (personal data).

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CoreError,
  encodeCursor,
  isOutletInScope,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  addBusinessDays,
  cancelShiftSwapRequest as cancelShiftSwapRequestEndpoint,
  createShiftSwapRequest as createShiftSwapRequestEndpoint,
  decideShiftSwapRequest as decideShiftSwapRequestEndpoint,
  evaluateShiftSwapCompliance,
  listShiftSwapRequests as listShiftSwapRequestsEndpoint,
  respondShiftSwapRequest as respondShiftSwapRequestEndpoint,
  transitionShiftAssignment,
  transitionShiftSwap,
  type ShiftAssignment,
  type ShiftComplianceIssue,
  type ShiftSwapRequest,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  shiftAssignments,
  shiftSwapRequests,
} from "../db/schema/hris-scheduling.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
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
  appendShiftCancelled,
  appendShiftPublished,
} from "./hris-scheduling-events.ts";
import {
  resolveCompliancePolicy,
  toShiftAssignment,
  toShiftSwapRequest,
} from "./hris-scheduling-common.ts";

export const HRIS_SWAP_OBJECT_TYPE = "shift_swap_request";
const HRIS_ASSIGNMENT_OBJECT_TYPE = "shift_assignment";

type SwapRow = typeof shiftSwapRequests.$inferSelect;
type AssignmentRow = typeof shiftAssignments.$inferSelect;
type CreateBody = z.output<typeof createShiftSwapRequestEndpoint.body>;
type DecideBody = z.output<typeof decideShiftSwapRequestEndpoint.body>;
type PeerBody = z.output<typeof respondShiftSwapRequestEndpoint.body>;
type CancelBody = z.output<typeof cancelShiftSwapRequestEndpoint.body>;
type ListQuery = z.output<typeof listShiftSwapRequestsEndpoint.query>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

// Drafts are unpublished plans: compliance never counts them, so a swap
// diff cannot leak or be blocked by a colleague's draft.
const COMPLIANCE_STATUSES = ["published", "swapped"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lower = (value: string) => value.toLowerCase();
const same = (left: string, right: string) => lower(left) === lower(right);

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

/** First segment start of an assignment; a shift counts as past once it began. */
function startsAtOf(row: Pick<AssignmentRow, "segments">): number {
  return Math.min(
    ...row.segments.map((segment) => Date.parse(segment.startsAt)),
  );
}

function hasStarted(row: Pick<AssignmentRow, "segments">, now: Date): boolean {
  return startsAtOf(row) <= now.getTime();
}

// ------------------------------------------------------------ visibility

function manageReach(access: HrisAccess) {
  return access.reach(["hr.shift_swap.approve", "hr.schedule.manage"]);
}

function isParty(access: HrisAccess, row: SwapRow): boolean {
  return (
    access.own !== null &&
    (same(access.own.id, row.requestedBy) ||
      same(access.own.id, row.toEmployeeId))
  );
}

function canSee(access: HrisAccess, row: SwapRow): boolean {
  if (isParty(access, row)) return true;
  const reach = manageReach(access);
  if (!reach) return false;
  return (
    reach.kind === "tenant" ||
    reach.outletIds.some((id) => id === lower(row.outletId))
  );
}

// ------------------------------------------------------------ helpers

async function findSwap(
  tx: Tx,
  tenantId: TenantId,
  swapId: string,
  lock = false,
): Promise<SwapRow | null> {
  const query = tx
    .select()
    .from(shiftSwapRequests)
    .where(
      and(
        eq(shiftSwapRequests.tenantId, tenantId),
        eq(shiftSwapRequests.id, swapId),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

/**
 * The request already stored under this create key, if any. The same key for
 * a different request is `IDEMPOTENCY_KEY_REUSED`.
 */
async function findCreateReplay(
  tx: Tx,
  tenantId: TenantId,
  requesterId: string,
  input: CreateBody,
): Promise<SwapRow | null> {
  const [replayed] = await tx
    .select()
    .from(shiftSwapRequests)
    .where(
      and(
        eq(shiftSwapRequests.tenantId, tenantId),
        eq(shiftSwapRequests.createIdempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!replayed) return null;
  if (
    !same(replayed.requestedBy, requesterId) ||
    !same(replayed.fromAssignmentId, input.fromAssignmentId) ||
    !same(replayed.toEmployeeId, input.toEmployeeId) ||
    (replayed.toAssignmentId ?? null) !== (input.toAssignmentId ?? null)
  )
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key already used for a different request.",
    );
  return replayed;
}

/** Locks assignments in id order, so two swaps touching the same rows cannot deadlock. */
async function lockAssignments(
  tx: Tx,
  tenantId: TenantId,
  ids: readonly string[],
): Promise<AssignmentRow[]> {
  return tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, tenantId),
        inArray(shiftAssignments.id, [...ids]),
      ),
    )
    .orderBy(asc(shiftAssignments.id))
    .for("update");
}

async function activeEmployee(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
): Promise<{ id: string; homeOutletId: string } | null> {
  const [row] = await tx
    .select({
      id: employees.id,
      homeOutletId: employees.homeOutletId,
      status: employees.status,
    })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1);
  return row && row.status === "active"
    ? { id: row.id, homeOutletId: row.homeOutletId }
    : null;
}

/**
 * Every published or swapped assignment of the given employees around the swapped shifts,
 * across outlets, so rest between outlets and the weekly total are judged on
 * the whole person. The window is padded by the consecutive-day limit and one
 * week, which is as far as any compliance rule can look.
 */
async function loadEmployeeAssignments(
  tx: Tx,
  tenantId: TenantId,
  employeeIds: readonly string[],
  dates: readonly string[],
  padDays: number,
): Promise<ShiftAssignment[]> {
  const sorted = [...dates].sort();
  const from = addBusinessDays(sorted[0], -padDays);
  const to = addBusinessDays(sorted[sorted.length - 1], padDays);
  const rows = await tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, tenantId),
        inArray(shiftAssignments.employeeId, [...employeeIds]),
        inArray(shiftAssignments.status, [...COMPLIANCE_STATUSES]),
        sql`${shiftAssignments.businessDate} >= ${from}::date`,
        sql`${shiftAssignments.businessDate} <= ${to}::date`,
      ),
    );
  return rows.map(toShiftAssignment);
}

async function swapCompliance(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  input: {
    from: AssignmentRow;
    to: AssignmentRow | null;
    requesterId: string;
    toEmployeeId: string;
  },
): Promise<ShiftComplianceIssue[]> {
  const { limits } = await resolveCompliancePolicy(tx, tenantId, outletId);
  const assignments = await loadEmployeeAssignments(
    tx,
    tenantId,
    [input.requesterId, input.toEmployeeId],
    [input.from.businessDate, ...(input.to ? [input.to.businessDate] : [])],
    Math.max(7, limits.maxConsecutiveWorkDays + 1),
  );
  return evaluateShiftSwapCompliance({
    assignments,
    fromAssignmentId: input.from.id,
    toEmployeeId: input.toEmployeeId as ShiftAssignment["employeeId"],
    toAssignmentId: input.to?.id ?? null,
    policy: limits,
  });
}

/**
 * HR-05 must judge the person, not the caller's reach: an outlet-scoped
 * approver or requester still has to see the employees' shifts at every
 * outlet. The read runs in a server-built tenant-wide context; the permission
 * and outlet checks stay on the real context. The result is only a list of
 * issue codes about the two employees, never the rows themselves.
 */
async function tenantWideSwapCompliance(
  context: ScopedTenantContext,
  outletId: string,
  input: Parameters<typeof swapCompliance>[3],
): Promise<ShiftComplianceIssue[]> {
  const wide = establishScopedTenantContext(context.tenant, {
    kind: "tenant",
  });
  return withTenant(db, wide, (tx) =>
    swapCompliance(tx, context.tenant.tenantId, outletId, input),
  );
}

async function auditSwap(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: SwapRow,
  action: string,
) {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      outletId: row.outletId,
      action,
      objectType: HRIS_SWAP_OBJECT_TYPE,
      objectId: row.id,
      after: { status: row.status },
    }),
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

async function auditAssignment(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: AssignmentRow,
) {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      outletId: row.outletId,
      action: "hris.shift_assignment.swapped",
      objectType: HRIS_ASSIGNMENT_OBJECT_TYPE,
      objectId: row.id,
      after: { status: row.status },
    }),
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

// ---------------------------------------------------------------- list

/** GET /api/hris/shift-swaps — approvers see their outlets; everyone sees their own. */
export async function listShiftSwapRequests(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
  now = new Date(),
): Promise<Page<ShiftSwapRequest>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = manageReach(access);
    const own = access.own;
    if (query.mine && !own)
      return { data: [], meta: { limit: query.limit, nextCursor: null } };
    const conditions: SQL[] = [];
    if (own)
      conditions.push(
        or(
          eq(shiftSwapRequests.requestedBy, own.id),
          eq(shiftSwapRequests.toEmployeeId, own.id),
        )!,
      );
    if (!query.mine) {
      if (reach?.kind === "tenant") conditions.push(sql`true`);
      else if (reach)
        conditions.push(
          inArray(shiftSwapRequests.outletId, [...reach.outletIds]),
        );
    }
    if (conditions.length === 0) throw forbidden();
    // A manager (no employee record of their own) filtering on an outlet
    // outside their reach gets the same 404 as every other outlet-scoped read.
    if (
      query.outletId &&
      !own &&
      reach &&
      reach.kind !== "tenant" &&
      ![...reach.outletIds].includes(query.outletId)
    )
      throw notFound("Outlet");
    const filters: SQL[] = [
      eq(shiftSwapRequests.tenantId, context.tenant.tenantId),
      or(...conditions)!,
    ];
    if (query.outletId)
      filters.push(eq(shiftSwapRequests.outletId, query.outletId));
    if (query.status) filters.push(eq(shiftSwapRequests.status, query.status));
    if (query.cursor) {
      const [requestedAt, id] = cursorPair(query.cursor);
      const at = new Date(requestedAt);
      if (
        !UUID_PATTERN.test(id) ||
        Number.isNaN(at.getTime()) ||
        at.toISOString() !== requestedAt
      )
        throw invalid("Check the cursor.");
      filters.push(
        or(
          lt(shiftSwapRequests.requestedAt, at),
          and(
            eq(shiftSwapRequests.requestedAt, at),
            lt(shiftSwapRequests.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(shiftSwapRequests)
      .where(and(...filters))
      .orderBy(desc(shiftSwapRequests.requestedAt), desc(shiftSwapRequests.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toShiftSwapRequest),
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

// -------------------------------------------------------------- create

/**
 * POST /api/hris/shift-swaps — the owner of a published, not yet started
 * assignment asks to cover or swap it. Replaying the same key returns the
 * stored request; one open request per surrendered assignment (409).
 */
export async function createShiftSwapRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateBody,
  now = new Date(),
): Promise<ShiftSwapRequest> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const own = access.own;
    if (
      own === null ||
      !access.snapshot.permissions.includes("self.shift_swap.request")
    )
      throw forbidden();
    const tenantId = context.tenant.tenantId;

    const replayed = await findCreateReplay(tx, tenantId, own.id, input);
    if (replayed) return toShiftSwapRequest(replayed);

    const ids = [input.fromAssignmentId, input.toAssignmentId].filter(
      (id): id is NonNullable<typeof id> => id !== null && id !== undefined,
    );
    if (ids.length === 2 && same(ids[0], ids[1]))
      throw invalid("Shift asal dan shift tujuan harus berbeda.");
    const locked = await lockAssignments(tx, tenantId, ids);
    // A concurrent retry with the same key waited on the lock above; look
    // again so it returns the first result instead of failing on the rows
    // the first call just changed or filed.
    const replayedAfterLock = await findCreateReplay(
      tx,
      tenantId,
      own.id,
      input,
    );
    if (replayedAfterLock) return toShiftSwapRequest(replayedAfterLock);
    const from = locked.find((row) => same(row.id, input.fromAssignmentId));
    if (
      !from ||
      !same(from.employeeId, own.id) ||
      !same(from.outletId, input.outletId)
    )
      throw notFound("Jadwal shift");
    if (from.status === "swapped")
      throw conflict(
        "CONFLICT",
        "Shift ini sudah pernah ditukar dan tidak dapat ditukar lagi.",
      );
    if (from.status !== "published")
      throw conflict(
        "CONFLICT",
        "Hanya shift yang sudah dipublikasikan yang dapat ditukar.",
      );
    if (hasStarted(from, now))
      throw conflict(
        "CONFLICT",
        "Shift yang sudah dimulai tidak dapat ditukar.",
      );

    if (same(input.toEmployeeId, own.id))
      throw invalid("Pilih karyawan lain untuk menukar atau menggantikan.");
    const target = await activeEmployee(tx, tenantId, input.toEmployeeId);
    if (!target || !same(target.homeOutletId, input.outletId))
      throw invalid("Karyawan tujuan harus aktif di outlet yang sama.");

    let to: AssignmentRow | null = null;
    if (input.toAssignmentId) {
      to = locked.find((row) => same(row.id, input.toAssignmentId!)) ?? null;
      if (
        !to ||
        !same(to.employeeId, input.toEmployeeId) ||
        !same(to.outletId, input.outletId)
      )
        throw notFound("Jadwal shift tujuan");
      if (to.status === "swapped")
        throw conflict(
          "CONFLICT",
          "Shift tujuan sudah pernah ditukar dan tidak dapat ditukar lagi.",
        );
      if (to.status !== "published" || hasStarted(to, now))
        throw conflict(
          "CONFLICT",
          "Shift tujuan harus sudah dipublikasikan dan belum dimulai.",
        );
      // The first move would hand each side a second row for the same
      // (day, template) while the old one is still active, which the
      // shift_assignments_active_employee_day_template_key index rejects.
      if (
        from.shiftTemplateId !== null &&
        from.shiftTemplateId === to.shiftTemplateId &&
        from.businessDate === to.businessDate
      )
        throw invalid(
          "Shift asal dan shift tujuan memakai template yang sama pada hari yang sama; tukar tidak diperlukan, ubah stasiun lewat roster.",
        );
    }

    const [open] = await tx
      .select({ id: shiftSwapRequests.id })
      .from(shiftSwapRequests)
      .where(
        and(
          eq(shiftSwapRequests.tenantId, tenantId),
          eq(shiftSwapRequests.fromAssignmentId, from.id),
          eq(shiftSwapRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (open)
      throw conflict(
        "SHIFT_SWAP_EXISTS",
        "Sudah ada permintaan tukar yang menunggu untuk shift ini.",
      );

    const complianceIssues = await tenantWideSwapCompliance(
      context,
      input.outletId,
      {
        from,
        to,
        requesterId: own.id,
        toEmployeeId: input.toEmployeeId,
      },
    );

    // Savepoint: a unique violation aborts only the insert, so the stored row
    // can still be read back in this transaction.
    const created = await tx
      .transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(shiftSwapRequests)
          .values({
            tenantId,
            outletId: from.outletId,
            fromAssignmentId: from.id,
            toAssignmentId: to?.id ?? null,
            requestedBy: own.id,
            toEmployeeId: input.toEmployeeId,
            status: "pending",
            complianceIssues,
            requestedByUserId: access.actorUserId,
            requestedAt: now,
            createIdempotencyKey: input.idempotencyKey,
            updatedAt: now,
          })
          .returning();
        return { row, replayed: false };
      })
      .catch(async (error: unknown) => {
        const constraint = uniqueViolation(error)?.constraint;
        if (constraint === "shift_swap_requests_tenant_idempotency_key") {
          const stored = await findCreateReplay(tx, tenantId, own.id, input);
          if (stored) return { row: stored, replayed: true };
          throw new CoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key already used for a different request.",
          );
        }
        if (constraint === "shift_swap_requests_open_from_key")
          throw conflict(
            "SHIFT_SWAP_EXISTS",
            "Sudah ada permintaan tukar yang menunggu untuk shift ini.",
          );
        throw error;
      });
    const inserted = created.row;
    if (!inserted) throw new Error("Shift swap insert returned no row");
    if (created.replayed) return toShiftSwapRequest(inserted);
    await auditSwap(
      tx,
      context,
      access.actorUserId,
      now,
      inserted,
      "hris.shift_swap.requested",
    );
    return toShiftSwapRequest(inserted);
  });
}

// -------------------------------------------------------------- decide

/**
 * POST /api/hris/shift-swaps/:swapId/decision. Approve or reject by an outlet
 * approver (not a party to the swap). HR-05 gate: see the module comment.
 */
export async function decideShiftSwapRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  swapId: string,
  input: DecideBody,
  now = new Date(),
): Promise<ShiftSwapRequest> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const tenantId = context.tenant.tenantId;
    const row = await findSwap(tx, tenantId, swapId, true);
    if (!row || !canSee(access, row)) throw notFound("Permintaan tukar shift");
    if (
      !access.snapshot.allows("hr.shift_swap.approve", {
        type: "outlet",
        id: row.outletId,
      }) ||
      isParty(access, row)
    )
      throw forbidden();

    const wantsApproval =
      input.action === "approve" || input.action === "approve_with_override";
    if (
      (wantsApproval && row.status === "approved") ||
      (input.action === "reject" && row.status === "rejected")
    )
      return toShiftSwapRequest(row);
    if (row.status !== "pending")
      throw conflict("CONFLICT", `Permintaan tukar shift sudah ${row.status}.`);

    if (!row.peerAcceptedAt)
      throw conflict(
        "CONFLICT",
        "Rekan harus menerima permintaan terlebih dahulu.",
      );

    const actor = access.actorUserId;
    if (input.action === "reject") {
      transitionShiftSwap(row.status, "reject");
      const [rejected] = await tx
        .update(shiftSwapRequests)
        .set({
          status: "rejected",
          rejectionReason: input.rejectionReason ?? null,
          approvedBy: actor,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(shiftSwapRequests.id, row.id))
        .returning();
      if (!rejected) throw new Error("Shift swap update returned no row");
      await auditSwap(
        tx,
        context,
        actor,
        now,
        rejected,
        "hris.shift_swap.rejected",
      );
      return toShiftSwapRequest(rejected);
    }

    if (!isOutletInScope(context.outletScope, row.outletId))
      throw notFound("Permintaan tukar shift");
    const ids = [row.fromAssignmentId, row.toAssignmentId].filter(
      (id): id is string => id !== null,
    );
    // Lock order: swap row (findSwap above), then assignments. Cancelling an
    // assignment in the roster service takes the same order.
    const locked = await lockAssignments(tx, tenantId, ids);
    const from = locked.find((item) => same(item.id, row.fromAssignmentId));
    const to = row.toAssignmentId
      ? (locked.find((item) => same(item.id, row.toAssignmentId!)) ?? null)
      : null;
    const stale = conflict(
      "SHIFT_SWAP_STALE",
      "Jadwal sudah berubah sejak permintaan diajukan; ajukan ulang.",
    );
    if (
      !from ||
      !same(from.employeeId, row.requestedBy) ||
      from.status !== "published" ||
      hasStarted(from, now)
    )
      throw stale;
    if (row.toAssignmentId !== null) {
      if (
        !to ||
        !same(to.employeeId, row.toEmployeeId) ||
        to.status !== "published" ||
        hasStarted(to, now)
      )
        throw stale;
    }
    const target = await activeEmployee(tx, tenantId, row.toEmployeeId);
    if (!target || !same(target.homeOutletId, row.outletId)) throw stale;

    // Recomputed against the roster as it is now; the copy on the row may be stale.
    const complianceIssues = await tenantWideSwapCompliance(
      context,
      row.outletId,
      {
        from,
        to,
        requesterId: row.requestedBy,
        toEmployeeId: row.toEmployeeId,
      },
    );
    const overrideReason =
      input.action === "approve_with_override"
        ? (input.overrideReason?.trim() ?? null)
        : null;
    transitionShiftSwap(row.status, input.action, {
      complianceIssues,
      overrideReason,
    });

    const moves: Array<{ row: AssignmentRow; employeeId: string }> = [
      { row: from, employeeId: row.toEmployeeId },
      ...(to ? [{ row: to, employeeId: row.requestedBy }] : []),
    ];
    const changed: Array<{ row: AssignmentRow; previousEmployeeId: string }> =
      [];
    for (const move of moves) {
      // The savepoint keeps a unique violation from aborting the whole
      // transaction; the 409 below then rolls everything back, so the swap
      // stays pending and no assignment changes.
      const [updated] = await tx
        .transaction(async (savepoint) =>
          savepoint
            .update(shiftAssignments)
            .set({
              employeeId: move.employeeId,
              status: transitionShiftAssignment(
                move.row.status as ShiftAssignment["status"],
                "swap",
              ),
              updatedAt: now,
            })
            .where(eq(shiftAssignments.id, move.row.id))
            .returning(),
        )
        .catch((error: unknown) => {
          if (
            uniqueViolation(error)?.constraint ===
            "shift_assignments_active_employee_day_template_key"
          )
            throw conflict(
              "SHIFT_DUPLICATE",
              "Karyawan penerima sudah punya jadwal dengan template yang sama pada hari ini.",
            );
          throw error;
        });
      if (!updated) throw new Error("Shift assignment update returned no row");
      changed.push({ row: updated, previousEmployeeId: move.row.employeeId });
    }

    const [approved] = await tx
      .update(shiftSwapRequests)
      .set({
        status: "approved",
        complianceIssues,
        overrideReason,
        approvedBy: actor,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(shiftSwapRequests.id, row.id))
      .returning();
    if (!approved) throw new Error("Shift swap update returned no row");

    // Per moved assignment, in sequence order: the old owner's shift is
    // cancelled (`swapped_away`), then published again for the new owner.
    for (const { row: assignment, previousEmployeeId } of changed) {
      await appendShiftCancelled(
        tx,
        context,
        assignment,
        previousEmployeeId,
        "swapped_away",
        actor,
        now,
      );
      await appendShiftPublished(tx, context, assignment, actor, now, now);
      await auditAssignment(tx, context, actor, now, assignment);
    }
    await auditSwap(
      tx,
      context,
      actor,
      now,
      approved,
      overrideReason === null
        ? "hris.shift_swap.approved"
        : "hris.shift_swap.approved_with_override",
    );
    return toShiftSwapRequest(approved);
  });
}

/** Active colleagues in the caller's own outlet; no other employee fields leave the API. */
export async function listShiftSwapCandidates(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
  now = new Date(),
): Promise<{ data: Array<{ id: string; name: string }> }> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const own = access.own;
    if (
      !own ||
      !access.snapshot.permissions.includes("self.shift_swap.request")
    )
      throw forbidden();
    if (
      !same(own.homeOutletId, outletId) ||
      !isOutletInScope(context.outletScope, outletId)
    )
      throw notFound("Outlet");
    if (!(await activeEmployee(tx, context.tenant.tenantId, own.id)))
      throw forbidden();
    const rows = await tx
      .select({ id: employees.id, name: employees.fullName })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.homeOutletId, outletId),
          eq(employees.status, "active"),
          sql`${employees.id} <> ${own.id}`,
        ),
      )
      .orderBy(asc(employees.fullName), asc(employees.id));
    return { data: rows };
  });
}

/** Only the named colleague can respond; the row lock serializes manager decisions. */
export async function respondShiftSwapRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  swapId: string,
  input: PeerBody,
  now = new Date(),
): Promise<ShiftSwapRequest> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const row = await findSwap(tx, context.tenant.tenantId, swapId, true);
    if (!row || !canSee(access, row)) throw notFound("Permintaan tukar shift");
    if (
      !access.own ||
      !same(access.own.id, row.toEmployeeId) ||
      !access.snapshot.permissions.includes("self.shift_swap.request")
    )
      throw forbidden();
    const target = await activeEmployee(
      tx,
      context.tenant.tenantId,
      access.own.id,
    );
    if (!target || !same(target.homeOutletId, row.outletId)) throw forbidden();
    if (
      input.action === "reject" &&
      row.status === "rejected" &&
      row.approvedBy === access.actorUserId &&
      row.rejectionReason === input.rejectionReason
    )
      return toShiftSwapRequest(row);
    if (
      input.action === "accept" &&
      row.status === "pending" &&
      row.peerAcceptedAt
    )
      return toShiftSwapRequest(row);
    if (row.status !== "pending" || row.peerAcceptedAt)
      throw conflict("CONFLICT", "Permintaan sudah diproses.");
    const [updated] = await tx
      .update(shiftSwapRequests)
      .set(
        input.action === "accept"
          ? {
              peerAcceptedAt: now,
              updatedAt: now,
            }
          : {
              status: "rejected",
              rejectionReason: input.rejectionReason ?? null,
              approvedBy: access.actorUserId,
              decidedAt: now,
              updatedAt: now,
            },
      )
      .where(eq(shiftSwapRequests.id, row.id))
      .returning();
    if (!updated) throw new Error("Shift swap update returned no row");
    await auditSwap(
      tx,
      context,
      access.actorUserId,
      now,
      updated,
      input.action === "accept"
        ? "hris.shift_swap.peer_accepted"
        : "hris.shift_swap.peer_rejected",
    );
    return toShiftSwapRequest(updated);
  });
}

// -------------------------------------------------------------- cancel

/** POST /api/hris/shift-swaps/:swapId/cancel — only the requester, only while pending. */
export async function cancelShiftSwapRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  swapId: string,
  _input: CancelBody,
  now = new Date(),
): Promise<ShiftSwapRequest> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const row = await findSwap(tx, context.tenant.tenantId, swapId, true);
    if (!row || !canSee(access, row)) throw notFound("Permintaan tukar shift");
    if (access.own === null || !same(access.own.id, row.requestedBy))
      throw forbidden();
    if (row.status === "cancelled") return toShiftSwapRequest(row);
    transitionShiftSwap(row.status, "cancel");
    const [cancelled] = await tx
      .update(shiftSwapRequests)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(shiftSwapRequests.id, row.id))
      .returning();
    if (!cancelled) throw new Error("Shift swap update returned no row");
    await auditSwap(
      tx,
      context,
      access.actorUserId,
      now,
      cancelled,
      "hris.shift_swap.cancelled",
    );
    return toShiftSwapRequest(cancelled);
  });
}
