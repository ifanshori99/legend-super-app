// Support access (PRD v1.7 §3 F4 "Support Access", §6 A
// `support_access_grants`, TEN-04). A Super Admin opens a time-boxed session
// with a mandatory reason and a second factor; tenant personal/financial data
// is unreachable without one, every session is recorded, and the tenant admin
// can list the sessions that touched their tenant.
//
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka (default 60 menit) dengan alasan wajib, read-only secara
// default, tercatat di audit log, dan memicu notifikasi ke admin tenant."
//
// The grant row names the target tenant, so reads/writes run inside that
// tenant's transaction (RLS): a tenant can never see another tenant's grants,
// and the platform service sets the context explicitly because the target is a
// path parameter chosen by a platform-permissioned user (TEN-02 exception for
// platform routes, see platform/endpoints.ts).
//
// Every state change (granted, ended, expired, MFA-denied) writes its audit row
// with recordAudit inside the same tenant transaction (legend-bd95), and
// granted/ended/expired append `support_access.*` to the transactional outbox
// for the notification consumer, which tells the tenant admin (TEN-04).
//
// MFA: the route passes the instant the six-digit code in this request was
// verified (lib/mfa.ts). No verified factor → null → the request is refused.

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  assertCanOpenSupportAccess,
  assertSupportAccess as assertSupportAccessPolicy,
  PlatformError,
  platformEvents,
  SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS,
  supportAccessExpiry,
  supportAccessGrantSchema,
  supportAccessRequestSchema,
  type DataClass,
  type RequestSupportAccessInput,
  type RequestSupportWriteAccessInput,
  type SupportAccessGrant,
  type SupportAccessRequest,
  type SupportAccessRequestStatus,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import {
  domainEventOutbox,
  platformAdmins,
  roleAssignments,
  roles,
  session,
  supportAccessGrants,
  supportAccessRequests,
  tenants,
  user,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { getRequestContext } from "../lib/request-context.ts";
import {
  recordAudit,
  type AuditEntry,
  type AuditTransaction,
} from "./audit-writer.ts";
import { appendOutbox } from "./core-outbox.ts";

type GrantRow = typeof supportAccessGrants.$inferSelect;
type RequestRow = typeof supportAccessRequests.$inferSelect;
type Tx = AuditTransaction;
type Page = {
  data: SupportAccessGrant[];
  meta: { limit: number; nextCursor: string | null };
  /** API clock at read time (ISO), so the banner does not trust the device. */
  serverNow: string;
};
type EndCause = "expired" | "ended_by_super_admin" | "revoked_by_tenant_admin";

/** A write session is an explicit choice (accessMode defaults to read_only)
 * and is capped shorter than a read session. PRD §3 F4 is silent on the cap;
 * 30 minutes is the safest offered duration above 15 (DB check
 * support_access_write_duration_check enforces the same bound). */
export const SUPPORT_ACCESS_WRITE_MAX_MINUTES = 30;
/** The second factor must be verified for this request, not reused from an
 * older login (TEN-04 "MFA"): anything older than this is refused. */
export const SUPPORT_ACCESS_MFA_MAX_AGE_MS = 5 * 60_000;
/** The notification consumer turns support_access.* into the tenant-admin
 * alert (TEN-04 "memicu notifikasi ke admin tenant"). */
const NOTIFICATION_DESTINATION = "notification";
const AGGREGATE_TYPE = "support_access";
const OBJECT_TYPE = "support_access_grant";
const SWEEP_BATCH = 100;

function toGrant(row: GrantRow, actorName?: string | null): SupportAccessGrant {
  return supportAccessGrantSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    superAdminUserId: row.superAdminUserId,
    ...(actorName === undefined ? {} : { actorName }),
    reason: row.reason,
    accessMode: row.accessMode,
    durationMinutes: row.durationMinutes,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    mfaVerifiedAt: row.mfaVerifiedAt.toISOString(),
    tenantAdminNotifiedAt: row.tenantAdminNotifiedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    endedBy: row.endedBy,
  });
}

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

/** The Super Admin registry: an active platform_admins row, deny by default. */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(
      and(eq(platformAdmins.userId, userId), isNull(platformAdmins.revokedAt)),
    )
    .limit(1);
  return Boolean(row);
}

/** Tenant context for a platform route's path parameter. */
export function platformTenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

export async function assertTenantExists(tenantId: string): Promise<void> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
}

// ------------------------------------------------------- audit + outbox

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  entry: Omit<
    AuditEntry,
    "tenantId" | "outletId" | "deviceId" | "objectType"
  > & { objectType?: string },
): Promise<void> {
  await recordAudit(
    {
      ...entry,
      tenantId: context.tenant.tenantId,
      outletId: null,
      deviceId: null,
      objectType: entry.objectType ?? OBJECT_TYPE,
    },
    { tx, context },
  );
}

async function nextSequence(tx: Tx, tenantId: string, aggregateId: string) {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, NOTIFICATION_DESTINATION),
        eq(domainEventOutbox.aggregateType, AGGREGATE_TYPE),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Transactional outbox: the event commits with the grant change or not at
 * all. The aggregate is the grant, so granted (1) precedes ended (2). */
async function appendSupportEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name:
    | "support_access.granted"
    | "support_access.ended"
    | "support_access.requested",
  input: {
    /** The grant, or the request for support_access.requested. */
    aggregateId: string;
    actor: { type: "user"; id: string } | { type: "system" };
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const definition = platformEvents[name];
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    input.aggregateId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: input.actor,
    deviceId: null,
    idempotencyKey: `${name}:${input.aggregateId}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: NOTIFICATION_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Records a lapsed session exactly once: stamps expiry_recorded_at, writes
 * the system audit row and appends support_access.ended (cause "expired").
 * Access itself was already refused at read time once expires_at passed.
 */
async function recordExpiry(
  tx: Tx,
  context: ScopedTenantContext,
  row: GrantRow,
  now: Date,
): Promise<boolean> {
  const [updated] = await tx
    .update(supportAccessGrants)
    .set({ expiryRecordedAt: now })
    .where(
      and(
        eq(supportAccessGrants.id, row.id),
        eq(supportAccessGrants.tenantId, context.tenant.tenantId),
        isNull(supportAccessGrants.endedAt),
        isNull(supportAccessGrants.expiryRecordedAt),
        lte(supportAccessGrants.expiresAt, now),
      ),
    )
    .returning();
  if (!updated) return false;
  await audit(tx, context, {
    actorType: "system",
    actorId: null,
    action: "support_access.expired",
    objectId: updated.id,
    reason: "Sesi support access berakhir otomatis (batas waktu).",
    before: { status: "active" },
    after: {
      status: "expired",
      superAdminUserId: updated.superAdminUserId,
      expiresAt: updated.expiresAt.toISOString(),
    },
    sensitiveAccess: false,
  });
  await appendSupportEvent(tx, context, "support_access.ended", {
    aggregateId: updated.id,
    actor: { type: "system" },
    now,
    payload: {
      grantId: updated.id,
      endedAt: updated.expiresAt.toISOString(),
      cause: "expired" satisfies EndCause,
    },
  });
  return true;
}

// ------------------------------------------------------------ request

/**
 * The second factor must have been verified for this request (at most
 * SUPPORT_ACCESS_MFA_MAX_AGE_MS ago). A refused attempt is itself recorded for
 * the tenant (TEN-04 "setiap sesi tercatat") and nothing is opened.
 */
async function assertFreshMfa(input: {
  context: ScopedTenantContext;
  actorUserId: string;
  mfaVerifiedAt: string | null;
  reason: string;
  accessMode: "read_only" | "read_write";
  durationMinutes: number;
  now: Date;
}): Promise<number> {
  const mfaAt =
    input.mfaVerifiedAt === null ? Number.NaN : Date.parse(input.mfaVerifiedAt);
  const mfaFresh =
    Number.isFinite(mfaAt) &&
    mfaAt <= input.now.getTime() &&
    input.now.getTime() - mfaAt <= SUPPORT_ACCESS_MFA_MAX_AGE_MS;
  if (mfaFresh) return mfaAt;
  await withTenant(db, input.context, (tx) =>
    audit(tx, input.context, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "support_access.denied",
      objectId: null,
      reason: input.reason,
      before: null,
      after: {
        cause: "mfa_not_verified",
        accessMode: input.accessMode,
        durationMinutes: input.durationMinutes,
      },
      sensitiveAccess: false,
    }),
  );
  throw new HttpError(
    403,
    "FORBIDDEN",
    "Verifikasi MFA wajib sebelum membuka sesi support access.",
  );
}

/** Serialises every grant/request change of one Super Admin in one tenant. */
async function lockAdminTenant(
  tx: Tx,
  tenantId: string,
  superAdminUserId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`support_access:${tenantId}:${superAdminUserId}`}, 0))`,
  );
}

/**
 * Records this admin's lapsed open sessions in the tenant and returns the
 * still-live ones. Caller holds lockAdminTenant.
 */
async function liveOpenGrants(
  tx: Tx,
  context: ScopedTenantContext,
  superAdminUserId: string,
  now: Date,
): Promise<GrantRow[]> {
  const open = await tx
    .select()
    .from(supportAccessGrants)
    .where(
      and(
        eq(supportAccessGrants.tenantId, context.tenant.tenantId),
        eq(supportAccessGrants.superAdminUserId, superAdminUserId),
        isNull(supportAccessGrants.endedAt),
        isNull(supportAccessGrants.expiryRecordedAt),
      ),
    );
  // A lapsed session that the sweep has not reached yet is recorded now,
  // so its expiry is audited before the next session opens.
  for (const row of open)
    if (row.expiresAt.getTime() <= now.getTime())
      await recordExpiry(tx, context, row, now);
  return open.filter((row) => row.expiresAt.getTime() > now.getTime());
}

/**
 * Inserts the grant with its `support_access.granted` audit row and outbox
 * event (the tenant-admin notification), in the caller's tenant transaction.
 * The window starts now: for read_write that is the owner's approval
 * (legend-c9kbk, Q37).
 */
async function insertGrant(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    superAdminUserId: string;
    actorUserId: string;
    reason: string;
    accessMode: "read_only" | "read_write";
    durationMinutes: 15 | 30 | 60 | 120;
    mfaVerifiedAt: Date;
    now: Date;
    requestId?: string;
  },
): Promise<GrantRow> {
  const startedAt = input.now.toISOString();
  const [row] = await tx
    .insert(supportAccessGrants)
    .values({
      tenantId: context.tenant.tenantId,
      superAdminUserId: input.superAdminUserId,
      reason: input.reason,
      accessMode: input.accessMode,
      durationMinutes: input.durationMinutes,
      startedAt: new Date(startedAt),
      expiresAt: new Date(
        supportAccessExpiry(startedAt, input.durationMinutes),
      ),
      // mfaVerifiedAt <= startedAt is a table check; the verified instant
      // is never later than the session it authorizes.
      mfaVerifiedAt: input.mfaVerifiedAt,
      // Queued in this transaction (outbox below), so it is notified iff
      // the grant exists.
      tenantAdminNotifiedAt: new Date(startedAt),
      // A read_write grant must name the approved request it comes from
      // (support_access_grant_write_approved_check, migration 0160).
      approvalRequestId: input.requestId ?? null,
    })
    .returning();
  if (!row) throw new Error("support access insert returned no row");
  await audit(tx, context, {
    actorType: "user",
    actorId: input.actorUserId,
    action: "support_access.granted",
    objectId: row.id,
    reason: row.reason,
    before: null,
    after: {
      accessMode: row.accessMode,
      durationMinutes: row.durationMinutes,
      startedAt: row.startedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      superAdminUserId: row.superAdminUserId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
    sensitiveAccess: true,
  });
  await appendSupportEvent(tx, context, "support_access.granted", {
    aggregateId: row.id,
    actor: { type: "user", id: input.actorUserId },
    now: input.now,
    payload: {
      grantId: row.id,
      superAdminUserId: row.superAdminUserId,
      reason: row.reason,
      accessMode: row.accessMode,
      startedAt: row.startedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    },
  });
  return row;
}

/**
 * Opens a read_only session at once. A read_write session needs the tenant
 * owner's approval first (founder Q37, legend-c9kbk): it is requested with
 * requestSupportWriteAccess and only exists as a grant once approved, so it is
 * refused here without any row.
 */
export async function requestSupportAccess(input: {
  tenantId: string;
  actorUserId: string;
  request: RequestSupportAccessInput;
  /** When the second factor was verified; null = not verified (denied). */
  mfaVerifiedAt: string | null;
  now?: Date;
}): Promise<SupportAccessGrant> {
  const now = input.now ?? new Date();
  const { request } = input;
  if (
    request.accessMode === "read_write" &&
    request.durationMinutes > SUPPORT_ACCESS_WRITE_MAX_MINUTES
  )
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      `Sesi read_write paling lama ${SUPPORT_ACCESS_WRITE_MAX_MINUTES} menit.`,
    );
  if (request.accessMode === "read_write")
    throw new HttpError(
      409,
      "SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED",
      "Akses ubah data perlu persetujuan Owner tenant. Ajukan permintaan akses.",
    );
  if (!(await isPlatformAdmin(input.actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
  await assertTenantExists(input.tenantId);
  const context = platformTenantContext(input.tenantId);
  const mfaAt = await assertFreshMfa({
    context,
    actorUserId: input.actorUserId,
    mfaVerifiedAt: input.mfaVerifiedAt,
    reason: request.reason,
    accessMode: request.accessMode,
    durationMinutes: request.durationMinutes,
    now,
  });

  try {
    return await withTenant(db, context, async (tx) => {
      // Serialise concurrent requests by the same Super Admin for the same
      // tenant; the partial unique index is the backstop.
      await lockAdminTenant(tx, input.tenantId, input.actorUserId);
      const live = await liveOpenGrants(tx, context, input.actorUserId, now);
      assertCanOpenSupportAccess(
        live.map((row) => toGrant(row)),
        { tenantId: input.tenantId, superAdminUserId: input.actorUserId },
        now,
      );
      const row = await insertGrant(tx, context, {
        superAdminUserId: input.actorUserId,
        actorUserId: input.actorUserId,
        reason: request.reason,
        accessMode: request.accessMode,
        durationMinutes: request.durationMinutes,
        mfaVerifiedAt: new Date(mfaAt),
        now,
      });
      return toGrant(row);
    });
  } catch (error) {
    if (uniqueViolation(error))
      throw new PlatformError("SUPPORT_ACCESS_ALREADY_ACTIVE");
    throw error;
  }
}

// ------------------------------------- read_write owner approval (c9kbk)

/*
 * Founder Q37: a read_write session starts as a request the tenant owner
 * approves or rejects. While pending (or after rejection/expiry) no grant row
 * exists, so the guard, impersonation and the session cap see no grant at all
 * (fail closed by construction). Approval inserts an ordinary read_write grant
 * whose window starts at the approval. An unanswered request expires after
 * SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS. Every transition writes a tenant audit
 * row (TEN-04).
 */

const REQUEST_OBJECT_TYPE = "support_access_request";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_WINDOW_MS = SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS * 60 * 60_000;

function requestStatus(row: RequestRow, now: Date): SupportAccessRequestStatus {
  if (
    row.status === "pending" &&
    row.approvalExpiresAt.getTime() <= now.getTime()
  )
    return "expired";
  return row.status as SupportAccessRequestStatus;
}

function toRequest(
  row: RequestRow,
  now: Date,
  requesterName: string | null,
): SupportAccessRequest {
  const status = requestStatus(row, now);
  return supportAccessRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    superAdminUserId: row.superAdminUserId,
    requesterName,
    reason: row.reason,
    accessMode: row.accessMode,
    durationMinutes: row.durationMinutes,
    mfaVerifiedAt: row.mfaVerifiedAt.toISOString(),
    requestedAt: row.requestedAt.toISOString(),
    approvalExpiresAt: row.approvalExpiresAt.toISOString(),
    status,
    // A pending row past its window reads as expired at its deadline until
    // the sweep records it.
    decidedAt:
      row.decidedAt?.toISOString() ??
      (status === "expired" ? row.approvalExpiresAt.toISOString() : null),
    decidedBy: row.decidedBy,
    grantId: row.grantId,
    ownerNotifiedAt: row.ownerNotifiedAt?.toISOString() ?? null,
  });
}

async function requestDtos(
  rows: RequestRow[],
  now: Date,
): Promise<SupportAccessRequest[]> {
  if (rows.length === 0) return [];
  const people = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(
      inArray(user.id, [...new Set(rows.map((row) => row.superAdminUserId))]),
    );
  const names = new Map(people.map((person) => [person.id, person.name]));
  return rows.map((row) =>
    toRequest(row, now, names.get(row.superAdminUserId) ?? null),
  );
}

/** Records a lapsed pending request once (status expired + audit row). */
async function recordRequestExpiry(
  tx: Tx,
  context: ScopedTenantContext,
  row: RequestRow,
  now: Date,
): Promise<RequestRow | null> {
  const [updated] = await tx
    .update(supportAccessRequests)
    .set({ status: "expired", decidedAt: now })
    .where(
      and(
        eq(supportAccessRequests.id, row.id),
        eq(supportAccessRequests.tenantId, context.tenant.tenantId),
        eq(supportAccessRequests.status, "pending"),
        lte(supportAccessRequests.approvalExpiresAt, now),
      ),
    )
    .returning();
  if (!updated) return null;
  await audit(tx, context, {
    actorType: "system",
    actorId: null,
    action: "support_access.request_expired",
    objectType: REQUEST_OBJECT_TYPE,
    objectId: updated.id,
    reason: "Permintaan akses dukungan tidak dijawab dalam 24 jam.",
    before: { status: "pending" },
    after: {
      status: "expired",
      superAdminUserId: updated.superAdminUserId,
      approvalExpiresAt: updated.approvalExpiresAt.toISOString(),
    },
    sensitiveAccess: false,
  });
  return updated;
}

/**
 * A Super Admin asks the tenant owner for a read_write session (Q37). Same
 * Super Admin and fresh-MFA rules as requestSupportAccess; the MFA instant is
 * carried to the grant opened on approval.
 */
export async function requestSupportWriteAccess(input: {
  tenantId: string;
  actorUserId: string;
  request: RequestSupportWriteAccessInput;
  mfaVerifiedAt: string | null;
  now?: Date;
}): Promise<SupportAccessRequest> {
  const now = input.now ?? new Date();
  const { request } = input;
  if (request.durationMinutes > SUPPORT_ACCESS_WRITE_MAX_MINUTES)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      `Sesi read_write paling lama ${SUPPORT_ACCESS_WRITE_MAX_MINUTES} menit.`,
    );
  if (!(await isPlatformAdmin(input.actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
  await assertTenantExists(input.tenantId);
  const context = platformTenantContext(input.tenantId);
  const mfaAt = await assertFreshMfa({
    context,
    actorUserId: input.actorUserId,
    mfaVerifiedAt: input.mfaVerifiedAt,
    reason: request.reason,
    accessMode: "read_write",
    durationMinutes: request.durationMinutes,
    now,
  });

  const outcome = await (async () => {
    try {
      return await withTenant(db, context, async (tx) => {
        await lockAdminTenant(tx, input.tenantId, input.actorUserId);
        const pending = await tx
          .select()
          .from(supportAccessRequests)
          .where(
            and(
              eq(supportAccessRequests.tenantId, input.tenantId),
              eq(supportAccessRequests.superAdminUserId, input.actorUserId),
              eq(supportAccessRequests.status, "pending"),
            ),
          )
          .for("update");
        for (const row of pending)
          if (row.approvalExpiresAt.getTime() <= now.getTime())
            await recordRequestExpiry(tx, context, row, now);
        if (
          pending.some((row) => row.approvalExpiresAt.getTime() > now.getTime())
        )
          return { kind: "pending" } as const;
        const [row] = await tx
          .insert(supportAccessRequests)
          .values({
            tenantId: input.tenantId,
            superAdminUserId: input.actorUserId,
            reason: request.reason,
            accessMode: "read_write",
            durationMinutes: request.durationMinutes,
            mfaVerifiedAt: new Date(mfaAt),
            requestedAt: now,
            approvalExpiresAt: new Date(now.getTime() + APPROVAL_WINDOW_MS),
            // Queued below in this transaction: notified iff it exists.
            ownerNotifiedAt: now,
          })
          .returning();
        if (!row)
          throw new Error("support access request insert returned no row");
        await audit(tx, context, {
          actorType: "user",
          actorId: input.actorUserId,
          action: "support_access.requested",
          objectType: REQUEST_OBJECT_TYPE,
          objectId: row.id,
          reason: row.reason,
          before: null,
          after: {
            status: "pending",
            accessMode: row.accessMode,
            durationMinutes: row.durationMinutes,
            approvalExpiresAt: row.approvalExpiresAt.toISOString(),
          },
          sensitiveAccess: true,
        });
        await appendSupportEvent(tx, context, "support_access.requested", {
          aggregateId: row.id,
          actor: { type: "user", id: input.actorUserId },
          now,
          payload: {
            requestId: row.id,
            superAdminUserId: row.superAdminUserId,
            reason: row.reason,
            durationMinutes: row.durationMinutes,
            approvalExpiresAt: row.approvalExpiresAt.toISOString(),
          },
        });
        return { kind: "created", row } as const;
      });
    } catch (error) {
      if (uniqueViolation(error)) return { kind: "pending" } as const;
      throw error;
    }
  })();
  if (outcome.kind === "pending")
    throw new HttpError(
      409,
      "SUPPORT_ACCESS_REQUEST_PENDING",
      "Masih ada permintaan akses yang menunggu jawaban Owner.",
    );
  return (await requestDtos([outcome.row], now))[0]!;
}

/** Tenant owner view of the read_write requests for their tenant. */
export async function listSupportAccessRequests(
  context: ScopedTenantContext,
  actor: { userId: string },
  query: { limit: number; cursor?: string },
  now: Date = new Date(),
): Promise<{
  data: SupportAccessRequest[];
  meta: { limit: number; nextCursor: string | null };
}> {
  const rows = await withTenant(db, context, async (tx) => {
    // Same audience as the decision: reasons and Super Admin ids are shown
    // to the tenant's owners only.
    const owner = await activeOwnerAssignments(
      tx,
      context.tenant.tenantId,
      actor.userId,
      now,
    );
    if (owner.length === 0)
      throw new HttpError(
        403,
        "OWNER_REQUIRED",
        "Hanya Owner tenant yang dapat melihat permintaan akses dukungan.",
      );
    const filters = [
      eq(supportAccessRequests.tenantId, context.tenant.tenantId),
    ];
    if (query.cursor) {
      const [requestedAt, id] = decodeCursor(query.cursor);
      if (
        typeof requestedAt !== "string" ||
        typeof id !== "string" ||
        !UUID_PATTERN.test(id)
      )
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const at = new Date(requestedAt);
      if (Number.isNaN(at.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const cursorFilter = or(
        lt(supportAccessRequests.requestedAt, at),
        and(
          eq(supportAccessRequests.requestedAt, at),
          lt(supportAccessRequests.id, id),
        ),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    return tx
      .select()
      .from(supportAccessRequests)
      .where(and(...filters))
      .orderBy(
        desc(supportAccessRequests.requestedAt),
        desc(supportAccessRequests.id),
      )
      .limit(query.limit + 1);
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: await requestDtos(page, now),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.requestedAt.toISOString(), last.id])
          : null,
    },
  };
}

/** The caller's active tenant-scope assignments of the owner template here. */
async function activeOwnerAssignments(
  tx: Tx,
  tenantId: string,
  userId: string,
  now: Date,
): Promise<{ assignedAt: Date; assignedBy: string }[]> {
  return tx
    .select({
      assignedAt: roleAssignments.assignedAt,
      assignedBy: roleAssignments.assignedBy,
    })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.userId, userId),
        eq(roles.templateKey, "owner"),
        eq(roleAssignments.scopeType, "tenant"),
        lte(roleAssignments.validFrom, now),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
      ),
    );
}

/**
 * The owner standing must not come from the requester. A read_write session
 * can create users and role assignments, so an owner assignment made by the
 * requesting Super Admin, or made while they held a grant in this tenant
 * (possibly through impersonation), would let them approve their own later
 * requests from a second account. At least one of the approver's owner
 * assignments must predate (or follow) every such grant window.
 */
/**
 * legend-w1due: a support request that passed the guard just before its grant
 * ended can still commit an Owner assignment a moment after the end (the end
 * time is read before the assignment's own lock). Assignments within this
 * margin after a window closes still count as made during it.
 */
const SUPPORT_WINDOW_GRACE_MS = 5 * 60 * 1000;

async function hasIndependentOwnerStanding(
  tx: Tx,
  tenantId: string,
  superAdminUserId: string,
  assignments: { assignedAt: Date; assignedBy: string }[],
): Promise<boolean> {
  const windows = await tx
    .select({
      startedAt: supportAccessGrants.startedAt,
      endedAt: supportAccessGrants.endedAt,
      expiresAt: supportAccessGrants.expiresAt,
    })
    .from(supportAccessGrants)
    .where(
      and(
        eq(supportAccessGrants.tenantId, tenantId),
        eq(supportAccessGrants.superAdminUserId, superAdminUserId),
      ),
    );
  const requester = superAdminUserId.toLowerCase();
  return assignments.some((assignment) => {
    if (assignment.assignedBy.toLowerCase() === requester) return false;
    const at = assignment.assignedAt.getTime();
    return windows.every((window) => {
      const end =
        (window.endedAt ?? window.expiresAt).getTime() +
        SUPPORT_WINDOW_GRACE_MS;
      return at < window.startedAt.getTime() || at >= end;
    });
  });
}

type Decision = "approve" | "reject";

async function decideSupportAccessRequest(
  context: ScopedTenantContext,
  actor: { userId: string },
  requestId: string,
  decision: Decision,
  now: Date,
): Promise<SupportAccessRequest> {
  const tenantId = context.tenant.tenantId;
  const outcome = await (async () => {
    try {
      return await withTenant(db, context, async (tx) => {
        // Defence in depth behind the route's owner-only permission: the
        // decider holds the owner template in THIS tenant right now.
        const ownerAssignments = await activeOwnerAssignments(
          tx,
          tenantId,
          actor.userId,
          now,
        );
        if (ownerAssignments.length === 0)
          return { kind: "owner_required" } as const;
        const [peek] = await tx
          .select({ superAdminUserId: supportAccessRequests.superAdminUserId })
          .from(supportAccessRequests)
          .where(
            and(
              eq(supportAccessRequests.id, requestId),
              eq(supportAccessRequests.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!peek) return { kind: "not_found" } as const;
        // Same lock order as requestSupportAccess/requestSupportWriteAccess
        // (advisory lock, then rows), so these never deadlock.
        await lockAdminTenant(tx, tenantId, peek.superAdminUserId);
        const [current] = await tx
          .select()
          .from(supportAccessRequests)
          .where(
            and(
              eq(supportAccessRequests.id, requestId),
              eq(supportAccessRequests.tenantId, tenantId),
            ),
          )
          .for("update");
        if (!current) return { kind: "not_found" } as const;
        if (
          current.superAdminUserId.toLowerCase() === actor.userId.toLowerCase()
        )
          return { kind: "self" } as const;
        // Only approval opens access; any owner may still reject.
        if (
          decision === "approve" &&
          !(await hasIndependentOwnerStanding(
            tx,
            tenantId,
            current.superAdminUserId,
            ownerAssignments,
          ))
        )
          return { kind: "owner_from_support" } as const;
        if (current.status !== "pending")
          return { kind: "not_pending" } as const;
        if (current.approvalExpiresAt.getTime() <= now.getTime()) {
          // Committed (no throw inside the transaction) so the expiry is
          // audited even though the decision is refused.
          await recordRequestExpiry(tx, context, current, now);
          return { kind: "not_pending" } as const;
        }

        let grantId: string | null = null;
        if (decision === "approve") {
          // A request outlives its author's Super Admin standing: never open a
          // grant (or notify / audit one) for a revoked platform admin.
          if (!(await isPlatformAdmin(current.superAdminUserId)))
            return { kind: "requester_not_admin" } as const;
          const live = await liveOpenGrants(
            tx,
            context,
            current.superAdminUserId,
            now,
          );
          if (live.length > 0) return { kind: "already_open" } as const;
          const grant = await insertGrant(tx, context, {
            superAdminUserId: current.superAdminUserId,
            actorUserId: actor.userId,
            reason: current.reason,
            accessMode: "read_write",
            durationMinutes: current.durationMinutes as 15 | 30,
            mfaVerifiedAt: current.mfaVerifiedAt,
            now,
            requestId: current.id,
          });
          grantId = grant.id;
        }
        const status = decision === "approve" ? "approved" : "rejected";
        const [row] = await tx
          .update(supportAccessRequests)
          .set({ status, decidedAt: now, decidedBy: actor.userId, grantId })
          .where(
            and(
              eq(supportAccessRequests.id, current.id),
              eq(supportAccessRequests.tenantId, tenantId),
              eq(supportAccessRequests.status, "pending"),
            ),
          )
          .returning();
        if (!row) throw new Error("support access request decision lost");
        await audit(tx, context, {
          actorType: "user",
          actorId: actor.userId,
          action:
            decision === "approve"
              ? "support_access.approved"
              : "support_access.rejected",
          objectType: REQUEST_OBJECT_TYPE,
          objectId: row.id,
          reason: row.reason,
          before: { status: "pending" },
          after: {
            status,
            superAdminUserId: row.superAdminUserId,
            durationMinutes: row.durationMinutes,
            grantId,
          },
          sensitiveAccess: decision === "approve",
        });
        return { kind: "decided", row } as const;
      });
    } catch (error) {
      if (uniqueViolation(error)) return { kind: "already_open" } as const;
      throw error;
    }
  })();

  switch (outcome.kind) {
    case "decided":
      return (await requestDtos([outcome.row], now))[0]!;
    case "owner_required":
      throw new HttpError(
        403,
        "OWNER_REQUIRED",
        "Hanya Owner tenant yang dapat menjawab permintaan akses dukungan.",
      );
    case "not_found":
      throw new HttpError(
        404,
        "SUPPORT_ACCESS_REQUEST_NOT_FOUND",
        "Permintaan akses dukungan tidak ditemukan.",
      );
    case "self":
      throw new HttpError(
        403,
        "SUPPORT_SELF_APPROVAL",
        "Super Admin tidak dapat menjawab permintaannya sendiri.",
      );
    case "requester_not_admin":
      throw new HttpError(
        409,
        "SUPPORT_REQUESTER_NOT_ADMIN",
        "Akun yang meminta akses ini sudah bukan Super Admin.",
      );
    case "owner_from_support":
      throw new HttpError(
        403,
        "SUPPORT_APPROVER_NOT_INDEPENDENT",
        "Peran Owner akun ini dibuat oleh atau selama sesi dukungan Super Admin yang meminta, jadi tidak dapat menyetujui permintaannya.",
      );
    case "not_pending":
      throw new HttpError(
        409,
        "SUPPORT_ACCESS_REQUEST_NOT_PENDING",
        "Permintaan ini sudah dijawab atau sudah kedaluwarsa.",
      );
    case "already_open":
      throw new HttpError(
        409,
        "SUPPORT_ACCESS_ALREADY_OPEN",
        "Super Admin ini masih punya sesi dukungan aktif di tenant ini.",
      );
  }
}

/** The tenant owner approves: the read_write grant opens now (Q37/Q38). */
export function approveSupportAccessRequest(
  context: ScopedTenantContext,
  actor: { userId: string },
  requestId: string,
  now: Date = new Date(),
): Promise<SupportAccessRequest> {
  return decideSupportAccessRequest(context, actor, requestId, "approve", now);
}

/** The tenant owner rejects: no grant ever exists for this request. */
export function rejectSupportAccessRequest(
  context: ScopedTenantContext,
  actor: { userId: string },
  requestId: string,
  now: Date = new Date(),
): Promise<SupportAccessRequest> {
  return decideSupportAccessRequest(context, actor, requestId, "reject", now);
}

// --------------------------------------------------------------- list

async function listTenantPage(
  context: ScopedTenantContext,
  query: { limit: number; cursor?: string },
): Promise<{ rows: GrantRow[] }> {
  return withTenant(db, context, async (tx) => {
    const filters = [eq(supportAccessGrants.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const [startedAt, id] = decodeCursor(query.cursor);
      if (typeof startedAt !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const at = new Date(startedAt);
      if (Number.isNaN(at.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const cursorFilter = or(
        lt(supportAccessGrants.startedAt, at),
        and(
          eq(supportAccessGrants.startedAt, at),
          lt(supportAccessGrants.id, id),
        ),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select()
      .from(supportAccessGrants)
      .where(and(...filters))
      .orderBy(
        desc(supportAccessGrants.startedAt),
        desc(supportAccessGrants.id),
      )
      .limit(query.limit + 1);
    return { rows };
  });
}

/** Super Admin display names for a page of grants. A name that looks like an
 * email address is dropped: the list must never leak the email. */
async function actorNames(rows: GrantRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.superAdminUserId))];
  if (ids.length === 0) return new Map();
  const people = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, ids));
  return new Map(
    people.flatMap((person) => {
      const name = person.name.trim();
      return name === "" || name.includes("@") ? [] : [[person.id, name]];
    }),
  );
}

async function toPage(
  rows: GrantRow[],
  limit: number,
  now: Date = new Date(),
): Promise<Page> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const names = await actorNames(page);
  return {
    data: page.map((row) =>
      toGrant(row, names.get(row.superAdminUserId) ?? null),
    ),
    meta: {
      limit,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor([last.startedAt.toISOString(), last.id])
          : null,
    },
    serverNow: now.toISOString(),
  };
}

/** Tenant admin view of the sessions that touched their tenant (TEN-04). */
export async function listSupportAccess(
  context: ScopedTenantContext,
  query: { limit: number; cursor?: string },
): Promise<Page> {
  const { rows } = await listTenantPage(context, query);
  return toPage(rows, query.limit);
}

/**
 * Tenants that hold a grant matching the filter, from the SECURITY DEFINER
 * function app.support_access_grant_tenants (legend-ca4l). It names tenant ids
 * only; the grant rows themselves are still read per tenant under RLS.
 * `grantId`: the tenant of that grant. `adminUserId` + `at`: tenants where that
 * admin holds a grant live at `at`. No filter: every tenant with any grant.
 */
async function grantTenantIds(filter: {
  grantId?: string;
  adminUserId?: string;
  at?: Date;
}): Promise<string[]> {
  const result = await db.execute<{ tenant_id: string }>(
    sql`SELECT app.support_access_grant_tenants(
      ${filter.grantId ?? null}::uuid,
      ${filter.adminUserId ?? null}::text,
      ${filter.at?.toISOString() ?? null}::timestamptz
    ) AS tenant_id`,
  );
  return result.rows.map((row) => row.tenant_id);
}

/**
 * Platform view (GET /api/platform/support-access). Grants are tenant-owned
 * under RLS, so without a tenant filter each tenant that has a grant is read
 * in its own transaction (tenants without one are not opened) and the pages
 * are merged on the same (startedAt, id) order.
 */
export async function listPlatformSupportAccess(query: {
  limit: number;
  cursor?: string;
  tenantId?: string;
}): Promise<Page> {
  const tenantIds =
    query.tenantId === undefined ? await grantTenantIds({}) : [query.tenantId];
  const rows: GrantRow[] = [];
  for (const tenantId of tenantIds)
    rows.push(
      ...(await listTenantPage(platformTenantContext(tenantId), query)).rows,
    );
  rows.sort(
    (a, b) =>
      b.startedAt.getTime() - a.startedAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  return toPage(rows, query.limit);
}

// ---------------------------------------------------------------- end

async function findGrantTenant(grantId: string): Promise<string | null> {
  for (const tenantId of await grantTenantIds({ grantId })) {
    const found = await withTenant(
      db,
      platformTenantContext(tenantId),
      async (tx) =>
        (
          await tx
            .select({ id: supportAccessGrants.id })
            .from(supportAccessGrants)
            .where(
              and(
                eq(supportAccessGrants.tenantId, tenantId),
                eq(supportAccessGrants.id, grantId),
              ),
            )
            .limit(1)
        ).length > 0,
    );
    if (found) return tenantId;
  }
  return null;
}

/**
 * The platform end route and the tenant Owner's revoke routes share one core.
 * Ending an ended grant is idempotent; a lapsed grant records only its expiry.
 */
export async function endSupportAccess(input: {
  tenantId?: string;
  grantId: string;
  actorUserId: string;
  now?: Date;
}): Promise<SupportAccessGrant> {
  return endSupportAccessInternal(input);
}

export async function endTenantSupportAccess(
  context: ScopedTenantContext,
  actor: { userId: string },
  grantId: string,
): Promise<SupportAccessGrant> {
  return endSupportAccessInternal({
    tenantId: context.tenant.tenantId,
    grantId,
    actorUserId: actor.userId,
    ownerContext: context,
  });
}

async function endSupportAccessInternal(input: {
  tenantId?: string;
  grantId: string;
  actorUserId: string;
  now?: Date;
  ownerContext?: ScopedTenantContext;
}): Promise<SupportAccessGrant> {
  const now = input.now ?? new Date();
  const tenantId = input.tenantId ?? (await findGrantTenant(input.grantId));
  if (tenantId === null)
    throw new HttpError(404, "NOT_FOUND", "Support session not found.");
  const context = input.ownerContext ?? platformTenantContext(tenantId);
  const cause: EndCause = input.ownerContext
    ? "revoked_by_tenant_admin"
    : "ended_by_super_admin";
  const grant = await withTenant(db, context, async (tx) => {
    if (
      input.ownerContext &&
      (await activeOwnerAssignments(tx, tenantId, input.actorUserId, now))
        .length === 0
    )
      throw new HttpError(
        403,
        "OWNER_REQUIRED",
        "Hanya Owner tenant yang dapat mencabut akses dukungan.",
      );

    const [current] = await tx
      .select()
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.id, input.grantId),
          eq(supportAccessGrants.tenantId, tenantId),
        ),
      )
      .for("update");
    if (!current)
      throw new HttpError(404, "NOT_FOUND", "Support session not found.");
    if (current.endedAt !== null || current.expiryRecordedAt !== null)
      return toGrant(current);
    if (current.expiresAt.getTime() <= now.getTime()) {
      await recordExpiry(tx, context, current, now);
      return toGrant(current);
    }
    const [row] = await tx
      .update(supportAccessGrants)
      .set({ endedAt: now, endedBy: input.actorUserId })
      .where(
        and(
          eq(supportAccessGrants.id, current.id),
          eq(supportAccessGrants.tenantId, tenantId),
          isNull(supportAccessGrants.endedAt),
        ),
      )
      .returning();
    if (!row) return toGrant(current);
    await audit(tx, context, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "support_access.ended",
      objectId: row.id,
      reason:
        cause === "revoked_by_tenant_admin"
          ? "Sesi support access dicabut oleh admin tenant."
          : "Sesi support access diakhiri lebih awal.",
      before: { status: "active" },
      after: {
        status: "ended",
        superAdminUserId: row.superAdminUserId,
        endedAt: now.toISOString(),
        cause,
      },
      sensitiveAccess: false,
    });
    await appendSupportEvent(tx, context, "support_access.ended", {
      aggregateId: row.id,
      actor: { type: "user", id: input.actorUserId },
      now,
      payload: {
        grantId: row.id,
        endedAt: now.toISOString(),
        cause,
      },
    });
    return toGrant(row);
  });
  // legend-w1due: the support sessions this grant carried die with it, unless
  // another live grant of the same admin still covers their user.
  // The grant is already ended; a cleanup failure must not undo that answer,
  // and the per-request guard still refuses the session meanwhile.
  try {
    await endImpersonationSessionsWithoutGrant({
      adminUserId: grant.superAdminUserId,
      now,
    });
  } catch (error) {
    logger.error(
      { err: error, grantId: grant.id },
      "failed to end support sessions of an ended grant",
    );
  }
  return grant;
}

// -------------------------------------------------------------- sweep

/**
 * Worker sweep (relay tick, per active tenant): records every lapsed session
 * of this tenant once (audit + support_access.ended "expired") and every
 * unanswered read_write request past its approval window (audit
 * support_access.request_expired). Returns how many were recorded. Rows locked by a concurrent request/end are skipped and
 * picked up on the next tick.
 */
export async function expireDueSupportAccessGrants(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<number> {
  if (context.outletScope.kind !== "tenant")
    throw new Error("Support access sweep requires tenant scope");
  return withTenant(db, context, async (tx) => {
    const due = await tx
      .select()
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.tenantId, context.tenant.tenantId),
          isNull(supportAccessGrants.endedAt),
          isNull(supportAccessGrants.expiryRecordedAt),
          lte(supportAccessGrants.expiresAt, now),
        ),
      )
      .orderBy(asc(supportAccessGrants.expiresAt), asc(supportAccessGrants.id))
      .limit(SWEEP_BATCH)
      .for("update", { skipLocked: true });
    let recorded = 0;
    for (const row of due)
      if (await recordExpiry(tx, context, row, now)) recorded++;
    // Read_write requests the owner left unanswered past their window
    // (legend-c9kbk): status expired + support_access.request_expired audit.
    const dueRequests = await tx
      .select()
      .from(supportAccessRequests)
      .where(
        and(
          eq(supportAccessRequests.tenantId, context.tenant.tenantId),
          eq(supportAccessRequests.status, "pending"),
          lte(supportAccessRequests.approvalExpiresAt, now),
        ),
      )
      .orderBy(
        asc(supportAccessRequests.approvalExpiresAt),
        asc(supportAccessRequests.id),
      )
      .limit(SWEEP_BATCH)
      .for("update", { skipLocked: true });
    for (const row of dueRequests)
      if (await recordRequestExpiry(tx, context, row, now)) recorded++;
    return recorded;
  });
}

// -------------------------------------------------------------- guard

/**
 * TEN-04 gate every platform read of tenant personal/financial data must call
 * ("Super Admin tidak dapat membuka data pribadi atau keuangan tenant tanpa
 * support access aktif"). Returns the grant the access is attributed to (pass
 * it to supportAccessAuditFields for the caller's audit row) or null for data
 * classes that need no session. Throws SUPPORT_ACCESS_REQUIRED /
 * SUPPORT_ACCESS_READ_ONLY (mapped to 403 by the error handler).
 *
 * Expiry is decided here against the clock, so a lapsed grant stops working
 * the instant it expires even before the worker sweep records it. A grant
 * whose holder is no longer an active platform admin never counts. Pass `tx`
 * when the caller already runs inside this tenant's transaction.
 */
export async function assertSupportAccess(input: {
  tenantId: string;
  actorUserId: string;
  dataClass: DataClass;
  intent: "read" | "write";
  now?: Date;
  tx?: Tx;
}): Promise<SupportAccessGrant | null> {
  const now = input.now ?? new Date();
  const decide = async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.tenantId, input.tenantId),
          eq(supportAccessGrants.superAdminUserId, input.actorUserId),
          isNull(supportAccessGrants.endedAt),
          gt(supportAccessGrants.expiresAt, now),
        ),
      );
    return assertSupportAccessPolicy(
      rows.map((row) => toGrant(row)),
      {
        tenantId: input.tenantId,
        superAdminUserId: input.actorUserId,
        dataClass: input.dataClass,
        intent: input.intent,
        now,
      },
    );
  };
  const grant = input.tx
    ? await decide(input.tx)
    : await withTenant(db, platformTenantContext(input.tenantId), decide);
  if (grant !== null && !(await isPlatformAdmin(input.actorUserId)))
    throw new PlatformError("SUPPORT_ACCESS_REQUIRED");
  return grant;
}

/** @deprecated Same guard; kept for existing callers. Use assertSupportAccess. */
export const requireSupportAccess = assertSupportAccess;

// ------------------------------------------------- impersonation (rzirp)

/*
 * Starting a Better Auth impersonation needs a grant, not only the admin role
 * (TEN-04, legend-rzirp). The target must hold a role in a tenant where the
 * caller has an active grant; the session lasts at most 60 minutes; start and
 * end each write a sensitive audit row in every matched tenant.
 */

/** Hard cap of an impersonated session, whatever the grant length. */
export const IMPERSONATION_SESSION_MAX_SECONDS = 60 * 60;

export type ImpersonationRefusalCode =
  "SUPPORT_ACCESS_REQUIRED" | "IMPERSONATION_NOT_ALLOWED";

/** Refusal that lib/auth.ts maps to a Better Auth 403. */
export class ImpersonationRefused extends Error {
  readonly code: ImpersonationRefusalCode;
  constructor(code: ImpersonationRefusalCode, message: string) {
    super(message);
    this.name = "ImpersonationRefused";
    this.code = code;
  }
}

export type ImpersonationMatch = { tenantId: string; grant: GrantRow };

/**
 * Tenant ids an impersonating super admin may see of `targetUserId`'s
 * account-level data (own push devices and login sessions, which carry no
 * tenant context): tenants where the admin holds a live grant (not ended, not
 * expired) and the target has an active role assignment (same match as
 * findImpersonationGrants). No match returns an empty list, so the caller
 * shows nothing.
 */
export async function supportGrantedTenantIds(input: {
  adminUserId: string;
  targetUserId: string;
  now?: Date;
}): Promise<string[]> {
  const matches = await findImpersonationGrants({
    adminUserId: input.adminUserId,
    targetUserId: input.targetUserId,
    now: input.now ?? new Date(),
  });
  return matches.map((match) => match.tenantId);
}
export type ImpersonationEndCause =
  | "stopped"
  | "signed_out"
  | "expired"
  | "revoked"
  // legend-w1due: no live grant covers the session any more (ended, lapsed,
  // or the admin lost platform standing).
  | "grant_ended";

/**
 * Tenants where `adminUserId` holds a grant active at `at` (default `now`)
 * and `targetUserId` has a role assignment active at `at` (the end audit
 * passes the session start, so it finds the tenants the start row went to). One entry per
 * tenant, carrying the grant that expires last.
 */
export async function findImpersonationGrants(input: {
  adminUserId: string;
  targetUserId: string;
  now: Date;
  at?: Date;
  /** Only these tenants (default: the tenants where the admin holds a grant live at `at`). */
  tenantIds?: readonly string[];
}): Promise<ImpersonationMatch[]> {
  const at = input.at ?? input.now;
  const matches: ImpersonationMatch[] = [];
  const tenantIds =
    input.tenantIds ??
    (await grantTenantIds({ adminUserId: input.adminUserId, at }));
  for (const tenantId of tenantIds) {
    const match = await withTenant(
      db,
      platformTenantContext(tenantId),
      async (tx): Promise<ImpersonationMatch | null> => {
        const [grant] = await tx
          .select()
          .from(supportAccessGrants)
          .where(
            and(
              eq(supportAccessGrants.tenantId, tenantId),
              eq(supportAccessGrants.superAdminUserId, input.adminUserId),
              lte(supportAccessGrants.startedAt, at),
              gt(supportAccessGrants.expiresAt, at),
              or(
                isNull(supportAccessGrants.endedAt),
                gt(supportAccessGrants.endedAt, at),
              ),
            ),
          )
          .orderBy(desc(supportAccessGrants.expiresAt))
          .limit(1);
        if (!grant) return null;
        const [assignment] = await tx
          .select({ id: roleAssignments.id })
          .from(roleAssignments)
          .where(
            and(
              eq(roleAssignments.tenantId, tenantId),
              eq(roleAssignments.userId, input.targetUserId),
              lte(roleAssignments.validFrom, at),
              or(
                isNull(roleAssignments.validUntil),
                gt(roleAssignments.validUntil, at),
              ),
            ),
          )
          .limit(1);
        return assignment ? { tenantId, grant } : null;
      },
    );
    if (match) matches.push(match);
  }
  return matches;
}

/*
 * One POST /api/auth/admin/impersonate-user checks the same impersonation
 * three times (hooks.before, session.create.before, session.create.after;
 * legend-npkpz). Grants are tenant-owned under forced RLS, so they are read
 * one tenant transaction at a time, only for the tenants where the admin holds
 * a live grant (app.support_access_grant_tenants, legend-ca4l). The first
 * successful scan of a request remembers which tenants matched; the later
 * checks of that request scan again, fresh, but only those tenants. A grant
 * or role assignment that ends in between is therefore still seen, and a
 * tenant outside the first match could only add a match, never remove one.
 * The memo is keyed on the request's AsyncLocalStorage store, which dies with
 * the request. Outside an HTTP request (server-side auth.api.impersonateUser)
 * there is no store and every check looks the tenants up again.
 */
const requestScans = new WeakMap<object, Map<string, string[]>>();

async function scanImpersonationGrants(input: {
  adminUserId: string;
  targetUserId: string;
  now: Date;
}): Promise<ImpersonationMatch[]> {
  const store = getRequestContext();
  const key = `${input.adminUserId}\u0000${input.targetUserId}`;
  const tenantIds = store ? requestScans.get(store)?.get(key) : undefined;
  const matches = await findImpersonationGrants({ ...input, tenantIds });
  if (store && !tenantIds && matches.length > 0) {
    let scans = requestScans.get(store);
    if (!scans) requestScans.set(store, (scans = new Map()));
    scans.set(
      key,
      matches.map((match) => match.tenantId),
    );
  }
  return matches;
}

/**
 * When an impersonated session must end: the Better Auth expiry, but never
 * after IMPERSONATION_SESSION_MAX_SECONDS from `now`, nor after the last
 * matched grant ends (legend-npkpz). The support-session guard still refuses
 * each request once the grant of that request's tenant has ended.
 */
export function impersonationSessionEnd(input: {
  requested: Date;
  matches: ImpersonationMatch[];
  now: Date;
}): Date {
  const ends = [
    input.requested.getTime(),
    input.now.getTime() + IMPERSONATION_SESSION_MAX_SECONDS * 1000,
  ];
  if (input.matches.length > 0)
    ends.push(
      Math.max(...input.matches.map(({ grant }) => grant.expiresAt.getTime())),
    );
  return new Date(Math.min(...ends));
}

/** Throws ImpersonationRefused unless the impersonation is covered by a grant. */
export async function assertImpersonationAllowed(input: {
  adminUserId: string;
  targetUserId: string;
  now: Date;
}): Promise<ImpersonationMatch[]> {
  if (!(await isPlatformAdmin(input.adminUserId)))
    throw new ImpersonationRefused(
      "SUPPORT_ACCESS_REQUIRED",
      "Only a platform admin with an active support access can impersonate.",
    );
  if (
    input.targetUserId === input.adminUserId ||
    (await isPlatformAdmin(input.targetUserId))
  )
    throw new ImpersonationRefused(
      "IMPERSONATION_NOT_ALLOWED",
      "This user cannot be impersonated.",
    );
  const matches = await scanImpersonationGrants(input);
  if (matches.length === 0)
    throw new ImpersonationRefused(
      "SUPPORT_ACCESS_REQUIRED",
      "No active support access covers this user.",
    );
  return matches;
}

async function auditImpersonation(
  matches: ImpersonationMatch[],
  entry: (match: ImpersonationMatch) => {
    action: string;
    after: Record<string, unknown>;
  },
  adminUserId: string,
): Promise<void> {
  for (const match of matches) {
    const { action, after } = entry(match);
    const context = platformTenantContext(match.tenantId);
    await withTenant(db, context, (tx) =>
      audit(tx, context, {
        actorType: "user",
        actorId: adminUserId,
        action,
        objectId: match.grant.id,
        reason: match.grant.reason,
        before: null,
        after,
        sensitiveAccess: true,
      }),
    );
  }
}

export async function recordImpersonationStarted(input: {
  adminUserId: string;
  targetUserId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  matches: ImpersonationMatch[];
  now: Date;
}): Promise<void> {
  await auditImpersonation(
    input.matches,
    ({ grant }) => ({
      action: "support_access.impersonation_started",
      after: {
        impersonatedUserId: input.targetUserId,
        // Pairs start and end rows. Not named *session*: masking redacts it.
        impersonationId: input.sessionId,
        accessMode: grant.accessMode,
        // This tenant's access ends with its own grant, even when another
        // tenant's later grant keeps the session alive (legend-npkpz).
        impersonationEndsAt: new Date(
          Math.min(input.sessionExpiresAt.getTime(), grant.expiresAt.getTime()),
        ).toISOString(),
        grantExpiresAt: grant.expiresAt.toISOString(),
      },
    }),
    input.adminUserId,
  );
}

/**
 * legend-w1due: deletes every impersonated session of `adminUserId` (or only
 * `sessionId`) that no live grant covers any more, and audits each end as
 * "grant_ended". A session still covered by another live grant of the same
 * admin (another tenant the user belongs to) is kept; the per-request guard
 * keeps it out of the tenant whose grant ended. Without this a session
 * outlived its grant until its own expiry: readable through get-session and
 * the session list, and one guard away from acting in the tenant.
 * Returns the ids of the deleted sessions.
 */
export async function endImpersonationSessionsWithoutGrant(input: {
  adminUserId: string;
  sessionId?: string;
  now?: Date;
}): Promise<string[]> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      id: session.id,
      userId: session.userId,
      createdAt: session.createdAt,
    })
    .from(session)
    .where(
      and(
        eq(session.impersonatedBy, input.adminUserId),
        // An already expired row is dead anyway (Better Auth refuses it) and
        // must not be audited as grant_ended.
        gt(session.expiresAt, now),
        input.sessionId === undefined
          ? undefined
          : eq(session.id, input.sessionId),
      ),
    );
  if (rows.length === 0) return [];
  const standing = await isPlatformAdmin(input.adminUserId);
  const ended: string[] = [];
  for (const row of rows) {
    if (standing) {
      const live = await findImpersonationGrants({
        adminUserId: input.adminUserId,
        targetUserId: row.userId,
        now,
      });
      if (live.length > 0) continue;
    }
    // A direct delete skips Better Auth's delete hook. Among these cleanups
    // only the call that actually deleted the row audits it; a stop or
    // sign-out racing this delete may still write its own end row (Better
    // Auth runs delete.after even when its delete removed nothing).
    const deleted = await db
      .delete(session)
      .where(eq(session.id, row.id))
      .returning({ id: session.id });
    if (deleted.length === 0) continue;
    ended.push(row.id);
    try {
      await recordImpersonationEnded({
        adminUserId: input.adminUserId,
        targetUserId: row.userId,
        sessionId: row.id,
        sessionCreatedAt: row.createdAt,
        cause: "grant_ended",
        now,
      });
    } catch (error) {
      // Never keep a dead session alive over an audit failure; logged for
      // follow-up like the other impersonation end paths.
      logger.error(
        { err: error, sessionId: row.id },
        "failed to audit impersonation end",
      );
    }
  }
  return ended;
}

export async function recordImpersonationEnded(input: {
  adminUserId: string;
  targetUserId: string;
  sessionId: string;
  sessionCreatedAt: Date;
  cause: ImpersonationEndCause;
  now: Date;
}): Promise<void> {
  const matches = await findImpersonationGrants({
    adminUserId: input.adminUserId,
    targetUserId: input.targetUserId,
    now: input.now,
    at: input.sessionCreatedAt,
  });
  await auditImpersonation(
    matches,
    ({ grant }) => ({
      action: "support_access.impersonation_ended",
      after: {
        impersonatedUserId: input.targetUserId,
        // Pairs start and end rows. Not named *session*: masking redacts it.
        impersonationId: input.sessionId,
        accessMode: grant.accessMode,
        cause: input.cause,
        grantExpiresAt: grant.expiresAt.toISOString(),
      },
    }),
    input.adminUserId,
  );
}
