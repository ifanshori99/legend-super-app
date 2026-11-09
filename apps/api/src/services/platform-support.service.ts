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

import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  assertCanOpenSupportAccess,
  assertSupportAccess as assertSupportAccessPolicy,
  PlatformError,
  platformEvents,
  supportAccessExpiry,
  supportAccessGrantSchema,
  type DataClass,
  type RequestSupportAccessInput,
  type SupportAccessGrant,
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
  supportAccessGrants,
  tenants,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { getRequestContext } from "../lib/request-context.ts";
import {
  recordAudit,
  type AuditEntry,
  type AuditTransaction,
} from "./audit-writer.ts";
import { appendOutbox } from "./core-outbox.ts";

type GrantRow = typeof supportAccessGrants.$inferSelect;
type Tx = AuditTransaction;
type Page = {
  data: SupportAccessGrant[];
  meta: { limit: number; nextCursor: string | null };
};
type EndCause = "expired" | "ended_by_super_admin";

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

function toGrant(row: GrantRow): SupportAccessGrant {
  return supportAccessGrantSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    superAdminUserId: row.superAdminUserId,
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
function platformTenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function assertTenantExists(tenantId: string): Promise<void> {
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
  entry: Omit<AuditEntry, "tenantId" | "outletId" | "deviceId" | "objectType">,
): Promise<void> {
  await recordAudit(
    {
      ...entry,
      tenantId: context.tenant.tenantId,
      outletId: null,
      deviceId: null,
      objectType: OBJECT_TYPE,
    },
    { tx, context },
  );
}

async function nextSequence(tx: Tx, tenantId: string, grantId: string) {
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
        eq(domainEventOutbox.aggregateId, grantId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Transactional outbox: the event commits with the grant change or not at
 * all. The aggregate is the grant, so granted (1) precedes ended (2). */
async function appendSupportEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: "support_access.granted" | "support_access.ended",
  input: {
    grantId: string;
    actor: { type: "user"; id: string } | { type: "system" };
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const definition = platformEvents[name];
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    input.grantId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.grantId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: input.actor,
    deviceId: null,
    idempotencyKey: `${name}:${input.grantId}`,
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
    grantId: updated.id,
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
  if (!(await isPlatformAdmin(input.actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
  await assertTenantExists(input.tenantId);
  const context = platformTenantContext(input.tenantId);

  const mfaAt =
    input.mfaVerifiedAt === null ? Number.NaN : Date.parse(input.mfaVerifiedAt);
  const mfaFresh =
    Number.isFinite(mfaAt) &&
    mfaAt <= now.getTime() &&
    now.getTime() - mfaAt <= SUPPORT_ACCESS_MFA_MAX_AGE_MS;
  if (!mfaFresh) {
    // The refused attempt is itself recorded for the tenant (TEN-04 "setiap
    // sesi tercatat"); nothing is opened.
    await withTenant(db, context, (tx) =>
      audit(tx, context, {
        actorType: "user",
        actorId: input.actorUserId,
        action: "support_access.denied",
        objectId: null,
        reason: request.reason,
        before: null,
        after: {
          cause: "mfa_not_verified",
          accessMode: request.accessMode,
          durationMinutes: request.durationMinutes,
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

  const startedAt = now.toISOString();
  try {
    return await withTenant(db, context, async (tx) => {
      // Serialise concurrent requests by the same Super Admin for the same
      // tenant; the partial unique index is the backstop.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`support_access:${input.tenantId}:${input.actorUserId}`}, 0))`,
      );
      const open = await tx
        .select()
        .from(supportAccessGrants)
        .where(
          and(
            eq(supportAccessGrants.tenantId, input.tenantId),
            eq(supportAccessGrants.superAdminUserId, input.actorUserId),
            isNull(supportAccessGrants.endedAt),
            isNull(supportAccessGrants.expiryRecordedAt),
          ),
        );
      // A lapsed session that the sweep has not reached yet is recorded now,
      // so its expiry is audited before the next session opens.
      for (const row of open)
        if (row.expiresAt.getTime() <= now.getTime())
          await recordExpiry(tx, context, row, now);
      assertCanOpenSupportAccess(
        open
          .filter((row) => row.expiresAt.getTime() > now.getTime())
          .map(toGrant),
        { tenantId: input.tenantId, superAdminUserId: input.actorUserId },
        now,
      );
      const [row] = await tx
        .insert(supportAccessGrants)
        .values({
          tenantId: input.tenantId,
          superAdminUserId: input.actorUserId,
          reason: request.reason,
          accessMode: request.accessMode,
          durationMinutes: request.durationMinutes,
          startedAt: new Date(startedAt),
          expiresAt: new Date(
            supportAccessExpiry(startedAt, request.durationMinutes),
          ),
          // mfaVerifiedAt <= startedAt is a table check; the verified instant
          // is never later than the session it authorizes.
          mfaVerifiedAt: new Date(mfaAt),
          // Queued in this transaction (outbox below), so it is notified iff
          // the grant exists.
          tenantAdminNotifiedAt: new Date(startedAt),
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
        },
        sensitiveAccess: true,
      });
      await appendSupportEvent(tx, context, "support_access.granted", {
        grantId: row.id,
        actor: { type: "user", id: input.actorUserId },
        now,
        payload: {
          grantId: row.id,
          superAdminUserId: row.superAdminUserId,
          reason: row.reason,
          accessMode: row.accessMode,
          startedAt: row.startedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        },
      });
      return toGrant(row);
    });
  } catch (error) {
    if (uniqueViolation(error))
      throw new PlatformError("SUPPORT_ACCESS_ALREADY_ACTIVE");
    throw error;
  }
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

function toPage(rows: GrantRow[], limit: number): Page {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(toGrant),
    meta: {
      limit,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor([last.startedAt.toISOString(), last.id])
          : null,
    },
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

async function allTenantIds(): Promise<string[]> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.id));
  return rows.map((row) => row.id);
}

/**
 * Platform view (GET /api/platform/support-access). Grants are tenant-owned
 * under RLS, so without a tenant filter each tenant is read in its own
 * transaction and the pages are merged on the same (startedAt, id) order.
 */
export async function listPlatformSupportAccess(query: {
  limit: number;
  cursor?: string;
  tenantId?: string;
}): Promise<Page> {
  const tenantIds =
    query.tenantId === undefined ? await allTenantIds() : [query.tenantId];
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
  for (const tenantId of await allTenantIds()) {
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
 * Ends a session early; an ended session is history and stays readable.
 * Idempotent: ending an ended session returns it unchanged, and ending a
 * lapsed one records its expiry instead (no second audit row or event).
 * The tenant is optional (the platform contract carries only the grant id).
 */
export async function endSupportAccess(input: {
  tenantId?: string;
  grantId: string;
  actorUserId: string;
  now?: Date;
}): Promise<SupportAccessGrant> {
  const now = input.now ?? new Date();
  const tenantId = input.tenantId ?? (await findGrantTenant(input.grantId));
  if (tenantId === null)
    throw new HttpError(404, "NOT_FOUND", "Support session not found.");
  const context = platformTenantContext(tenantId);
  return withTenant(db, context, async (tx) => {
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
      reason: "Sesi support access diakhiri lebih awal.",
      before: { status: "active" },
      after: {
        status: "ended",
        superAdminUserId: row.superAdminUserId,
        endedAt: now.toISOString(),
      },
      sensitiveAccess: false,
    });
    await appendSupportEvent(tx, context, "support_access.ended", {
      grantId: row.id,
      actor: { type: "user", id: input.actorUserId },
      now,
      payload: {
        grantId: row.id,
        endedAt: now.toISOString(),
        cause: "ended_by_super_admin" satisfies EndCause,
      },
    });
    return toGrant(row);
  });
}

// -------------------------------------------------------------- sweep

/**
 * Worker sweep (relay tick, per active tenant): records every lapsed session
 * of this tenant once (audit + support_access.ended "expired"). Returns how
 * many were recorded. Rows locked by a concurrent request/end are skipped and
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
    return assertSupportAccessPolicy(rows.map(toGrant), {
      tenantId: input.tenantId,
      superAdminUserId: input.actorUserId,
      dataClass: input.dataClass,
      intent: input.intent,
      now,
    });
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
export type ImpersonationEndCause =
  "stopped" | "signed_out" | "expired" | "revoked";

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
  /** Only these tenants (default: every tenant). */
  tenantIds?: readonly string[];
}): Promise<ImpersonationMatch[]> {
  const at = input.at ?? input.now;
  const matches: ImpersonationMatch[] = [];
  for (const tenantId of input.tenantIds ?? (await allTenantIds())) {
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
 * legend-npkpz). Grants are tenant-owned under forced RLS, so only a scan of
 * every tenant (one tenant transaction each) can find them. The first
 * successful scan of a request remembers which tenants matched; the later
 * checks of that request scan again, fresh, but only those tenants. A grant
 * or role assignment that ends in between is therefore still seen, and a
 * tenant outside the first match could only add a match, never remove one.
 * The memo is keyed on the request's AsyncLocalStorage store, which dies with
 * the request. Outside an HTTP request (server-side auth.api.impersonateUser)
 * there is no store and every check scans every tenant.
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
