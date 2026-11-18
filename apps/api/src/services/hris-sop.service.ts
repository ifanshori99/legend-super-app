// HRIS SOP library: versioned documents and read acknowledgements (PRD v1.7
// §3 F32 "SOP, Pelatihan & Pengumuman"; bead legend-7df1). Routes:
// routes/hris-sop.routes.ts. Tables: db/schema/hris-sop.ts.
//
// - Every version is its own immutable row. Publishing inserts version + 1
//   with `supersedes_id` set; nothing is updated. Two concurrent publishes of
//   the same version collide on the (tenant, supersedes_id) unique index and
//   the loser answers 409 SOP_VERSION_STALE.
// - The library is tenant master data, so outlet reach is enforced here:
//   a station-bound SOP belongs to the station's outlet, a SOP without
//   station belongs to the whole tenant (managing it needs tenant reach).
// - Managers (`hr.sop.manage`) see documents of their outlets; employees
//   (`self.sop.read` + own employee row) see documents of their home outlet
//   and position. Everything else answers 404 (a foreign row looks missing).
// - An acknowledgement is bound to the exact version on screen; an
//   acknowledgement of v1 never counts for v2.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import {
  createUlid,
  encodeCursor,
  localDateOf,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  sopAcknowledgementSchema,
  sopDocumentSchema,
  sopAcknowledgementStatusSchema,
  type CreateSopDocumentInput,
  type PublishSopVersionInput,
  type SopAcknowledgement,
  type SopAcknowledgementStatus,
  type SopDocument,
} from "@starter/shared/hris";
import type { PermissionCode } from "@starter/shared/access";
import { db } from "../db/index.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { employees, positions } from "../db/schema/hris.ts";
import { sopAcknowledgements, sopDocuments } from "../db/schema/hris-sop.ts";
import { stations } from "../db/schema/menu.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  cursorPair,
  forbidden,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type HrisReach,
  type Tx,
} from "./hris-access.ts";

export const SOP_MANAGE_CODE: PermissionCode = "hr.sop.manage";
export const SOP_SELF_CODE: PermissionCode = "self.sop.read";

const MANAGE: readonly PermissionCode[] = [SOP_MANAGE_CODE];
const STALE = "SOP_VERSION_STALE";

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type Cursor = { cursor?: string | undefined; limit: number };
type DocumentRow = typeof sopDocuments.$inferSelect;

const toDocument = (row: DocumentRow): SopDocument =>
  sopDocumentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    stationId: row.stationId,
    positionId: row.positionId,
    title: row.title,
    version: row.version,
    body: row.body,
    mediaIds: row.mediaIds,
    requiresAcknowledgement: row.requiresAcknowledgement,
    effectiveFrom: row.effectiveFrom,
    publishedAt: row.publishedAt.toISOString(),
    supersedesId: row.supersedesId,
  });

const toAcknowledgement = (
  row: typeof sopAcknowledgements.$inferSelect,
): SopAcknowledgement =>
  sopAcknowledgementSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sopDocumentId: row.sopDocumentId,
    employeeId: row.employeeId,
    documentVersion: row.documentVersion,
    acknowledgedAt: row.acknowledgedAt.toISOString(),
  });

function outOfScope(): HttpError {
  return new HttpError(
    403,
    "OUTLET_OUT_OF_SCOPE",
    "Outlet di luar jangkauan akun Anda.",
  );
}

const staleVersion = () =>
  new HttpError(
    409,
    STALE,
    "Versi SOP sudah diganti. Muat ulang untuk melihat versi terbaru.",
  );

const cursorId = z.uuid();

/** Cursor of (text, uuid); a malformed id is a 422, never a Postgres 500. */
function sopCursorPair(cursor: string): [string, string] {
  const [first, id] = cursorPair(cursor);
  if (!cursorId.safeParse(id).success)
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return [first, id];
}

const outletList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** Station of the document sits in one of `ids` (RLS hides other outlets). */
const stationInOutlets = (ids: readonly string[]) =>
  sql`exists (select 1 from stations st
    where st.tenant_id = sop_documents.tenant_id
      and st.id = sop_documents.station_id
      and st.outlet_id in (${outletList(ids)}))`;

/** No newer version exists: the row is the head of its lineage. */
const isLatest = sql`not exists (select 1 from sop_documents next
  where next.tenant_id = sop_documents.tenant_id
    and next.supersedes_id = sop_documents.id)`;

/**
 * Latest version that already applies on `today` (WIB): effective by then and
 * not followed by a version that is also effective. Employees read and
 * confirm this one; a future-dated version waits for its date.
 */
const isEffectiveLatest = (today: string) =>
  sql`(sop_documents.effective_from <= ${today}::date
    and not exists (select 1 from sop_documents next
      where next.tenant_id = sop_documents.tenant_id
        and next.supersedes_id = sop_documents.id
        and next.effective_from <= ${today}::date))`;

function page<Row, T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  keys: (row: Row) => [string, string],
): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data: data.map(map),
    meta: {
      limit,
      nextCursor: rows.length > limit && last ? encodeCursor(keys(last)) : null,
    },
  };
}

type Viewer = {
  readonly access: HrisAccess;
  readonly manage: HrisReach | null;
  /** The caller's own employee row when they may read SOPs as an employee. */
  readonly self: {
    readonly id: string;
    readonly homeOutletId: string;
    readonly positionId: string | null;
  } | null;
};

async function loadViewer(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  now: Date,
): Promise<Viewer> {
  const access = await loadHrisAccess(tx, context, actorUserId, now);
  const manage = access.reach(MANAGE);
  let self: Viewer["self"] = null;
  if (
    access.own &&
    access.snapshot.allows(SOP_SELF_CODE, {
      type: "outlet",
      id: access.own.homeOutletId,
    })
  ) {
    const [row] = await tx
      .select({ positionId: employees.positionId })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.id, access.own.id),
          // Only working employees read and confirm SOPs (same rule as the
          // training and announcement self paths).
          inArray(employees.status, ["active", "onboarding"]),
        ),
      )
      .limit(1);
    if (row)
      self = {
        id: access.own.id,
        homeOutletId: access.own.homeOutletId,
        positionId: row.positionId ?? null,
      };
  }
  // Holding the employee code without an employee row is a 404 for the caller's
  // own data (nothing visible), not a permission failure.
  if (!manage && !self && !access.snapshot.permissions.includes(SOP_SELF_CODE))
    throw forbidden();
  return { access, manage, self };
}

/** SQL for "this caller may see the document", or null for nothing. */
function visibleTo(viewer: Viewer): SQL {
  const parts: SQL[] = [];
  const { manage, self } = viewer;
  if (manage?.kind === "tenant") return sql`true`;
  if (manage)
    parts.push(
      sql`(sop_documents.station_id is null or ${stationInOutlets(manage.outletIds)})`,
    );
  if (self) {
    const position = self.positionId
      ? sql`(sop_documents.position_id is null or sop_documents.position_id = ${self.positionId}::uuid)`
      : sql`sop_documents.position_id is null`;
    parts.push(
      sql`((sop_documents.station_id is null or ${stationInOutlets([self.homeOutletId])}) and ${position})`,
    );
  }
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` or `)})`;
}

async function stationOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  stationId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ outletId: stations.outletId })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, context.tenant.tenantId),
        eq(stations.id, stationId),
      ),
    )
    .limit(1);
  return row?.outletId.toLowerCase() ?? null;
}

/**
 * The caller must manage the scope a document sits in: the station's outlet,
 * or the whole tenant for a station-less document. Returns the outlet to file
 * the audit row under (null = tenant-wide).
 */
async function assertCanManageScope(
  tx: Tx,
  context: ScopedTenantContext,
  manage: HrisReach | null,
  stationId: string | null,
): Promise<string | null> {
  if (!manage) throw forbidden();
  if (stationId === null) {
    if (manage.kind !== "tenant") throw outOfScope();
    return null;
  }
  const outletId = await stationOutlet(tx, context, stationId);
  // An outlet-scoped caller cannot see stations of other outlets at all (RLS):
  // a missing row is out of scope for them, a missing station for a tenant-wide
  // caller is plain 404.
  if (outletId === null) {
    if (manage.kind === "tenant") throw notFound("Stasiun");
    throw outOfScope();
  }
  if (manage.kind === "outlets" && !manage.outletIds.includes(outletId))
    throw outOfScope();
  return outletId;
}

async function assertPositionExists(
  tx: Tx,
  context: ScopedTenantContext,
  positionId: string | null,
): Promise<void> {
  if (positionId === null) return;
  const [row] = await tx
    .select({ id: positions.id })
    .from(positions)
    .where(
      and(
        eq(positions.tenantId, context.tenant.tenantId),
        eq(positions.id, positionId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Jabatan");
}

async function assertMediaExist(
  tx: Tx,
  context: ScopedTenantContext,
  mediaIds: readonly string[],
  actorUserId: string,
  scopeOutletId: string | null,
  /** Media the previous version already carried (publishing a new version). */
  carriedMediaIds: readonly string[] = [],
): Promise<void> {
  const wanted = [...new Set(mediaIds.map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return;
  const carried = new Set(carriedMediaIds.map((id) => id.toLowerCase()));
  const kept = wanted.filter((id) => carried.has(id));
  const fresh = wanted.filter((id) => !carried.has(id));
  // Strict allowlist: only unclassified document objects. HR files carry a
  // source kind; brand_logo, receipt and selfie purposes are refused.
  const allowlisted = and(
    eq(coreStorageObjects.purpose, "document"),
    isNull(coreStorageObjects.sourceKind),
  );
  const candidates = [
    // Media the previous version already had stays valid for any publisher.
    kept.length === 0
      ? undefined
      : and(inArray(coreStorageObjects.id, kept), allowlisted),
    // New media must be the actor's own, unattached, and (for an outlet SOP)
    // of the SOP's outlet; a tenant-wide SOP has no outlet condition.
    fresh.length === 0
      ? undefined
      : and(
          inArray(coreStorageObjects.id, fresh),
          allowlisted,
          eq(coreStorageObjects.ownerUserId, actorUserId),
          isNull(coreStorageObjects.sourceId),
          scopeOutletId === null
            ? undefined
            : eq(coreStorageObjects.outletId, scopeOutletId),
        ),
  ].filter((condition) => condition !== undefined);
  const rows = await tx
    .select({ id: coreStorageObjects.id })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, context.tenant.tenantId),
        or(...candidates),
      ),
    )
    .orderBy(coreStorageObjects.id)
    .for("update");
  if (rows.length !== wanted.length)
    throw new HttpError(
      422,
      "SOP_MEDIA_NOT_FOUND",
      "Media SOP tidak ditemukan.",
    );
}

async function auditPublished(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: DocumentRow,
  outletId: string | null,
) {
  const scope = context.outletScope;
  const filedUnder =
    outletId ?? (scope.kind === "tenant" ? null : (scope.outletIds[0] ?? null));
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: filedUnder,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "hris.sop_document.published",
      objectType: "sop_document",
      objectId: row.id,
      reason: null,
      maskedChanges: { before: null, after: { version: row.version } },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    [...HRIS_AUDIT_SAFE_FIELDS, "version"],
  );
}

async function loadVisibleDocument(
  tx: Tx,
  context: ScopedTenantContext,
  viewer: Viewer,
  sopDocumentId: string,
): Promise<DocumentRow> {
  const [row] = await tx
    .select()
    .from(sopDocuments)
    .where(
      and(
        eq(sopDocuments.tenantId, context.tenant.tenantId),
        eq(sopDocuments.id, sopDocumentId),
        visibleTo(viewer),
      ),
    )
    .limit(1);
  if (!row) throw notFound("SOP");
  return row;
}

async function latestVersion(
  tx: Tx,
  context: ScopedTenantContext,
  lineageId: string,
  /** Only versions effective on this date (WIB); omitted = every version. */
  effectiveOn?: string,
): Promise<number> {
  const [row] = await tx
    .select({
      version: sql<number>`max(${sopDocuments.version})::int`,
    })
    .from(sopDocuments)
    .where(
      and(
        eq(sopDocuments.tenantId, context.tenant.tenantId),
        eq(sopDocuments.lineageId, lineageId),
        effectiveOn
          ? sql`${sopDocuments.effectiveFrom} <= ${effectiveOn}::date`
          : undefined,
      ),
    );
  return row?.version ?? 0;
}

export async function createSopDocument(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateSopDocumentInput,
  now = new Date(),
): Promise<SopDocument> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const outletId = await assertCanManageScope(
      tx,
      context,
      access.reach(MANAGE),
      input.stationId,
    );
    await assertPositionExists(tx, context, input.positionId);
    await assertMediaExist(
      tx,
      context,
      input.mediaIds,
      access.actorUserId,
      outletId,
    );
    const id = randomUUID();
    const [row] = await tx
      .insert(sopDocuments)
      .values({
        id,
        tenantId: context.tenant.tenantId,
        lineageId: id,
        version: 1,
        supersedesId: null,
        stationId: input.stationId,
        positionId: input.positionId,
        title: input.title,
        body: input.body,
        mediaIds: input.mediaIds.map((media) => media.toLowerCase()),
        requiresAcknowledgement: input.requiresAcknowledgement,
        effectiveFrom: input.effectiveFrom,
        publishedBy: access.actorUserId,
        publishedAt: now,
      })
      .returning();
    if (!row) throw new Error("SOP document insert returned no row");
    await auditPublished(tx, context, access.actorUserId, now, row, outletId);
    return toDocument(row);
  });
}

export async function publishSopVersion(
  context: ScopedTenantContext,
  actorUserId: string,
  sopDocumentId: string,
  input: PublishSopVersionInput,
  now = new Date(),
): Promise<SopDocument> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const manage = access.reach(MANAGE);
    if (!manage) throw forbidden();
    const [previous] = await tx
      .select()
      .from(sopDocuments)
      .where(
        and(
          eq(sopDocuments.tenantId, context.tenant.tenantId),
          eq(sopDocuments.id, sopDocumentId),
        ),
      )
      .limit(1);
    if (!previous) throw notFound("SOP");
    // Station and position are inherited, so the scope is the old version's.
    const outletId = await assertCanManageScope(
      tx,
      context,
      manage,
      previous.stationId,
    );
    const head = await latestVersion(tx, context, previous.lineageId);
    if (previous.version !== head) throw staleVersion();
    if (input.effectiveFrom < previous.effectiveFrom)
      throw new HttpError(
        422,
        "SOP_EFFECTIVE_DATE_INVALID",
        "Tanggal berlaku tidak boleh lebih awal dari versi sebelumnya.",
      );
    await assertMediaExist(
      tx,
      context,
      input.mediaIds,
      access.actorUserId,
      outletId,
      previous.mediaIds,
    );
    const [row] = await tx
      .insert(sopDocuments)
      .values({
        tenantId: context.tenant.tenantId,
        lineageId: previous.lineageId,
        version: previous.version + 1,
        supersedesId: previous.id,
        stationId: previous.stationId,
        positionId: previous.positionId,
        title: input.title,
        body: input.body,
        mediaIds: input.mediaIds.map((media) => media.toLowerCase()),
        requiresAcknowledgement: input.requiresAcknowledgement,
        effectiveFrom: input.effectiveFrom,
        publishedBy: access.actorUserId,
        publishedAt: now,
      })
      .returning()
      .catch((error: unknown) => {
        // A concurrent publish already took the successor slot.
        if (uniqueViolation(error)) throw staleVersion();
        throw error;
      });
    if (!row) throw new Error("SOP version insert returned no row");
    await auditPublished(tx, context, access.actorUserId, now, row, outletId);
    return toDocument(row);
  });
}

type ListQuery = Cursor & {
  stationId?: string | undefined;
  positionId?: string | undefined;
};

/** Latest version of every SOP the caller may see. */
export async function listSopDocuments(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
  now = new Date(),
): Promise<Page<SopDocument>> {
  return withTenant(db, context, async (tx) => {
    const viewer = await loadViewer(tx, context, actorUserId, now);
    const filters: SQL[] = [
      eq(sopDocuments.tenantId, context.tenant.tenantId),
      // A manager sees the true head (incl. a future version); an employee
      // only the version already in force.
      viewer.manage ? isLatest : isEffectiveLatest(localDateOf(now)),
      visibleTo(viewer),
    ];
    if (query.stationId)
      filters.push(eq(sopDocuments.stationId, query.stationId));
    if (query.positionId)
      filters.push(eq(sopDocuments.positionId, query.positionId));
    if (query.cursor) {
      const [title, id] = sopCursorPair(query.cursor);
      filters.push(
        or(
          gt(sopDocuments.title, title),
          and(eq(sopDocuments.title, title), gt(sopDocuments.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(sopDocuments)
      .where(and(...filters))
      .orderBy(asc(sopDocuments.title), asc(sopDocuments.id))
      .limit(query.limit + 1);
    return page(rows, query.limit, toDocument, (row) => [row.title, row.id]);
  });
}

/** Every version of the lineage, oldest to newest. */
export async function listSopDocumentVersions(
  context: ScopedTenantContext,
  actorUserId: string,
  sopDocumentId: string,
  now = new Date(),
): Promise<SopDocument[]> {
  return withTenant(db, context, async (tx) => {
    const viewer = await loadViewer(tx, context, actorUserId, now);
    const document = await loadVisibleDocument(
      tx,
      context,
      viewer,
      sopDocumentId,
    );
    const rows = await tx
      .select()
      .from(sopDocuments)
      .where(
        and(
          eq(sopDocuments.tenantId, context.tenant.tenantId),
          eq(sopDocuments.lineageId, document.lineageId),
        ),
      )
      .orderBy(asc(sopDocuments.version));
    return rows.map(toDocument);
  });
}

/** Employees the manager reaches who have to read this SOP, and their state. */
export async function listSopAcknowledgementStatus(
  context: ScopedTenantContext,
  actorUserId: string,
  sopDocumentId: string,
  query: Cursor,
  now = new Date(),
): Promise<Page<SopAcknowledgementStatus>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const manage = access.reach(MANAGE);
    if (!manage) throw forbidden();
    const requested = await loadVisibleDocument(
      tx,
      context,
      { access, manage, self: null },
      sopDocumentId,
    );
    // Status is always against the lineage head, whichever version was asked.
    const [head] = await tx
      .select()
      .from(sopDocuments)
      .where(
        and(
          eq(sopDocuments.tenantId, context.tenant.tenantId),
          eq(sopDocuments.lineageId, requested.lineageId),
          isEffectiveLatest(localDateOf(now)),
        ),
      )
      .limit(1);
    const document = head ?? requested;
    const filters: SQL[] = [
      eq(employees.tenantId, context.tenant.tenantId),
      inArray(employees.status, ["active", "onboarding"]),
    ];
    if (manage.kind === "outlets")
      filters.push(inArray(employees.homeOutletId, [...manage.outletIds]));
    if (document.stationId) {
      const outletId = await stationOutlet(tx, context, document.stationId);
      if (outletId === null)
        return { data: [], meta: { limit: query.limit, nextCursor: null } };
      filters.push(eq(employees.homeOutletId, outletId));
    }
    if (document.positionId)
      filters.push(eq(employees.positionId, document.positionId));
    if (query.cursor) {
      const [name, id] = sopCursorPair(query.cursor);
      filters.push(
        or(
          gt(employees.fullName, name),
          and(eq(employees.fullName, name), gt(employees.id, id)),
        )!,
      );
    }
    const people = await tx
      .select({
        id: employees.id,
        fullName: employees.fullName,
        homeOutletId: employees.homeOutletId,
      })
      .from(employees)
      .where(and(...filters))
      .orderBy(asc(employees.fullName), asc(employees.id))
      .limit(query.limit + 1);
    const shown = people.slice(0, query.limit);
    // Acknowledgements are per version row; fold them over the whole lineage.
    const acknowledged =
      shown.length === 0
        ? []
        : await tx
            .select({
              employeeId: sopAcknowledgements.employeeId,
              version: sopAcknowledgements.documentVersion,
              acknowledgedAt: sopAcknowledgements.acknowledgedAt,
            })
            .from(sopAcknowledgements)
            .innerJoin(
              sopDocuments,
              and(
                eq(sopDocuments.tenantId, sopAcknowledgements.tenantId),
                eq(sopDocuments.id, sopAcknowledgements.sopDocumentId),
              ),
            )
            .where(
              and(
                eq(sopAcknowledgements.tenantId, context.tenant.tenantId),
                eq(sopDocuments.lineageId, document.lineageId),
                inArray(
                  sopAcknowledgements.employeeId,
                  shown.map((person) => person.id),
                ),
              ),
            );
    const latestByEmployee = new Map<
      string,
      { version: number; acknowledgedAt: Date }
    >();
    for (const entry of acknowledged) {
      const known = latestByEmployee.get(entry.employeeId);
      if (!known || entry.version > known.version)
        latestByEmployee.set(entry.employeeId, entry);
    }
    return page(
      people,
      query.limit,
      (person) => {
        const last = latestByEmployee.get(person.id);
        return sopAcknowledgementStatusSchema.parse({
          employeeId: person.id,
          employeeName: person.fullName,
          homeOutletId: person.homeOutletId,
          acknowledgedVersion: last?.version ?? null,
          acknowledgedAt: last?.acknowledgedAt.toISOString() ?? null,
          current: last?.version === document.version,
        });
      },
      (person) => [person.fullName, person.id],
    );
  });
}

/** The caller confirms they read the latest version (idempotent). */
export async function acknowledgeSopDocument(
  context: ScopedTenantContext,
  actorUserId: string,
  sopDocumentId: string,
  input: { idempotencyKey: string },
  now = new Date(),
): Promise<SopAcknowledgement> {
  return withTenant(db, context, async (tx) => {
    const viewer = await loadViewer(tx, context, actorUserId, now);
    const { access } = viewer;
    if (!access.own) throw notFound("Data karyawan");
    if (!viewer.self) throw forbidden();
    // Employee scope only: a manager who is also an employee must not
    // acknowledge a SOP that is not addressed to them.
    const document = await loadVisibleDocument(
      tx,
      context,
      { ...viewer, manage: null },
      sopDocumentId,
    );
    const existing = () =>
      tx
        .select()
        .from(sopAcknowledgements)
        .where(
          and(
            eq(sopAcknowledgements.tenantId, context.tenant.tenantId),
            eq(sopAcknowledgements.sopDocumentId, document.id),
            eq(sopAcknowledgements.employeeId, viewer.self!.id),
          ),
        )
        .limit(1);
    const [replay] = await existing();
    // A retry with the same idempotency key replays the stored row even after
    // a newer version was published (the first call did succeed).
    if (replay && replay.idempotencyKey === input.idempotencyKey)
      return toAcknowledgement(replay);
    // A future-dated version cannot be confirmed before its date.
    if (document.effectiveFrom > localDateOf(now))
      throw new HttpError(
        409,
        "SOP_NOT_EFFECTIVE",
        "Versi SOP ini belum berlaku.",
      );
    const isHead =
      document.version ===
      (await latestVersion(tx, context, document.lineageId, localDateOf(now)));
    // A fresh confirmation of a superseded version is stale: the employee
    // must read and confirm the current one.
    if (!isHead) throw staleVersion();
    if (replay) return toAcknowledgement(replay);
    await tx
      .insert(sopAcknowledgements)
      .values({
        tenantId: context.tenant.tenantId,
        sopDocumentId: document.id,
        documentVersion: document.version,
        employeeId: viewer.self.id,
        acknowledgedAt: now,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing();
    const [row] = await existing();
    if (!row) throw new Error("SOP acknowledgement insert returned no row");
    return toAcknowledgement(row);
  });
}
