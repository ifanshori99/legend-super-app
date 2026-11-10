// HRIS internal announcements (PRD v1.7 §3 F32 "Pengumuman Internal"; bead
// legend-7df1). Routes: routes/hris-announcement.routes.ts.
//
// Manage = `hr.announcement.manage` (legend-poxk; apart from `hr.sop.manage`
// so a kitchen lead does not see every employee's receipts); employees read and
// confirm with `self.sop.read` on their own employee row.
//
// - An `all` announcement needs tenant-wide reach to publish; an `outlets`
//   one needs every target outlet inside the caller's reach (403
//   OUTLET_OUT_OF_SCOPE). The audience rows carry outlet RLS, so a reader only
//   ever sees the audience outlets inside their own scope.
// - Employee feed: announcements that cover the employee's home outlet and
//   have not expired. Managers also see every announcement whose audience
//   touches their reach, expired ones included (they audit receipts).
// - A receipt appears on first read. `read_at` is set once and
//   `acknowledged_at` is set once and never cleared (ON CONFLICT keeps both).
// - Someone else's announcement (not in audience / not in reach) answers 404.

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  encodeCursor,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  announcementReceiptSchema,
  announcementRecipientSchema,
  announcementSchema,
  listAnnouncements as listAnnouncementsEndpoint,
  listAnnouncementReceipts as listAnnouncementReceiptsEndpoint,
  type Announcement,
  type AnnouncementReceipt,
  type AnnouncementReceiptSummary,
  type AnnouncementRecipient,
  type CreateAnnouncementInput,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  announcementOutlets,
  announcementReceipts,
  announcements,
} from "../db/schema/hris-announcement.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  cursorPair,
  forbidden,
  loadHrisAccess,
  notFound,
  type HrisAccess,
  type HrisReach,
  type Tx,
} from "./hris-access.ts";

export const ANNOUNCEMENT_MANAGE_CODE = "hr.announcement.manage";
export const ANNOUNCEMENT_SELF_CODE = "self.sop.read";

type AnnouncementRow = typeof announcements.$inferSelect;
type ListQuery = z.output<typeof listAnnouncementsEndpoint.query>;
type ReceiptsQuery = z.output<typeof listAnnouncementReceiptsEndpoint.query>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type RecipientPage = Page<AnnouncementRecipient> & {
  meta: Page<unknown>["meta"] & { summary: AnnouncementReceiptSummary };
};

const lower = (value: string) => value.toLowerCase();

const toAnnouncement = (
  row: AnnouncementRow,
  outletIds: readonly string[],
): Announcement =>
  announcementSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    body: row.body,
    audience:
      row.audienceKind === "all"
        ? { kind: "all" }
        : { kind: "outlets", outletIds: [...outletIds] },
    requiresReceipt: row.requiresReceipt,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  });

const toReceipt = (
  row: typeof announcementReceipts.$inferSelect,
): AnnouncementReceipt =>
  announcementReceiptSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    announcementId: row.announcementId,
    employeeId: row.employeeId,
    readAt: row.readAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  });

/** Audience outlets of the announcements, as far as the caller's scope sees. */
async function loadAudiences(
  tx: Tx,
  context: ScopedTenantContext,
  announcementIds: readonly string[],
): Promise<Map<string, string[]>> {
  const audiences = new Map<string, string[]>();
  if (announcementIds.length === 0) return audiences;
  const rows = await tx
    .select({
      announcementId: announcementOutlets.announcementId,
      outletId: announcementOutlets.outletId,
    })
    .from(announcementOutlets)
    .where(
      and(
        eq(announcementOutlets.tenantId, context.tenant.tenantId),
        inArray(announcementOutlets.announcementId, [...announcementIds]),
      ),
    )
    .orderBy(asc(announcementOutlets.outletId));
  for (const row of rows) {
    const list = audiences.get(row.announcementId) ?? [];
    list.push(lower(row.outletId));
    audiences.set(row.announcementId, list);
  }
  return audiences;
}

async function loadAnnouncement(
  tx: Tx,
  context: ScopedTenantContext,
  announcementId: string,
): Promise<AnnouncementRow | null> {
  const [row] = await tx
    .select()
    .from(announcements)
    .where(
      and(
        eq(announcements.tenantId, context.tenant.tenantId),
        eq(announcements.id, announcementId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The employee can act on announcements (code held; row may still be absent). */
function holdsSelf(access: HrisAccess): boolean {
  return access.snapshot.permissions.includes(ANNOUNCEMENT_SELF_CODE);
}

/** Employee statuses that read and confirm announcements (same list as hris-sop.service). */
const READER_STATUSES: ("active" | "onboarding")[] = ["active", "onboarding"];

/** The caller's own row when `self.sop.read` reaches its home outlet and they still work here. */
async function selfSubject(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
) {
  const own = access.own;
  if (
    own === null ||
    !access.snapshot.allows(ANNOUNCEMENT_SELF_CODE, {
      type: "outlet",
      id: own.homeOutletId,
    })
  )
    return null;
  const [working] = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, own.id),
        inArray(employees.status, READER_STATUSES),
      ),
    )
    .limit(1);
  return working ? own : null;
}

/** Audience of one announcement touches the manager's reach. */
function reachesAudience(
  reach: HrisReach,
  row: Pick<AnnouncementRow, "audienceKind">,
  audience: readonly string[],
): boolean {
  if (reach.kind === "tenant" || row.audienceKind === "all") return true;
  const allowed = new Set(reach.outletIds.map(lower));
  return audience.some((outletId) => allowed.has(lower(outletId)));
}

function audienceCovers(
  row: Pick<AnnouncementRow, "audienceKind">,
  audience: readonly string[],
  homeOutletId: string,
): boolean {
  return (
    row.audienceKind === "all" ||
    audience.some((outletId) => lower(outletId) === lower(homeOutletId))
  );
}

function hasOutletAudience(outletIds: readonly string[]) {
  return exists(
    sql`(SELECT 1 FROM ${announcementOutlets}
          WHERE ${announcementOutlets.tenantId} = ${announcements.tenantId}
            AND ${announcementOutlets.announcementId} = ${announcements.id}
            AND ${inArray(
              announcementOutlets.outletId,
              outletIds.map((id) => outletIdSchema.parse(id)),
            )})`,
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function badCursor(): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
}

function publishedCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = cursorPair(cursor);
  const at = new Date(iso);
  if (
    !ISO_PATTERN.test(iso) ||
    Number.isNaN(at.getTime()) ||
    !UUID_PATTERN.test(id)
  )
    throw badCursor();
  return { at, id };
}

function recipientCursor(cursor: string): [string, string] {
  const [name, id] = cursorPair(cursor);
  if (!UUID_PATTERN.test(id)) throw badCursor();
  return [name, id];
}

export async function createAnnouncement(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateAnnouncementInput,
  now = new Date(),
): Promise<Announcement> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach([ANNOUNCEMENT_MANAGE_CODE]);
    if (reach === null) throw forbidden();
    const outletIds =
      input.audience.kind === "outlets"
        ? [...new Set(input.audience.outletIds.map(lower))]
        : [];
    if (input.audience.kind === "all") {
      if (reach.kind !== "tenant") throw outOfScope();
    } else {
      for (const outletId of outletIds) {
        if (reach.kind !== "tenant" && !reach.outletIds.includes(outletId))
          throw outOfScope();
      }
      const known = await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, context.tenant.tenantId),
            inArray(outlets.id, outletIds),
          ),
        );
      if (known.length !== outletIds.length) throw notFound("Outlet");
    }
    if (input.expiresAt !== null && new Date(input.expiresAt) <= now)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Waktu kedaluwarsa harus di masa depan.",
      );
    const [row] = await tx
      .insert(announcements)
      .values({
        tenantId: context.tenant.tenantId,
        title: input.title,
        body: input.body,
        audienceKind: input.audience.kind,
        requiresReceipt: input.requiresReceipt,
        publishedBy: access.actorUserId,
        publishedAt: now,
        expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
      })
      .returning();
    if (!row) throw new Error("Announcement insert returned no row");
    if (outletIds.length > 0)
      await tx.insert(announcementOutlets).values(
        outletIds.map((outletId) => ({
          tenantId: context.tenant.tenantId,
          announcementId: row.id,
          outletId: outletIdSchema.parse(outletId),
        })),
      );
    return toAnnouncement(row, outletIds);
  });
}

function outOfScope(): HttpError {
  return new HttpError(
    403,
    "OUTLET_OUT_OF_SCOPE",
    "Outlet di luar jangkauan akun Anda.",
  );
}

export async function listAnnouncements(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
  now = new Date(),
): Promise<Page<Announcement>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach([ANNOUNCEMENT_MANAGE_CODE]);
    if (reach === null && !holdsSelf(access)) throw forbidden();
    const subject = await selfSubject(tx, context, access);
    const visible: SQL[] = [];
    if (subject !== null)
      visible.push(
        and(
          or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)),
          or(
            eq(announcements.audienceKind, "all"),
            hasOutletAudience([lower(subject.homeOutletId)]),
          ),
        )!,
      );
    if (reach !== null)
      visible.push(
        reach.kind === "tenant"
          ? sql`true`
          : or(
              eq(announcements.audienceKind, "all"),
              hasOutletAudience([...reach.outletIds]),
            )!,
      );
    if (visible.length === 0) return emptyPage(query.limit);
    const filters: SQL[] = [
      eq(announcements.tenantId, context.tenant.tenantId),
      or(...visible)!,
    ];
    if (query.cursor) {
      const { at, id } = publishedCursor(query.cursor);
      filters.push(
        or(
          lt(announcements.publishedAt, at),
          and(eq(announcements.publishedAt, at), lt(announcements.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(announcements)
      .where(and(...filters))
      .orderBy(desc(announcements.publishedAt), desc(announcements.id))
      .limit(query.limit + 1);
    const data = rows.slice(0, query.limit);
    const audiences = await loadAudiences(
      tx,
      context,
      data.map((row) => row.id),
    );
    const last = data.at(-1);
    return {
      data: data.map((row) => toAnnouncement(row, audiences.get(row.id) ?? [])),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.publishedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

function emptyPage<T>(limit: number): Page<T> {
  return { data: [], meta: { limit, nextCursor: null } };
}

export async function markAnnouncementRead(
  context: ScopedTenantContext,
  actorUserId: string,
  announcementId: string,
  input: { readonly acknowledged: boolean; readonly idempotencyKey: string },
  now = new Date(),
): Promise<AnnouncementReceipt> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (!holdsSelf(access)) throw forbidden();
    const subject = await selfSubject(tx, context, access);
    if (subject === null) throw notFound("Pengumuman");
    const row = await loadAnnouncement(tx, context, announcementId);
    if (
      row === null ||
      (row.expiresAt !== null && row.expiresAt <= now) ||
      !audienceCovers(
        row,
        (await loadAudiences(tx, context, [row.id])).get(row.id) ?? [],
        subject.homeOutletId,
      )
    )
      throw notFound("Pengumuman");
    // First call creates the receipt; later calls never move read_at and only
    // ever fill acknowledged_at (COALESCE keeps an earlier confirmation).
    const [receipt] = await tx
      .insert(announcementReceipts)
      .values({
        tenantId: context.tenant.tenantId,
        announcementId: row.id,
        employeeId: subject.id,
        readAt: now,
        acknowledgedAt: input.acknowledged ? now : null,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoUpdate({
        target: [
          announcementReceipts.tenantId,
          announcementReceipts.announcementId,
          announcementReceipts.employeeId,
        ],
        set: {
          acknowledgedAt: sql`COALESCE(${announcementReceipts.acknowledgedAt}, excluded.acknowledged_at)`,
        },
      })
      .returning();
    if (!receipt) throw new Error("Receipt upsert returned no row");
    return toReceipt(receipt);
  });
}

export async function listAnnouncementReceipts(
  context: ScopedTenantContext,
  actorUserId: string,
  announcementId: string,
  query: ReceiptsQuery,
  now = new Date(),
): Promise<RecipientPage> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach([ANNOUNCEMENT_MANAGE_CODE]);
    if (reach === null) throw forbidden();
    const row = await loadAnnouncement(tx, context, announcementId);
    if (row === null) throw notFound("Pengumuman");
    const audience =
      (await loadAudiences(tx, context, [row.id])).get(row.id) ?? [];
    if (!reachesAudience(reach, row, audience)) throw notFound("Pengumuman");

    // Recipients: active employees in the audience, inside the manager's reach.
    let homeOutlets: string[] | null = null;
    if (row.audienceKind === "outlets") homeOutlets = audience;
    if (reach.kind === "outlets") {
      const allowed = new Set(reach.outletIds.map(lower));
      homeOutlets = (homeOutlets ?? [...allowed]).filter((id) =>
        allowed.has(lower(id)),
      );
    }
    const recipientFilters: SQL[] = [
      eq(employees.tenantId, context.tenant.tenantId),
      inArray(employees.status, READER_STATUSES),
    ];
    if (homeOutlets !== null)
      recipientFilters.push(
        homeOutlets.length === 0
          ? sql`false`
          : inArray(employees.homeOutletId, homeOutlets),
      );
    const joinReceipts = and(
      eq(announcementReceipts.tenantId, employees.tenantId),
      eq(announcementReceipts.announcementId, row.id),
      eq(announcementReceipts.employeeId, employees.id),
    );

    const [totals] = await tx
      .select({
        recipients: count(),
        read: count(announcementReceipts.id),
        acknowledged: count(announcementReceipts.acknowledgedAt),
      })
      .from(employees)
      .leftJoin(announcementReceipts, joinReceipts)
      .where(and(...recipientFilters));

    const filters = [...recipientFilters];
    if (query.status === "unread")
      filters.push(isNull(announcementReceipts.id));
    else if (query.status === "read")
      filters.push(
        isNotNull(announcementReceipts.id),
        isNull(announcementReceipts.acknowledgedAt),
      );
    else if (query.status === "acknowledged")
      filters.push(isNotNull(announcementReceipts.acknowledgedAt));
    if (query.cursor) {
      const [name, id] = recipientCursor(query.cursor);
      filters.push(
        or(
          gt(employees.fullName, name),
          and(eq(employees.fullName, name), gt(employees.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select({
        employeeId: employees.id,
        employeeName: employees.fullName,
        homeOutletId: employees.homeOutletId,
        readAt: announcementReceipts.readAt,
        acknowledgedAt: announcementReceipts.acknowledgedAt,
      })
      .from(employees)
      .leftJoin(announcementReceipts, joinReceipts)
      .where(and(...filters))
      .orderBy(asc(employees.fullName), asc(employees.id))
      .limit(query.limit + 1);
    const data = rows.slice(0, query.limit);
    const last = data.at(-1);
    return {
      data: data.map((item) =>
        announcementRecipientSchema.parse({
          employeeId: item.employeeId,
          employeeName: item.employeeName,
          homeOutletId: item.homeOutletId,
          readAt: item.readAt?.toISOString() ?? null,
          acknowledgedAt: item.acknowledgedAt?.toISOString() ?? null,
        }),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.employeeName, last.employeeId])
            : null,
        summary: {
          recipients: totals?.recipients ?? 0,
          read: totals?.read ?? 0,
          acknowledged: totals?.acknowledged ?? 0,
        },
      },
    };
  });
}
