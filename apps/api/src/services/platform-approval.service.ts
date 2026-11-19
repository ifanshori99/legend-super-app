// Generic approval service (bead legend-y5q; PRD v1.7 §3 F7 "Matriks Approval"
// + "Kotak Approval", §6 B approval_policies / approval_requests, AUTH-06,
// MCP-04, §2 AI dan MCP "aksi selalu melalui approval").
//
// One service for every module: POS void/discount/refund, supervisor override,
// purchasing, payroll (HR then Finance/Owner), journals, AI and MCP drafts.
//
// How a module uses it:
// 1. Inside its own tenant transaction it calls `openApprovalRequest(...)` and
//    stores the returned `chainId` on its own pending row.
// 2. The matrix decides how many levels and which roles (`approvalRequirementFor`
//    from @starter/shared/access); the requirement is snapshotted on the row,
//    so a later matrix edit never changes a request in flight.
// 3. Approvers decide through the inbox API. Each level is one row (identity
//    contract `approvalRequestSchema`); an approved level opens the next one.
// 4. When the chain ends (approved, rejected, expired, cancelled) the service
//    appends `approval.resolved` to the transactional outbox. The source module
//    consumes it and applies the effect in ITS OWN transaction, acting only on
//    a chain it opened (`chainId` + `sourceModule`). This service never writes
//    another module's tables.
//
// Rules enforced here (shared contract functions, never re-implemented):
// - requester ≠ approver, no actor decides two levels, levels in order, the
//   approver holds a matrix role whose scope covers the request's outlet (or
//   tenant), MFA on the dashboard (access.assertApprovalDecisionAllowed);
// - pending + inside deadline (identity.recordApprovalDecision);
// - `approval.request.decide` permission over the same target.
// Races: every mutation of a chain locks its level-1 row (FOR UPDATE), so two
// concurrent approvals of one level produce exactly one decision; the partial
// unique index allows one pending level per (source module, action, object),
// and an advisory lock serialises creation for one object. Idempotency keys are
// bound to a request fingerprint (IDEMPOTENCY_KEY_REUSED on a different body);
// a decision key is scoped per chain + approver, so reusing it on another
// level of the same chain is refused too.
// Deadline (§3 F7 "dengan batas waktu"): the worker sweep expires a pending
// level after its deadline — fail closed, the action stays blocked — and the
// source module plus the notification stream receive `approval.resolved`
// (outcome `expired`). See `expireDueApprovalRequests`.

import { createHash, randomUUID } from "node:crypto";
import {
  AccessError,
  APPROVAL_MAX_LEVELS,
  approvalRequirementFor,
  approvalPolicySchema,
  assertApprovalDecisionAllowed,
  isAssignmentActive,
  outletReachOf,
  SELF_APPROVABLE_ACTION_TYPES,
  type AccessTarget,
  type ApprovalActionType,
  type ApprovalPolicy,
  type ApprovalRequirement,
  type ApprovalSource,
  type ApprovalStep,
  type OrgIndex,
  type RoleId,
  type SelfApprovalBasis,
} from "@starter/shared/access";
import {
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  outletIdSchema,
  userIdSchema,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  APPROVAL_DEADLINE_MINUTES,
  approvalDecidedEvent,
  approvalDeadlineAt,
  approvalRequestedEvent,
  approvalRequestSchema,
  approvalResolvedEvent,
  expireApprovalRequest,
  IdentityError,
  objectIdSchema,
  objectTypeSchema,
  recordApprovalDecision,
  type ApprovalDecisionInput,
  type ApprovalInboxQuery,
  type ApprovalRequest,
  type CreateApprovalRequestInput,
} from "@starter/shared/identity";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  approvalPolicies,
  approvalRequests,
  domainEventOutbox,
  paymentRefunds,
} from "../db/schema";
import type { ApprovalStepSnapshot } from "../db/schema/platform-approval";
import { withTenant } from "../db/tenant";
import { recordAudit } from "./audit-writer";
import { appendOutbox } from "./core-outbox";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type AccessSnapshot,
  type TenantAccessData,
  type Tx,
} from "./permission-resolver";
import { PROFIT_SHARE_APPROVAL_SOURCE_MODULE } from "./profit-share-approval";
import {
  lockRefundApprovalScope,
  refundChainDecisionTime,
  refundApprovalLimitRefused,
  refundApprovalWithinLimit,
} from "./payment-refund-approval-limits.ts";
import {
  lockAndCheckSoleOwnerSelfApproval,
  soleOwnerSelfApprovalPreview,
} from "./sole-owner-self-approval";

type Row = typeof approvalRequests.$inferSelect;

/** Source modules consume approval callbacks through the cloud sync stream. */
const EVENT_DESTINATION = "cloud-sync";
/** The notification consumer turns the same events into inbox/phone alerts (F7). */
const NOTIFICATION_DESTINATION = "notification";
/** `sourceModule` of a request opened through POST /api/approvals. */
export const INBOX_SOURCE_MODULE = "inbox";
const SOURCE_MODULE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
/** Bounds for a caller-chosen deadline: 5 minutes to 7 days. */
const MIN_DEADLINE_MINUTES = 5;
const MAX_DEADLINE_MINUTES = 7 * 24 * 60;

export type ApprovalOutcome =
  "pending" | "approved" | "rejected" | "expired" | "cancelled";

// ----------------------------------------------------------------- helpers

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function notFound(): CoreError {
  return new CoreError("NOT_FOUND", "Permintaan approval tidak ditemukan.");
}

function toDto(row: Row): ApprovalRequest {
  return approvalRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    actionType: row.actionType,
    objectType: row.objectType,
    objectId: row.objectId,
    payload: row.payload,
    requestedBy: row.requestedBy,
    source: row.source,
    level: row.level,
    requiredLevels: row.requiredLevels,
    amountIdr: row.amountIdr,
    status: row.status,
    requestReason: row.requestReason,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason,
    deadlineAt: row.deadlineAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Inbox view: a pending row past its deadline reads as expired before the
 * sweep. A blind cash count (`cash_shift_close`) hides its amount (the
 * |variance|) from the requester, so the cashier never learns the expected
 * cash; other viewers (approvers) still see it.
 */
function toView(row: Row, now: Date, viewerId?: string): ApprovalRequest {
  const view = expireApprovalRequest(toDto(row), now);
  if (
    row.actionType !== "cash_shift_close" ||
    viewerId === undefined ||
    viewerId.toLowerCase() !== row.requestedBy.toLowerCase()
  )
    return view;
  const payload = Object.fromEntries(
    Object.entries(view.payload).filter(([key]) => key !== "valueIdr"),
  );
  return { ...view, amountIdr: null, payload };
}

function targetOf(outletId: string | null): AccessTarget {
  return outletId === null
    ? { type: "tenant" }
    : { type: "outlet", id: outletIdSchema.parse(outletId) };
}

function requirementOf(row: Row): ApprovalRequirement {
  return {
    required: true,
    thresholdIdr: row.thresholdIdr,
    steps: row.requiredSteps.map((step): ApprovalStep => ({
      level: step.level,
      approverRoleIds: step.approverRoleIds as RoleId[],
    })),
  };
}

function toPolicy(row: typeof approvalPolicies.$inferSelect): ApprovalPolicy {
  return approvalPolicySchema.parse({
    id: row.id,
    actionType: row.actionType,
    thresholdIdr: row.thresholdIdr,
    approverRoleId: row.approverRoleId,
    levels: row.levels,
    requiresDistinctActor: true,
  });
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  destination: string,
  aggregateId: string,
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
        eq(domainEventOutbox.aggregateType, "approval"),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

type EventDefinition = {
  readonly name: string;
  readonly version: number;
  readonly payloadSchemaRef: string;
  readonly entry: { readonly aggregateType: string };
  readonly envelopeSchema: { parse(value: unknown): unknown };
};

type EventActor = { type: "user"; id: string } | { type: "system" };

/**
 * Appends one approval event for every destination, in the caller's
 * transaction (transactional outbox). The aggregate is the chain, so one
 * request's events are ordered; the chain row lock serialises the sequence.
 */
async function appendApprovalEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: EventDefinition,
  input: {
    chainId: string;
    outletId: string | null;
    actor: EventActor;
    payload: Record<string, unknown>;
    destinations: readonly string[];
    now: Date;
  },
): Promise<void> {
  for (const destination of input.destinations) {
    const sequence = await nextSequence(
      tx,
      context.tenant.tenantId,
      destination,
      input.chainId,
    );
    const event = definition.envelopeSchema.parse({
      id: createUlid(input.now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      name: definition.name,
      version: definition.version,
      aggregateType: definition.entry.aggregateType,
      aggregateId: input.chainId,
      sequence,
      occurredAt: input.now.toISOString(),
      actor: input.actor,
      deviceId: null,
      idempotencyKey: `${definition.name}:${input.chainId}:${sequence}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: input.payload,
    });
    await appendOutbox(tx, context, {
      id: createUlid(input.now.getTime()),
      event,
      destination,
      direction: null,
      peerId: null,
    });
  }
}

function requestedPayload(row: Row) {
  return {
    requestId: row.id,
    actionType: row.actionType,
    objectType: row.objectType,
    objectId: row.objectId,
    source: row.source,
    level: row.level,
    requiredLevels: row.requiredLevels,
    requestedBy: row.requestedBy,
    amountIdr: row.amountIdr,
    deadlineAt: row.deadlineAt.toISOString(),
  };
}

async function emitResolved(
  tx: Tx,
  context: ScopedTenantContext,
  row: Row,
  outcome: Exclude<ApprovalOutcome, "pending">,
  actor: EventActor,
  now: Date,
): Promise<void> {
  await appendApprovalEvent(tx, context, approvalResolvedEvent, {
    chainId: row.chainId,
    outletId: row.outletId,
    actor,
    now,
    destinations: [EVENT_DESTINATION, NOTIFICATION_DESTINATION],
    payload: {
      chainId: row.chainId,
      requestId: row.id,
      sourceModule: row.sourceModule,
      actionType: row.actionType,
      objectType: row.objectType,
      objectId: row.objectId,
      source: row.source,
      outcome,
      level: row.level,
      requiredLevels: row.requiredLevels,
      requestedBy: row.requestedBy,
      decidedBy: row.decidedBy,
      amountIdr: row.amountIdr,
    },
  });
}

async function lockChain(tx: Tx, chainId: string): Promise<void> {
  await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, chainId))
    .for("update");
}

async function chainRows(tx: Tx, chainId: string): Promise<Row[]> {
  return tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.chainId, chainId))
    .orderBy(asc(approvalRequests.level));
}

function chainOutcome(rows: readonly Row[]): ApprovalOutcome {
  const last = rows.at(-1);
  if (!last) throw notFound();
  if (last.status === "approved")
    return last.level >= last.requiredLevels ? "approved" : "pending";
  return last.status;
}

// ------------------------------------------------------- access snapshots

type Caller = {
  readonly snapshot: AccessSnapshot;
  readonly data: TenantAccessData;
};

async function loadCaller(
  tenant: TenantContext,
  userId: string,
  mfaVerified: boolean,
  now: Date,
): Promise<Caller> {
  const bootstrap = establishScopedTenantContext(tenant, { kind: "tenant" });
  const data = await withTenant(db, bootstrap, (tx) =>
    loadTenantAccessInTransaction(tx, bootstrap, userId),
  );
  return {
    data,
    snapshot: resolveAccessSnapshot({
      tenant,
      userId,
      ...data,
      mfaVerified,
      now,
    }),
  };
}

/**
 * Outlets the caller belongs to through any active assignment (whatever its
 * role): tenant-wide, or the outlets its brand/outlet/station scopes reach.
 * Used for the caller's own requests; null = no membership (deny).
 */
function membershipContext(
  tenant: TenantContext,
  userId: string,
  data: TenantAccessData,
  now: Date,
): ScopedTenantContext | null {
  const active = data.assignments.filter(
    (row) =>
      row.tenantId.toLowerCase() === tenant.tenantId.toLowerCase() &&
      row.userId.toLowerCase() === userId.toLowerCase() &&
      isAssignmentActive(row, now),
  );
  if (active.length === 0) return null;
  const org: OrgIndex = data.org;
  const outlets = new Set<OutletId>();
  for (const row of active) {
    const scope = row.scope;
    if (scope.type === "tenant")
      return establishScopedTenantContext(tenant, { kind: "tenant" });
    if (scope.type === "brand")
      for (const outlet of org.outlets)
        if (outlet.brandId.toLowerCase() === scope.id.toLowerCase())
          outlets.add(outlet.id);
    if (scope.type === "outlet")
      for (const outlet of org.outlets)
        if (outlet.id.toLowerCase() === scope.id.toLowerCase())
          outlets.add(outlet.id);
    if (scope.type === "station")
      for (const station of org.stations)
        if (station.id.toLowerCase() === scope.id.toLowerCase())
          outlets.add(station.outletId);
  }
  if (outlets.size === 0) return null;
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [...outlets],
  });
}

/**
 * The caller's reach for `permission`: tenant-wide when an assignment reaches
 * the whole tenant, else the union of outlets its applicable assignments reach
 * (TEN-03, same rule as the menu routes). null = no reach (deny).
 */
function reachContext(
  tenant: TenantContext,
  userId: string,
  data: TenantAccessData,
  permission: "approval.inbox.view" | "approval.request.decide",
  now: Date,
): ScopedTenantContext | null {
  const reach = outletReachOf({
    principal: {
      tenantId: tenant.tenantId,
      userId: userIdSchema.parse(userId),
      assignments: data.assignments,
    },
    roles: data.roles,
    org: data.org,
    now,
    permission,
  });
  return reach === null ? null : establishScopedTenantContext(tenant, reach);
}

function covers(context: ScopedTenantContext, outletId: string | null) {
  if (context.outletScope.kind === "tenant") return true;
  if (outletId === null) return false;
  return context.outletScope.outletIds.some(
    (id) => id.toLowerCase() === outletId.toLowerCase(),
  );
}

// ------------------------------------------------------ opening a request

export type OpenApprovalRequestInput = {
  /** Module that owns the effect (`payment`, `pos`, `purchasing`, `payroll`, `ai`, `mcp`...). */
  readonly sourceModule: string;
  readonly actionType: ApprovalActionType;
  readonly objectType: string;
  readonly objectId: string;
  /** The amount the matrix tiers on; null = unknown → every tier applies (fail closed). */
  readonly amountIdr: Idr | number | null;
  readonly outletId: string | null;
  readonly requestedBy: string;
  /** `ai` / `mcp`: `requestedBy` is the human the agent acts for (PRD §4 Q, MCP-04). */
  readonly source: ApprovalSource;
  readonly requestReason: string;
  readonly payload?: Record<string, unknown>;
  readonly deadlineMinutes?: number;
  readonly idempotencyKey?: string | null;
  readonly now?: Date;
  /**
   * True: the action always needs another person. An amount below every tier
   * takes the lowest tier's chain instead of `{ required: false }` (founder
   * Q27 supplier payments; held cash and top-ups, SO 1036 findings 2, 5, 6).
   */
  readonly alwaysRequire?: boolean;
};

export type OpenApprovalResult =
  | { readonly required: false }
  | {
      readonly required: true;
      readonly chainId: string;
      readonly request: ApprovalRequest;
      /** True when an idempotent retry returned the existing request. */
      readonly replayed: boolean;
    };

/**
 * Opens an approval request inside the caller's tenant transaction (source
 * modules). The caller has already authorised the action itself; this checks
 * the matrix, snapshots it, writes level 1 and appends `approval.requested`.
 * `{ required: false }` when the amount is below every tier of the matrix.
 * Throws APPROVAL_POLICY_MISSING when the tenant has no policy for the action
 * (nobody may approve: fail closed).
 */
export async function openApprovalRequest(
  tx: Tx,
  context: ScopedTenantContext,
  input: OpenApprovalRequestInput,
): Promise<OpenApprovalResult> {
  const now = input.now ?? new Date();
  if (!SOURCE_MODULE_PATTERN.test(input.sourceModule))
    throw new TypeError("sourceModule must be one snake_case word");
  const objectType = objectTypeSchema.parse(input.objectType);
  const objectId = objectIdSchema.parse(input.objectId);
  const requestedBy = userIdSchema.parse(input.requestedBy);
  const outletId =
    input.outletId === null ? null : outletIdSchema.parse(input.outletId);
  const requestReason = input.requestReason.trim();
  if (requestReason.length < 3 || requestReason.length > 500)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Alasan permintaan wajib 3 sampai 500 karakter.",
    );
  const deadlineMinutes = input.deadlineMinutes ?? APPROVAL_DEADLINE_MINUTES;
  if (
    !Number.isInteger(deadlineMinutes) ||
    deadlineMinutes < MIN_DEADLINE_MINUTES ||
    deadlineMinutes > MAX_DEADLINE_MINUTES
  )
    throw new RangeError("deadlineMinutes must be 5 minutes to 7 days");
  if (!covers(context, outletId))
    throw new CoreError("OUTLET_OUT_OF_SCOPE", "Outlet di luar cakupan Anda.");
  const payload = input.payload ?? {};
  const key =
    input.idempotencyKey === undefined || input.idempotencyKey === null
      ? null
      : idempotencyKeySchema.parse(input.idempotencyKey);
  const createFingerprint = fingerprint({
    sourceModule: input.sourceModule,
    actionType: input.actionType,
    objectType,
    objectId,
    amountIdr: input.amountIdr,
    outletId,
    source: input.source,
    requestReason,
    payload,
  });

  if (key !== null) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`approval-create:${context.tenant.tenantId}:${requestedBy}:${key}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.requestedBy, requestedBy),
          eq(approvalRequests.createIdempotencyKey, key),
        ),
      );
    if (existing) {
      if (existing.createFingerprint !== createFingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different request.",
        );
      return {
        required: true,
        chainId: existing.chainId,
        request: toView(existing, now),
        replayed: true,
      };
    }
  }

  const policies = (
    await tx
      .select()
      .from(approvalPolicies)
      .where(
        and(
          eq(approvalPolicies.tenantId, context.tenant.tenantId),
          eq(approvalPolicies.actionType, input.actionType),
        ),
      )
  ).map(toPolicy);
  let requirement = approvalRequirementFor(
    policies,
    input.actionType,
    input.amountIdr,
  );
  if (!requirement.required && input.alwaysRequire === true) {
    // Below every tier: fall back to the lowest tier of the matrix (a null
    // threshold always applies, so a non-null row exists when we get here).
    const lowest = Math.min(
      ...policies.flatMap((row) =>
        row.thresholdIdr === null ? [] : [row.thresholdIdr],
      ),
    );
    requirement = approvalRequirementFor(policies, input.actionType, lowest);
  }
  if (!requirement.required) return { required: false };
  const steps: ApprovalStepSnapshot[] = requirement.steps.map((step) => ({
    level: step.level,
    approverRoleIds: [...step.approverRoleIds],
  }));
  const requiredLevels = steps.length;
  if (requiredLevels < 1 || requiredLevels > APPROVAL_MAX_LEVELS)
    throw new AccessError("APPROVAL_POLICY_MISSING");

  // One open request per (source module, action, object): serialise creation
  // for the object, then refuse a duplicate instead of opening a parallel
  // chain. Scoped by source module so a hand-made inbox request (client-chosen
  // objectId) can never block a module's own approval for the same object.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`approval-object:${context.tenant.tenantId}:${input.sourceModule}:${input.actionType}:${objectType}:${objectId}`}, 0))`,
  );
  const [pending] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenant.tenantId),
        eq(approvalRequests.sourceModule, input.sourceModule),
        eq(approvalRequests.actionType, input.actionType),
        eq(approvalRequests.objectType, objectType),
        eq(approvalRequests.objectId, objectId),
        eq(approvalRequests.status, "pending"),
      ),
    );
  if (pending)
    throw new CoreError(
      "CONFLICT",
      "Permintaan approval untuk objek ini masih menunggu keputusan.",
    );

  const id = randomUUID();
  const [row] = await tx
    .insert(approvalRequests)
    .values({
      id,
      tenantId: context.tenant.tenantId,
      outletId,
      chainId: id,
      sourceModule: input.sourceModule,
      actionType: input.actionType,
      objectType,
      objectId,
      payload,
      requestedBy,
      source: input.source,
      level: 1,
      requiredLevels,
      requiredSteps: steps,
      thresholdIdr: requirement.thresholdIdr,
      amountIdr: input.amountIdr === null ? null : (input.amountIdr as Idr),
      status: "pending",
      requestReason,
      createIdempotencyKey: key,
      createFingerprint: key === null ? null : createFingerprint,
      deadlineAt: approvalDeadlineAt(now, deadlineMinutes),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("approval request insert returned no row");
  const actor: EventActor = { type: "user", id: requestedBy };
  await appendApprovalEvent(tx, context, approvalRequestedEvent, {
    chainId: row.chainId,
    outletId,
    actor,
    now,
    destinations: [EVENT_DESTINATION, NOTIFICATION_DESTINATION],
    payload: requestedPayload(row),
  });
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId,
      actorType:
        input.source === "ai"
          ? "ai"
          : input.source === "mcp"
            ? "mcp_client"
            : "user",
      actorId: requestedBy,
      deviceId: null,
      action: "approval.requested",
      objectType: "approval_request",
      objectId: row.id,
      reason: null,
      before: null,
      after: {
        actionType: row.actionType,
        objectType: row.objectType,
        objectId: row.objectId,
        sourceModule: row.sourceModule,
        level: 1,
        requiredLevels,
        amountIdr: row.amountIdr,
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
  return {
    required: true,
    chainId: row.chainId,
    request: toDto(row),
    replayed: false,
  };
}

/**
 * The chain's outcome for a source module that wants to check synchronously
 * (e.g. before applying an effect). Only the module that opened it may ask.
 */
export async function getApprovalChainOutcome(
  tx: Tx,
  input: { readonly chainId: string; readonly sourceModule: string },
): Promise<ApprovalOutcome> {
  const rows = await chainRows(tx, input.chainId);
  if (rows[0]?.sourceModule !== input.sourceModule) throw notFound();
  return chainOutcome(rows);
}

/**
 * Announces a level that just became `expired`: `approval.resolved` (expired,
 * system) to the source module and notifications, plus the audit row. Shared by
 * the deadline sweep and `resolveApprovalChainOutcome`.
 */
async function announceExpired(
  tx: Tx,
  context: ScopedTenantContext,
  row: Row,
  now: Date,
): Promise<void> {
  await emitResolved(tx, context, row, "expired", { type: "system" }, now);
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: row.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: "approval.expired",
      objectType: "approval_request",
      objectId: row.id,
      reason: null,
      before: {
        status: "pending",
        deadlineAt: row.deadlineAt.toISOString(),
      },
      after: { status: "expired" },
      sensitiveAccess: false,
    },
    { tx, context },
  );
}

/**
 * The chain's outcome for a source module that settles synchronously, with
 * the deadline applied atomically: locks the chain head (the lock every
 * decide takes), re-reads, and when the open level is still pending past its
 * deadline expires it here (conditional on status 'pending'), emitting
 * approval.resolved (expired, system) + audit approval.expired like the sweep.
 * An inbox decision already in flight commits first and wins.
 */
export async function resolveApprovalChainOutcome(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    readonly chainId: string;
    readonly sourceModule: string;
    readonly now: Date;
  },
): Promise<ApprovalOutcome> {
  await lockChain(tx, input.chainId);
  // The caller's clock was read before waiting on the lock: never judge the
  // deadline or stamp the transition with a time earlier than the lock grant.
  const at = new Date(Math.max(input.now.getTime(), Date.now()));
  const rows = await chainRows(tx, input.chainId);
  if (rows[0]?.sourceModule !== input.sourceModule) throw notFound();
  const open = rows.find((row) => row.status === "pending");
  if (!open) return chainOutcome(rows);
  if (open.deadlineAt.getTime() > at.getTime()) return "pending";
  return expireOpenLevel(tx, context, input.chainId, open, at);
}

/**
 * Expires the open level of a chain whose deadline has passed (conditional on
 * status 'pending') and announces it. When the sweep won between the caller's
 * read and this write, reports what it left behind. The caller holds the chain
 * head lock and has already judged the deadline against `at`.
 */
async function expireOpenLevel(
  tx: Tx,
  context: ScopedTenantContext,
  chainId: string,
  open: Row,
  at: Date,
): Promise<ApprovalOutcome> {
  const [expired] = await tx
    .update(approvalRequests)
    .set({ status: "expired", updatedAt: at })
    .where(
      and(
        eq(approvalRequests.id, open.id),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .returning();
  // The sweep won between our read and write: report what it left behind.
  if (!expired) return chainOutcome(await chainRows(tx, chainId));
  await announceExpired(tx, context, expired, at);
  return "expired";
}

/**
 * The source module withdraws its request (e.g. the order was voided first).
 * Idempotent: an already-ended chain returns its outcome unchanged.
 */
export async function cancelApprovalRequest(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    readonly chainId: string;
    readonly sourceModule: string;
    /** The human withdrawing it; null = the module itself (system). */
    readonly actorUserId: string | null;
    /** The signed device the human withdrew it from (POS), for the audit row. */
    readonly deviceId?: string | null;
    readonly now?: Date;
  },
): Promise<ApprovalOutcome> {
  await lockChain(tx, input.chainId);
  // Time after the lock grant, not the clock read before waiting on it.
  const at = new Date(
    Math.max((input.now ?? new Date()).getTime(), Date.now()),
  );
  const rows = await chainRows(tx, input.chainId);
  if (rows[0]?.sourceModule !== input.sourceModule) throw notFound();
  const open = rows.find((row) => row.status === "pending");
  if (!open) return chainOutcome(rows);
  // A level past its deadline is expired, never cancelled: the module may have
  // queued on the chain lock until after the deadline. No throw, system callers
  // (settlement import) must not abort; every caller treats a non-approved
  // outcome as safe.
  if (open.deadlineAt.getTime() <= at.getTime()) {
    return expireOpenLevel(tx, context, input.chainId, open, at);
  }
  const [cancelled] = await tx
    .update(approvalRequests)
    .set({ status: "cancelled", updatedAt: at })
    .where(
      and(
        eq(approvalRequests.id, open.id),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .returning();
  if (!cancelled) {
    // The deadline sweep locks the due row (not the chain head), so it can
    // expire this level between our read and our write. One terminal outcome
    // per chain: report the winner instead of overwriting "expired" with
    // "cancelled" and emitting a second approval.resolved.
    return chainOutcome(await chainRows(tx, input.chainId));
  }
  const actor: EventActor =
    input.actorUserId === null
      ? { type: "system" }
      : { type: "user", id: userIdSchema.parse(input.actorUserId) };
  await emitResolved(tx, context, cancelled, "cancelled", actor, at);
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: cancelled.outletId,
      actorType: input.actorUserId === null ? "system" : "user",
      actorId: input.actorUserId,
      deviceId: input.deviceId ?? null,
      action: "approval.cancelled",
      objectType: "approval_request",
      objectId: cancelled.id,
      reason: null,
      before: { status: "pending" },
      after: { status: "cancelled" },
      sensitiveAccess: false,
    },
    { tx, context },
  );
  return "cancelled";
}

// ------------------------------------------------------------ HTTP: cancel

/**
 * POST /api/approvals/:requestId/cancel (bead legend-6hr8): the requester
 * withdraws their own pending request (POS "Berhenti menunggu"). The row is
 * read by tenant AND id AND requester in SQL, so another user's request and
 * another tenant's request are both 404 (no leak). The read runs on the
 * tenant-wide context because a tenant-level request has no outlet and RLS
 * hides it from outlet-scoped callers; the requester filter is what scopes it
 * and an outlet request must still be inside the caller's own outlets.
 * Idempotent: an already-cancelled chain returns 200 with the same view;
 * approved/rejected/expired is 409 and the outcome stands.
 */
export async function cancelOwnApprovalRequest(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  now = new Date(),
): Promise<ApprovalRequest> {
  return (
    await cancelOwnRequest(tenant, actorUserId, requestId, null, null, now)
  ).request;
}

/**
 * A source module's own cancel path (sub-brief E3, POS "Berhenti menunggu"):
 * the requester withdraws their pending request of `sourceModule` at one
 * outlet. Same rules as the back-office cancel; the SQL read adds the outlet
 * and the source module, so another module's request, another outlet or
 * another tenant answers 404 exactly like a missing one. The caller owns the
 * guards (POS: signed device + acting cashier; `actorUserId` and `outletId`
 * come from the verified token, never from the body).
 */
export async function cancelOwnModuleApprovalRequest(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  scope: { readonly outletId: string; readonly sourceModule: string },
  deviceId: string | null,
  now = new Date(),
): Promise<{ request: ApprovalRequest; chainId: string }> {
  return cancelOwnRequest(
    tenant,
    actorUserId,
    requestId,
    {
      outletId: outletIdSchema.parse(scope.outletId),
      sourceModule: scope.sourceModule,
    },
    deviceId,
    now,
  );
}

/**
 * GET /api/pos-overrides/approvals/:requestId (sub-brief E3, PhoneWait poll):
 * the requester reads their own request of `sourceModule` at one outlet, with
 * the same SQL scope as cancelOwnModuleApprovalRequest (anything else is
 * 404). Reports the chain's latest level, so a 2-level chain read by its
 * level-1 id is pending until the last level ends.
 */
export async function getOwnModuleApprovalRequest(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  scope: { readonly outletId: string; readonly sourceModule: string },
  now = new Date(),
): Promise<ApprovalRequest> {
  const caller = await loadCaller(tenant, actorUserId, false, now);
  const membership = membershipContext(tenant, actorUserId, caller.data, now);
  if (membership === null) throw notFound();
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  return withTenant(db, context, async (tx) => {
    const row = await findOwnRequest(tx, tenant, actorUserId, requestId, {
      outletId: outletIdSchema.parse(scope.outletId),
      sourceModule: scope.sourceModule,
    });
    if (!row || (row.outletId !== null && !covers(membership, row.outletId)))
      throw notFound();
    const latest = (await chainRows(tx, row.chainId)).at(-1);
    return toView(latest ?? row, now, actorUserId);
  });
}

/** The caller's own request by id; `scope` adds the outlet and source module. */
async function findOwnRequest(
  tx: Tx,
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  scope: { readonly outletId: OutletId; readonly sourceModule: string } | null,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenant.tenantId),
        eq(approvalRequests.id, requestId),
        eq(approvalRequests.requestedBy, actorUserId),
        ...(scope === null
          ? []
          : [
              eq(approvalRequests.outletId, scope.outletId),
              eq(approvalRequests.sourceModule, scope.sourceModule),
            ]),
      ),
    );
  return row;
}

/** `scope` null = back-office cancel of an inbox request (any outlet reached). */
async function cancelOwnRequest(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  scope: { readonly outletId: OutletId; readonly sourceModule: string } | null,
  deviceId: string | null,
  now: Date,
): Promise<{ request: ApprovalRequest; chainId: string }> {
  const sourceModule = scope?.sourceModule ?? INBOX_SOURCE_MODULE;
  const caller = await loadCaller(tenant, actorUserId, false, now);
  const membership = membershipContext(tenant, actorUserId, caller.data, now);
  if (membership === null) throw notFound();
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  return withTenant(db, context, async (tx) => {
    const row = await findOwnRequest(tx, tenant, actorUserId, requestId, scope);
    if (!row) throw notFound();
    if (row.outletId !== null && !covers(membership, row.outletId))
      throw notFound();
    const conflict = () =>
      new CoreError(
        "CONFLICT",
        "Permintaan approval sudah diputuskan atau kedaluwarsa dan tidak bisa dibatalkan.",
      );
    // Back office: only inbox-opened requests are withdrawn here; other
    // modules cancel their own through cancelApprovalRequest or their scoped
    // path (cancelOwnModuleApprovalRequest).
    if (row.sourceModule !== sourceModule) throw conflict();
    // Apply the deadline first: a pending request past it is expired (409,
    // which rolls the expiry back for the sweep to announce), not cancelled.
    const current = await resolveApprovalChainOutcome(tx, context, {
      chainId: row.chainId,
      sourceModule: row.sourceModule,
      now,
    });
    if (current !== "pending" && current !== "cancelled") throw conflict();
    const outcome =
      current === "cancelled"
        ? current
        : await cancelApprovalRequest(tx, context, {
            chainId: row.chainId,
            sourceModule: row.sourceModule,
            actorUserId,
            deviceId,
            now,
          });
    if (outcome !== "cancelled") throw conflict();
    // The chain's terminal row, not the row of the id sent: a 2-level chain
    // cancelled via its level-1 id reports the cancelled level-2 row.
    const terminal = (await chainRows(tx, row.chainId)).at(-1);
    return {
      request: toView(terminal ?? row, now, actorUserId),
      chainId: row.chainId,
    };
  });
}

// ------------------------------------------------------------ HTTP: create

/**
 * POST /api/approvals: a user asks for approval directly from the inbox. The
 * request is `sourceModule = inbox`; no module applies an effect for it, so a
 * hand-made request can never trigger a refund or a payroll lock. The
 * requester must belong to the outlet (or to the whole tenant when no outlet).
 */
export async function createApprovalRequestFromInbox(
  tenant: TenantContext,
  actorUserId: string,
  input: CreateApprovalRequestInput,
  options: { idempotencyKey: string | null; now?: Date },
): Promise<{ request: ApprovalRequest; replayed: boolean }> {
  const now = options.now ?? new Date();
  const caller = await loadCaller(tenant, actorUserId, false, now);
  const membership = membershipContext(tenant, actorUserId, caller.data, now);
  const outletId = input.outletId ?? null;
  if (membership === null || !covers(membership, outletId))
    throw new AccessError(
      "PERMISSION_DENIED",
      outletId === null
        ? "Permintaan tingkat tenant hanya untuk pengguna tingkat tenant."
        : "Anda tidak terdaftar di outlet ini.",
    );
  const context = establishScopedTenantContext(
    tenant,
    outletId === null
      ? { kind: "tenant" }
      : { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
  const result = await withTenant(db, context, (tx) =>
    openApprovalRequest(tx, context, {
      sourceModule: INBOX_SOURCE_MODULE,
      actionType: input.actionType,
      objectType: input.objectType,
      objectId: input.objectId,
      amountIdr: input.amountIdr ?? null,
      outletId,
      requestedBy: actorUserId,
      source: "user",
      requestReason: input.requestReason,
      payload: input.payload,
      idempotencyKey: options.idempotencyKey,
      now,
    }),
  );
  if (!result.required)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "Tindakan ini tidak memerlukan persetujuan untuk nilai tersebut.",
    );
  return { request: result.request, replayed: result.replayed };
}

// -------------------------------------------------------- HTTP: list / get

/**
 * legend-b8y6l: a pending self-approvable row (shareholder_version) the caller
 * submitted may show "selfApprovalAllowed" when the caller is the tenant's sole
 * Owner. The preview query runs once per call and only if some row qualifies;
 * decideApprovalRequest re-checks under the advisory lock.
 */
/** A chain a sole Owner may approve itself: profit share's shareholder_version only. */
function isSelfApprovableRow(row: Row): boolean {
  return (
    row.sourceModule === PROFIT_SHARE_APPROVAL_SOURCE_MODULE &&
    SELF_APPROVABLE_ACTION_TYPES.has(row.actionType)
  );
}

async function selfApprovalAllowedFor(
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  rows: readonly Row[],
  now: Date,
): Promise<boolean> {
  const qualifies = rows.some(
    (row) =>
      row.status === "pending" &&
      row.deadlineAt.getTime() > now.getTime() &&
      isSelfApprovableRow(row) &&
      row.requestedBy.toLowerCase() === actorUserId.toLowerCase(),
  );
  return qualifies
    ? soleOwnerSelfApprovalPreview(tx, tenantId, actorUserId)
    : false;
}

function withSelfApproval(
  view: ApprovalRequest,
  row: Row,
  actorUserId: string,
  selfApprovable: boolean,
): ApprovalRequest {
  return selfApprovable &&
    view.status === "pending" &&
    isSelfApprovableRow(row) &&
    row.requestedBy.toLowerCase() === actorUserId.toLowerCase()
    ? { ...view, selfApprovalAllowed: true }
    : view;
}

/**
 * GET /api/approvals (F7 "Kotak Approval"). With `approval.inbox.view` the
 * caller sees every request inside its reach (RLS outlet scope; tenant-wide
 * requests only with tenant reach). Without it, only its own requests.
 */
export async function listApprovalRequests(
  tenant: TenantContext,
  actorUserId: string,
  query: ApprovalInboxQuery,
  now = new Date(),
): Promise<{
  data: ApprovalRequest[];
  meta: { limit: number; nextCursor: string | null };
}> {
  const caller = await loadCaller(tenant, actorUserId, false, now);
  const inboxContext = reachContext(
    tenant,
    actorUserId,
    caller.data,
    "approval.inbox.view",
    now,
  );
  const context =
    inboxContext ??
    membershipContext(tenant, actorUserId, caller.data, now) ??
    null;
  if (context === null) throw new AccessError("PERMISSION_DENIED");
  if (query.outletId !== undefined && !covers(context, query.outletId))
    throw new CoreError("OUTLET_OUT_OF_SCOPE", "Outlet di luar cakupan Anda.");
  return withTenant(db, context, async (tx) => {
    const filters = [eq(approvalRequests.tenantId, tenant.tenantId)];
    if (inboxContext === null)
      filters.push(eq(approvalRequests.requestedBy, actorUserId));
    if (query.actionType)
      filters.push(eq(approvalRequests.actionType, query.actionType));
    if (query.source) filters.push(eq(approvalRequests.source, query.source));
    if (query.outletId)
      filters.push(eq(approvalRequests.outletId, query.outletId));
    if (query.status === "pending") {
      // The inbox shows open rows only; a past-deadline row waits for the sweep.
      filters.push(eq(approvalRequests.status, "pending"));
      filters.push(sql`${approvalRequests.deadlineAt} > ${now}`);
    } else if (query.status === "expired") {
      filters.push(
        or(
          eq(approvalRequests.status, "expired"),
          and(
            eq(approvalRequests.status, "pending"),
            lte(approvalRequests.deadlineAt, now),
          ),
        )!,
      );
    } else if (query.status) {
      filters.push(eq(approvalRequests.status, query.status));
    }
    if (query.cursor) {
      const [createdAt, id] = decodeCursor(query.cursor);
      if (typeof createdAt !== "string" || typeof id !== "string")
        throw new CoreError("VALIDATION_ERROR", "Check the cursor.");
      const at = new Date(createdAt);
      if (Number.isNaN(at.getTime()))
        throw new CoreError("VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          sql`${approvalRequests.createdAt} < ${at}`,
          and(
            eq(approvalRequests.createdAt, at),
            sql`${approvalRequests.id} < ${id}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(approvalRequests)
      .where(and(...filters))
      .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const selfApprovable = await selfApprovalAllowedFor(
      tx,
      tenant.tenantId,
      actorUserId,
      page,
      now,
    );
    return {
      data: page.map((row) =>
        withSelfApproval(
          toView(row, now, actorUserId),
          row,
          actorUserId,
          selfApprovable,
        ),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** GET /api/approvals/:requestId — an inbox viewer in reach, or the requester. */
export async function getApprovalRequest(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  now = new Date(),
): Promise<ApprovalRequest> {
  const caller = await loadCaller(tenant, actorUserId, false, now);
  const inboxContext = reachContext(
    tenant,
    actorUserId,
    caller.data,
    "approval.inbox.view",
    now,
  );
  for (const context of [
    inboxContext,
    membershipContext(tenant, actorUserId, caller.data, now),
  ]) {
    if (context === null) continue;
    const ownOnly = context !== inboxContext;
    const row = await withTenant(db, context, async (tx) => {
      const [found] = await tx
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, requestId),
            ownOnly ? eq(approvalRequests.requestedBy, actorUserId) : undefined,
          ),
        );
      if (!found) return undefined;
      return {
        found,
        selfApprovable: await selfApprovalAllowedFor(
          tx,
          tenant.tenantId,
          actorUserId,
          [found],
          now,
        ),
      };
    });
    if (row)
      return withSelfApproval(
        toView(row.found, now, actorUserId),
        row.found,
        actorUserId,
        row.selfApprovable,
      );
  }
  throw notFound();
}

// ------------------------------------------------------------ HTTP: decide

export type DecideOptions = {
  /** The session verified a second factor (AUTH-05; the dashboard is MFA-guarded). */
  readonly mfaVerified: boolean;
  readonly idempotencyKey: string | null;
  readonly now?: Date;
};

/**
 * POST /api/approvals/:requestId/decisions (F7: approve/reject with reason).
 * Returns the decided row. Replaying the same decision (same approver,
 * decision and reason, or the same Idempotency-Key with the same body) returns
 * the stored row without a second decision or event.
 */
export async function decideApprovalRequest(
  tenant: TenantContext,
  actorUserId: string,
  requestId: string,
  input: ApprovalDecisionInput,
  options: DecideOptions,
): Promise<ApprovalRequest> {
  const now = options.now ?? new Date();
  const approverId = userIdSchema.parse(actorUserId);
  const key =
    options.idempotencyKey === null
      ? null
      : idempotencyKeySchema.parse(options.idempotencyKey);
  const reason = input.reason.trim();
  const decisionFingerprint = fingerprint({
    requestId: requestId.toLowerCase(),
    decision: input.decision,
    reason,
    approverId: approverId.toLowerCase(),
  });
  const caller = await loadCaller(tenant, approverId, options.mfaVerified, now);
  // Rows outside the approver's decide reach are invisible (RLS): 404, no leak.
  const context = reachContext(
    tenant,
    approverId,
    caller.data,
    "approval.request.decide",
    now,
  );
  if (context === null) throw new AccessError("PERMISSION_DENIED");

  return withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    if (!found) throw notFound();
    // Payment limits serialize by bill before the chain lock, matching the
    // payment service's group -> intent -> refund -> chain lock order.
    let paymentRefund: typeof paymentRefunds.$inferSelect | null = null;
    // legend-ykk88: a refund approval fact follows commit order, so its time is
    // taken after the scope lock rather than from the pre-lock request clock.
    let decisionAt = now;
    if (
      input.decision === "approved" &&
      found.sourceModule === "payment" &&
      found.actionType === "refund" &&
      found.objectType === "payment_refund"
    ) {
      const [refund] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, tenant.tenantId),
            eq(paymentRefunds.approvalChainId, found.chainId),
            sql`lower(${paymentRefunds.id}::text) = lower(${found.objectId})`,
          ),
        );
      if (refund) {
        paymentRefund = refund;
        await lockRefundApprovalScope(
          tx,
          tenant.tenantId,
          refund.paymentIntentId,
        );
        decisionAt = await refundChainDecisionTime(tx, refund, now);
      }
    }
    await lockChain(tx, found.chainId);
    const rows = await chainRows(tx, found.chainId);
    const row = rows.find((candidate) => candidate.id === requestId);
    if (!row) throw notFound();
    // A decision key belongs to one level: reusing it on another level of the
    // same chain (same approver) is a different request, not a replay.
    if (
      key !== null &&
      rows.some(
        (candidate) =>
          candidate.id !== row.id &&
          candidate.decisionIdempotencyKey === key &&
          candidate.decidedBy?.toLowerCase() === approverId.toLowerCase(),
      )
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key already used for a different decision.",
      );

    // Idempotent replay: same body (and key, if any) → the stored decision.
    if (row.status !== "pending") {
      const sameBody = row.decisionFingerprint === decisionFingerprint;
      if (key !== null && row.decisionIdempotencyKey === key && !sameBody)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different decision.",
        );
      if (sameBody) return toDto(row);
      if (row.status === "expired")
        throw new IdentityError("APPROVAL_REQUEST_EXPIRED");
      throw new IdentityError("APPROVAL_REQUEST_NOT_PENDING");
    }

    // legend-b8y6l: a sole Owner may approve (never reject) their own
    // shareholder_version request. Lock order: chain row first, then the
    // role-assignment advisory lock (same as the settle paths; avoids deadlock).
    let selfApproval: SelfApprovalBasis | null = null;
    if (
      input.decision === "approved" &&
      isSelfApprovableRow(row) &&
      row.requestedBy.toLowerCase() === approverId.toLowerCase()
    )
      selfApproval = await lockAndCheckSoleOwnerSelfApproval(
        tx,
        tenant.tenantId,
        approverId,
      );

    // legend-k8g62: the pre-lock caller data is stale once the call queued
    // behind the locks. Reload role, assignments and scope after the last lock,
    // inside this same transaction (no second pool connection). Fail closed:
    // a revoked or moved assignment is refused below.
    const lockedBootstrap = establishScopedTenantContext(tenant, {
      kind: "tenant",
    });
    const lockedCaller = {
      data: await loadTenantAccessInTransaction(
        tx,
        lockedBootstrap,
        approverId,
      ),
    };

    // legend-ijy8u, 1151: the call may have queued behind the refund
    // scope, chain and role-assignment locks, so every time-based check below
    // uses a clock read after the LAST lock. Fail safe: the later of the
    // caller's options.now, a refund fact time taken before the lock, and the
    // server clock wins; the server clock is never skipped, even when the
    // caller passes an older options.now.
    const serverAt = new Date(Date.now());
    let checkAt = serverAt;
    if (now.getTime() > checkAt.getTime()) checkAt = now;
    if (decisionAt.getTime() > checkAt.getTime()) checkAt = decisionAt;
    // The decision is stored at the time it was judged.
    decisionAt = checkAt;

    // The approver's role assignment may have ended while queued: judge reach
    // and the access snapshot again at the post-lock time (fail closed).
    if (
      reachContext(
        tenant,
        approverId,
        lockedCaller.data,
        "approval.request.decide",
        checkAt,
      ) === null
    )
      throw new AccessError("PERMISSION_DENIED");
    const lockedSnapshot = resolveAccessSnapshot({
      tenant,
      userId: approverId,
      ...lockedCaller.data,
      mfaVerified: options.mfaVerified,
      now: checkAt,
    });

    const prior = rows.filter((candidate) => candidate.level < row.level);
    if (
      prior.some(
        (candidate) =>
          candidate.status !== "approved" || candidate.decidedBy === null,
      )
    )
      throw new AccessError("APPROVAL_LEVEL_OUT_OF_ORDER");
    const priorApproverIds = prior.map((candidate) =>
      userIdSchema.parse(candidate.decidedBy),
    );
    const dto = toDto(row);
    // Lifecycle: pending, inside the deadline, requester ≠ approver (AUTH-06).
    const decided = recordApprovalDecision({
      request: dto,
      decision: input.decision,
      decidedBy: approverId,
      priorApproverIds,
      reason,
      now: checkAt,
      selfApproval,
    });
    // Matrix: role for this level, scope covers the outlet/tenant, MFA (MCP-04).
    const target = targetOf(row.outletId);
    assertApprovalDecisionAllowed({
      requirement: requirementOf(row),
      requestedBy: row.requestedBy,
      priorDecisions: prior.map((candidate) => ({
        level: candidate.level,
        approverId: candidate.decidedBy as string,
      })),
      level: row.level,
      approver: {
        tenantId: tenant.tenantId,
        userId: approverId,
        assignments: lockedCaller.data.assignments,
      },
      approverRoles: lockedCaller.data.roles,
      priorSelfApprovalAllowed: isSelfApprovableRow(row),
      approverMfaVerified: options.mfaVerified,
      surface: "dashboard",
      target,
      org: lockedCaller.data.org,
      now: checkAt,
      selfApproval,
    });
    if (!lockedSnapshot.allows("approval.request.decide", target))
      throw new AccessError("PERMISSION_DENIED");
    // Replays above keep their stored decision. A new approval must satisfy
    // the current scoped amount ceiling as well as the configured matrix.
    if (
      paymentRefund !== null &&
      lockedSnapshot.allows("pos.refund.approve", target) &&
      !(await refundApprovalWithinLimit(
        tx,
        context,
        approverId,
        paymentRefund,
        checkAt,
      ))
    )
      throw refundApprovalLimitRefused();

    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status: decided.status,
        decidedBy: approverId,
        decidedAt: decisionAt,
        reason,
        decisionFingerprint,
        decisionIdempotencyKey: key,
        updatedAt: decisionAt,
      })
      .where(
        and(
          eq(approvalRequests.id, row.id),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .returning();
    if (!updated) throw new IdentityError("APPROVAL_REQUEST_NOT_PENDING");
    const actor: EventActor = { type: "user", id: approverId };
    await appendApprovalEvent(tx, context, approvalDecidedEvent, {
      chainId: row.chainId,
      outletId: row.outletId,
      actor,
      now: decisionAt,
      destinations: [EVENT_DESTINATION],
      payload: {
        requestId: row.id,
        actionType: row.actionType,
        objectType: row.objectType,
        objectId: row.objectId,
        level: row.level,
        decision: input.decision,
        decidedBy: approverId,
      },
    });

    if (input.decision === "approved" && row.level < row.requiredLevels) {
      // Next level: same request snapshot, fresh deadline of the same length.
      const chainHead = rows[0] ?? row;
      const minutes = Math.max(
        MIN_DEADLINE_MINUTES,
        Math.round(
          (chainHead.deadlineAt.getTime() - chainHead.createdAt.getTime()) /
            60_000,
        ),
      );
      const [next] = await tx
        .insert(approvalRequests)
        .values({
          tenantId: row.tenantId,
          outletId: row.outletId,
          chainId: row.chainId,
          sourceModule: row.sourceModule,
          actionType: row.actionType,
          objectType: row.objectType,
          objectId: row.objectId,
          payload: row.payload,
          requestedBy: row.requestedBy,
          source: row.source,
          level: row.level + 1,
          requiredLevels: row.requiredLevels,
          requiredSteps: row.requiredSteps,
          thresholdIdr: row.thresholdIdr,
          amountIdr: row.amountIdr,
          status: "pending",
          requestReason: row.requestReason,
          deadlineAt: approvalDeadlineAt(checkAt, minutes),
          createdAt: checkAt,
          updatedAt: checkAt,
        })
        .returning();
      if (!next) throw new Error("next approval level insert returned no row");
      await appendApprovalEvent(tx, context, approvalRequestedEvent, {
        chainId: row.chainId,
        outletId: row.outletId,
        actor,
        now: checkAt,
        destinations: [EVENT_DESTINATION, NOTIFICATION_DESTINATION],
        payload: requestedPayload(next),
      });
    } else {
      await emitResolved(
        tx,
        context,
        updated,
        input.decision,
        actor,
        decisionAt,
      );
    }

    await recordAudit(
      {
        tenantId: tenant.tenantId,
        outletId: row.outletId,
        actorType: "user",
        actorId: approverId,
        deviceId: null,
        action: "approval.decided",
        objectType: "approval_request",
        objectId: row.id,
        reason,
        before: { status: "pending", level: row.level },
        after: {
          status: input.decision,
          level: row.level,
          requiredLevels: row.requiredLevels,
          actionType: row.actionType,
          ...(selfApproval ? { selfApproval } : {}),
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toDto(updated);
  });
}

// ------------------------------------------------------- deadline sweep

/**
 * Worker sweep (relay runtime, tenant-wide context): every pending level past
 * its deadline becomes `expired` and the chain ends with `approval.resolved`
 * (outcome `expired`) to the source module and the notification stream, which
 * alerts the requester and approvers so it can be re-submitted (§3 F7 "batas
 * waktu"; the action stays blocked — fail closed). PRD names no automatic
 * re-routing to another approver, so none is invented. Rows already locked by
 * a decision in flight are skipped and picked up by the next sweep.
 */
export async function expireDueApprovalRequests(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 100,
): Promise<number> {
  if (context.outletScope.kind !== "tenant")
    throw new Error("The approval deadline sweep requires tenant-wide scope");
  return withTenant(db, context, async (tx) => {
    const due = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.status, "pending"),
          lte(approvalRequests.deadlineAt, now),
        ),
      )
      .orderBy(asc(approvalRequests.deadlineAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return 0;
    const expired = await tx
      .update(approvalRequests)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          inArray(
            approvalRequests.id,
            due.map((row) => row.id),
          ),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .returning();
    for (const row of expired) await announceExpired(tx, context, row, now);
    return expired.length;
  });
}
